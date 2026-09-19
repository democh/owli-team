/**
 * M31：通用异步任务模板适配器 —— 云端视频 / 图像 API（提交-轮询-取件三段式，零依赖）。
 *
 * 模板（连接 config.template，见 shared TaskApiTemplate）：
 * - create：方法 / 路径 / 请求体（占位符深替换）→ 提交任务；
 * - poll：GET 路径（{id} 插值为任务 id）/ 间隔 intervalMs（缺省 3000，下限 500）/ 上限 maxMs（缺省 9 分钟）；
 * - extract：点路径提取 任务 id / 状态 / 完成态（done）/ 失败态（fail）/ 进度 / 进度文案 / 结果（outputUrl 或数组 outputUrls）。
 *
 * 变量：{{prompt}} {{negative}} {{seed}} {{width}} {{height}} {{steps}} {{duration}} {{model}}
 *       {{image}}/{{image2}}…（输入图 base64） {{first_frame}} {{last_frame}}（base64）
 * 结果支持 http(s) 链接 / 相对路径（同端点自动带凭据）/ data:base64 内联。
 * 未配置 done/fail：首次轮询即视为完成（fire-and-forget 型 API）。
 */
import fs from 'node:fs'
import type { MediaJob } from '@multi-agent/shared'
import type { MediaJobContext, MediaProviderAdapter } from '../types.js'
import { outputExtFor } from '../types.js'
import { authHeaders, deepReplaceVars, fetchBuffer, fetchJson, getPath, sleep, trimBase } from './http.js'

const DEFAULT_POLL_INTERVAL_MS = 3000
const POLL_MAX_MS = 9 * 60_000

/** 组装模板变量（输入图 → base64；有模型才注入 model） */
function buildVars(job: MediaJob, ctx: MediaJobContext): Record<string, unknown> {
  const vars: Record<string, unknown> = {
    prompt: job.prompt,
    negative: job.negative ?? '',
    seed: job.params.seed ?? Math.floor(Math.random() * 2 ** 32),
    width: job.params.width ?? 1024,
    height: job.params.height ?? 1024,
    steps: job.params.steps ?? 20,
    duration: job.params.duration ?? 4,
  }
  const model = job.model ?? ctx.config.defaultModel
  if (model) vars.model = model
  const images = job.inputs.images ?? []
  images.forEach((rel, index) => {
    vars[index === 0 ? 'image' : `image${index + 1}`] = fs.readFileSync(ctx.resolveInput(rel)).toString('base64')
  })
  if (job.inputs.firstFrame) vars.first_frame = fs.readFileSync(ctx.resolveInput(job.inputs.firstFrame)).toString('base64')
  if (job.inputs.lastFrame) vars.last_frame = fs.readFileSync(ctx.resolveInput(job.inputs.lastFrame)).toString('base64')
  return vars
}

/** 进度归一：0-1 视为比例（×100）；>1 视为百分比原值 */
function normalizeProgress(raw: unknown): number | undefined {
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  if (!Number.isFinite(value)) return undefined
  return value <= 1 ? Math.round(value * 100) : Math.round(value)
}

/** 产物扩展名：URL 路径后缀优先，缺省按能力（图像 png / 视频 mp4） */
function extFromUrl(url: string, fallback: string): string {
  return /\.([a-z0-9]+)(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase() ?? fallback
}

/** 下载产物（http(s) / 相对路径 / data:base64；相对路径自动带凭据，绝对链接不带） */
async function downloadOutputs(urls: string[], base: string, ctx: MediaJobContext, job: MediaJob): Promise<string[]> {
  const auth = authHeaders(ctx.secret)
  const fallbackExt = outputExtFor(job.capability)
  const outputs: string[] = []
  for (const url of urls) {
    if (url.startsWith('data:')) {
      const inline = /^data:[^;]+;base64,(.*)$/s.exec(url)
      if (inline) outputs.push(ctx.saveOutput(Buffer.from(inline[1]!, 'base64'), fallbackExt))
      continue
    }
    const isAbsolute = /^https?:\/\//i.test(url)
    const absolute = isAbsolute ? url : `${base}${url.startsWith('/') ? '' : '/'}${url}`
    const buffer = await fetchBuffer(absolute, { method: 'GET', headers: isAbsolute ? undefined : auth }, ctx.signal, '产物下载')
    outputs.push(ctx.saveOutput(buffer, extFromUrl(absolute, fallbackExt)))
  }
  return outputs
}

export const taskTemplateAdapter: MediaProviderAdapter = {
  kind: 'template',
  capabilities: ['text2image', 'image2image', 'text2video', 'image2video', 'firstlast2video'],

  async test({ config }) {
    const template = config.template
    if (!template?.create?.path || !template.poll?.path || !template.extract) {
      return { ok: false, error: '任务模板不完整：create.path / poll.path / extract 必填（在连接配置中填写）' }
    }
    return { ok: true, detail: `模板：${template.create.method} ${template.create.path} → ${template.poll.method} ${template.poll.path}` }
  },

  async run(job, ctx) {
    const template = ctx.config.template
    if (!template) throw new Error('任务模板缺失：请在连接配置中填写 create / poll / extract 三段式模板')
    const base = trimBase(ctx.config.baseUrl)
    const auth = authHeaders(ctx.secret)
    const vars = buildVars(job, ctx)

    // 1) 创建任务
    ctx.report(3, '提交任务')
    const created = await fetchJson<unknown>(
      `${base}${template.create.path}`,
      {
        method: template.create.method,
        headers: { 'content-type': 'application/json', ...auth, ...(template.create.headers ?? {}) },
        body: JSON.stringify(deepReplaceVars(template.create.body, vars)),
      },
      ctx.signal,
      '任务提交',
    )

    // 2) 轮询（配置 taskId 时；否则 create 响应即终态）
    const extract = template.extract
    let source: unknown = created
    const taskId = extract.taskId ? getPath(created, extract.taskId) : undefined
    if (extract.taskId && (taskId === undefined || taskId === null)) {
      throw new Error(`未从创建响应提取到任务 id（路径 ${extract.taskId}）：请核对模板 extract.taskId`)
    }
    if (taskId !== undefined) {
      const pollPath = template.poll.path.replace('{id}', encodeURIComponent(String(taskId)))
      const interval = Math.max(500, template.poll.intervalMs ?? DEFAULT_POLL_INTERVAL_MS)
      const maxMs = Math.max(10_000, Math.min(template.poll.maxMs ?? POLL_MAX_MS, POLL_MAX_MS))
      const startedAt = Date.now()
      for (;;) {
        const polled = await fetchJson<unknown>(`${base}${pollPath}`, { method: 'GET', headers: auth }, ctx.signal, '任务轮询')
        source = polled
        const status = extract.status ? String(getPath(polled, extract.status) ?? '') : ''
        const doneStates = (extract.done ?? []).map(String)
        const failStates = (extract.fail ?? []).map(String)
        const progress = extract.progress ? normalizeProgress(getPath(polled, extract.progress)) : undefined
        const progressText = extract.progressText ? getPath(polled, extract.progressText) : undefined
        ctx.report(progress, typeof progressText === 'string' && progressText ? progressText : status ? `状态：${status}` : undefined)
        if (status && failStates.includes(status)) {
          const errorText = extract.errorText ? getPath(polled, extract.errorText) : undefined
          throw new Error(`远端任务失败（${status}${errorText ? `：${String(errorText).slice(0, 200)}` : ''}）`)
        }
        if (doneStates.length === 0 || doneStates.includes(status)) break
        if (Date.now() - startedAt > maxMs) throw new Error(`远端任务超时（超过 ${Math.round(maxMs / 1000)}s 未完成）`)
        await sleep(interval, ctx.signal)
      }
    }

    // 3) 取件
    const singleUrl = extract.outputUrl ? getPath(source, extract.outputUrl) : undefined
    const manyUrls = extract.outputUrls ? getPath(source, extract.outputUrls) : undefined
    const urls: string[] = [
      ...(Array.isArray(manyUrls) ? manyUrls.filter((u): u is string => typeof u === 'string') : []),
      ...(typeof singleUrl === 'string' && singleUrl ? [singleUrl] : []),
    ]
    if (urls.length === 0) {
      throw new Error('任务已完成但未提取到产物：请核对模板 extract.outputUrl / outputUrls 路径')
    }
    return { outputs: await downloadOutputs(urls, base, ctx, job) }
  },
}

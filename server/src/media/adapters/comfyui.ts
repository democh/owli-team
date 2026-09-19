/**
 * M31：ComfyUI 适配器 —— 本地生图 / 生视频 / 首尾帧（HTTP API，零依赖）。
 *
 * 协议（ComfyUI 默认端口 8188）：
 * - 输入素材：POST /upload/image（multipart）→ 供 LoadImage 类节点引用（替换 {{image}} 等占位符）；
 * - 提交：POST /prompt { prompt: <API 格式工作流 JSON>, client_id } → { prompt_id }；
 * - 状态：GET /queue（排队位次 / 执行中）+ GET /progress（采样步数，老版本缺失时降级为文案）+ GET /history/{id}（完成判定）；
 * - 取件：GET /view?filename=&subfolder=&type=output 下载产物（images / gifs / videos 键，兼容 VHS 视频节点）；
 * - 取消：POST /interrupt（ComfyUI 无按任务取消，中断当前执行）。
 *
 * 工作流模板：连接 config.workflows（用户粘贴「Save (API Format)」导出 JSON）；
 * 未配置时文生图回退内置默认工作流（需连接「默认模型」= checkpoint 名称）。
 * 占位符：{{prompt}} {{negative}} {{seed}} {{steps}} {{width}} {{height}} {{duration}} {{model}}
 *         {{image}}/{{image2}}… {{first_frame}} {{last_frame}}（上传后返回的远端文件名）。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { MediaConnectionConfig, MediaJob } from '@multi-agent/shared'
import type { MediaJobContext, MediaProviderAdapter } from '../types.js'
import { outputExtFor } from '../types.js'
import { deepReplaceVars, fetchBuffer, fetchJson, mimeOf, sleep, trimBase } from './http.js'

/** 轮询间隔（队列 / 进度 / 历史） */
const POLL_INTERVAL_MS = 1200

/** /view 下载引用（history outputs 内的文件项） */
interface ComfyViewFile {
  filename: string
  subfolder?: string
  type?: string
}

interface ComfyHistoryEntry {
  outputs?: Record<string, Record<string, unknown>>
  status?: {
    status_str?: string
    completed?: boolean
    messages?: Array<{ type?: string; data?: Record<string, unknown> }>
  }
}

interface ComfyQueue {
  queue_running?: unknown[][]
  queue_pending?: unknown[][]
}

interface ComfyProgress {
  value?: number
  max?: number
  prompt_id?: string
}

/** 内置默认文生图工作流（API 格式；checkpoint 经 {{model}} 注入，随机种子由占位符替换） */
const DEFAULT_T2I_WORKFLOW: Record<string, unknown> = {
  '3': {
    class_type: 'KSampler',
    inputs: {
      seed: '{{seed}}',
      steps: '{{steps}}',
      cfg: 7,
      sampler_name: 'euler',
      scheduler: 'normal',
      denoise: 1,
      model: ['4', 0],
      positive: ['6', 0],
      negative: ['7', 0],
      latent_image: ['5', 0],
    },
  },
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: '{{model}}' } },
  '5': { class_type: 'EmptyLatentImage', inputs: { width: '{{width}}', height: '{{height}}', batch_size: 1 } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}', clip: ['4', 1] } },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: '{{negative}}', clip: ['4', 1] } },
  '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
  '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'm30', images: ['8', 0] } },
}

/** 选择工作流：任务指定 → 能力匹配模板 → 内置文生图；均无则给出配置指引 */
function pickWorkflow(config: MediaConnectionConfig, job: MediaJob): { id: string; name: string; json: Record<string, unknown> } {
  const workflows = config.workflows ?? []
  if (job.params.workflowId) {
    const found = workflows.find((w) => w.id === job.params.workflowId)
    if (!found) throw new Error(`工作流「${job.params.workflowId}」不在连接配置中：请在连接面板核对模板清单`)
    return found
  }
  const matched = workflows.find((w) => w.capability === job.capability)
  if (matched) return matched
  if (job.capability === 'text2image') return { id: 'builtin-t2i', name: '内置文生图', json: DEFAULT_T2I_WORKFLOW }
  throw new Error('连接未配置该能力的工作流模板：请在连接面板粘贴 ComfyUI API 格式工作流并声明对应能力')
}

/** 上传输入素材 → 返回 ComfyUI 侧文件名（LoadImage 节点引用值） */
async function uploadImage(base: string, absPath: string, fileName: string, signal: AbortSignal): Promise<string> {
  const form = new FormData()
  form.append('image', new Blob([fs.readFileSync(absPath)], { type: mimeOf(fileName) }), fileName)
  form.append('overwrite', 'true')
  const res = await fetchJson<{ name?: string; subfolder?: string }>(
    `${base}/upload/image`,
    { method: 'POST', body: form },
    signal,
    '输入图上传',
  )
  if (!res.name) throw new Error('ComfyUI 输入图上传失败（未返回文件名）')
  return res.subfolder ? `${res.subfolder}/${res.name}` : res.name
}

/** 组装占位符变量（含输入素材上传；引用 {{model}} 但未配置模型时提前报错） */
async function buildVars(job: MediaJob, ctx: MediaJobContext, workflow: Record<string, unknown>): Promise<Record<string, unknown>> {
  const base = trimBase(ctx.config.baseUrl)
  const vars: Record<string, unknown> = {
    prompt: job.prompt,
    negative: job.negative ?? '',
    seed: job.params.seed ?? Math.floor(Math.random() * 2 ** 32),
    steps: job.params.steps ?? 20,
    width: job.params.width ?? 1024,
    height: job.params.height ?? 1024,
    duration: job.params.duration ?? 4,
  }
  const model = job.model ?? ctx.config.defaultModel
  if (model) {
    vars.model = model
  } else if (JSON.stringify(workflow).includes('{{model}}')) {
    throw new Error('工作流引用 {{model}} 但未指定模型：请在连接配置「默认模型」填写 checkpoint 名称')
  }
  const images = job.inputs.images ?? []
  for (let i = 0; i < images.length; i += 1) {
    const rel = images[i]!
    vars[i === 0 ? 'image' : `image${i + 1}`] = await uploadImage(base, ctx.resolveInput(rel), path.basename(rel), ctx.signal)
  }
  if (job.inputs.firstFrame) {
    vars.first_frame = await uploadImage(base, ctx.resolveInput(job.inputs.firstFrame), path.basename(job.inputs.firstFrame), ctx.signal)
  }
  if (job.inputs.lastFrame) {
    vars.last_frame = await uploadImage(base, ctx.resolveInput(job.inputs.lastFrame), path.basename(job.inputs.lastFrame), ctx.signal)
  }
  return vars
}

/** 汇总 history 输出文件（images / gifs / videos 三类键，兼容 SaveImage 与 VHS 视频节点） */
function collectOutputs(entry: ComfyHistoryEntry): ComfyViewFile[] {
  const files: ComfyViewFile[] = []
  for (const nodeOutput of Object.values(entry.outputs ?? {})) {
    for (const key of ['images', 'gifs', 'videos']) {
      const list = nodeOutput[key]
      if (!Array.isArray(list)) continue
      for (const item of list) {
        const file = item as ComfyViewFile
        if (file && typeof file.filename === 'string') files.push(file)
      }
    }
  }
  return files
}

/** history 错误信息（execution_error 消息优先） */
function describeHistoryError(entry: ComfyHistoryEntry): string {
  for (const message of entry.status?.messages ?? []) {
    if (message.type === 'execution_error' && message.data) {
      const node = typeof message.data.node_type === 'string' ? message.data.node_type : ''
      const detail =
        (typeof message.data.exception_message === 'string' && message.data.exception_message) ||
        (typeof message.data.exception_type === 'string' && message.data.exception_type) ||
        ''
      return `ComfyUI 执行错误：${node} ${detail}`.trim()
    }
  }
  return 'ComfyUI 执行错误（请在 ComfyUI 控制台查看节点日志）'
}

function extOf(fileName: string, fallback: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(fileName)
  return match ? match[1]!.toLowerCase() : fallback
}

/** 瞬时故障容忍的 GET（网络抖动返回 undefined 下轮重试；取消照常抛出） */
async function tryGetJson<T>(url: string, signal: AbortSignal): Promise<T | undefined> {
  try {
    return await fetchJson<T>(url, { method: 'GET' }, signal, 'ComfyUI 查询')
  } catch (err) {
    if (signal.aborted || (err instanceof Error && err.name === 'AbortError')) throw err
    return undefined
  }
}

/** 采样步进度（老版本无 /progress 时降级为「执行中」文案） */
async function reportComfyProgress(base: string, promptId: string, ctx: MediaJobContext): Promise<void> {
  const progress = await tryGetJson<ComfyProgress>(`${base}/progress`, ctx.signal)
  if (progress && progress.prompt_id === promptId && typeof progress.value === 'number' && typeof progress.max === 'number' && progress.max > 0) {
    ctx.report(Math.round((progress.value / progress.max) * 100), `采样 ${progress.value}/${progress.max}`)
  } else {
    ctx.report(undefined, '执行中')
  }
}

/** 尽力而为的远端取消（独立 3s 超时，不随任务 signal 中断） */
async function interrupt(base: string): Promise<void> {
  try {
    await fetch(`${base}/interrupt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(3000),
    })
  } catch {
    /* 忽略（取消尽力而为） */
  }
}

export const comfyUiAdapter: MediaProviderAdapter = {
  kind: 'comfyui',
  capabilities: ['text2image', 'image2image', 'text2video', 'image2video', 'firstlast2video'],

  async test({ config, signal }) {
    const base = trimBase(config.baseUrl)
    try {
      const stats = await fetchJson<{ system?: { comfyui_version?: string }; devices?: unknown[] }>(
        `${base}/system_stats`,
        { method: 'GET' },
        signal,
        'ComfyUI 连接测试',
      )
      const version = stats.system?.comfyui_version
      const deviceCount = Array.isArray(stats.devices) ? stats.devices.length : 0
      return { ok: true, detail: `ComfyUI${version ? ` v${version}` : ''}${deviceCount ? ` · ${deviceCount} 个设备` : ''}` }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  },

  async run(job, ctx) {
    const base = trimBase(ctx.config.baseUrl)
    const workflow = pickWorkflow(ctx.config, job)
    const vars = await buildVars(job, ctx, workflow.json)
    const workflowJson = deepReplaceVars(workflow.json, vars)

    const onAbort = (): void => {
      void interrupt(base)
    }
    ctx.signal.addEventListener('abort', onAbort, { once: true })
    try {
      ctx.report(1, `提交工作流「${workflow.name}」`)
      const submitted = await fetchJson<{ prompt_id?: string; error?: unknown; node_errors?: unknown }>(
        `${base}/prompt`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt: workflowJson, client_id: `m30-${job.id}` }),
        },
        ctx.signal,
        'ComfyUI 工作流提交',
      )
      const promptId = submitted.prompt_id
      if (!promptId) {
        const detail = JSON.stringify(submitted.error ?? submitted.node_errors ?? {})
        throw new Error(`ComfyUI 拒绝工作流${detail !== '{}' ? `：${detail.slice(0, 240)}` : '（请检查节点输入与模型名）'}`)
      }

      for (;;) {
        const queue = await tryGetJson<ComfyQueue>(`${base}/queue`, ctx.signal)
        const running = (queue?.queue_running ?? []).some((item) => item[1] === promptId)
        const pendingIndex = (queue?.queue_pending ?? []).findIndex((item) => item[1] === promptId)
        if (running) {
          await reportComfyProgress(base, promptId, ctx)
        } else if (pendingIndex >= 0) {
          ctx.report(undefined, `排队中 · 前方 ${pendingIndex} 个任务`)
        } else {
          // 不在队列 = 已结束（history 出现）或瞬时故障（下轮重试）
          const history = await tryGetJson<Record<string, ComfyHistoryEntry>>(`${base}/history/${promptId}`, ctx.signal)
          const entry = history?.[promptId]
          if (entry) {
            if (entry.status?.status_str === 'error') throw new Error(describeHistoryError(entry))
            const files = collectOutputs(entry)
            if (files.length === 0) {
              throw new Error('ComfyUI 工作流完成但没有输出文件：请确认末端为 SaveImage / VHS_VideoCombine 等保存节点')
            }
            const outputs: string[] = []
            for (const file of files) {
              const query = `filename=${encodeURIComponent(file.filename)}&subfolder=${encodeURIComponent(file.subfolder ?? '')}&type=${encodeURIComponent(file.type ?? 'output')}`
              const buffer = await fetchBuffer(`${base}/view?${query}`, { method: 'GET' }, ctx.signal, 'ComfyUI 产物下载')
              outputs.push(ctx.saveOutput(buffer, extOf(file.filename, outputExtFor(job.capability))))
            }
            return { outputs }
          }
        }
        await sleep(POLL_INTERVAL_MS, ctx.signal)
      }
    } finally {
      ctx.signal.removeEventListener('abort', onAbort)
    }
  },
}

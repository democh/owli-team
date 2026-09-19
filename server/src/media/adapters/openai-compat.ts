/**
 * M31：OpenAI 兼容图像 API 适配器 —— 云端生图（零依赖）。
 *
 * 协议（baseUrl 指向兼容端点，如 https://api.openai.com/v1 或第三方兼容网关）：
 * - 文生图：POST /images/generations（n=1；返回 b64_json 或 url，自动下载落盘）；
 * - 图生图：POST /images/edits（multipart：image / image[]；Node 原生 FormData）；
 * - dall-e 系列显式请求 b64_json；gpt-image-1 默认返回 b64_json（不传 response_format）。
 * - 连接测试：GET /models（Bearer 凭据）。
 * - 取消：本地中断请求即终止（无远端取消协议）。
 *
 * 说明：模型必填（连接「默认模型」或生成面板选择）；负向词不被该协议支持（忽略）。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { MediaJob } from '@multi-agent/shared'
import type { MediaJobContext, MediaProviderAdapter } from '../types.js'
import { authHeaders, fetchBuffer, fetchJson, mimeOf, trimBase } from './http.js'

interface OpenAiImageItem {
  b64_json?: string
  url?: string
}

interface OpenAiImageResponse {
  data?: OpenAiImageItem[]
  error?: { message?: string }
}

/** 尺寸参数：宽高齐备时传 WxH（缺省由服务端决定） */
function sizeOf(job: MediaJob): string | undefined {
  const { width, height } = job.params
  return width && height ? `${width}x${height}` : undefined
}

/** 响应 → 落盘：b64_json 直接解码；url 自动下载（扩展名取自 URL，缺省 png） */
async function persist(ctx: MediaJobContext, res: OpenAiImageResponse): Promise<string> {
  const item = res.data?.[0]
  if (!item) throw new Error(`接口未返回图像数据${res.error?.message ? `：${res.error.message}` : ''}`)
  if (item.b64_json) return ctx.saveOutput(Buffer.from(item.b64_json, 'base64'), 'png')
  if (item.url) {
    const buffer = await fetchBuffer(item.url, { method: 'GET' }, ctx.signal, '产物下载')
    const ext = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(item.url)?.[1]?.toLowerCase() ?? 'png'
    return ctx.saveOutput(buffer, ext)
  }
  throw new Error('接口未返回图像数据（b64_json / url 均缺失）')
}

export const openAiCompatAdapter: MediaProviderAdapter = {
  kind: 'openai',
  capabilities: ['text2image', 'image2image'],

  async test({ config, secret, signal }) {
    const base = trimBase(config.baseUrl)
    try {
      const res = await fetchJson<{ data?: unknown[] }>(
        `${base}/models`,
        { method: 'GET', headers: authHeaders(secret) },
        signal,
        'OpenAI 兼容连接测试',
      )
      const count = Array.isArray(res.data) ? res.data.length : 0
      return { ok: true, detail: `端点可用${count ? ` · ${count} 个模型` : ''}` }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  },

  async run(job, ctx) {
    const base = trimBase(ctx.config.baseUrl)
    const model = job.model ?? ctx.config.defaultModel
    if (!model) throw new Error('OpenAI 兼容连接需要模型名：请在连接配置「默认模型」填写或在生成面板选择')
    const size = sizeOf(job)

    if (job.capability === 'text2image') {
      const body: Record<string, unknown> = { model, prompt: job.prompt, n: 1 }
      if (size) body.size = size
      if (/^dall-e/i.test(model)) body.response_format = 'b64_json'
      const res = await fetchJson<OpenAiImageResponse>(
        `${base}/images/generations`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders(ctx.secret) },
          body: JSON.stringify(body),
        },
        ctx.signal,
        '图像生成',
      )
      return { outputs: [await persist(ctx, res)] }
    }

    if (job.capability === 'image2image') {
      const images = job.inputs.images ?? []
      if (images.length === 0) throw new Error('图生图需要输入图片（inputs.images）')
      const form = new FormData()
      images.forEach((rel, index) => {
        const abs = ctx.resolveInput(rel)
        form.append(index === 0 ? 'image' : 'image[]', new Blob([fs.readFileSync(abs)], { type: mimeOf(rel) }), path.basename(rel))
      })
      form.append('prompt', job.prompt)
      form.append('model', model)
      if (size) form.append('size', size)
      const res = await fetchJson<OpenAiImageResponse>(
        `${base}/images/edits`,
        { method: 'POST', headers: authHeaders(ctx.secret), body: form },
        ctx.signal,
        '图生图',
      )
      return { outputs: [await persist(ctx, res)] }
    }

    throw new Error('OpenAI 兼容连接仅支持文生图 / 图生图（视频请使用任务模板连接）')
  },
}

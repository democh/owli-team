/**
 * M31：Stable Diffusion WebUI（A1111 / Forge）适配器 —— 本地生图（零依赖）。
 *
 * 协议：
 * - 出图：POST /sdapi/v1/txt2img | /sdapi/v1/img2img（长连接，返回 images[0] 为 base64 PNG）；
 * - 进度：生成期间轮询 GET /sdapi/v1/progress?skip_current_image=true（progress 0-1 + 采样步数）；
 * - 取消：POST /sdapi/v1/interrupt；
 * - 连接测试：GET /sdapi/v1/options（回显当前 checkpoint）。
 *
 * 说明：任务模型经 override_settings.sd_model_checkpoint 切换；seed 缺省 -1（服务端随机）。
 */
import fs from 'node:fs'
import type { MediaJob } from '@multi-agent/shared'
import type { MediaProviderAdapter } from '../types.js'
import { fetchJson, sleep, trimBase } from './http.js'

/** 进度轮询间隔（长连接生成期间） */
const PROGRESS_INTERVAL_MS = 1500

interface SdProgress {
  progress?: number
  state?: { job?: string; sampling_step?: number; sampling_steps?: number }
}

interface SdImageResponse {
  images?: string[]
  detail?: string
}

/** 公共参数（txt2img / img2img 共用；模型经 override_settings 切换） */
function basePayload(job: MediaJob, model: string | undefined): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    prompt: job.prompt,
    negative_prompt: job.negative ?? '',
    steps: job.params.steps ?? 20,
    seed: job.params.seed ?? -1,
    batch_size: 1,
    n_iter: 1,
  }
  if (job.params.width) payload.width = job.params.width
  if (job.params.height) payload.height = job.params.height
  if (model) payload.override_settings = { sd_model_checkpoint: model }
  return payload
}

/** 尽力而为的远端取消（独立 3s 超时，不随任务 signal 中断） */
async function interrupt(base: string): Promise<void> {
  try {
    await fetch(`${base}/sdapi/v1/interrupt`, { method: 'POST', signal: AbortSignal.timeout(3000) })
  } catch {
    /* 忽略（取消尽力而为） */
  }
}

export const sdWebUiAdapter: MediaProviderAdapter = {
  kind: 'sdwebui',
  capabilities: ['text2image', 'image2image'],

  async test({ config, signal }) {
    const base = trimBase(config.baseUrl)
    try {
      const options = await fetchJson<{ sd_model_checkpoint?: string }>(
        `${base}/sdapi/v1/options`,
        { method: 'GET' },
        signal,
        'SD WebUI 连接测试',
      )
      return { ok: true, detail: `SD WebUI 就绪${options.sd_model_checkpoint ? ` · 当前模型 ${options.sd_model_checkpoint}` : ''}` }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  },

  async run(job, ctx) {
    if (job.capability !== 'text2image' && job.capability !== 'image2image') {
      throw new Error('Stable Diffusion WebUI 连接仅支持文生图 / 图生图（视频请使用 ComfyUI 或任务模板连接）')
    }
    const base = trimBase(ctx.config.baseUrl)
    const payload = basePayload(job, job.model ?? ctx.config.defaultModel)
    let endpoint = '/sdapi/v1/txt2img'
    if (job.capability === 'image2image') {
      endpoint = '/sdapi/v1/img2img'
      const initImages: string[] = []
      for (const rel of job.inputs.images ?? []) {
        initImages.push(fs.readFileSync(ctx.resolveInput(rel)).toString('base64'))
      }
      payload.init_images = initImages
      payload.denoising_strength = 0.75
    }

    const onAbort = (): void => {
      void interrupt(base)
    }
    ctx.signal.addEventListener('abort', onAbort, { once: true })
    try {
      ctx.report(2, '提交生成请求')
      // 生成请求为长连接：并行轮询进度，settled 后取结果
      let settled = false
      const task = fetchJson<SdImageResponse>(
        `${base}${endpoint}`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) },
        ctx.signal,
        'SD WebUI 生成',
      )
      void task.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        },
      )
      while (!settled) {
        await sleep(PROGRESS_INTERVAL_MS, ctx.signal)
        if (settled) break
        try {
          const progress = await fetchJson<SdProgress>(
            `${base}/sdapi/v1/progress?skip_current_image=true`,
            { method: 'GET' },
            ctx.signal,
            'SD WebUI 进度',
          )
          const state = progress.state ?? {}
          const text = state.sampling_steps ? `采样 ${state.sampling_step ?? 0}/${state.sampling_steps}` : state.job || '生成中'
          ctx.report(typeof progress.progress === 'number' ? Math.round(progress.progress * 100) : undefined, text)
        } catch (err) {
          if (ctx.signal.aborted) throw err
          /* 进度端点偶发失败忽略（生成本身不受影响） */
        }
      }
      const res = await task
      const first = res.images?.[0]
      if (!first) throw new Error(`SD WebUI 未返回图像数据${res.detail ? `：${res.detail}` : '（images 为空）'}`)
      return { outputs: [ctx.saveOutput(Buffer.from(first, 'base64'), 'png')] }
    } finally {
      ctx.signal.removeEventListener('abort', onAbort)
    }
  },
}

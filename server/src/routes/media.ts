/**
 * M31：媒体生成路由（挂载于 /api 之下）。
 * - GET  /sessions/:id/media/jobs：会话任务历史（内存，最近 50 条；产物以交付件为持久真相）
 * - POST /sessions/:id/media/jobs：创建任务（启用连接 + 能力 + 输入校验在 MediaService 收口）
 * - GET  /media/jobs/:id、POST /media/jobs/:id/cancel、POST /media/jobs/:id/retry
 * - GET  /media/providers：启用中的媒体连接清单（全局；设置页媒体生成分组与生成面板共用）
 * 未装配 MediaService 时统一 503（与 MCP 路由未装配语义一致）。
 */
import { Router } from 'express'
import { z } from 'zod'
import type { Request } from 'express'
import type { AuthUser } from '../auth/service.js'
import type { ApiDeps } from './index.js'

const CapabilitySchema = z.enum(['text2image', 'image2image', 'text2video', 'image2video', 'firstlast2video'])

const CreateJobSchema = z.object({
  connectionId: z.string().min(1).optional(),
  capability: CapabilitySchema,
  model: z.string().optional(),
  prompt: z.string().min(1),
  negative: z.string().optional(),
  inputs: z
    .object({
      images: z.array(z.string()).max(4).optional(),
      firstFrame: z.string().optional(),
      lastFrame: z.string().optional(),
    })
    .optional(),
  params: z
    .object({
      width: z.number().int().min(64).max(4096).optional(),
      height: z.number().int().min(64).max(4096).optional(),
      steps: z.number().int().min(1).max(150).optional(),
      seed: z.number().int().optional(),
      duration: z.number().int().min(1).max(60).optional(),
      workflowId: z.string().optional(),
    })
    .optional(),
  canvasTarget: z.object({ x: z.number(), y: z.number() }).optional(),
})

export function createMediaRouter(deps: ApiDeps): Router {
  const router = Router()

  const requireService = (res: import('express').Response): boolean => {
    if (!deps.media) {
      res.status(503).json({ error: '媒体生成服务未装配' })
      return false
    }
    return true
  }

  /** M57：媒体任务守卫（任务 → 所属会话 → 归属）；跨用户一律 404 */
  const guardJob = (req: Request): { ok: true } | { ok: false } => {
    const job = deps.media!.get(req.params.id)
    if (!job) return { ok: false }
    const user = (req as Request & { user?: AuthUser }).user
    if (job.sessionId && !deps.access.canAccessSession(user, job.sessionId)) return { ok: false }
    return { ok: true }
  }

  router.get('/media/providers', (_req, res) => {
    if (!requireService(res)) return
    res.json({ providers: deps.media!.providersOf() })
  })

  router.get('/sessions/:id/media/jobs', (req, res) => {
    if (!requireService(res)) return
    if (!deps.sessions.getSession(req.params.id)) return res.status(404).json({ error: '会话不存在' })
    res.json({ jobs: deps.media!.list(req.params.id) })
  })

  router.post('/sessions/:id/media/jobs', (req, res) => {
    if (!requireService(res)) return
    const sessionId = req.params.id
    if (!deps.sessions.getSession(sessionId)) return res.status(404).json({ error: '会话不存在' })
    const parsed = CreateJobSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      return res.status(400).json({ error: `生成参数非法：${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}` })
    }
    const result = deps.media!.create(sessionId, 'user', parsed.data)
    if ('error' in result) return res.status(400).json({ error: result.error })
    res.json({ job: result.job })
  })

  router.get('/media/jobs/:id', (req, res) => {
    if (!requireService(res)) return
    if (!guardJob(req)) return res.status(404).json({ error: '任务不存在' })
    const job = deps.media!.get(req.params.id)
    res.json({ job })
  })

  router.post('/media/jobs/:id/cancel', (req, res) => {
    if (!requireService(res)) return
    if (!guardJob(req)) return res.status(404).json({ error: '任务不存在' })
    const result = deps.media!.cancel(req.params.id)
    if ('error' in result) return res.status(400).json({ error: result.error })
    res.json({ job: result.job })
  })

  router.post('/media/jobs/:id/retry', (req, res) => {
    if (!requireService(res)) return
    if (!guardJob(req)) return res.status(404).json({ error: '任务不存在' })
    const result = deps.media!.retry(req.params.id)
    if ('error' in result) return res.status(400).json({ error: result.error })
    res.json({ job: result.job })
  })

  return router
}

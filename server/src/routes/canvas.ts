/**
 * M31：无限画布路由（挂载于 /api 之下）。
 * - GET  /sessions/:id/canvas：画布文档（空白文档兜底）+ mediaBound（全局是否有启用中的媒体连接）
 * - PUT  /sessions/:id/canvas：用户保存（乐观锁 baseVersion；409 回传服务端最新版）
 * - POST /sessions/:id/media/upload：素材直传（raw 二进制，body 上限由 index.ts 的 express.raw 控制）
 * - POST /sessions/:id/canvas/mind：脑图生成（P4 接入 LLM 结构化；路由在本模块统一维护）
 *
 * 素材落盘：workspace/<sid>/canvas/media/up-<ts>-<slug>.<ext>（成为普通交付件，artifact:updated 广播）
 */
import fs from 'node:fs'
import path from 'node:path'
import { Router } from 'express'
import { z } from 'zod'
import type { CanvasDoc, CanvasNode, CanvasEdge } from '@multi-agent/shared'
import type { ApiDeps } from './index.js'
import { CanvasDocConflictError } from '../canvas/store.js'

/** 上传白名单扩展名（图片 / 视频；与前端拖拽上传口径一致） */
const UPLOAD_IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.svg'])
const UPLOAD_VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.m4v'])
const UPLOAD_MAX_BYTES = 200 * 1024 * 1024

/** PUT 文档校验（nodes / edges 结构宽松校验，深层 data 由 store sanitize 兜底） */
const CanvasSaveSchema = z.object({
  baseVersion: z.number().int().min(0),
  viewport: z.object({ x: z.number(), y: z.number(), zoom: z.number().min(0.05).max(10) }),
  nodes: z.array(z.unknown()).max(2000),
  edges: z.array(z.unknown()).max(4000),
})

/** 脑图生成请求（source 五来源；topic 仅自定义主题时携带） */
const MindRequestSchema = z.object({
  source: z.enum(['conversation', 'plans', 'tasks', 'memory', 'topic']),
  topic: z.string().trim().max(200).optional(),
})

function isSessionMissing(deps: ApiDeps, id: string): boolean {
  return !deps.sessions.getSession(id)
}

/** 全局是否有启用中的媒体连接（生成面板引导共用；媒体生成为全局配置，不区分会话） */
function mediaBound(deps: ApiDeps): boolean {
  return deps.connections.list().some((c) => c.kind === 'media' && c.enabled)
}

/** 文件名 slug 化（保留中英文与数字，其余折叠为连字符） */
function slugify(name: string): string {
  const base = name.replace(/\.[^.]+$/, '')
  const slug = base
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug || 'file'
}

export function createCanvasRouter(deps: ApiDeps): Router {
  const router = Router()

  router.get('/sessions/:id/canvas', (req, res) => {
    if (isSessionMissing(deps, req.params.id)) return res.status(404).json({ error: '会话不存在' })
    if (!deps.canvas) return res.status(503).json({ error: '画布存储未装配' })
    res.json({ doc: deps.canvas.get(req.params.id), mediaBound: mediaBound(deps) })
  })

  router.put('/sessions/:id/canvas', (req, res) => {
    const sessionId = req.params.id
    if (isSessionMissing(deps, sessionId)) return res.status(404).json({ error: '会话不存在' })
    if (!deps.canvas) return res.status(503).json({ error: '画布存储未装配' })
    const parsed = CanvasSaveSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      return res.status(400).json({ error: `画布保存参数非法：${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}` })
    }
    try {
      const doc = deps.canvas.save(
        sessionId,
        {
          nodes: parsed.data.nodes as CanvasNode[],
          edges: parsed.data.edges as CanvasEdge[],
          viewport: parsed.data.viewport,
        },
        parsed.data.baseVersion,
      )
      res.json({ doc })
    } catch (err) {
      if (err instanceof CanvasDocConflictError) {
        return res.status(409).json({ error: err.message, doc: err.current })
      }
      throw err
    }
  })

  // ---------- 素材直传（raw 二进制；body 已由 index.ts 的 express.raw 解析为 Buffer） ----------
  router.post('/sessions/:id/media/upload', (req, res) => {
    const sessionId = req.params.id
    if (isSessionMissing(deps, sessionId)) return res.status(404).json({ error: '会话不存在' })
    const body = req.body as unknown
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return res.status(400).json({ error: '请求体为空：请以 raw 二进制上传文件内容' })
    }
    if (body.length > UPLOAD_MAX_BYTES) {
      return res.status(413).json({ error: '文件过大：单文件上限 200MB' })
    }
    // M57 P3：存储配额闸门（工作区体积 + 本次增量；超限 403）
    if (deps.quotas) {
      try {
        deps.quotas.assertUploadAllowed(sessionId, body.length)
      } catch (err) {
        const status = typeof (err as { status?: number }).status === 'number' ? (err as { status: number }).status : 403
        return res.status(status).json({ error: (err as Error).message })
      }
    }
    const rawName = decodeURIComponent(String(req.header('x-file-name') ?? 'file'))
    const ext = path.extname(rawName).toLowerCase()
    const kind = UPLOAD_IMAGE_EXT.has(ext) ? 'image' : UPLOAD_VIDEO_EXT.has(ext) ? 'video' : undefined
    if (!kind) {
      return res.status(400).json({ error: `不支持的文件类型：${ext || '（无扩展名）'}（仅图片 / 视频）` })
    }
    const dir = path.join(deps.artifacts.ensureSessionDir(sessionId), 'canvas', 'media')
    fs.mkdirSync(dir, { recursive: true })
    const relPath = `canvas/media/up-${Date.now().toString(36)}-${slugify(rawName)}${ext}`
    fs.writeFileSync(path.join(deps.artifacts.sessionDir(sessionId), relPath), body)
    deps.index.upsert(sessionId, [{ path: relPath, origin: 'canvas' }])
    deps.notify.publish({
      type: 'notify:artifact-updated',
      sessionId,
      payload: { path: relPath },
    })
    res.json({ path: relPath, kind, size: body.length })
  })

  // ---------- 脑图生成（LLM 结构化；只读调用，落画布由前端 canvas-store 收口） ----------
  router.post('/sessions/:id/canvas/mind', async (req, res) => {
    const sessionId = req.params.id
    if (isSessionMissing(deps, sessionId)) return res.status(404).json({ error: '会话不存在' })
    if (!deps.mind) return res.status(503).json({ error: '脑图生成未装配' })
    const parsed = MindRequestSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      return res.status(400).json({ error: '脑图生成参数非法：source 应为 conversation / plans / tasks / memory / topic' })
    }
    const { source, topic } = parsed.data
    if (source === 'topic' && !topic) return res.status(400).json({ error: '自定义主题来源需填写 topic' })
    const result = await deps.mind.generate({ sessionId, source, topic })
    if (!result.ok) {
      // 422：来源无内容 / 输出不可用（用户可换来源或重试）；502：模型调用失败（基础设施问题）
      return res.status(result.code === 'llm' ? 502 : 422).json({ error: result.error })
    }
    res.json({ tree: result.tree, source })
  })

  return router
}

/** 导出校验白名单供测试与工具复用（上传扩展名口径） */
export const CANVAS_UPLOAD_EXT = { image: UPLOAD_IMAGE_EXT, video: UPLOAD_VIDEO_EXT }

/** 类型辅助：文档空态（测试构造用） */
export function blankCanvasDoc(sessionId: string): CanvasDoc {
  return {
    v: 1,
    sessionId,
    version: 1,
    updatedAt: new Date().toISOString(),
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    edges: [],
  }
}

/**
 * M68：用户素材库路由（/api/library/*）—— per-user 私人素材（独立菜单管理页面的服务端面）。
 *
 * - 归属：owner 一律服务端取（登录身份；单用户兼容模式固定 'local'）——不信请求体（同 ADR 0148 纪律）；
 * - POST /api/library/uploads：raw 二进制上传（index.ts 注册 express.raw ≤200mb；x-file-name 携原名）；
 * - GET  /api/library/items：列表（query 对展示名子串 / kind 筛选 / limit ≤200）；
 * - GET  /api/library/items/:id/content：内容流（res.sendFile 原生 Range / 206；MIME 白名单）；
 * - POST /api/library/items/:id/to-canvas：copy-on-use 入仓（返回会话工作区相对路径，前端 sendArtifact 落节点）；
 * - DELETE /api/library/items/:id：删除（行 + 文件双清）；
 * - GET  /api/library/usage：容量（条数 / 字节 / 配额上限）。
 */
import path from 'node:path'
import { Router } from 'express'
import type { Request } from 'express'
import { z } from 'zod'
import type { LibraryItem } from '@multi-agent/shared'
import type { AuthUser } from '../auth/service.js'
import type { MaterialRecord, MaterialSource, MaterialKind } from '../store/materials.js'
import type { ApiDeps } from './index.js'

/** 单用户兼容模式 owner 段（无账号体系时素材归入本段；与多用户 u_<uid> 同构） */
export const LOCAL_OWNER = 'local'

function toItem(record: MaterialRecord): LibraryItem {
  return {
    id: record.id,
    name: record.name,
    kind: record.kind as MaterialKind,
    ext: record.ext,
    mime: record.mime,
    sizeBytes: record.sizeBytes,
    source: record.source as MaterialSource,
    createdAt: record.createdAt,
  }
}

export function createLibraryRouter(deps: ApiDeps): Router {
  const router = Router()

  /** 未装配（测试 / 裁剪部署）→ 503（与其他未装配服务同语义） */
  const requireService = (res: import('express').Response): boolean => {
    if (!deps.library) {
      res.status(503).json({ error: '素材库服务未装配' })
      return false
    }
    return true
  }

  const userOf = (req: Request): AuthUser | undefined => (req as Request & { user?: AuthUser }).user
  /** owner 口径：登录身份；兼容模式固定 'local' */
  const ownerOf = (req: Request): string => userOf(req)?.id ?? LOCAL_OWNER

  router.get('/library/items', (req, res) => {
    if (!requireService(res)) return
    const query = typeof req.query.query === 'string' ? req.query.query : undefined
    const kindRaw = typeof req.query.kind === 'string' ? req.query.kind : ''
    const kind = kindRaw === 'image' || kindRaw === 'video' || kindRaw === 'audio' ? kindRaw : undefined
    const limit = Number(req.query.limit ?? 60)
    const items = deps.library!.list(ownerOf(req), { query, kind, limit: Number.isFinite(limit) ? limit : 60 })
    res.json({ items: items.map(toItem) })
  })

  router.get('/library/usage', (req, res) => {
    if (!requireService(res)) return
    const user = userOf(req)
    const { count, bytes } = deps.library!.usageOf(ownerOf(req))
    // 容量上限：多用户命中配额（兼容模式 / 未配置 = 不限）
    const limitMb = user && deps.quotas ? deps.quotas.limitsOf(user.id).maxStorageMb : undefined
    res.json({ usage: { count, bytes, limitMb } })
  })

  router.post('/library/uploads', (req, res) => {
    if (!requireService(res)) return
    const body = req.body as unknown
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return res.status(400).json({ error: '请求体为空：请以 raw 二进制上传文件内容' })
    }
    const rawName = decodeURIComponent(String(req.header('x-file-name') ?? 'file'))
    const result = deps.library!.upload(ownerOf(req), { name: rawName, buffer: body })
    if ('error' in result) {
      const status = result.error.includes('存储空间不足') ? 403 : 400
      return res.status(status).json({ error: result.error })
    }
    res.json({ item: toItem(result) })
  })

  router.get('/library/items/:id/content', (req, res) => {
    if (!requireService(res)) return
    const found = deps.library!.contentOf(ownerOf(req), req.params.id)
    if (!found) return res.status(404).json({ error: '素材不存在' })
    res.type(found.record.mime ?? 'application/octet-stream')
    // sendFile 原生支持 Range / 206 / Accept-Ranges（与交付件内容流同模式）
    res.sendFile(path.resolve(found.abs))
  })

  const ToCanvasSchema = z.object({ sessionId: z.string().min(1) })
  router.post('/library/items/:id/to-canvas', (req, res) => {
    if (!requireService(res)) return
    const parsed = ToCanvasSchema.safeParse(req.body ?? {})
    if (!parsed.success) return res.status(400).json({ error: '参数校验失败：需要 sessionId' })
    // M79-AF：入仓 = 向会话工作区拷贝文件（与附件上传同族的写操作）——viewer 写闸门；
    // 不可读 → 404 不泄漏（admin 无归属旁路，M79-G 隐私语义）；兼容模式全放行
    if (deps.access.multiUser) {
      const user = userOf(req)
      if (deps.access.sessionRole(user, parsed.data.sessionId) === undefined) {
        return res.status(404).json({ error: '会话不存在' })
      }
      if (!deps.access.canWriteSession(user, parsed.data.sessionId)) {
        return res.status(403).json({ error: '当前为只读共享（viewer）：无操作权限' })
      }
    }
    const result = deps.library!.toSession(ownerOf(req), req.params.id, parsed.data.sessionId)
    if ('error' in result) return res.status(404).json({ error: result.error })
    res.json(result)
  })

  router.delete('/library/items/:id', (req, res) => {
    if (!requireService(res)) return
    const removed = deps.library!.remove(ownerOf(req), req.params.id)
    if (!removed) return res.status(404).json({ error: '素材不存在' })
    res.json({ ok: true })
  })

  return router
}

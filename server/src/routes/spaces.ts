/**
 * 空间 CRUD（Space）：工作生活一体的一级信息架构（docs/work-life-fusion-design.md）。
 *
 * - 内置三空间（default / work / life）：名称 / 图标 / 排序可改、不可删除；对所有人可见；
 * - 自建空间**用户级隔离**（P4）：多用户 = 仅创建者可见 / 可改 / 可删（非属主一律 404，
 *   不暴露存在性）；兼容模式归属 'local'；迁移前历史自建（owner 为空）仅 admin 可改删；
 * - 删除空间不删除会话（外键置空回「我的」语义），响应附 sessionsDetached 供前端提示。
 */
import { Router } from 'express'
import type { Request, Response } from 'express'
import type { AuthUser } from '../auth/service.js'
import { createSpaceSchema, firstIssue, patchSpaceSchema } from './schemas.js'
import type { ApiDeps } from './index.js'

export function createSpacesRouter(deps: ApiDeps): Router {
  const router = Router()

  /** 空间存储缺省（测试夹具未装配）= 路由不挂载，行为与现状零差异 */
  const spaces = deps.spaces
  if (!spaces) return router

  const userOf = (req: Request): AuthUser | undefined => (req as Request & { user?: AuthUser }).user
  /** 归属口径：多用户 = 登录用户；兼容模式 = 'local'（与素材库 / 仪式订阅同族） */
  const ownerOf = (req: Request): string => (deps.access.multiUser ? (userOf(req)?.id ?? '') : 'local')
  /**
   * 自建空间写操作归属校验（内置放行——名称 / 图标 / 排序为展示元数据）：
   * 非属主一律 404（不暴露存在性）；迁移前历史遗留（owner 为空）仅 admin 可改删。
   */
  const assertManageable = (req: Request, res: Response, id: string): boolean => {
    const space = spaces.get(id)
    if (!space) {
      res.status(404).json({ error: '空间不存在' })
      return false
    }
    if (space.builtin || !deps.access.multiUser) return true
    const uid = userOf(req)?.id ?? ''
    const owner = spaces.ownerOf(id)
    if (owner && owner === uid) return true
    if (!owner && userOf(req)?.role === 'admin') return true
    res.status(404).json({ error: '空间不存在' })
    return false
  }

  router.get('/spaces', (req, res) => {
    res.json({ spaces: spaces.listForUser(ownerOf(req)) })
  })

  router.post('/spaces', (req, res) => {
    const parsed = createSpaceSchema.safeParse(req.body ?? {})
    if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) })
    try {
      const space = spaces.create(parsed.data, ownerOf(req))
      res.status(201).json({ space })
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  router.patch('/spaces/:id', (req, res) => {
    if (!assertManageable(req, res, req.params.id)) return
    const parsed = patchSpaceSchema.safeParse(req.body ?? {})
    if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) })
    try {
      const space = spaces.update(req.params.id, parsed.data)
      if (!space) return res.status(404).json({ error: '空间不存在' })
      res.json({ space })
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  router.delete('/spaces/:id', (req, res) => {
    if (!assertManageable(req, res, req.params.id)) return
    try {
      const { removed, sessionsDetached } = spaces.remove(req.params.id)
      if (!removed) return res.status(404).json({ error: '空间不存在' })
      res.json({ ok: true, sessionsDetached })
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  return router
}

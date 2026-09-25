/**
 * P4：仪式订阅路由（/api/rituals，本人资源）。
 *
 * - GET 列表 / POST 订阅 / DELETE 退订——服务端从场景 `_group.yaml` 声明取
 *   title / cron / opener / members（**不信任客户端**，请求体只收 sceneId 与 spaceId）；
 * - 归属：多用户 = 登录用户（跨用户一律 404，store 层 WHERE user_id 兜底）；
 *   兼容模式 = 'local'（与素材库同口径）；
 * - 未装配（deps.schedules 缺省 / 测试夹具）= 503，与 /schedules 路由同口径。
 */
import { Router } from 'express'
import type { Request } from 'express'
import type { AuthUser } from '../auth/service.js'
import type { ApiDeps } from './index.js'

export function createRitualsRouter(deps: ApiDeps): Router {
  const router = Router()

  const userOf = (req: Request): AuthUser | undefined => (req as Request & { user?: AuthUser }).user
  /** 订阅归属：多用户 = 登录用户；兼容模式 = 'local' */
  const ritualUserIdOf = (req: Request): string => (deps.access.multiUser ? (userOf(req)?.id ?? '') : 'local')

  router.use((_req, res, next) => {
    if (!deps.schedules) return res.status(503).json({ error: '仪式订阅未装配' })
    next()
  })

  router.get('/rituals', (req, res) => {
    const userId = ritualUserIdOf(req)
    if (!userId) return res.status(401).json({ error: '未登录' })
    res.json({ rituals: deps.schedules!.listRituals(userId) })
  })

  router.post('/rituals', (req, res) => {
    const userId = ritualUserIdOf(req)
    if (!userId) return res.status(401).json({ error: '未登录' })
    const body = (req.body ?? {}) as { sceneId?: unknown; ritualId?: unknown; spaceId?: unknown }
    const sceneId = typeof body.sceneId === 'string' ? body.sceneId.trim() : ''
    const ritualId = typeof body.ritualId === 'string' ? body.ritualId.trim() : ''
    if (!sceneId && !ritualId) return res.status(400).json({ error: 'sceneId 或 ritualId 必填' })
    const spaceId = typeof body.spaceId === 'string' ? body.spaceId : undefined
    const result = ritualId
      ? deps.schedules!.subscribeRitual(userId, ritualId, { spaceId, source: 'system' })
      : deps.schedules!.subscribeRitual(userId, sceneId, { spaceId })
    if (!result.ok || !result.subscription) return res.status(400).json({ error: result.error ?? '订阅失败' })
    res.status(201).json({ ritual: result.subscription })
  })

  router.delete('/rituals/:id', (req, res) => {
    const userId = ritualUserIdOf(req)
    if (!userId) return res.status(401).json({ error: '未登录' })
    const result = deps.schedules!.unsubscribeRitual(userId, req.params.id)
    if (!result.ok) return res.status(404).json({ error: result.error ?? '订阅不存在' })
    res.json({ ok: true })
  })

  router.patch('/rituals/:id', (req, res) => {
    const userId = ritualUserIdOf(req)
    if (!userId) return res.status(401).json({ error: '未登录' })
    const body = (req.body ?? {}) as { enabled?: unknown; cron?: unknown }
    const patch: { enabled?: boolean; cron?: string } = {}
    if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
    if (typeof body.cron === 'string') patch.cron = body.cron
    const result = deps.schedules!.updateRitual(userId, req.params.id, patch)
    if (!result.ok || !result.subscription) return res.status(400).json({ error: result.error ?? '更新失败' })
    res.json({ ritual: result.subscription })
  })

  return router
}

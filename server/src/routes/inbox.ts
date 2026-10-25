/**
 * M79-A：收件箱与已读（设计 §9.2–9.4）。
 *
 * 端点：
 * - GET  /api/inbox?since=&limit=   收件箱增量（本人；游标 / 未读总数）
 * - POST /api/inbox/read            {"ids":[…] | "upTo":N} 单项 / 整段已读
 * - POST /api/sessions/:id/read     {"seq":N} 会话已读上报（读级权限：viewer 亦可；WS 断线时的 REST 通道）
 *
 * 说明：本路由挂载在会话守卫之前（/sessions/:id/read 需读级放行，不参与写守卫——viewer 也应能清未读）；
 * 已读广播经 publishRead 注入（NotifyHub.publishToUser；多端同步；不向对方回执）。
 */
import { Router } from 'express'
import type { Request } from 'express'
import { z } from 'zod'
import type { AuthUser } from '../auth/service.js'
import type { AuthService } from '../auth/service.js'
import type { AccessService } from '../auth/access.js'
import type { InboxStore } from '../store/inbox.js'
import type { SessionReadsStore } from '../store/session-reads.js'
import { firstIssue } from './schemas.js'

const readBodySchema = z.object({ seq: z.number().int().min(0) })
const inboxReadSchema = z
  .object({
    ids: z.array(z.string().min(1)).max(500).optional(),
    upTo: z.number().int().min(0).optional(),
  })
  .refine((v) => v.ids !== undefined || v.upTo !== undefined, 'ids 或 upTo 至少提供一项')

export interface InboxRouterDeps {
  inbox: InboxStore
  reads: SessionReadsStore
  access: AccessService
  auth: AuthService
  /** 已读广播（多端同步；缺省 = 不广播（测试 / 未装配）） */
  publishRead?: (userId: string, sessionId: string, lastReadSeq: number) => void
  /** M80-C：已读对外展示开关（缺省 = 不广播回执，与 M79 行为一致） */
  readReceiptAllowed?: (userId: string) => boolean
  /** M80-C：已读回执会话主题广播（对等原则——仅开关开启者投影给他人） */
  publishReceipt?: (userId: string, sessionId: string, lastReadSeq: number) => void
  /** IM：会话个人偏好（读到最新后解除「标记未读」） */
  sessionPrefs?: import('../store/session-prefs.js').SessionPrefsStore
  /** IM：偏好变更多端广播 */
  publishPrefs?: (userId: string, sessionId: string, prefs: import('@multi-agent/shared').SessionPrefs) => void
}

export function createInboxRouter(deps: InboxRouterDeps): Router {
  const router = Router()
  const userOf = (req: Request): AuthUser | undefined => (req as Request & { user?: AuthUser }).user

  /** 收件箱增量（本人；actorName 随行投影） */
  router.get('/inbox', (req, res) => {
    const me = userOf(req)
    if (!me) return res.json({ items: [], cursor: 0, unreadCount: 0 }) // 兼容模式无收件箱
    const since = Number(req.query.since ?? 0)
    const limit = Number(req.query.limit ?? 200)
    const floor = Number.isSafeInteger(since) && since > 0 ? since : 0
    const pageSize = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 500) : 200
    const page = deps.inbox.listSince(me.id, floor, pageSize + 1)
    const hasMore = page.length > pageSize
    const items = page.slice(0, pageSize)
    const nextCursor = items.at(-1)?.seq ?? floor
    const actorIds = [...new Set(items.map((i) => i.actorId).filter((x): x is string => !!x))]
    const names = new Map(actorIds.map((id) => [id, deps.auth.getUser(id)?.displayName]))
    const projected = items.map((i) => {
      const name = i.actorId ? names.get(i.actorId) : undefined
      return name ? { ...i, actorName: name } : i
    })
    res.json({ items: projected, cursor: nextCursor, nextCursor, hasMore, unreadCount: deps.inbox.unreadCount(me.id) })
  })

  /** 单项 / 整段已读（幂等） */
  router.post('/inbox/read', (req, res) => {
    const me = userOf(req)
    if (!me) return res.json({ ok: true, changed: 0 })
    const parsed = inboxReadSchema.safeParse(req.body ?? {})
    if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) })
    let changed = 0
    if (parsed.data.ids) changed += deps.inbox.markRead(me.id, parsed.data.ids)
    if (typeof parsed.data.upTo === 'number') changed += deps.inbox.markReadUpTo(me.id, parsed.data.upTo)
    res.json({ ok: true, changed })
  })

  /** 会话已读上报（读级放行：viewer 亦可；WS 在线时通常走 WS `read` 帧，此端点供降级路径） */
  router.post('/sessions/:id/read', (req, res) => {
    const me = userOf(req)
    const session = deps.access.assertSession(me, req.params.id)
    const parsed = readBodySchema.safeParse(req.body ?? {})
    if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) })
    if (!me) return res.json({ ok: true, lastReadSeq: 0 }) // 兼容模式：无账号（无未读语义）
    const lastReadSeq = deps.reads.set(me.id, session.id, parsed.data.seq)
    // IM：真实读到消息后解除「标记未读」（标记是提醒，不是永久状态）
    if (lastReadSeq > 0 && deps.sessionPrefs?.get(me.id, session.id).markedUnread) {
      const prefs = deps.sessionPrefs.set(me.id, session.id, { markedUnread: false })
      deps.publishPrefs?.(me.id, session.id, prefs)
    }
    deps.publishRead?.(me.id, session.id, lastReadSeq)
    // M80-C：REST 降级路径同样广播已读回执（对等原则：关闭开关者不投影）
    if (deps.readReceiptAllowed?.(me.id)) deps.publishReceipt?.(me.id, session.id, lastReadSeq)
    res.json({ ok: true, lastReadSeq })
  })

  return router
}

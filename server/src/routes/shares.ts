/**
 * M57 P2：会话共享接口（`/sessions/:id/shares` + `/sessions/:id/leave`）。
 *
 * 权限（聚合层会话守卫已做读写闸门，此处做属主级校验）：
 * - 查看共享列表：任何可见者（owner / editor / viewer）；
 * - 邀请 / 改角色 / 移出：仅会话属主；
 * - 自助退出（/leave）：共享成员本人（viewer 亦可；属主不可退出，需删除会话）。
 *
 * 副作用：审计（session.share-*）+ 广播（notify:share-changed，payload: { sessionId, userId, role?, action }）。
 * 单用户兼容模式（owners 为空）：共享无意义 → 400 拒绝写操作。
 */
import { Router } from 'express'
import type { Request } from 'express'
import { z } from 'zod'
import type { SessionShare } from '@multi-agent/shared'
import type { AccessService } from '../auth/access.js'
import type { AuthService, AuthUser } from '../auth/service.js'
import type { AuditStore } from '../store/audit.js'
import type { SessionMemberStore } from '../store/session-members.js'
import { HttpError } from '../util/http-error.js'
import { firstIssue } from './schemas.js'

const inviteSchema = z.object({
  username: z.string().trim().min(1, 'username 必填').max(32),
  role: z.enum(['editor', 'viewer']).default('editor'),
})

const patchSchema = z.object({ role: z.enum(['editor', 'viewer']) })

export interface SharesRouterDeps {
  access: AccessService
  auth: AuthService
  members: SessionMemberStore
  audit: AuditStore
  /** 变更广播（notify:share-changed；测试可缺省） */
  publish?: (sessionId: string, userId: string, action: string, role?: string) => void
}

/** 共享面板投影：属主（基础信息）+ 成员（含角色 / 邀请人 / 用户名 / 昵称） */
interface SharesView {
  owner?: { userId: string; username: string; displayName: string }
  members: SessionShare[]
}

export function createSharesRouter(deps: SharesRouterDeps): Router {
  const router = Router()
  const userOf = (req: Request): AuthUser | undefined => (req as Request & { user?: AuthUser }).user
  const actorOf = (req: Request): { userId?: string; ip?: string } => ({
    userId: userOf(req)?.id,
    ip: req.ip,
  })

  /** 共享面板数据（属主 + 成员；仅可见者） */
  const build = (sessionId: string, ownerId: string | undefined): SharesView => {
    const owner = ownerId ? deps.auth.getUser(ownerId) : undefined
    const members = deps.members.list(sessionId).map((record): SessionShare => {
      const user = deps.auth.getUser(record.userId)
      return {
        userId: record.userId,
        username: user?.username ?? '（已删除）',
        displayName: user?.displayName ?? '（已删除）',
        role: record.role,
        invitedBy: record.invitedBy,
        createdAt: record.createdAt,
      }
    })
    return {
      owner: owner ? { userId: owner.id, username: owner.username, displayName: owner.displayName } : undefined,
      members,
    }
  }

  /** 查看：任何可见者 */
  router.get('/sessions/:id/shares', (req, res) => {
    const session = deps.access.assertSession(userOf(req), req.params.id)
    res.json(build(req.params.id, session.ownerId))
  })

  /** 邀请（仅属主）：按用户名；目标须存在、非本人、非属主、未在成员中 */
  router.post('/sessions/:id/shares', (req, res) => {
    const me = userOf(req)
    const session = deps.access.assertSessionOwner(me, req.params.id)
    if (!deps.access.multiUser) return res.status(400).json({ error: '多用户未启用：共享会话需先完成管理员设置' })
    const parsed = inviteSchema.safeParse(req.body ?? {})
    if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) })
    const target = deps.auth.getUserByUsername(parsed.data.username)
    if (!target) return res.status(404).json({ error: '账号不存在（请让管理员先在用户管理中创建）' })
    if (target.id === me?.id) return res.status(400).json({ error: '不能邀请自己（你已是属主）' })
    if (target.id === session.ownerId) return res.status(400).json({ error: '该账号已是会话属主' })
    if (deps.members.has(req.params.id, target.id)) {
      return res.status(409).json({ error: '该账号已在共享成员中（可修改其角色）' })
    }
    deps.members.upsert(req.params.id, target.id, parsed.data.role, me?.id)
    deps.audit.record({
      actor: 'user',
      action: 'session.share-add',
      userId: me?.id,
      ip: actorOf(req).ip,
      resourceType: 'session',
      resourceId: req.params.id,
      sessionId: req.params.id,
      detail: { targetUserId: target.id, role: parsed.data.role },
    })
    deps.publish?.(req.params.id, target.id, 'added', parsed.data.role)
    res.status(201).json(build(req.params.id, session.ownerId))
  })

  /** 改角色（仅属主） */
  router.patch('/sessions/:id/shares/:userId', (req, res) => {
    const me = userOf(req)
    const session = deps.access.assertSessionOwner(me, req.params.id)
    const parsed = patchSchema.safeParse(req.body ?? {})
    if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) })
    const record = deps.members.get(req.params.id, req.params.userId)
    if (!record) return res.status(404).json({ error: '该账号不在共享成员中' })
    deps.members.upsert(req.params.id, req.params.userId, parsed.data.role, record.invitedBy)
    deps.audit.record({
      actor: 'user',
      action: 'session.share-update',
      userId: me?.id,
      ip: actorOf(req).ip,
      resourceType: 'session',
      resourceId: req.params.id,
      sessionId: req.params.id,
      detail: { targetUserId: req.params.userId, role: parsed.data.role },
    })
    deps.publish?.(req.params.id, req.params.userId, 'role', parsed.data.role)
    res.json(build(req.params.id, session.ownerId))
  })

  /** 移出（仅属主） */
  router.delete('/sessions/:id/shares/:userId', (req, res) => {
    const me = userOf(req)
    const session = deps.access.assertSessionOwner(me, req.params.id)
    if (!deps.members.remove(req.params.id, req.params.userId)) {
      return res.status(404).json({ error: '该账号不在共享成员中' })
    }
    deps.audit.record({
      actor: 'user',
      action: 'session.share-remove',
      userId: me?.id,
      ip: actorOf(req).ip,
      resourceType: 'session',
      resourceId: req.params.id,
      sessionId: req.params.id,
      detail: { targetUserId: req.params.userId },
    })
    deps.publish?.(req.params.id, req.params.userId, 'removed')
    res.json(build(req.params.id, session.ownerId))
  })

  /** 自助退出（成员本人；viewer 亦可——会话守卫已放行 /leave） */
  router.post('/sessions/:id/leave', (req, res) => {
    const me = userOf(req)
    const session = deps.access.assertSession(me, req.params.id)
    if (!deps.access.multiUser) return res.status(400).json({ error: '多用户未启用：无共享语义' })
    if (!me) throw new HttpError(401, '未登录或登录已失效：请登录后重试')
    if (session.ownerId === me.id) return res.status(400).json({ error: '会话属主不能退出共享（可删除会话）' })
    if (!deps.members.remove(req.params.id, me.id)) {
      return res.status(404).json({ error: '你不在该会话的共享成员中' })
    }
    deps.audit.record({
      actor: 'user',
      action: 'session.share-leave',
      userId: me.id,
      ip: actorOf(req).ip,
      resourceType: 'session',
      resourceId: req.params.id,
      sessionId: req.params.id,
    })
    deps.publish?.(req.params.id, me.id, 'left')
    res.json({ ok: true })
  })

  return router
}

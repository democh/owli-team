/**
 * M57 P2：会话共享接口（`/sessions/:id/shares` + `/sessions/:id/leave`）。
 *
 * 权限（聚合层会话守卫已做读写闸门，此处做属主级校验）：
 * - 查看共享列表：任何可见者（owner / editor / viewer）；
 * - 邀请 / 改角色 / 移出：仅会话属主（群聊邀请放宽为任何成员，见下）；
 * - 自助退出（/leave）：共享成员本人（viewer 亦可；属主不可退出，需解散 / 删除会话）；
 * - 私聊（direct）不支持退出（设计 §12.2：只有隐藏；对方不受影响）。
 *
 * 副作用：审计（session.share-*）+ 广播（notify:share-changed，payload: { sessionId, userId, role?, action }）
 * + 系统事件条留痕（appendSystem：退出 / 移出，非 direct；群聊「退出了群聊」通稿）。
 * 单用户兼容模式（owners 为空）：共享无意义 → 400 拒绝写操作。
 */
import { Router } from 'express'
import type { Request } from 'express'
import { z } from 'zod'
import type { UserAvatar, SessionShare } from '@multi-agent/shared'
import type { AccessService } from '../auth/access.js'
import type { AuthService, AuthUser } from '../auth/service.js'
import type { AuditStore } from '../store/audit.js'
import type { FriendStore } from '../store/friends.js'
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
  /** M79：被邀请人收件箱投递（写库 + 用户主题实时帧——修复 M57 P2「刷新才发现」缺口） */
  deliver?: (input: {
    userId: string
    /** M79-AE：'system' 用于移出等系统通知 */
    type: 'session-invite' | 'system'
    title: string
    body?: string
    sessionId?: string
    actorId?: string
    payload?: Record<string, unknown>
  }) => void
  /** M79-D：好友关系存储（群聊邀请「限邀请者好友」判定；缺省 = 不限制，测试兼容） */
  friends?: FriendStore
  /** M79-E：成员移除钩子（持球方清洗 + session-meta 广播；缺省 = 跳过） */
  onMemberRemoved?: (sessionId: string, userId: string) => void
  /**
   * M79-AA 群管理补全：退出 / 移出留痕——append 一条 system 事件条并广播（群聊语义闭环；
   * 非 direct 会话调用；缺省 = 跳过，测试兼容）。
   */
  appendSystem?: (sessionId: string, content: string) => void
}

/** 共享面板投影：属主（基础信息）+ 成员（含角色 / 邀请人 / 用户名 / 昵称 / M79-B 画像） */
interface SharesView {
  owner?: { userId: string; username: string; displayName: string; headline?: string; avatar?: UserAvatar }
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
        // M79-B：画像随行投影（缺省 = 未设置；前端回退首字母头像）
        ...(user?.headline ? { headline: user.headline } : {}),
        ...(user?.avatar ? { avatar: user.avatar } : {}),
        role: record.role,
        invitedBy: record.invitedBy,
        createdAt: record.createdAt,
      }
    })
    return {
      owner: owner
        ? {
            userId: owner.id,
            username: owner.username,
            displayName: owner.displayName,
            ...(owner.headline ? { headline: owner.headline } : {}),
            ...(owner.avatar ? { avatar: owner.avatar } : {}),
          }
        : undefined,
      members,
    }
  }

  /** 查看：任何可见者 */
  router.get('/sessions/:id/shares', (req, res) => {
    const session = deps.access.assertSession(userOf(req), req.params.id)
    res.json(build(req.params.id, session.ownerId))
  })

  /**
   * 邀请（团队会话：仅属主；M79-D 群聊：任何成员可邀请自己的好友——role 恒 editor）。
   * 目标须存在、非本人、非属主、未在成员中；群聊另限「邀请者好友」。
   */
  router.post('/sessions/:id/shares', (req, res) => {
    const me = userOf(req)
    const session = deps.access.assertSession(me, req.params.id)
    const isGroup = session.kind === 'group'
    if (isGroup) {
      deps.access.assertSessionWrite(me, req.params.id)
    } else {
      deps.access.assertSessionOwner(me, req.params.id)
    }
    if (!deps.access.multiUser) return res.status(400).json({ error: '多用户未启用：共享会话需先完成管理员设置' })
    const parsed = inviteSchema.safeParse(req.body ?? {})
    if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) })
    const target = deps.auth.getUserByUsername(parsed.data.username)
    if (!target) return res.status(404).json({ error: '账号不存在（请让管理员先在用户管理中创建）' })
    if (target.id === me?.id) return res.status(400).json({ error: '不能邀请自己（你已是成员）' })
    if (target.id === session.ownerId) return res.status(400).json({ error: '该账号已是会话属主' })
    if (deps.members.has(req.params.id, target.id)) {
      return res.status(409).json({ error: '该账号已在共享成员中（可修改其角色）' })
    }
    if (isGroup && me && deps.friends && !deps.friends.areFriends(me.id, target.id)) {
      return res.status(403).json({ error: '仅可邀请自己的好友加入群聊' })
    }
    const role = isGroup ? ('editor' as const) : parsed.data.role
    deps.members.upsert(req.params.id, target.id, role, me?.id)
    deps.audit.record({
      actor: 'user',
      action: 'session.share-add',
      userId: me?.id,
      ip: actorOf(req).ip,
      resourceType: 'session',
      resourceId: req.params.id,
      sessionId: req.params.id,
      detail: { targetUserId: target.id, role },
    })
    deps.publish?.(req.params.id, target.id, 'added', role)
    // M79：邀请实时化——被邀请人收件箱（历史缺口：此前仅会话主题广播，被邀请人未订阅该会话）
    deps.deliver?.({
      userId: target.id,
      type: 'session-invite',
      title: `${me?.displayName ?? '成员'} 邀请你加入「${session.title}」`,
      sessionId: req.params.id,
      actorId: me?.id,
      payload: { role },
    })
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
    // M79-AE：被移出通知（收件箱 'system'；离线可见——访问权已失去，列表移除之外再给明确告知）
    deps.deliver?.({
      userId: req.params.userId,
      type: 'system',
      title: '你已被移出会话',
      sessionId: req.params.id,
      body: `「${session.title}」`,
    })
    // M79-E：移除成员 → 持球方清洗（waiting_on 移除该用户；session-meta 广播）
    deps.onMemberRemoved?.(req.params.id, req.params.userId)
    // M79-AA 群管理补全：移出留痕（群聊「移出了群聊」/ 团队「移出了协作」；direct 不适用）
    if (session.kind !== 'direct') {
      const targetName = deps.auth.getUser(req.params.userId)?.displayName ?? '成员'
      deps.appendSystem?.(
        req.params.id,
        `${me?.displayName ?? '成员'} 将 ${targetName} 移出了${session.kind === 'group' ? '群聊' : '协作'}`,
      )
    }
    res.json(build(req.params.id, session.ownerId))
  })

  /** 自助退出（成员本人；viewer 亦可——会话守卫已放行 /leave；群聊退出 / direct 400 防护） */
  router.post('/sessions/:id/leave', (req, res) => {
    const me = userOf(req)
    const session = deps.access.assertSession(me, req.params.id)
    if (!deps.access.multiUser) return res.status(400).json({ error: '多用户未启用：无共享语义' })
    if (!me) throw new HttpError(401, '未登录或登录已失效：请登录后重试')
    if (session.ownerId === me.id) return res.status(400).json({ error: '会话属主不能退出共享（群聊可解散 / 会话可删除）' })
    // M79-AA 群管理补全：direct 不支持退出（设计 §12.2——只有隐藏；对方不受影响；防 API 层单方断开私聊）
    if (session.kind === 'direct') {
      return res.status(400).json({ error: '私聊不支持退出（可选择隐藏会话，对方不受影响）' })
    }
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
    // M79-E：退出 → 持球方清洗
    deps.onMemberRemoved?.(req.params.id, me.id)
    // M79-AA 群管理补全：退出留痕（群聊「退出了群聊」/ 团队「退出了协作」）
    deps.appendSystem?.(req.params.id, `${me.displayName} 退出了${session.kind === 'group' ? '群聊' : '协作'}`)
    res.json({ ok: true })
  })

  return router
}

/**
 * M79-C：好友接口（设计 §11–§12）。
 *
 * 端点：
 * - GET    /friends                    好友清单（画像 + 在线态；按在线 → 成为好友时间排序）
 * - GET    /friends/requests           待处理请求（incoming / outgoing）
 * - POST   /friends/requests           发起请求（userId 或 username 寻址；附言可选；日限流）
 * - POST   /friends/requests/:id/accept|reject   接收方处理（accept → accepted；reject → 删行）
 * - DELETE /friends/:userId            解除好友（双向删行）
 * - POST   /friends/:userId/block|unblock        拉黑（隐含解除；不可逆面单向）/ 解除拉黑
 * - GET    /users/search?q=            成员搜索（隐私开关 / 排除自己与拉黑对 / 滑动窗口限流）
 *
 * 副作用：inbox 投递（deliver 注入：写库 + 用户主题实时帧）+ notify:friends-changed + audit_log。
 * 兼容模式（multiUser=false）：读接口返回空集，写接口 400（明确提示先完成管理员初始化）。
 */
import { Router } from 'express'
import type { Request } from 'express'
import { z } from 'zod'
import type { FriendEntry, FriendRequest, FriendRequestsView, FriendState, UserProfile, UserSearchHit } from '@multi-agent/shared'
import type { AccessService } from '../auth/access.js'
import type { AuthService, AuthUser } from '../auth/service.js'
import type { AuditStore } from '../store/audit.js'
import type { InboxAddInput } from '../store/inbox.js'
import { otherOf, type FriendLinkRecord, type FriendStore } from '../store/friends.js'
import type { UserStore } from '../store/users.js'
import { toUserInfo } from '../store/users.js'
import type { AppConfig } from '../config.js'
import { firstIssue } from './schemas.js'

const requestSchema = z.object({
  /** 寻址：userId 或 username 二选一（username 不区分大小写） */
  userId: z.string().trim().min(1).optional(),
  username: z.string().trim().min(1).max(32).optional(),
  message: z.string().trim().max(200, '附言最长 200 字').optional(),
})

export interface FriendsRouterDeps {
  cfg: AppConfig
  access: AccessService
  auth: AuthService
  users: UserStore
  friends: FriendStore
  audit?: AuditStore
  /** 收件箱投递（写库 + 用户主题实时帧；缺省 = 仅落库由调用方保证，测试可注入 spy） */
  deliver?: (input: InboxAddInput) => void
  /** 关系变化广播（对端视角；action: request | accepted | removed | blocked） */
  publishFriendsChanged?: (userId: string, counterpartId: string, action: 'request' | 'accepted' | 'removed' | 'blocked') => void
  /** 在线状态读取（缺省 = 全部离线） */
  presence?: { isOnline: (userId: string) => boolean; lastSeenAt: (userId: string) => string | undefined }
}

/** 画像投影（绝不外泄凭据字段） */
function profileOf(users: UserStore, userId: string): UserProfile | undefined {
  const user = users.get(userId)
  if (!user) return undefined
  // M79-Q：复用 toUserInfo 投影（图片头像：内部文件名 → 公开 URL；唯一投影点纪律）
  const info = toUserInfo(user)
  return {
    userId: info.id,
    username: info.username,
    displayName: info.displayName,
    ...(info.headline ? { headline: info.headline } : {}),
    ...(info.avatar ? { avatar: info.avatar } : {}),
  }
}

export function createFriendsRouter(deps: FriendsRouterDeps): Router {
  const router = Router()
  const userOf = (req: Request): AuthUser | undefined => (req as Request & { user?: AuthUser }).user
  const actorOf = (req: Request): { userId?: string; ip?: string } => ({ userId: userOf(req)?.id, ip: req.ip })

  /** 搜索滑动窗口限流（每用户 30 次/分钟；本地内存，单进程语义） */
  const searchHits = new Map<string, number[]>()
  const SEARCH_LIMIT = 30
  const SEARCH_WINDOW_MS = 60_000
  const allowSearch = (userId: string): boolean => {
    const now = Date.now()
    const hits = (searchHits.get(userId) ?? []).filter((ts) => now - ts < SEARCH_WINDOW_MS)
    if (hits.length >= SEARCH_LIMIT) {
      searchHits.set(userId, hits)
      return false
    }
    hits.push(now)
    searchHits.set(userId, hits)
    return true
  }

  const requireMultiUser = (res: { status: (code: number) => { json: (b: unknown) => void } }): boolean => {
    if (deps.access.multiUser) return true
    res.status(400).json({ error: '好友功能需先完成管理员初始化（账号 → 创建管理员并启用多用户）' })
    return false
  }

  const pendingView = (record: FriendLinkRecord, direction: 'in' | 'out', viewerId: string): FriendRequest | undefined => {
    const other = otherOf(record, viewerId)
    const user = profileOf(deps.users, other)
    if (!user) return undefined
    return {
      id: record.id,
      direction,
      user: deps.presence
        ? { ...user, online: deps.presence.isOnline(other), ...(deps.presence.lastSeenAt(other) ? { lastSeenAt: deps.presence.lastSeenAt(other)! } : {}) }
        : user,
      ...(record.message ? { message: record.message } : {}),
      createdAt: record.createdAt,
    }
  }

  /** 好友清单（画像 + 在线态） */
  router.get('/friends', (req, res) => {
    const me = userOf(req)
    if (!me || !deps.access.multiUser) return res.json({ friends: [] as FriendEntry[] })
    const friends: FriendEntry[] = []
    for (const link of deps.friends.listFriends(me.id)) {
      const user = profileOf(deps.users, link.userId)
      if (!user) continue
      const online = deps.presence?.isOnline(link.userId) ?? false
      const lastSeenAt = deps.presence?.lastSeenAt(link.userId)
      friends.push({ ...user, online, ...(lastSeenAt ? { lastSeenAt } : {}) })
    }
    // 排序：在线优先 → 昵称（稳定可测）
    friends.sort((a, b) => Number(!!b.online) - Number(!!a.online) || a.displayName.localeCompare(b.displayName, 'zh-Hans-CN'))
    res.json({ friends })
  })

  /** 待处理请求（收发两视图） */
  router.get('/friends/requests', (req, res) => {
    const me = userOf(req)
    if (!me || !deps.access.multiUser) return res.json({ incoming: [], outgoing: [] } satisfies FriendRequestsView)
    const { incoming, outgoing } = deps.friends.listPending(me.id)
    res.json({
      incoming: incoming.map((r) => pendingView(r, 'in', me.id)).filter((x): x is FriendRequest => !!x),
      outgoing: outgoing.map((r) => pendingView(r, 'out', me.id)).filter((x): x is FriendRequest => !!x),
    } satisfies FriendRequestsView)
  })

  /** 发起好友请求（userId / username 寻址；同意后才成为好友） */
  router.post('/friends/requests', (req, res) => {
    const me = userOf(req)
    if (!me) return res.status(401).json({ error: '未登录或登录已失效：请登录后重试' })
    if (!requireMultiUser(res)) return
    const parsed = requestSchema.safeParse(req.body ?? {})
    if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) })
    const { userId, username, message } = parsed.data
    if (!userId && !username) return res.status(400).json({ error: '请提供 userId 或 username' })

    const target = userId ? deps.users.get(userId) : deps.users.getByUsername(username!)
    if (!target || target.status !== 'active') return res.status(404).json({ error: '账号不存在或已停用' })
    if (target.id === me.id) return res.status(400).json({ error: '不能添加自己为好友' })

    const relation = deps.friends.relation(me.id, target.id)
    if (relation === 'accepted') return res.status(409).json({ error: '你们已经是好友' })
    if (relation === 'pending-out') return res.status(409).json({ error: '已发出申请，等待对方处理' })
    if (relation === 'pending-in') return res.status(409).json({ error: '对方已向你发出申请：请在请求列表中直接接受' })
    if (relation === 'blocked') {
      // 拉黑方视角给出可操作提示；被拉黑方不暴露事实
      const record = deps.friends.find(me.id, target.id)
      if (record?.blockedBy === me.id) return res.status(400).json({ error: '你已拉黑对方：请先解除拉黑' })
      return res.status(400).json({ error: '对方设置了隐私限制' })
    }

    // 目标隐私开关（默认开放）
    const prefs = deps.users.getPrefs(target.id)
    if (prefs.allowFriendRequests === false) return res.status(403).json({ error: '对方未开放好友申请' })

    // 日限流
    const since = new Date(Date.now() - 86_400_000).toISOString()
    if (deps.friends.countRequestsSince(me.id, since) >= deps.cfg.friendRequestDailyLimit) {
      return res.status(429).json({ error: `今日好友申请已达上限（${deps.cfg.friendRequestDailyLimit} 次），请明日再试` })
    }

    const record = deps.friends.request(me.id, target.id, message)
    deps.audit?.record({
      actor: 'user',
      ...actorOf(req),
      action: 'friend.request',
      resourceType: 'user',
      resourceId: target.id,
      detail: { message: message ?? '' },
    })
    deps.deliver?.({
      userId: target.id,
      type: 'friend-request',
      title: `${me.displayName} 请求添加你为好友`,
      ...(message ? { body: message } : {}),
      actorId: me.id,
      payload: { requestId: record.id },
    })
    deps.publishFriendsChanged?.(target.id, me.id, 'request')
    const user = profileOf(deps.users, target.id)
    res.status(201).json({ request: pendingView(record, 'out', me.id), user })
  })

  /** 接受 / 拒绝（接收方专属） */
  router.post('/friends/requests/:id/accept', (req, res) => {
    const me = userOf(req)
    if (!me) return res.status(401).json({ error: '未登录或登录已失效：请登录后重试' })
    if (!requireMultiUser(res)) return
    const record = deps.friends.byId(req.params.id)
    if (!record || record.state !== 'pending') return res.status(404).json({ error: '请求不存在或已处理' })
    if (record.requestedBy === me.id) return res.status(403).json({ error: '不能接受自己发出的申请' })
    const accepted = deps.friends.accept(record.id)!
    const requesterId = record.requestedBy
    deps.audit?.record({
      actor: 'user',
      ...actorOf(req),
      action: 'friend.accept',
      resourceType: 'user',
      resourceId: requesterId,
    })
    deps.deliver?.({
      userId: requesterId,
      type: 'friend-accepted',
      title: `${me.displayName} 已同意你的好友申请`,
      actorId: me.id,
    })
    deps.publishFriendsChanged?.(requesterId, me.id, 'accepted')
    deps.publishFriendsChanged?.(me.id, requesterId, 'accepted')
    const user = profileOf(deps.users, requesterId)
    res.json({ ok: true, friend: user, acceptedAt: accepted.updatedAt })
  })

  router.post('/friends/requests/:id/reject', (req, res) => {
    const me = userOf(req)
    if (!me) return res.status(401).json({ error: '未登录或登录已失效：请登录后重试' })
    if (!requireMultiUser(res)) return
    const record = deps.friends.byId(req.params.id)
    if (!record || record.state !== 'pending') return res.status(404).json({ error: '请求不存在或已处理' })
    if (record.requestedBy === me.id) {
      // 发出方撤回（同语义端点；静默）
      deps.friends.removeRow(record.id)
      return res.json({ ok: true, action: 'withdrawn' })
    }
    deps.friends.removeRow(record.id)
    deps.audit?.record({ actor: 'user', ...actorOf(req), action: 'friend.reject', resourceType: 'user', resourceId: record.requestedBy })
    res.json({ ok: true, action: 'rejected' })
  })

  /** 解除好友（任一方；双向删行；双方关系变化广播） */
  router.delete('/friends/:userId', (req, res) => {
    const me = userOf(req)
    if (!me) return res.status(401).json({ error: '未登录或登录已失效：请登录后重试' })
    if (!requireMultiUser(res)) return
    const other = req.params.userId
    if (!deps.users.get(other)) return res.status(404).json({ error: '账号不存在' })
    if (!deps.friends.removePair(me.id, other)) return res.status(404).json({ error: '你们不是好友' })
    deps.audit?.record({ actor: 'user', ...actorOf(req), action: 'friend.remove', resourceType: 'user', resourceId: other })
    deps.publishFriendsChanged?.(other, me.id, 'removed')
    deps.publishFriendsChanged?.(me.id, other, 'removed')
    res.json({ ok: true })
  })

  /** 拉黑（隐含解除；被拉黑方无感） */
  router.post('/friends/:userId/block', (req, res) => {
    const me = userOf(req)
    if (!me) return res.status(401).json({ error: '未登录或登录已失效：请登录后重试' })
    if (!requireMultiUser(res)) return
    const other = req.params.userId
    if (!deps.users.get(other)) return res.status(404).json({ error: '账号不存在' })
    if (other === me.id) return res.status(400).json({ error: '不能拉黑自己' })
    deps.friends.block(me.id, other)
    deps.audit?.record({ actor: 'user', ...actorOf(req), action: 'friend.block', resourceType: 'user', resourceId: other })
    deps.publishFriendsChanged?.(me.id, other, 'blocked')
    res.json({ ok: true })
  })

  /** 解除拉黑（仅拉黑方） */
  router.post('/friends/:userId/unblock', (req, res) => {
    const me = userOf(req)
    if (!me) return res.status(401).json({ error: '未登录或登录已失效：请登录后重试' })
    if (!requireMultiUser(res)) return
    const other = req.params.userId
    if (!deps.friends.unblock(me.id, other)) return res.status(404).json({ error: '不在拉黑名单中' })
    deps.audit?.record({ actor: 'user', ...actorOf(req), action: 'friend.unblock', resourceType: 'user', resourceId: other })
    res.json({ ok: true })
  })

  /** 成员搜索（隐私开关：searchable=false 仅精确 username 命中；排除自己 / 停用 / 拉黑对） */
  router.get('/users/search', (req, res) => {
    const me = userOf(req)
    if (!me || !deps.access.multiUser) return res.json({ users: [] as UserSearchHit[] })
    const q = String(req.query.q ?? '').trim()
    if (!q) return res.status(400).json({ error: 'q 必填（搜索关键词）' })
    if (!allowSearch(me.id)) return res.status(429).json({ error: '搜索过于频繁，请稍后再试' })
    const needle = q.toLowerCase()
    const hits: UserSearchHit[] = []
    for (const info of deps.users.list()) {
      if (info.id === me.id || info.status !== 'active') continue
      const prefs = deps.users.getPrefs(info.id)
      const searchable = prefs.searchable !== false
      const usernameHit = info.username.toLowerCase().includes(needle)
      const nameHit = info.displayName.toLowerCase().includes(needle)
      const matched = searchable ? usernameHit || nameHit : info.username.toLowerCase() === needle
      if (!matched) continue
      const relation = deps.friends.relation(me.id, info.id)
      if (relation === 'blocked' || deps.friends.hasBlockedPair(me.id, info.id)) continue // 拉黑对互不可见
      const online = deps.presence?.isOnline(info.id) ?? false
      hits.push({
        userId: info.id,
        username: info.username,
        displayName: info.displayName,
        ...(info.headline ? { headline: info.headline } : {}),
        ...(info.avatar ? { avatar: info.avatar } : {}),
        online,
        relation: relation as FriendState,
      })
      if (hits.length >= 10) break
    }
    res.json({ users: hits })
  })

  return router
}

/**
 * M79-D：人物会话接口（设计 §12）。
 *
 * - POST /chats/direct  { userId }            私聊创建 / 复用（仅好友；dm_key 唯一索引兜底并发竞态）
 * - POST /chats/group   { title?, memberIds } 群聊创建（成员须为创建人好友；1–50 人）
 *
 * 语义要点：
 * - kind='direct'：双方成员（creator=owner / 对方=editor）；标题列表侧动态渲染（对端显示名）；
 * - kind='group'：创建人 owner + 受邀者 editor；可后续经成员 API 拉 agent 进群（混编）；
 * - 被邀请人收件箱实时到达（deliver 注入）+ system 事件条；会话照常分配沙盒工作区（零特判）。
 */
import { Router } from 'express'
import type { Request } from 'express'
import { z } from 'zod'
import type { AuthUser } from '../auth/service.js'
import type { AuthService } from '../auth/service.js'
import type { AccessService } from '../auth/access.js'
import type { SessionMemberStore } from '../store/session-members.js'
import type { SessionStore } from '../store/sessions.js'
import type { FriendStore } from '../store/friends.js'
import type { InboxAddInput } from '../store/inbox.js'
import type { SessionHideStore } from '../store/session-hides.js'
import { firstIssue } from './schemas.js'

const directSchema = z.object({ userId: z.string().trim().min(1, 'userId 必填') })
const groupSchema = z.object({
  title: z.string().trim().max(60).optional(),
  memberIds: z.array(z.string().trim().min(1)).min(1, '至少邀请 1 位好友').max(50, '群聊人数上限 50'),
})

/** 私聊唯一键（排序后以 '|' 连接；与迁移 v24 注释一致） */
export function dmKeyOf(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

export interface ChatsRouterDeps {
  access: AccessService
  auth: AuthService
  sessions: SessionStore
  members: SessionMemberStore
  friends: FriendStore
  hides?: SessionHideStore
  /** 收件箱投递（被邀请人实时到达；缺省 = 仅落库由调用方保证） */
  deliver?: (input: InboxAddInput) => void
  /** 会话可见者列表变化广播（客户端列表/订阅刷新；复用 notify:share-changed 语义） */
  publishShareChanged?: (sessionId: string, userId: string, action: string, role?: string) => void
}

export function createChatsRouter(deps: ChatsRouterDeps): Router {
  const router = Router()
  const userOf = (req: Request): AuthUser | undefined => (req as Request & { user?: AuthUser }).user

  /** 私聊创建 / 复用（仅好友；唯一键兜底并发） */
  router.post('/chats/direct', (req, res) => {
    const me = userOf(req)
    if (!me) return res.status(401).json({ error: '未登录或登录已失效：请登录后重试' })
    if (!deps.access.multiUser) return res.status(400).json({ error: '私聊需先完成管理员初始化（账号 → 创建管理员并启用多用户）' })
    const parsed = directSchema.safeParse(req.body ?? {})
    if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) })
    const target = deps.auth.getUser(parsed.data.userId)
    if (!target || target.status !== 'active') return res.status(404).json({ error: '账号不存在或已停用' })
    if (target.id === me.id) return res.status(400).json({ error: '不能与自己私聊' })
    if (!deps.friends.areFriends(me.id, target.id)) {
      if (deps.friends.hasBlockedPair(me.id, target.id)) return res.status(400).json({ error: '对方设置了隐私限制' })
      return res.status(403).json({ error: '仅好友之间可以发起私聊' })
    }

    const dmKey = dmKeyOf(me.id, target.id)
    let session = deps.sessions.findByDmKey(dmKey)
    if (!session) {
      try {
        session = deps.sessions.create([], '私聊', { ownerId: me.id, kind: 'direct', dmKey })
      } catch {
        // 并发竞态：唯一索引冲突 → 回查复用
        session = deps.sessions.findByDmKey(dmKey)
        if (!session) return res.status(500).json({ error: '私聊创建失败，请重试' })
      }
      // 双方成员：创建人 owner（owner_id 承载），对方 editor
      deps.members.upsert(session.id, target.id, 'editor', me.id)
      const opened = deps.sessions.appendMessage({
        sessionId: session.id,
        role: 'system',
        content: `${me.displayName} 与 ${target.displayName} 开始了对话`,
        mentions: [],
        status: 'complete',
      })
      deps.publishShareChanged?.(session.id, target.id, 'added', 'editor')
      deps.deliver?.({
        userId: target.id,
        type: 'session-invite',
        title: `${me.displayName} 发起私聊`,
        sessionId: session.id,
        actorId: me.id,
        payload: { kind: 'direct' },
      })
      void opened
      return res.status(201).json({ session, created: true })
    }
    // 复用：清除双方隐藏（对方隐藏与否不影响；本人隐藏则复现）
    deps.hides?.unhide(me.id, session.id)
    res.json({ session, created: false })
  })

  /** 群聊创建（成员须为创建人好友；1–50 人） */
  router.post('/chats/group', (req, res) => {
    const me = userOf(req)
    if (!me) return res.status(401).json({ error: '未登录或登录已失效：请登录后重试' })
    if (!deps.access.multiUser) return res.status(400).json({ error: '群聊需先完成管理员初始化（账号 → 创建管理员并启用多用户）' })
    const parsed = groupSchema.safeParse(req.body ?? {})
    if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) })
    const memberIds = [...new Set(parsed.data.memberIds)].filter((id) => id !== me.id)
    if (memberIds.length === 0) return res.status(400).json({ error: '至少邀请 1 位好友' })

    const profiles: Array<{ id: string; name: string }> = []
    for (const id of memberIds) {
      const user = deps.auth.getUser(id)
      if (!user || user.status !== 'active') return res.status(404).json({ error: '邀请对象不存在或已停用' })
      if (!deps.friends.areFriends(me.id, id)) return res.status(403).json({ error: `仅可邀请好友加入群聊（${user.displayName} 不是你的好友）` })
      profiles.push({ id, name: user.displayName })
    }

    const session = deps.sessions.create([], parsed.data.title || `${me.displayName} 的群聊`, {
      ownerId: me.id,
      kind: 'group',
    })
    for (const member of profiles) deps.members.upsert(session.id, member.id, 'editor', me.id)
    deps.sessions.appendMessage({
      sessionId: session.id,
      role: 'system',
      content: `${me.displayName} 创建了群聊并邀请 ${profiles.map((p) => p.name).join('、')} 加入`,
      mentions: [],
      status: 'complete',
    })
    for (const member of profiles) {
      deps.publishShareChanged?.(session.id, member.id, 'added', 'editor')
      deps.deliver?.({
        userId: member.id,
        type: 'session-invite',
        title: `${me.displayName} 邀请你加入群聊「${session.title}」`,
        sessionId: session.id,
        actorId: me.id,
        payload: { kind: 'group' },
      })
    }
    res.status(201).json({ session })
  })

  return router
}

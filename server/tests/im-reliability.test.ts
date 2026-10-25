/** IM 可靠性夹具：真实 SQLite/HTTP/ACL，不依赖 Agent 资产目录或 LLM。 */
import 'express-async-errors'
import express from 'express'
import type { Request, ErrorRequestHandler } from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase, type AppDb } from '../src/store/db.js'
import { DuplicateSubmissionError, SessionStore } from '../src/store/sessions.js'
import { SessionMemberStore } from '../src/store/session-members.js'
import { SessionReadsStore } from '../src/store/session-reads.js'
import { UserStore } from '../src/store/users.js'
import { InboxStore } from '../src/store/inbox.js'
import { SessionPrefsStore } from '../src/store/session-prefs.js'
import { MessageHideStore } from '../src/store/message-hides.js'
import { AccessService } from '../src/auth/access.js'
import type { AuthUser } from '../src/auth/service.js'
import { createSessionsRouter } from '../src/routes/sessions.js'
import { createInboxRouter } from '../src/routes/inbox.js'
import type { ApiDeps } from '../src/routes/index.js'
import { NotifyHub } from '../src/ws.js'
import type { AppConfig } from '../src/config.js'
import type { ChatMessage, InboxItem } from '@multi-agent/shared'

interface SendResult {
  message: ChatMessage
  deduplicated?: boolean
  dispatchError?: string
}

let db: AppDb
let sessions: SessionStore
let inbox: InboxStore
let reads: SessionReadsStore
let prefs: SessionPrefsStore
let hides: MessageHideStore
let members: SessionMemberStore
let publishPrefs: ReturnType<typeof vi.fn>
let deliverInbox: ReturnType<typeof vi.fn>
let server: Server
let base: string
let sid: string
let alice: AuthUser
let bob: AuthUser
let deps: ApiDeps
const launch = vi.fn()
const publish = vi.fn()

beforeEach(async () => {
  db = openDatabase(':memory:')
  sessions = new SessionStore(db)
  const users = new UserStore(db)
  alice = users.create({
    username: 'alice',
    displayName: 'Alice',
    passwordHash: 'x',
    role: 'member',
  }) as unknown as AuthUser
  bob = users.create({
    username: 'bob',
    displayName: 'Bob',
    passwordHash: 'x',
    role: 'member',
  }) as unknown as AuthUser
  members = new SessionMemberStore(db)
  inbox = new InboxStore(db)
  reads = new SessionReadsStore(db)
  prefs = new SessionPrefsStore(db)
  hides = new MessageHideStore(db)
  sid = sessions.create([], 'IM', { ownerId: alice.id, kind: 'group' }).id
  members.upsert(sid, bob.id, 'editor', alice.id)
  const access = new AccessService({ isMultiUser: () => true, sessions, members, projects: {} as never })
  // 关闭人类提及投影即可隔离资产；消息署名和真实会话 ACL 仍参与验收。
  const auth = {
    multiUser: false,
    getUser: (id: string) => (id === alice.id ? alice : bob),
  } as ApiDeps['auth']
  launch.mockReset().mockReturnValue({ runId: 'run_1', queue: [], queued: false })
  publish.mockReset()
  deliverInbox = vi.fn()
  deps = {
    sessions,
    members,
    auth,
    access,
    prompts: { get: () => undefined, soul: () => undefined, list: () => [] },
    reads,
    sessionPrefs: prefs,
    messageHides: hides,
    runs: { latest: () => null },
    projects: { get: () => undefined },
    users: { getPrefs: () => ({}) },
    engine: { launch, activeRunOf: () => undefined },
    deliverInbox,
    notify: { publish, publishToUser: vi.fn() },
  } as unknown as ApiDeps
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as Request & { user: AuthUser }).user = req.headers['x-user'] === 'bob' ? bob : alice
    next()
  })
  app.use('/api/sessions/:id', (req, _res, next) => {
    try {
      access.assertSession((req as unknown as Request & { user: AuthUser }).user, req.params.id)
      next()
    } catch (err) {
      next(err)
    }
  })
  app.use('/api', createSessionsRouter(deps))
  publishPrefs = vi.fn()
  app.use('/api', createInboxRouter({ inbox, reads, auth, access, sessionPrefs: prefs, publishPrefs }))
  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) =>
    res.status(err.status ?? 500).json({ error: err.message })
  app.use(errorHandler)
  server = app.listen(0)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  sessions.close()
  db.close()
})

const send = (body: object, user = 'alice', id = sid): Promise<Response> =>
  fetch(`${base}/sessions/${id}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user': user },
    body: JSON.stringify(body),
  })

describe('幂等接收与 AI 解耦', () => {
  it('相同标识重试只生成一条；纯聊天不启动 Run', async () => {
    const body = { clientMessageId: 'client_1', content: '你好' }
    const first = (await (await send(body)).json()) as SendResult
    const second = (await (await send(body)).json()) as SendResult
    expect(second.message.id).toBe(first.message.id)
    expect(second.deduplicated).toBe(true)
    expect(sessions.messages(sid)).toHaveLength(1)
    expect(launch).not.toHaveBeenCalled()
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it('相同标识不同正文拒绝；不同作者可使用相同标识', async () => {
    await send({ clientMessageId: 'same', content: 'A' })
    expect((await send({ clientMessageId: 'same', content: 'B' })).status).toBe(409)
    expect((await send({ clientMessageId: 'same', content: 'B' }, 'bob')).status).toBe(201)
    expect(sessions.messages(sid)).toHaveLength(2)
  })

  it('清空进程缓存后仍可重放接收结果；删除后重试不复活消息', async () => {
    const body = { clientMessageId: 'restart', content: '持久确认' }
    const first = (await (await send(body)).json()) as SendResult
    sessions.close()
    sessions = new SessionStore(db)
    deps.sessions = sessions
    const replay = (await (await send(body)).json()) as SendResult
    expect(replay.message.clientMessageId).toBe('restart')
    expect(replay.message.id).toBe(first.message.id)
    sessions.deleteMessage(sid, first.message.id)
    expect((await send(body)).status).toBe(410)
    expect(sessions.messages(sid)).toHaveLength(0)
  })

  it('AI 启动失败仍确认消息，重试不再调用 AI', async () => {
    const team = sessions.create([], 'AI', { ownerId: alice.id }).id
    launch.mockImplementation(() => {
      throw new Error('额度不足')
    })
    const body = { clientMessageId: 'ai_error', content: '分析需求' }
    const response = await send(body, 'alice', team)
    expect(response.status).toBe(201)
    expect(((await response.json()) as SendResult).dispatchError).toBe('额度不足')
    expect(((await (await send(body, 'alice', team)).json()) as SendResult).dispatchError).toBe('额度不足')
    expect(launch).toHaveBeenCalledTimes(1)
    expect(sessions.messages(team)).toHaveLength(1)
  })

  it('删除末条并重建存储后，消息序号仍递增', () => {
    const first = sessions.appendMessage({
      sessionId: sid,
      role: 'user',
      content: 'a',
      status: 'complete',
      mentions: [],
    })
    sessions.deleteMessage(sid, first.id)
    sessions.close()
    sessions = new SessionStore(db)
    const next = sessions.appendMessage({
      sessionId: sid,
      role: 'user',
      content: 'b',
      status: 'complete',
      mentions: [],
    })
    expect(next.seq).toBe(first.seq! + 1)
  })

  it('凭据唯一约束失败时，消息与内存均不多写', () => {
    const input = {
      sessionId: sid,
      clientMessageId: 'atomic',
      userId: alice.id,
      role: 'user' as const,
      content: 'a',
      status: 'complete' as const,
      mentions: [],
    }
    sessions.appendMessage(input, 'hash')
    expect(() => sessions.appendMessage(input, 'hash')).toThrow(DuplicateSubmissionError)
    expect(sessions.messages(sid)).toHaveLength(1)
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM messages')?.n).toBe(1)
  })

  it('非成员不能使用提交标识查询消息', async () => {
    const privateId = sessions.create([], '私有', { ownerId: alice.id }).id
    await send({ clientMessageId: 'private', content: '私有消息' }, 'alice', privateId)
    expect((await send({ clientMessageId: 'private', content: '私有消息' }, 'bob', privateId)).status).toBe(
      404,
    )
  })
})

describe('分页游标与阅读水位', () => {
  it('积压超过 200 条时逐页完整拉取，不跳到全局最大游标', async () => {
    for (let i = 0; i < 451; i++) inbox.add({ userId: alice.id, type: 'system', title: `${i}` })
    let cursor = 0
    const received: string[] = []
    do {
      const page = (await (await fetch(`${base}/inbox?since=${cursor}&limit=200`)).json()) as {
        items: InboxItem[]
        cursor: number
        nextCursor: number
        hasMore: boolean
      }
      received.push(...page.items.map((item: { id: string }) => item.id))
      expect(page.cursor).toBe(page.items.at(-1)?.seq)
      cursor = page.nextCursor
      if (!page.hasMore) break
    } while (cursor < 451)
    expect(received).toHaveLength(451)
    expect(new Set(received).size).toBe(451)
  })

  it('全部已读通知清理后，下一条仍使用更大序号', () => {
    const old = inbox.add({ userId: alice.id, type: 'system', title: '旧通知' })
    inbox.markRead(alice.id, [old.id])
    db.run('UPDATE user_inbox SET created_at = ?', '2000-01-01T00:00:00.000Z')
    inbox.cleanup(1)
    expect(inbox.add({ userId: alice.id, type: 'system', title: '新通知' }).seq).toBe(old.seq + 1)
  })

  it('未来、非法、回退的已读水位不能吞掉未来消息', () => {
    const message = sessions.appendMessage({
      sessionId: sid,
      role: 'user',
      userId: bob.id,
      content: 'a',
      status: 'complete',
      mentions: [],
    })
    expect(reads.set(alice.id, sid, NaN)).toBe(0)
    expect(reads.set(alice.id, sid, Infinity)).toBe(0)
    expect(reads.set(alice.id, sid, 999999)).toBe(message.seq)
    expect(reads.set(alice.id, sid, 0)).toBe(message.seq)
    sessions.appendMessage({
      sessionId: sid,
      role: 'user',
      userId: bob.id,
      content: 'b',
      status: 'complete',
      mentions: [],
    })
    expect(reads.unreadFor(alice.id, [sid]).get(sid)).toBe(1)
  })
})

describe('引用回复与会话偏好', () => {
  it('引用同会话消息：固化作者与摘要；原消息删除后标记已删除', async () => {
    const original = sessions.appendMessage({
      sessionId: sid,
      role: 'user',
      userId: alice.id,
      content: '第一条\n完整内容',
      status: 'complete',
      mentions: [],
    })
    const reply = (await (
      await send({ clientMessageId: 'reply_1', content: '收到', replyToMessageId: original.id })
    ).json()) as SendResult
    expect(reply.message.replyTo).toMatchObject({
      messageId: original.id,
      authorName: 'Alice',
      excerpt: '第一条 完整内容',
    })
    sessions.deleteMessage(sid, original.id)
    const detail = sessions.get(sid)!
    expect(detail.messages.find((m) => m.id === reply.message.id)?.replyTo?.deleted).toBe(true)
  })

  it('跨会话或已消失的目标落墓碑快照，仍允许发送', async () => {
    const other = sessions.create([], '另一个', { ownerId: alice.id }).id
    const response = await send({ content: '越界', replyToMessageId: 'm_missing' }, 'alice', other)
    expect(response.status).toBe(201)
    const body = (await response.json()) as SendResult
    expect(body.message.replyTo).toMatchObject({ messageId: 'm_missing', excerpt: '原消息已删除', deleted: true })
  })

  it('会话偏好按本人隔离、随列表投影并下发多端帧', async () => {
    const patched = await fetch(`${base}/sessions/${sid}/prefs`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-user': 'alice' },
      body: JSON.stringify({ pinned: true, muted: true }),
    })
    expect(patched.status).toBe(200)
    expect(await patched.json()).toEqual({
      prefs: { pinned: true, muted: true, archived: false, markedUnread: false },
    })
    expect(deps.notify.publishToUser).toHaveBeenCalledWith(alice.id, 'notify:session-prefs', {
      sessionId: sid,
      prefs: { pinned: true, muted: true, archived: false, markedUnread: false },
    })
    const mine = (await (await fetch(`${base}/sessions`, { headers: { 'x-user': 'alice' } })).json()) as {
      sessions: Array<{ id: string; prefs?: unknown }>
    }
    expect(mine.sessions.find((s) => s.id === sid)?.prefs).toEqual({
      pinned: true,
      muted: true,
      archived: false,
      markedUnread: false,
    })
    const theirs = (await (await fetch(`${base}/sessions`, { headers: { 'x-user': 'bob' } })).json()) as {
      sessions: Array<{ id: string; prefs?: unknown }>
    }
    expect(theirs.sessions.find((s) => s.id === sid)?.prefs).toEqual({
      pinned: false,
      muted: false,
      archived: false,
      markedUnread: false,
    })
  })

  it('归档与标记未读：未读至少为 1，读到消息后自动解除', async () => {
    const patched = await fetch(`${base}/sessions/${sid}/prefs`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-user': 'alice' },
      body: JSON.stringify({ archived: true, markedUnread: true }),
    })
    expect(patched.status).toBe(200)
    const before = (await (await fetch(`${base}/sessions`, { headers: { 'x-user': 'alice' } })).json()) as {
      sessions: Array<{ id: string; unreadCount?: number; prefs?: { archived: boolean; markedUnread: boolean } }>
    }
    const row = before.sessions.find((s) => s.id === sid)
    expect(row?.unreadCount).toBe(1)
    expect(row?.prefs).toMatchObject({ archived: true, markedUnread: true })

    const message = sessions.appendMessage({
      sessionId: sid,
      role: 'user',
      userId: bob.id,
      content: '回看提醒',
      status: 'complete',
      mentions: [],
    })
    const read = await fetch(`${base}/sessions/${sid}/read`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user': 'alice' },
      body: JSON.stringify({ seq: message.seq }),
    })
    expect(read.status).toBe(200)
    expect(prefs.get(alice.id, sid).markedUnread).toBe(false)
    expect(prefs.get(alice.id, sid).archived).toBe(true)
    expect(publishPrefs).toHaveBeenCalledWith(
      alice.id,
      sid,
      expect.objectContaining({ archived: true, markedUnread: false }),
    )
  })

  it('会话偏好空体 400', async () => {
    const res = await fetch(`${base}/sessions/${sid}/prefs`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-user': 'alice' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })
})

describe('消息生命周期', () => {
  it('编辑写入 editedAt 并随响应返回', async () => {
    const m = sessions.appendMessage({ sessionId: sid, role: 'user', userId: alice.id, content: '原文', status: 'complete', mentions: [] })
    const res = await fetch(`${base}/sessions/${sid}/messages/${m.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-user': 'alice' },
      body: JSON.stringify({ content: '改后' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { message: ChatMessage }
    expect(body.message.content).toBe('改后')
    expect(body.message.editedAt).toBeTruthy()
    expect(sessions.get(sid)!.messages.find((x) => x.id === m.id)?.editedAt).toBeTruthy()
  })

  it('撤回清空正文 / 附件并让引用快照标为已撤回', async () => {
    const original = sessions.appendMessage({
      sessionId: sid,
      role: 'user',
      userId: bob.id,
      content: '会被撤回',
      status: 'complete',
      mentions: [],
    })
    const reply = (await (
      await send({ clientMessageId: 'recall_reply', content: '引用回复', replyToMessageId: original.id })
    ).json()) as SendResult
    const recalled = await fetch(`${base}/sessions/${sid}/messages/${original.id}/recall`, {
      method: 'POST',
      headers: { 'x-user': 'bob' },
    })
    expect(recalled.status).toBe(200)
    const body = (await recalled.json()) as { message: ChatMessage }
    expect(body.message.recalledAt).toBeTruthy()
    expect(body.message.content).toBe('')
    expect(body.message.mentions).toEqual([])
    const stored = sessions.get(sid)!.messages
    expect(stored.find((m) => m.id === original.id)?.content).toBe('')
    expect(stored.find((m) => m.id === reply.message.id)?.replyTo?.recalled).toBe(true)
    // 未读不计已撤回消息：bob 视角只剩 alice 的引用回复一条（否则应为 2）
    expect(reads.unreadFor(bob.id, [sid]).get(sid)).toBe(1)
  })

  it('撤回仅作者、限 2 分钟、不可撤回 agent 消息', async () => {
    const old = sessions.appendMessage({
      sessionId: sid,
      role: 'user',
      userId: bob.id,
      content: '旧消息',
      status: 'complete',
      mentions: [],
      createdAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    })
    const tooLate = await fetch(`${base}/sessions/${sid}/messages/${old.id}/recall`, {
      method: 'POST',
      headers: { 'x-user': 'bob' },
    })
    expect(tooLate.status).toBe(400)
    const otherUser = await fetch(`${base}/sessions/${sid}/messages/${old.id}/recall`, {
      method: 'POST',
      headers: { 'x-user': 'alice' },
    })
    expect(otherUser.status).toBe(403)
    const agent = sessions.appendMessage({ sessionId: sid, role: 'agent', agentId: 'pm', content: 'Agent', status: 'complete', mentions: [] })
    const byAgent = await fetch(`${base}/sessions/${sid}/messages/${agent.id}/recall`, {
      method: 'POST',
      headers: { 'x-user': 'alice' },
    })
    expect(byAgent.status).toBe(400)
  })

  it('仅自己删除按人隔离详情 / 预览 / 未读', async () => {
    const hidden = sessions.appendMessage({
      sessionId: sid,
      role: 'user',
      userId: bob.id,
      content: '只对 alice 隐藏',
      status: 'complete',
      mentions: [],
    })
    const res = await fetch(`${base}/sessions/${sid}/messages/${hidden.id}?scope=self`, {
      method: 'DELETE',
      headers: { 'x-user': 'alice' },
    })
    expect(res.status).toBe(200)
    expect(hides.has(alice.id, hidden.id)).toBe(true)
    const mine = (await (await fetch(`${base}/sessions/${sid}`, { headers: { 'x-user': 'alice' } })).json()) as {
      messages: ChatMessage[]
    }
    expect(mine.messages.some((m) => m.id === hidden.id)).toBe(false)
    const theirs = (await (await fetch(`${base}/sessions/${sid}`, { headers: { 'x-user': 'bob' } })).json()) as {
      messages: ChatMessage[]
    }
    expect(theirs.messages.some((m) => m.id === hidden.id)).toBe(true)
    const list = (await (await fetch(`${base}/sessions`, { headers: { 'x-user': 'alice' } })).json()) as {
      sessions: Array<{ id: string; lastMessage?: { content: string } }>
    }
    expect(list.sessions.find((s) => s.id === sid)?.lastMessage?.content).not.toBe('只对 alice 隐藏')
    expect(reads.unreadFor(alice.id, [sid]).get(sid)).toBeUndefined()
  })
})

describe('群主转让', () => {
  it('旧群主降为 editor、新群主移出成员表，并留系统事件与收件箱', async () => {
    const res = await fetch(`${base}/sessions/${sid}/transfer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user': 'alice' },
      body: JSON.stringify({ userId: bob.id }),
    })
    expect(res.status).toBe(200)
    expect(sessions.getSession(sid)?.ownerId).toBe(bob.id)
    expect(members.has(sid, bob.id)).toBe(false)
    expect(members.get(sid, alice.id)?.role).toBe('editor')
    expect(deps.access.sessionRole(alice, sid)).toBe('editor')
    expect(deps.access.sessionRole(bob, sid)).toBe('owner')
    const system = sessions.messages(sid).find((m) => m.role === 'system' && m.content.includes('转让'))
    expect(system?.content).toContain('Bob')
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'notify:share-changed',
        sessionId: sid,
        payload: expect.objectContaining({ action: 'owner', role: 'owner', userId: bob.id }),
      }),
    )
    expect(deliverInbox).toHaveBeenCalledWith(expect.objectContaining({ userId: bob.id, type: 'system' }))
  })

  it('非群主 / 非成员目标 / 私聊转让被拒', async () => {
    const dm = sessions.create([], 'DM', { ownerId: alice.id, kind: 'direct', dmKey: 'a|b' })
    members.upsert(dm.id, bob.id, 'editor', alice.id)
    const direct = await fetch(`${base}/sessions/${dm.id}/transfer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user': 'alice' },
      body: JSON.stringify({ userId: bob.id }),
    })
    expect(direct.status).toBe(400)

    const missing = await fetch(`${base}/sessions/${sid}/transfer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user': 'alice' },
      body: JSON.stringify({ userId: 'u_missing' }),
    })
    expect(missing.status).toBe(400)

    await fetch(`${base}/sessions/${sid}/transfer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user': 'alice' },
      body: JSON.stringify({ userId: bob.id }),
    })
    const byEditor = await fetch(`${base}/sessions/${sid}/transfer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user': 'alice' },
      body: JSON.stringify({ userId: bob.id }),
    })
    expect(byEditor.status).toBe(403)
  })
})

describe('搜索的个人可见性与直达信息', () => {
  it('筛选：我发的 / 时间范围 / 含附件', () => {
    const keyword = '筛选关键字丙'
    const mine = sessions.appendMessage({
      sessionId: sid,
      role: 'user',
      userId: bob.id,
      content: keyword,
      status: 'complete',
      mentions: [],
    })
    const other = sessions.appendMessage({
      sessionId: sid,
      role: 'user',
      userId: alice.id,
      content: keyword,
      status: 'complete',
      mentions: [],
    })
    const old = sessions.appendMessage({
      sessionId: sid,
      role: 'user',
      userId: bob.id,
      content: keyword,
      status: 'complete',
      mentions: [],
      createdAt: new Date(Date.now() - 40 * 24 * 3600_000).toISOString(),
    })
    const file = sessions.appendMessage({
      sessionId: sid,
      role: 'user',
      userId: bob.id,
      content: keyword,
      status: 'complete',
      mentions: [],
      attachments: [
        {
          path: 'uploads/a.png',
          name: 'a.png',
          kind: 'image',
          mime: 'image/png',
          size: 1,
          uploadedAt: new Date().toISOString(),
        },
      ],
    })
    const ids = (list: ReturnType<typeof sessions.search>): string[] => list.map((h) => h.messageId)
    const mineHits = ids(sessions.search(keyword, 20, bob.id, { userId: bob.id }))
    expect(mineHits).toEqual(expect.arrayContaining([mine.id, old.id, file.id]))
    expect(mineHits).not.toContain(other.id)
    const recent = ids(
      sessions.search(keyword, 20, bob.id, { from: new Date(Date.now() - 7 * 24 * 3600_000).toISOString() }),
    )
    expect(recent).toContain(file.id)
    expect(recent).not.toContain(old.id)
    const withFile = ids(sessions.search(keyword, 20, bob.id, { hasAttachment: true }))
    expect(withFile).toEqual([file.id])
  })

  it('排除本人自删与已撤回；返回 seq / 作者；共享会话标题可见', async () => {
    const keyword = '搜索关键字甲'
    const message = sessions.appendMessage({
      sessionId: sid,
      role: 'user',
      userId: bob.id,
      content: keyword,
      status: 'complete',
      mentions: [],
    })
    hides.hide(alice.id, sid, message.id)
    expect(sessions.search(keyword, 10, alice.id)).toEqual([])
    const hit = sessions.search(keyword, 10, bob.id)[0]
    expect(hit).toMatchObject({ messageId: message.id, seq: message.seq, role: 'user', userId: bob.id })
    expect(hit?.createdAt).toBeTruthy()

    // 共享会话（bob 是成员、不是属主）也必须能拿到标题与发送者
    const shared = (await (await fetch(`${base}/search?q=${encodeURIComponent(keyword)}`, { headers: { 'x-user': 'bob' } })).json()) as {
      results: Array<{ sessionTitle: string; senderName?: string; seq: number }>
    }
    expect(shared.results[0]).toMatchObject({ sessionTitle: 'IM', senderName: 'Bob', seq: message.seq })

    // 撤回后不可检索（flush 后 FTS / 主表同步）
    sessions.recallMessage(sid, message.id, bob.id)
    sessions.saveNow(sid)
    expect(sessions.search(keyword, 10, bob.id)).toEqual([])
  })
})

it('通知重建有新代际；缓冲过期及未来游标明确要求补偿', () => {
  const cfg = { wsReplayBuffer: 2 } as AppConfig
  const a = new NotifyHub(cfg)
  for (let i = 0; i < 4; i++) a.publish({ sessionId: sid, type: 'notify:turn-end', payload: {} })
  expect(a.list(sid, 1).truncated).toBe(true)
  expect(a.list(sid, 99).truncated).toBe(true)
  const b = new NotifyHub(cfg)
  expect(b.list(sid, 99).epoch).not.toBe(a.list(sid, 0).epoch)
  expect(b.publish({ sessionId: sid, type: 'notify:turn-end', payload: {} }).seq).toBe(1)
})

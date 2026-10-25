/**
 * M79-A 测试：实时通道稳定化（设计 §9.9）。
 *
 * 覆盖：
 * - InboxStore：seq 单调 / 游标拉取 / 已读（单项 + upTo）/ 聚合窗口 / 保留期清理（仅删已读）；
 * - SessionReadsStore：单调推进（回退忽略）/ 未读口径（自己消息不计，agent 与 system 计入）；
 * - PresenceTracker：引用计数 / 延迟离线（抖动吸收）/ 聚合批量派发；
 * - NotifyHub（真实 WS）：用户主题定向投递 / 他人主题不可订阅 / `read` 上报 + 多端广播 /
 *   `inbox-ack` / 每用户连接上限踢最旧 / 背压 resync（同步灌帧触发）/ 断开清理。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { WebSocket as WsClient } from 'ws'
import { describe, expect, it, vi } from 'vitest'
import { NotifyHub } from '../src/ws.js'
import { InboxStore } from '../src/store/inbox.js'
import { SessionReadsStore } from '../src/store/session-reads.js'
import { PresenceTracker } from '../src/realtime/presence.js'
import { AuthService } from '../src/auth/service.js'
import { AccessService } from '../src/auth/access.js'
import type { ApiDeps } from '../src/routes/index.js'
import { createRunsRouter } from '../src/routes/runs.js'
import { ApiKeyStore, AuthSessionStore } from '../src/store/auth-sessions.js'
import { SessionMemberStore } from '../src/store/session-members.js'
import { UserStore } from '../src/store/users.js'
import { makeEnv } from './helpers.js'

// ---------- 单元：收件箱 ----------

describe('M79-A：收件箱存储（InboxStore）', () => {
  it('seq 单调递增；listSince 游标拉取；已读（单项 + upTo）', () => {
    const env = makeEnv()
    try {
      const users = new UserStore(env.db)
      const alice = users.create({ username: 'alice', displayName: 'Alice', passwordHash: 'x', role: 'member' })
      const inbox = new InboxStore(env.db)
      const first = inbox.add({ userId: alice.id, type: 'friend-request', title: 'A 请求添加你为好友' })
      const second = inbox.add({ userId: alice.id, type: 'mention', title: '会话', sessionId: 's_x', actorId: alice.id })
      const third = inbox.add({ userId: alice.id, type: 'waiting', title: '会话', sessionId: 's_x' })
      expect(first.seq).toBe(1)
      expect(second.seq).toBe(2)
      expect(third.seq).toBe(3)
      expect(inbox.cursor(alice.id)).toBe(3)
      expect(inbox.unreadCount(alice.id)).toBe(3)
      expect(inbox.listSince(alice.id, 1).map((i) => i.seq)).toEqual([2, 3])
      expect(inbox.listSince(alice.id, 3)).toEqual([])

      expect(inbox.markRead(alice.id, [first.id])).toBe(1)
      expect(inbox.unreadCount(alice.id)).toBe(2)
      expect(inbox.markRead(alice.id, [first.id])).toBe(0) // 幂等
      expect(inbox.markReadUpTo(alice.id, 2)).toBe(1)
      expect(inbox.unreadCount(alice.id)).toBe(1)
    } finally {
      env.sessions.close()
      env.db.close()
    }
  })

  it('hasRecent 聚合窗口：同类型 + 同会话 + 同触发者命中；窗口外不命中', () => {
    const env = makeEnv()
    try {
      const users = new UserStore(env.db)
      const alice = users.create({ username: 'alice', displayName: 'Alice', passwordHash: 'x', role: 'member' })
      const inbox = new InboxStore(env.db)
      inbox.add({ userId: alice.id, type: 'mention', title: '会话', sessionId: 's_1', actorId: 'u_actor' })
      expect(inbox.hasRecent(alice.id, 'mention', 's_1', 'u_actor', 60_000)).toBe(true)
      expect(inbox.hasRecent(alice.id, 'mention', 's_1', 'u_other', 60_000)).toBe(false)
      expect(inbox.hasRecent(alice.id, 'mention', 's_2', 'u_actor', 60_000)).toBe(false)
      expect(inbox.hasRecent(alice.id, 'waiting', 's_1', 'u_actor', 60_000)).toBe(false)
      expect(inbox.hasRecent(alice.id, 'mention', 's_1', 'u_actor', -1)).toBe(false) // 窗口已过
    } finally {
      env.sessions.close()
      env.db.close()
    }
  })

  it('保留期清理：仅删已读且过期的项；未读恒保留', () => {
    const env = makeEnv()
    try {
      const users = new UserStore(env.db)
      const alice = users.create({ username: 'alice', displayName: 'Alice', passwordHash: 'x', role: 'member' })
      const inbox = new InboxStore(env.db)
      const readOld = inbox.add({ userId: alice.id, type: 'system', title: '已读旧项' })
      const unreadOld = inbox.add({ userId: alice.id, type: 'system', title: '未读旧项' })
      inbox.markRead(alice.id, [readOld.id])
      env.db.run('UPDATE user_inbox SET created_at = ? WHERE id IN (?, ?)', '2020-01-01T00:00:00.000Z', readOld.id, unreadOld.id)
      expect(inbox.cleanup(30)).toBe(1)
      expect(inbox.listSince(alice.id, 0).map((i) => i.id)).toEqual([unreadOld.id])
      expect(inbox.cleanup(0)).toBe(0) // 0 = 不清理
    } finally {
      env.sessions.close()
      env.db.close()
    }
  })
})

// ---------- 单元：已读游标 ----------

describe('M79-A：会话已读游标（SessionReadsStore）', () => {
  it('单调推进（回退忽略）；未读口径 = 非本人消息（agent / system 计入）', () => {
    const env = makeEnv()
    try {
      const users = new UserStore(env.db)
      const alice = users.create({ username: 'alice', displayName: 'Alice', passwordHash: 'x', role: 'member' })
      const bob = users.create({ username: 'bob', displayName: 'Bob', passwordHash: 'x', role: 'member' })
      const session = env.sessions.create(['pm'], '未读测试', { ownerId: alice.id })
      env.sessions.appendMessage({ sessionId: session.id, role: 'user', userId: alice.id, content: '自己的消息', mentions: [], status: 'complete' })
      env.sessions.appendMessage({ sessionId: session.id, role: 'agent', agentId: 'pm', content: 'agent 消息', mentions: [], status: 'complete' })
      env.sessions.appendMessage({ sessionId: session.id, role: 'user', userId: bob.id, content: '他人消息', mentions: [], status: 'complete' })
      const reads = new SessionReadsStore(env.db)
      // 全未读：自己 1 条不计 → 2
      expect(reads.unreadFor(alice.id, [session.id]).get(session.id)).toBe(2)
      expect(reads.set(alice.id, session.id, 3)).toBe(3)
      expect(reads.unreadFor(alice.id, [session.id]).get(session.id)).toBeUndefined() // 0 未读不出现在 Map
      expect(reads.set(alice.id, session.id, 1)).toBe(3) // 回退忽略
      expect(reads.get(alice.id, session.id)).toBe(3)
      // Bob 视角：alice 的 1 条 + agent 1 条 = 2
      expect(reads.unreadFor(bob.id, [session.id]).get(session.id)).toBe(2)
    } finally {
      env.sessions.close()
      env.db.close()
    }
  })
})

// ---------- 单元：在线状态 ----------

describe('M79-A：在线状态（PresenceTracker）', () => {
  it('引用计数 / 延迟离线（抖动吸收）/ 聚合批量派发', () => {
    vi.useFakeTimers()
    try {
      const flushed: Array<Array<{ userId: string; online: boolean; lastSeenAt?: string }>> = []
      const tracker = new PresenceTracker({
        aggregateMs: 500,
        offlineDelayMs: 30_000,
        onFlush: (events) => flushed.push(events),
      })
      tracker.connect('u_1')
      tracker.connect('u_1') // 两个标签页
      tracker.disconnect('u_1')
      expect(tracker.isOnline('u_1')).toBe(true) // 仍有连接
      tracker.disconnect('u_1')
      expect(tracker.isOnline('u_1')).toBe(false)
      // 离线事件延迟派发；期间重连取消
      tracker.connect('u_1')
      vi.advanceTimersByTime(31_000)
      // 首次 online 事件已聚合派发（connect 后的 500ms 窗口）
      vi.advanceTimersByTime(500)
      expect(flushed.length).toBeGreaterThan(0)
      expect(flushed.flat().every((e) => e.online)).toBe(true) // 全程未真正离线（重连吸收了）
      tracker.disconnect('u_1')
      vi.advanceTimersByTime(31_000)
      vi.advanceTimersByTime(500)
      const last = flushed[flushed.length - 1]!
      expect(last[0]).toMatchObject({ userId: 'u_1', online: false })
      expect(last[0]!.lastSeenAt).toBeTruthy()
      tracker.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---------- 单元：通知列表（M79-AF：降级轮询 per-session 增量游标） ----------

describe('M79-AF：NotifyHub.list per-session 游标', () => {
  it('无游标全量；per-session 游标只回增量；单会话模式游标覆盖 since；非法值回退', () => {
    const env = makeEnv()
    const notify = new NotifyHub(env.cfg)
    try {
      notify.publish({ type: 'notify:turn-end', sessionId: 's1', payload: { message: { id: 'm1' } } })
      notify.publish({ type: 'notify:turn-end', sessionId: 's1', payload: { message: { id: 'm2' } } })
      notify.publish({ type: 'notify:turn-end', sessionId: 's2', payload: { message: { id: 'm3' } } })

      // 无游标：全量（旧版语义，零差异）
      expect(notify.list(undefined, 0).notifications).toHaveLength(3)

      // per-session 游标：s1 已读至 seq 1 → 只回 s1 的 seq 2；s2 无游标 → since=0 全量
      const partial = notify.list(undefined, 0, { s1: 1 })
      expect(partial.notifications).toHaveLength(2)
      expect(partial.notifications.filter((e) => e.sessionId === 's1')).toHaveLength(1)

      // 双会话游标齐：只回 s1 增量（内容锚定）
      const next = notify.list(undefined, 0, { s1: 1, s2: 1 })
      expect(next.notifications.map((e) => e.sessionId)).toEqual(['s1'])
      expect((next.notifications[0]!.payload as { message: { id: string } }).message.id).toBe('m2')

      // 单会话模式：cursors 覆盖 since；cursor = 该会话总 seq
      const single = notify.list('s1', 0, { s1: 2 })
      expect(single.notifications).toHaveLength(0)
      expect(single.cursor).toBe(2)

      // 非法游标（NaN）：回退 since（0 = 全量，兜底安全）
      const fallback = notify.list(undefined, 0, { s1: Number.NaN } as Record<string, number>)
      expect(fallback.notifications).toHaveLength(3)
    } finally {
      notify.close()
      env.sessions.close()
      env.db.close()
    }
  })

  it('GET /api/notifications：cursors 参数防御式解析并透传；非法/缺省回退全量', async () => {
    const env = makeEnv()
    const app = express()
    app.use(express.json())
    const calls: Array<{ sid: string | undefined; cursors?: Record<string, number> }> = []
    const notifyStub = {
      list: (sid: string | undefined, _since: number, cursors?: Record<string, number>) => {
        calls.push({ sid, cursors })
        return { notifications: [], cursor: 0 }
      },
    }
    app.use('/api', createRunsRouter({ ...env, notify: notifyStub } as unknown as ApiDeps))
    const server = app.listen(0)
    await new Promise<void>((resolve) => server.once('listening', () => resolve()))
    const port = (server.address() as AddressInfo).port
    try {
      // 合法 JSON：仅收数值且 >= 0 的键（'bad' 字符串 / -1 负值剔除）
      const ok = await fetch(
        `http://127.0.0.1:${port}/api/notifications?since=0&cursors=${encodeURIComponent(JSON.stringify({ s1: 3, s2: 'bad', s3: -1 }))}`,
      )
      expect(ok.status).toBe(200)
      expect(calls[0]?.cursors).toEqual({ s1: 3 })
      // 非 JSON：忽略（回退全量语义）
      await fetch(`http://127.0.0.1:${port}/api/notifications?since=0&cursors=not-json`)
      expect(calls[1]?.cursors).toBeUndefined()
      // 缺省：undefined（旧客户端零差异）
      await fetch(`http://127.0.0.1:${port}/api/notifications?since=0`)
      expect(calls[2]?.cursors).toBeUndefined()
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      env.sessions.close()
      env.db.close()
    }
  })
})

// ---------- 集成：NotifyHub 用户主题 ----------

interface SocialEnv {
  env: ReturnType<typeof makeEnv>
  auth: AuthService
  access: AccessService
  notify: NotifyHub
  inbox: InboxStore
  reads: SessionReadsStore
  server: http.Server
  port: number
  aliceToken: string
  bobToken: string
  aliceId: string
  bobId: string
}

async function makeSocialEnv(overrides: Parameters<typeof makeEnv>[0] = {}): Promise<SocialEnv> {
  const env = makeEnv(overrides)
  const users = new UserStore(env.db)
  const authSessions = new AuthSessionStore(env.db)
  const apiKeys = new ApiKeyStore(env.db)
  const auth = new AuthService({ cfg: env.cfg, users, authSessions, apiKeys, sessions: env.sessions })
  const members = new SessionMemberStore(env.db)
  const access = new AccessService({ isMultiUser: () => auth.multiUser, sessions: env.sessions, projects: env.projects, members })
  const inbox = new InboxStore(env.db)
  const reads = new SessionReadsStore(env.db)
  const notify = new NotifyHub(
    env.cfg,
    () => ({ auth, access }),
    () => ({ inbox, reads }),
  )
  await auth.setup({ username: 'alice', password: 'Str0ngPass!x' })
  const aliceLogin = await auth.login({ username: 'alice', password: 'Str0ngPass!x' })
  const bob = await auth.createUser({ username: 'bob', role: 'member' })
  const bobLogin = await auth.login({ username: 'bob', password: bob.initialPassword! })
  const server = http.createServer((_req, res) => res.end('ok'))
  notify.attach(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  return {
    env,
    auth,
    access,
    notify,
    inbox,
    reads,
    server,
    port,
    aliceToken: aliceLogin.rawToken,
    bobToken: bobLogin.rawToken,
    aliceId: aliceLogin.user.id,
    bobId: bob.user?.id ?? '',
  }
}

/** 连接并等待 welcome；返回 { socket, frames, waitFor } */
function connectClient(port: number, cookie: string): {
  socket: WsClient
  frames: Array<Record<string, unknown>>
  waitFor: (predicate: (frame: Record<string, unknown>) => boolean, timeoutMs?: number) => Promise<Record<string, unknown>>
  closed: Promise<void>
} {
  const socket = new WsClient(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } })
  const frames: Array<Record<string, unknown>> = []
  const waiters: Array<{ predicate: (f: Record<string, unknown>) => boolean; resolve: (f: Record<string, unknown>) => void }> = []
  socket.on('message', (raw) => {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(String(raw)) as Record<string, unknown>
    } catch {
      return
    }
    frames.push(parsed)
    for (const waiter of [...waiters]) {
      if (waiter.predicate(parsed)) {
        waiter.resolve(parsed)
        waiters.splice(waiters.indexOf(waiter), 1)
      }
    }
  })
  const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()))
  const waitFor = (predicate: (f: Record<string, unknown>) => boolean, timeoutMs = 3000): Promise<Record<string, unknown>> => {
    const hit = [...frames].reverse().find(predicate)
    if (hit) return Promise.resolve(hit)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待帧超时')), timeoutMs)
      waiters.push({
        predicate,
        resolve: (f) => {
          clearTimeout(timer)
          resolve(f)
        },
      })
    })
  }
  return { socket, frames, waitFor, closed }
}

async function teardown(env: SocialEnv, clients: WsClient[]): Promise<void> {
  // 先断开客户端再关闭服务端（WsHub.close 需在无存活客户端语义下收敛；残留 socket 兜底 terminate）
  for (const c of clients) c.terminate()
  await new Promise((r) => setTimeout(r, 20))
  env.notify.close()
  await new Promise<void>((resolve) => env.server.close(() => resolve()))
  env.env.sessions.close()
  env.env.db.close()
}

describe('M79-A：NotifyHub 用户主题与稳定化（真实 WS）', () => {
  it('用户主题定向投递：仅本人连接收取；他人用户主题不可订阅', async () => {
    const se = await makeSocialEnv()
    const alice = connectClient(se.port, `sid=${se.aliceToken}`)
    const carolCreate = await se.auth.createUser({ username: 'carol', role: 'member' })
    const carolLogin = await se.auth.login({ username: 'carol', password: carolCreate.initialPassword! })
    const carol = connectClient(se.port, `sid=${carolLogin.rawToken}`)
    try {
      await alice.waitFor((f) => f.type === 'welcome')
      await carol.waitFor((f) => f.type === 'welcome')

      // 定向投递：仅 alice 收
      se.notify.publishToUser(se.aliceId, 'notify:inbox', { item: { id: 'ib_1', seq: 1 } })
      await alice.waitFor((f) => f.type === 'notify:inbox')
      expect(carol.frames.some((f) => f.type === 'notify:inbox')).toBe(false)

      // 订阅他人用户主题 → 被拒（subscribed 回执不含该主题）；本人主题可订
      alice.socket.send(JSON.stringify({ type: 'subscribe', sessionIds: [`u:${se.bobId}`, `u:${se.aliceId}`] }))
      const sub = (await alice.waitFor((f) => f.type === 'subscribed')) as { sessionIds: string[] }
      expect(sub.sessionIds).toContain(`u:${se.aliceId}`)
      expect(sub.sessionIds).not.toContain(`u:${se.bobId}`)
    } finally {
      await teardown(se, [alice.socket, carol.socket])
    }
  })

  it('read 帧：落库 + 向本人其他端广播（不回发触发端）；inbox-ack 整段已读', async () => {
    const se = await makeSocialEnv()
    const session = se.env.sessions.create(['pm'], '已读集成', { ownerId: se.aliceId })
    se.env.sessions.appendMessage({ sessionId: session.id, role: 'agent', agentId: 'pm', content: 'hi', mentions: [], status: 'complete' })
    const c1 = connectClient(se.port, `sid=${se.aliceToken}`)
    const c2 = connectClient(se.port, `sid=${se.aliceToken}`)
    try {
      await c1.waitFor((f) => f.type === 'welcome')
      await c2.waitFor((f) => f.type === 'welcome')

      c1.socket.send(JSON.stringify({ type: 'read', sessionId: session.id, seq: 1 }))
      const rs = await c2.waitFor((f) => f.type === 'notify:read-state')
      expect((rs.payload as { lastReadSeq?: number }).lastReadSeq).toBe(1)
      expect(se.reads.get(se.aliceId, session.id)).toBe(1)
      // 触发端不回发
      expect(c1.frames.some((f) => f.type === 'notify:read-state')).toBe(false)

      const item = se.inbox.add({ userId: se.aliceId, type: 'system', title: '测试' })
      expect(se.inbox.unreadCount(se.aliceId)).toBe(1)
      c1.socket.send(JSON.stringify({ type: 'inbox-ack', upTo: item.seq }))
      await vi.waitFor(() => expect(se.inbox.unreadCount(se.aliceId)).toBe(0))
    } finally {
      await teardown(se, [c1.socket, c2.socket])
    }
  })

  it('每用户连接上限：超限踢最旧（conn_evicted）', async () => {
    const se = await makeSocialEnv({ wsMaxConnsPerUser: 2 })
    const c1 = connectClient(se.port, `sid=${se.aliceToken}`)
    await c1.waitFor((f) => f.type === 'welcome')
    const c2 = connectClient(se.port, `sid=${se.aliceToken}`)
    await c2.waitFor((f) => f.type === 'welcome')
    const c3 = connectClient(se.port, `sid=${se.aliceToken}`)
    try {
      await c3.waitFor((f) => f.type === 'welcome')
      const evicted = await c1.waitFor((f) => f.type === 'error' && f.code === 'conn_evicted')
      expect(evicted.code).toBe('conn_evicted')
      await c1.closed // 旧连接被断开
      expect(c2.socket.readyState).toBe(WsClient.OPEN)
      expect(c3.socket.readyState).toBe(WsClient.OPEN)
      expect(se.notify.stats().evictions).toBe(1)
    } finally {
      await teardown(se, [c1.socket, c2.socket, c3.socket])
    }
  })

  it('背压：同步灌帧超限 → resync 计数 + 连接断开', async () => {
    const se = await makeSocialEnv({ wsSendQueueMax: 2 })
    const c1 = connectClient(se.port, `sid=${se.aliceToken}`)
    try {
      await c1.waitFor((f) => f.type === 'welcome')
      // 同一 tick 内连续投递（send 回调无法插队）→ 待写计数必然累加超限
      for (let i = 0; i < 10; i++) {
        se.notify.publishToUser(se.aliceId, 'notify:inbox', { item: { id: `ib_${i}`, seq: i + 1 } })
      }
      await c1.closed // 溢出后 terminate
      expect(se.notify.stats().resyncs).toBe(1)
    } finally {
      await teardown(se, [c1.socket])
    }
  })
})

describe('IM：正在输入（typing 临时帧）', () => {
  it('同会话他人收取、发送端不回显、1.5s 节流且不占会话 seq', async () => {
    const se = await makeSocialEnv()
    const sid = se.env.sessions.create([], 'typing', { ownerId: se.aliceId, kind: 'group' }).id
    se.env.members.upsert(sid, se.bobId, 'editor', se.aliceId)
    const alice = connectClient(se.port, `sid=${se.aliceToken}`)
    const bob = connectClient(se.port, `sid=${se.bobToken}`)
    try {
      await alice.waitFor((f) => f.type === 'welcome')
      await bob.waitFor((f) => f.type === 'welcome')
      alice.socket.send(JSON.stringify({ type: 'subscribe', sessionIds: [sid] }))
      bob.socket.send(JSON.stringify({ type: 'subscribe', sessionIds: [sid] }))
      await alice.waitFor((f) => f.type === 'subscribed')
      await bob.waitFor((f) => f.type === 'subscribed')

      alice.socket.send(JSON.stringify({ type: 'typing', sessionId: sid }))
      const frame = await bob.waitFor((f) => f.type === 'notify:typing')
      expect(frame.ephemeral).toBe(true)
      expect(frame.seq).toBe(0)
      expect((frame.payload as { userId: string }).userId).toBe(se.aliceId)
      expect((frame.payload as { name?: string }).name).toBe('alice')
      expect(alice.frames.some((f) => f.type === 'notify:typing')).toBe(false)

      // 1.5s 内重复上报被服务端节流
      alice.socket.send(JSON.stringify({ type: 'typing', sessionId: sid }))
      await new Promise((r) => setTimeout(r, 150))
      expect(bob.frames.filter((f) => f.type === 'notify:typing')).toHaveLength(1)

      // 临时帧不写重放缓冲、不推进 seq
      expect(se.notify.list(sid, 0).cursor).toBe(0)
    } finally {
      await teardown(se, [alice.socket, bob.socket])
    }
  })
})

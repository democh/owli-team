/**
 * M79-L 测试：多实例演进（共享通知总线 + 跨实例 presence）。
 *
 * 覆盖：
 * - NotifyBusStore：append / maxId / listSince（origin 排除防回环）/ 保留期清理；
 * - DbNotifyBus：**跨实例投递**（实例 A 发布 → 连在实例 B 的本地连接收到；会话主题与用户主题）；
 *   防回环（A 的本地订阅者只收一次）；游标起点 = 启动时 maxId（历史行不重放）；
 * - PresenceInstanceStore：计数合并 / stale 忽略 / 心跳刷新 / stale 回收；
 * - 离线门控语义（离线事件仅在全局合计为 0 时广播——防「A 断开但 B 仍在线」误判）。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket as WsClient } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { NotifyHub } from '../src/ws.js'
import { DbNotifyBus } from '../src/realtime/notify-bus-db.js'
import { NotifyBusStore } from '../src/store/notify-bus.js'
import { PresenceInstanceStore } from '../src/store/presence-instances.js'
import { AuthService } from '../src/auth/service.js'
import { AccessService } from '../src/auth/access.js'
import { ApiKeyStore, AuthSessionStore } from '../src/store/auth-sessions.js'
import { SessionMemberStore } from '../src/store/session-members.js'
import { UserStore } from '../src/store/users.js'
import { makeEnv } from './helpers.js'

const openClients: WsClient[] = []
const openHubs: NotifyHub[] = []
const openServers: http.Server[] = []
const closeEnv: Array<() => void> = []

afterEach(async () => {
  for (const c of openClients.splice(0)) c.terminate()
  await new Promise((r) => setTimeout(r, 20))
  for (const hub of openHubs.splice(0)) hub.close()
  await Promise.all(openServers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))))
  for (const fn of closeEnv.splice(0)) fn()
})

interface FrameWaiter {
  frames: Array<Record<string, unknown>>
  waitFor: (predicate: (f: Record<string, unknown>) => boolean, timeoutMs?: number) => Promise<Record<string, unknown>>
  settled: (ms: number) => Promise<void>
}

function connectClient(port: number, cookie: string): WsClient & FrameWaiter {
  const socket = new WsClient(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } }) as WsClient & FrameWaiter
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
  socket.frames = frames
  socket.waitFor = (predicate, timeoutMs = 4000) => {
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
  socket.settled = (ms) => new Promise((r) => setTimeout(r, ms))
  openClients.push(socket)
  return socket
}

interface InstanceFixture {
  instanceId: string
  notify: NotifyHub
  port: number
}

/** 两实例共享同一 DB（模拟多实例部署）：各自 NotifyHub + http server + DbNotifyBus */
async function makeTwoInstances(): Promise<{
  env: ReturnType<typeof makeEnv>
  auth: AuthService
  a: InstanceFixture
  b: InstanceFixture
  aliceId: string
  aliceToken: string
  bobId: string
  bobToken: string
  busStore: NotifyBusStore
  presence: PresenceInstanceStore
}> {
  const env = makeEnv()
  closeEnv.push(() => {
    env.sessions.close()
    env.db.close()
  })
  const users = new UserStore(env.db)
  const authSessions = new AuthSessionStore(env.db)
  const apiKeys = new ApiKeyStore(env.db)
  const auth = new AuthService({ cfg: env.cfg, users, authSessions, apiKeys, sessions: env.sessions })
  const members = new SessionMemberStore(env.db)
  const access = new AccessService({ isMultiUser: () => auth.multiUser, sessions: env.sessions, projects: env.projects, members })
  await auth.setup({ username: 'alice', password: 'Str0ngPass!x' })
  const aliceLogin = await auth.login({ username: 'alice', password: 'Str0ngPass!x' })
  const bob = await auth.createUser({ username: 'bob', role: 'member' })
  const bobLogin = await auth.login({ username: 'bob', password: bob.initialPassword! })

  const busStore = new NotifyBusStore(env.db)
  const presence = new PresenceInstanceStore(env.db)

  const makeInstance = async (instanceId: string): Promise<InstanceFixture> => {
    const notify = new NotifyHub(
      env.cfg,
      () => ({ auth, access }),
      () => ({}),
    )
    openHubs.push(notify)
    notify.attachTransport(new DbNotifyBus({ store: busStore, instanceId, pollMs: 25 }))
    const server = http.createServer((_req, res) => res.end('ok'))
    openServers.push(server)
    notify.attach(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    return { instanceId, notify, port: (server.address() as AddressInfo).port }
  }

  return {
    env,
    auth,
    a: await makeInstance('instance-A'),
    b: await makeInstance('instance-B'),
    aliceId: aliceLogin.user.id,
    aliceToken: aliceLogin.rawToken,
    bobId: bob.user.id,
    bobToken: bobLogin.rawToken,
    busStore,
    presence,
  }
}

describe('M79-L：NotifyBusStore（行存储）', () => {
  it('append / maxId / listSince（origin 排除）/ 保留期清理', () => {
    const env = makeEnv()
    try {
      const store = new NotifyBusStore(env.db)
      expect(store.maxId()).toBe(0)
      store.append({ origin: 'A', kind: 'session', target: 's_1', type: 'notify:turn-end', payload: '{}' })
      store.append({ origin: 'B', kind: 'user', target: 'u_1', type: 'notify:inbox', payload: '{"k":1}' })
      expect(store.maxId()).toBe(2)

      // origin 排除（A 看不到自己的行）；runId 透传
      const forA = store.listSince(0, 'A')
      expect(forA.map((r) => r.target)).toEqual(['u_1'])
      expect(forA[0]).toMatchObject({ kind: 'user', type: 'notify:inbox', payload: '{"k":1}' })
      expect(store.listSince(0, 'B').map((r) => r.target)).toEqual(['s_1'])

      // 保留期清理（0 = 不清理；过期行删除）
      expect(store.cleanup(0)).toBe(0)
      env.db.run('UPDATE notify_bus SET created_at = ?', '2020-01-01T00:00:00.000Z')
      expect(store.cleanup(10)).toBe(2)
      expect(store.maxId()).toBe(0)
    } finally {
      env.sessions.close()
      env.db.close()
    }
  })

  it('游标起点 = 启动时 maxId（历史行不重放）', async () => {
    const env = makeEnv()
    try {
      const store = new NotifyBusStore(env.db)
      store.append({ origin: 'Z', kind: 'session', target: 's_old', type: 'notify:turn-end', payload: '{}' })
      const received: string[] = []
      const transport = new DbNotifyBus({ store, instanceId: 'A', pollMs: 20 })
      transport.start((e) => received.push(e.target))
      await new Promise((r) => setTimeout(r, 80))
      expect(received).toEqual([]) // 历史行被跳过
      // 新行正常投递
      store.append({ origin: 'B', kind: 'session', target: 's_new', type: 'notify:turn-end', payload: '{}' })
      await new Promise((r) => setTimeout(r, 120))
      expect(received).toEqual(['s_new'])
      expect(transport.stats()).toMatchObject({ mode: 'db', instance: 'A', received: 1 })
      transport.dispose()
    } finally {
      env.sessions.close()
      env.db.close()
    }
  })
})

describe('M79-L：跨实例投递（真实 WS · 两实例共享 DB）', () => {
  it('会话主题：A 发布 → 连在 B 的订阅者收到；A 本地仅一次（防回环）', async () => {
    const fx = await makeTwoInstances()
    // 订阅经会话 ACL（canAccessSession）——需真实会话（owner = alice）
    const session = fx.env.sessions.create(['pm'], '跨实例会话', { ownerId: fx.aliceId })
    const sid = session.id
    const clientA = connectClient(fx.a.port, `sid=${fx.aliceToken}`)
    const clientB = connectClient(fx.b.port, `sid=${fx.aliceToken}`)
    await clientA.waitFor((f) => f.type === 'welcome')
    await clientB.waitFor((f) => f.type === 'welcome')
    clientA.send(JSON.stringify({ type: 'subscribe', sessionIds: [sid] }))
    clientB.send(JSON.stringify({ type: 'subscribe', sessionIds: [sid] }))
    await clientA.waitFor((f) => f.type === 'subscribed' && Array.isArray(f.sessionIds) && (f.sessionIds as string[]).includes(sid))
    await clientB.waitFor((f) => f.type === 'subscribed' && Array.isArray(f.sessionIds) && (f.sessionIds as string[]).includes(sid))

    fx.a.notify.publish({ type: 'notify:turn-end', sessionId: sid, payload: { n: 1 } })
    await clientB.waitFor((f) => f.type === 'notify:turn-end' && f.sessionId === sid)
    await clientA.settled(150)
    // 防回环：A 本地恰一封（本地扇出一次；总线条目 origin=A 被自身过滤）
    expect(clientA.frames.filter((f) => f.type === 'notify:turn-end')).toHaveLength(1)
    expect(clientB.frames.filter((f) => f.type === 'notify:turn-end')).toHaveLength(1)
  })

  it('用户主题：A 发布 → 目标用户连在 B 收到；非目标用户不收', async () => {
    const fx = await makeTwoInstances()
    const bobOnB = connectClient(fx.b.port, `sid=${fx.bobToken}`)
    const aliceOnB = connectClient(fx.b.port, `sid=${fx.aliceToken}`)
    await bobOnB.waitFor((f) => f.type === 'welcome')
    await aliceOnB.waitFor((f) => f.type === 'welcome')

    fx.a.notify.publishToUser(fx.bobId, 'notify:inbox', { item: { id: 'ib_x', seq: 1 } })
    const frame = await bobOnB.waitFor((f) => f.type === 'notify:inbox')
    expect(frame.sessionId).toBe(`u:${fx.bobId}`)
    await aliceOnB.settled(150)
    expect(aliceOnB.frames.some((f) => f.type === 'notify:inbox')).toBe(false)
  })
})

describe('M79-L：PresenceInstanceStore（跨实例计数合并）', () => {
  it('计数合并 / stale 忽略 / 心跳刷新 / stale 回收 / 离线门控语义', () => {
    const env = makeEnv()
    try {
      const store = new PresenceInstanceStore(env.db)
      store.setCount('A', 'u_1', 2)
      store.setCount('B', 'u_1', 1)
      expect(store.globalCount('u_1', 60_000)).toBe(3)

      // A 归零（删行）→ 全局仍 1（B 在线）→ 离线门控为 false（不广播离线）
      store.setCount('A', 'u_1', 0)
      expect(store.globalCount('u_1', 60_000)).toBe(1)

      // stale：B 行过期 → 忽略 → 全局 0 → 允许广播离线
      env.db.run('UPDATE presence_instances SET updated_at = ? WHERE instance_id = ?', '2020-01-01T00:00:00.000Z', 'B')
      expect(store.globalCount('u_1', 60_000)).toBe(0)

      // 心跳刷新（touchInstance）→ stale 行恢复计数（长连不变场景防误判）
      store.touchInstance('B')
      expect(store.globalCount('u_1', 60_000)).toBe(1)

      // stale 回收：过期行删除
      env.db.run('UPDATE presence_instances SET updated_at = ? WHERE instance_id = ?', '2020-01-01T00:00:00.000Z', 'B')
      expect(store.pruneStale(60_000)).toBe(1)
      expect(store.size()).toEqual({ instances: 0, rows: 0 })
    } finally {
      env.sessions.close()
      env.db.close()
    }
  })
})

describe('M79-Y：ACL 撤销 / 账号踢出跨实例（安全面）', () => {
  it('revoke：A 实例发起 → B 实例上该用户退订（后续会话帧不再到达）+ acl-changed 提示', async () => {
    const two = await makeTwoInstances()
    // admin（alice）连接在 B；孤儿会话对 admin 放行订阅（历史数据兼容语义）
    const aliceSocket = connectClient(two.b.port, `sid=${two.aliceToken}`)
    await aliceSocket.waitFor((f) => f.type === 'welcome')
    const sid = two.env.sessions.create([], 'revoke-测试').id
    aliceSocket.send(JSON.stringify({ type: 'subscribe', sessionIds: [sid] }))
    await aliceSocket.waitFor((f) => f.type === 'subscribed')

    // 基线：跨实例会话帧可达（M79-L 路径）
    two.a.notify.publish({ type: 'notify:turn-end', sessionId: sid, payload: { marker: 'pre' } })
    await aliceSocket.waitFor((f) => (f.payload as { marker?: string } | undefined)?.marker === 'pre')

    // A 实例撤销（alice 不在 A 上——靠总线传到 B 执行）
    two.a.notify.revokeSession(two.aliceId, sid, '你已被移出该会话')
    await aliceSocket.waitFor((f) => f.type === 'error' && f.code === 'acl-changed')

    // 退订生效：后续同会话帧不再到达
    await aliceSocket.settled(120)
    two.a.notify.publish({ type: 'notify:turn-end', sessionId: sid, payload: { marker: 'post' } })
    await aliceSocket.settled(250)
    expect(
      aliceSocket.frames.some((f) => (f.payload as { marker?: string } | undefined)?.marker === 'post'),
    ).toBe(false)
  })

  it('kick：A 实例发起 → B 实例上该账号连接被断开', async () => {
    const two = await makeTwoInstances()
    const bobSocket = connectClient(two.b.port, `sid=${two.bobToken}`)
    await bobSocket.waitFor((f) => f.type === 'welcome')

    const closed = new Promise<void>((resolve) => bobSocket.on('close', () => resolve()))
    two.a.notify.kickUser(two.bobId, '账号状态已变更，请重新登录')
    await closed
  })
})

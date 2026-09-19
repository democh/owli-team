/**
 * M62 测试：多用户浏览器资源治理。
 *
 * 覆盖：
 * - 归属隔离：Profile 按 owner 命名空间（u_<userId>）、注册表落归属、兼容模式旧路径零变化；
 * - 复用归属防御：注册表 userId 不一致 → 拒绝接管；
 * - 页面分治：同实例多会话自建管理页、他人管理页永不接管（含空白页观察与回退过滤）；
 * - 配额（先回收再拒绝 / 0 = 不限）与空闲回收（订阅者 / 人工接管 / 等待人工三重豁免）；
 * - 关闭链路：closeForSession / closeForUser + close_reason / user_id 落库 + ownerOf；
 * - 启动对账：僵尸行关闭、managed 目录清理、local 目录保留（清残留）；
 * - 连接线：绑定 / member_use 复核、remote 独占租约、健康回写（含节流）、重连端点再解析；
 * - 帧流线：subscriberCount 与同用户 takeover 流转（跨用户拒绝）。
 *
 * 替身策略（M22 惯例）：FakeCdp（tests/fake-cdp.ts 共享替身）+ 注入式 launcher（不真实 spawn Chrome）
 * + 真实 SQLite（makeEnv 临时目录）。
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { AuthService } from '../src/auth/service.js'
import type { CdpClient } from '../src/browser/cdp.js'
import type { BrowserRuntimeDeps } from '../src/browser/runtime.js'
import { BrowserRuntime } from '../src/browser/runtime.js'
import {
  BrowserSession,
  type BrowserSessionCallbacks,
  type BrowserSessionOptions,
} from '../src/browser/session.js'
import { StreamHub } from '../src/stream.js'
import { StreamTokenService } from '../src/browser/stream-token.js'
import type { AppConfig } from '../src/config.js'
import { SecretVault } from '../src/connections/crypto.js'
import { AuditStore } from '../src/store/audit.js'
import { ApiKeyStore, AuthSessionStore } from '../src/store/auth-sessions.js'
import { ConnectionStore } from '../src/store/connections.js'
import { UserStore } from '../src/store/users.js'
import { INSTANCE_INFO_FILE, readInstanceInfo, type LaunchOptions, type LaunchResult } from '../src/browser/launcher.js'
import { FakeCdp } from './fake-cdp.js'
import { makeEnv } from './helpers.js'

interface RuntimeEnv {
  env: ReturnType<typeof makeEnv>
  runtime: BrowserRuntime
  connections: ConnectionStore
  owners: Map<string, string>
  subscribers: Map<string, number>
  admins: Set<string>
  published: Array<{ topic: string; message: Record<string, unknown> }>
  cdpCalls: FakeCdp[]
  launches: LaunchOptions[]
}

/** 默认替身启动器：每次返回独立端点（模拟自启实例；不真实 spawn Chrome） */
function makeRuntimeEnv(
  overrides: Partial<AppConfig> = {},
  launcherOverrides: NonNullable<BrowserRuntimeDeps['launcher']> = {},
): RuntimeEnv {
  const env = makeEnv({
    browserMaxPerUser: 0,
    browserMaxTotal: 0,
    browserIdleCloseMs: 0,
    ...overrides,
  })
  const vault = SecretVault.load({ keyFile: path.join(env.cfg.dataDir, 'secrets.key') })
  const connections = new ConnectionStore(env.db, vault)
  const audit = new AuditStore(env.db)
  const owners = new Map<string, string>()
  const subscribers = new Map<string, number>()
  const admins = new Set<string>()
  const published: Array<{ topic: string; message: Record<string, unknown> }> = []
  const cdpCalls: FakeCdp[] = []
  const launches: LaunchOptions[] = []
  let seq = 0
  const runtime = new BrowserRuntime({
    cfg: env.cfg,
    db: env.db,
    audit,
    connections,
    publish: (topic, message) => published.push({ topic, message }),
    ownerOfSession: (sessionId) => owners.get(sessionId),
    subscriberCount: (topic) => subscribers.get(topic) ?? 0,
    isAdminUser: (userId) => admins.has(userId),
    cdpFactory: () => {
      const fake = new FakeCdp()
      cdpCalls.push(fake)
      return fake as unknown as CdpClient
    },
    launcher: {
      launchBrowser:
        launcherOverrides.launchBrowser ??
        (async (opts) => {
          seq += 1
          const id = seq
          launches.push(opts)
          fs.mkdirSync(opts.profileRoot, { recursive: true })
          const profileDir =
            opts.backend === 'managed'
              ? fs.mkdtempSync(path.join(opts.profileRoot, 'managed-'))
              : path.join(opts.profileRoot, 'local')
          fs.mkdirSync(profileDir, { recursive: true })
          const result: LaunchResult = {
            endpoint: `ws://fake/${id}`,
            backend: opts.backend,
            pid: 800_000 + id,
            profileDir,
            executable: '/bin/fake-browser',
            external: false,
          }
          return result
        }),
      killLaunchedBrowser: launcherOverrides.killLaunchedBrowser ?? (() => undefined),
      openInSystemBrowser: launcherOverrides.openInSystemBrowser ?? (async () => undefined),
      resolveCdpEndpoint:
        launcherOverrides.resolveCdpEndpoint ?? (async (raw) => `ws://resolved/${encodeURIComponent(raw)}`),
    },
  })
  return { env, runtime, connections, owners, subscribers, admins, published, cdpCalls, launches }
}

function dispose(t: RuntimeEnv): void {
  t.runtime.stopReclaimLoop()
  t.env.db.close()
}

describe('M62：多用户浏览器资源治理', () => {
  it('归属隔离：Profile 按 owner 命名空间 + 注册表落归属；兼容模式沿用旧路径', async () => {
    const t = makeRuntimeEnv()
    try {
      t.owners.set('s_a', 'u_a')
      const sessionA = await t.runtime.ensureForSession('s_a', { backend: 'local' })
      const profileDir = path.join(t.env.cfg.dataDir, 'browser-profile', 'u_u_a', 'local')
      expect(sessionA.endpoint).toBe('ws://fake/1')
      expect(fs.existsSync(profileDir)).toBe(true)
      const info = readInstanceInfo(profileDir)
      expect(info?.userId).toBe('u_a')
      expect(info?.browserSessionId).toBe(sessionA.id)
      // 信息面暴露归属
      expect(t.runtime.list().find((s) => s.id === sessionA.id)?.ownerId).toBe('u_a')

      // 兼容模式（无归属）：旧路径 browser-profile/local，注册表 userId 缺省
      await t.runtime.ensureForSession('s_c', { backend: 'local' })
      const legacyDir = path.join(t.env.cfg.dataDir, 'browser-profile', 'local')
      expect(fs.existsSync(legacyDir)).toBe(true)
      expect(readInstanceInfo(legacyDir)?.userId).toBeUndefined()
    } finally {
      dispose(t)
    }
  })

  it('复用归属防御：注册表 userId 与当前用户不一致 → 拒绝接管', async () => {
    const env = makeEnv({ browserMaxPerUser: 0, browserMaxTotal: 0, browserIdleCloseMs: 0 })
    const vault = SecretVault.load({ keyFile: path.join(env.cfg.dataDir, 'secrets.key') })
    const connections = new ConnectionStore(env.db, vault)
    const profileDir = path.join(env.cfg.dataDir, 'browser-profile', 'u_u_a', 'local')
    fs.mkdirSync(profileDir, { recursive: true })
    fs.writeFileSync(
      path.join(profileDir, INSTANCE_INFO_FILE),
      JSON.stringify({
        v: 1,
        browserSessionId: 'bs_old',
        sessionId: 's_old',
        userId: 'u_other',
        backend: 'local',
        endpoint: 'ws://shared/old',
        headless: true,
        startedAt: '',
      }),
    )
    const runtime = new BrowserRuntime({
      cfg: env.cfg,
      db: env.db,
      audit: new AuditStore(env.db),
      connections,
      publish: () => undefined,
      ownerOfSession: (sessionId) => (sessionId === 's_a' ? 'u_a' : undefined),
      cdpFactory: () => new FakeCdp() as unknown as CdpClient,
      launcher: {
        // 模拟「复用已有实例」：external、无 pid
        launchBrowser: async (opts) =>
          ({
            endpoint: 'ws://shared/old',
            backend: opts.backend,
            profileDir,
            executable: '/bin/fake-browser',
            external: true,
          }) satisfies LaunchResult,
        killLaunchedBrowser: () => undefined,
      },
    })
    try {
      await expect(runtime.ensureForSession('s_a', { backend: 'local' })).rejects.toThrow(
        /已被其他账号的实例占用/,
      )
    } finally {
      env.db.close()
    }
  })

  it('配额：先回收空闲实例再拒绝；全局上限拦截；0 = 不限', async () => {
    const t = makeRuntimeEnv({ browserMaxPerUser: 1, browserIdleCloseMs: 40 })
    try {
      t.owners.set('s_1', 'u_a')
      t.owners.set('s_2', 'u_a')
      const first = await t.runtime.ensureForSession('s_1', { backend: 'managed' })
      await expect(t.runtime.ensureForSession('s_2', { backend: 'managed' })).rejects.toThrow(/单用户上限/)
      // 空闲超时后：先回收再放行
      await new Promise((resolve) => setTimeout(resolve, 60))
      const second = await t.runtime.ensureForSession('s_2', { backend: 'managed' })
      expect(second.isClosed()).toBe(false)
      expect(first.isClosed()).toBe(true)
      expect(
        t.published.some(
          (p) => p.message.type === 'closed' && String(p.message.reason).includes('空闲超时自动关闭'),
        ),
      ).toBe(true)
    } finally {
      dispose(t)
    }

    // 全局上限（跨用户）
    const g = makeRuntimeEnv({ browserMaxTotal: 1 })
    try {
      g.owners.set('s_1', 'u_a')
      g.owners.set('s_2', 'u_b')
      await g.runtime.ensureForSession('s_1', { backend: 'managed' })
      await expect(g.runtime.ensureForSession('s_2', { backend: 'managed' })).rejects.toThrow(/全局上限/)
    } finally {
      dispose(g)
    }

    // 0 = 不限
    const unlimited = makeRuntimeEnv()
    try {
      unlimited.owners.set('s_1', 'u_a')
      unlimited.owners.set('s_2', 'u_a')
      await unlimited.runtime.ensureForSession('s_1', { backend: 'managed' })
      await unlimited.runtime.ensureForSession('s_2', { backend: 'managed' })
    } finally {
      dispose(unlimited)
    }
  })

  it('空闲回收豁免：订阅者 / 人工接管 / 等待人工不回收；归零后可回收并广播原因', async () => {
    const t = makeRuntimeEnv({ browserIdleCloseMs: 1 })
    try {
      t.owners.set('s_1', 'u_a')
      const session = await t.runtime.ensureForSession('s_1', { backend: 'managed' })
      await new Promise((resolve) => setTimeout(resolve, 10))
      t.subscribers.set(`browser:${session.id}`, 1)
      expect(await t.runtime.reclaimIdle()).toBe(0)
      t.subscribers.delete(`browser:${session.id}`)

      await session.takeover('user')
      expect(await t.runtime.reclaimIdle()).toBe(0)
      await session.release('user')
      await session.requestHuman('登录')
      expect(await t.runtime.reclaimIdle()).toBe(0)

      // 回到 ready 并静置：可回收
      await session.release('agent')
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(await t.runtime.reclaimIdle()).toBe(1)
      expect(session.isClosed()).toBe(true)
      expect(t.published.some((p) => p.message.type === 'closed' && String(p.message.reason).includes('空闲'))).toBe(
        true,
      )
    } finally {
      dispose(t)
    }
  })

  it('关闭链路：closeForSession / closeForUser 关闭实例并落关闭原因与归属', async () => {
    const t = makeRuntimeEnv()
    try {
      t.owners.set('s_1', 'u_a')
      const session = await t.runtime.ensureForSession('s_1', { backend: 'managed' })
      expect(await t.runtime.closeForSession('s_1', 'user')).toBe(1)
      expect(session.isClosed()).toBe(true)
      const row = t.env.db.get<{ close_reason: string | null; user_id: string | null; state: string }>(
        'SELECT close_reason, user_id, state FROM browser_sessions WHERE id = ?',
        session.id,
      )
      expect(row?.close_reason).toBe('会话删除')
      expect(row?.user_id).toBe('u_a')
      expect(row?.state).toBe('closed')
      // 已关闭会话的归属可查（成员回放判定数据源）
      expect(t.runtime.ownerOf(session.id)).toBe('u_a')

      t.owners.set('s_2', 'u_b')
      const session2 = await t.runtime.ensureForSession('s_2', { backend: 'managed' })
      expect(await t.runtime.closeForUser('u_b', 'user')).toBe(1)
      expect(session2.isClosed()).toBe(true)
      const row2 = t.env.db.get<{ close_reason: string | null }>(
        'SELECT close_reason FROM browser_sessions WHERE id = ?',
        session2.id,
      )
      expect(row2?.close_reason).toBe('用户删除')
      expect(await t.runtime.closeForUser('u_b', 'user')).toBe(0)
    } finally {
      dispose(t)
    }
  })

  it('启动对账：僵尸行关闭 + managed 目录清理 + local 目录保留（清残留）', async () => {
    const t = makeRuntimeEnv()
    try {
      const base = path.join(t.env.cfg.dataDir, 'browser-profile', 'u_u_a')
      const managed = path.join(base, 'managed-stale')
      fs.mkdirSync(managed, { recursive: true })
      fs.writeFileSync(
        path.join(managed, INSTANCE_INFO_FILE),
        JSON.stringify({
          v: 1,
          browserSessionId: 'bs_x',
          sessionId: 's_x',
          backend: 'managed',
          pid: 999_999_999,
          endpoint: 'ws://x',
          headless: true,
          startedAt: '',
        }),
      )
      fs.writeFileSync(path.join(managed, 'data.bin'), 'x')
      const local = path.join(base, 'local')
      fs.mkdirSync(local, { recursive: true })
      fs.writeFileSync(path.join(local, 'DevToolsActivePort'), '1234\n/devtools/browser/x')
      fs.writeFileSync(
        path.join(local, INSTANCE_INFO_FILE),
        JSON.stringify({
          v: 1,
          browserSessionId: 'bs_y',
          sessionId: 's_y',
          backend: 'local',
          pid: 999_999_999,
          endpoint: 'ws://y',
          headless: true,
          startedAt: '',
        }),
      )
      t.env.db.run(
        "INSERT INTO browser_sessions (id, session_id, backend, state, controller, created_at) VALUES ('bs_zombie','s_z','local','ready','agent', ?)",
        new Date().toISOString(),
      )
      await t.runtime.reconcileOnStartup()
      expect(fs.existsSync(managed)).toBe(false)
      expect(fs.existsSync(local)).toBe(true)
      expect(fs.existsSync(path.join(local, 'DevToolsActivePort'))).toBe(false)
      expect(fs.existsSync(path.join(local, INSTANCE_INFO_FILE))).toBe(false)
      const row = t.env.db.get<{ closed_at: string | null; close_reason: string | null }>(
        'SELECT closed_at, close_reason FROM browser_sessions WHERE id = ?',
        'bs_zombie',
      )
      expect(row?.closed_at).toBeTruthy()
      expect(row?.close_reason).toBe('service_restart')
      expect(
        t.env.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'browser.reconcile'")?.n,
      ).toBe(1)
    } finally {
      dispose(t)
    }
  })

  it('连接线：绑定 / member_use 复核 + remote 独占租约 + 健康回写 ok', async () => {
    const t = makeRuntimeEnv()
    try {
      const conn = t.connections.create({
        name: '远程调试',
        kind: 'chrome',
        config: { backend: 'remote', endpoint: 'http://127.0.0.1:9222' },
      })
      const sessionA = t.env.sessions.create(['pm'], '会话 A').id
      const sessionB = t.env.sessions.create(['pm'], '会话 B').id
      t.owners.set(sessionA, 'u_a')
      t.owners.set(sessionB, 'u_b')
      t.admins.add('u_a')

      // 未绑定 → 拒绝
      await expect(t.runtime.ensureForSession(sessionA, { connectionId: conn.id })).rejects.toThrow(/未绑定/)
      // 绑定后 → 成功 + 健康回写 ok
      t.connections.bind(sessionA, conn.id)
      const first = await t.runtime.ensureForSession(sessionA, { connectionId: conn.id })
      expect(first.backend).toBe('remote')
      expect(t.connections.get(conn.id)?.status).toBe('ok')

      // 第二会话（同连接）→ 独占租约拒绝
      t.connections.bind(sessionB, conn.id)
      await expect(t.runtime.ensureForSession(sessionB, { connectionId: conn.id })).rejects.toThrow(
        /正在被其他会话使用/,
      )

      // 关闭后租约释放 → 可接入
      await t.runtime.close(first.id, 'user')
      const second = await t.runtime.ensureForSession(sessionB, { connectionId: conn.id })
      expect(second.backend).toBe('remote')

      // member + member_use=0 → 拒绝（即使已绑定；需先关闭既有实例绕过复用短路）
      await t.runtime.close(second.id, 'user')
      const conn2 = t.connections.create({
        name: '受限远程',
        kind: 'chrome',
        config: { backend: 'remote', endpoint: 'http://127.0.0.1:9333' },
      })
      t.env.db.run('UPDATE connections SET member_use = 0 WHERE id = ?', conn2.id)
      t.connections.bind(sessionB, conn2.id)
      await expect(t.runtime.ensureForSession(sessionB, { connectionId: conn2.id })).rejects.toThrow(
        /不允许成员使用/,
      )
    } finally {
      dispose(t)
    }
  })

  it('健康回写：启动失败落 error 且 30s 节流内不覆盖首因', async () => {
    let failure = 'boom-1'
    const t = makeRuntimeEnv(
      {},
      {
        launchBrowser: async () => {
          throw new Error(failure)
        },
      },
    )
    try {
      const conn = t.connections.create({
        name: '本机 Chrome',
        kind: 'chrome',
        config: { backend: 'local' },
      })
      const sessionA = t.env.sessions.create(['pm'], '会话 A').id
      t.owners.set(sessionA, 'u_a')
      t.connections.bind(sessionA, conn.id)
      await expect(t.runtime.ensureForSession(sessionA, { connectionId: conn.id })).rejects.toThrow('boom-1')
      expect(t.connections.get(conn.id)?.status).toBe('error')
      expect(t.connections.get(conn.id)?.lastError).toContain('boom-1')

      failure = 'boom-2'
      await expect(t.runtime.ensureForSession(sessionA, { connectionId: conn.id })).rejects.toThrow('boom-2')
      expect(t.connections.get(conn.id)?.lastError).toContain('boom-1')
    } finally {
      dispose(t)
    }
  })

  it('页面分治：同实例后续会话自建管理页；他人管理页永不接管（含回退过滤）', async () => {
    let seq = 0
    const t = makeRuntimeEnv(
      {},
      {
        launchBrowser: async (opts) => {
          seq += 1
          const profileDir = path.join(opts.profileRoot, 'local')
          fs.mkdirSync(profileDir, { recursive: true })
          const shared: LaunchResult = {
            endpoint: 'ws://shared/1',
            backend: 'local',
            profileDir,
            executable: '/bin/fake-browser',
            external: seq > 1,
          }
          return seq === 1 ? { ...shared, pid: 100 } : shared
        },
      },
    )
    try {
      t.owners.set('s_1', 'u_a')
      t.owners.set('s_2', 'u_a')
      const s1 = await t.runtime.ensureForSession('s_1', { backend: 'local' })
      const fake1 = t.cdpCalls[0]!
      const s2 = await t.runtime.ensureForSession('s_2', { backend: 'local' })
      const fake2 = t.cdpCalls[1]!

      // 会话 2 强制新建自有管理页（不与会话 1 抢页）
      expect(fake2.calls('Target.createTarget')).toEqual([{ url: 'about:blank' }])
      expect(fake2.currentTargetId).toBe('page-2')
      expect(s2.info().currentUrl).toBeUndefined()

      // 会话 1 视角：会话 2 的管理页（空白 → 导航）为 foreign → 不观察、不接管
      fake1.openTarget({ targetId: 'page-2', url: 'about:blank' })
      fake1.changeTargetUrl('page-2', 'https://b.example.com/')
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(fake1.calls('Target.attachToTarget')).toHaveLength(0)

      // 回退过滤：会话 1 自己的页面关闭，剩余仅 foreign → 不回退接管，进入无页状态
      fake1.closeTarget('page-1')
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(fake1.calls('Target.attachToTarget')).toHaveLength(0)
      expect(s1.info().currentUrl).toBeUndefined()
      const actions = t.env.db
        .all<{ action: string }>('SELECT action FROM browser_steps WHERE browser_session_id = ? ORDER BY seq', s1.id)
        .map((row) => row.action)
      expect(actions).toContain('page_closed')
    } finally {
      dispose(t)
    }
  })

  it('端点再解析：重连前重新解析端点并回传（remote 重启换端口）', async () => {
    const fake = new FakeCdp({ initialUrl: 'https://a.example.com/' })
    const next = new FakeCdp({ initialUrl: 'https://a.example.com/' })
    const changes: string[] = []
    const callbacks: BrowserSessionCallbacks = {
      onFrame: () => undefined,
      onState: () => undefined,
      onStep: () => undefined,
      onClosed: () => undefined,
    }
    const options: BrowserSessionOptions = {
      id: 'bs_r',
      sessionId: 's_r',
      backend: 'remote',
      endpoint: 'ws://old/1',
      external: true,
      cfg: {
        browserViewportWidth: 1280,
        browserViewportHeight: 800,
        browserFrameQuality: 60,
        browserStepShots: false,
        browserScreenshotDir: path.join(os.tmpdir(), 'ma-m62-shots'),
      } as unknown as AppConfig,
      callbacks,
      cdpFactory: () => next as unknown as CdpClient,
      reconnectDelaysMs: [1, 1, 1],
      resolveEndpoint: async () => 'ws://new/2',
      onEndpointChange: (endpoint) => changes.push(endpoint),
    }
    const session = new BrowserSession(options)
    await session.start(fake as unknown as CdpClient)
    fake.emitClose('endpoint restart')
    const deadline = Date.now() + 2_000
    while (session.info().state !== 'ready' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(session.info().state).toBe('ready')
    expect(next.connectCalls).toEqual([{ url: 'ws://new/2' }])
    expect(session.endpoint).toBe('ws://new/2')
    expect(changes).toEqual(['ws://new/2'])
  })

  it('帧流线：subscriberCount + 同用户 takeover 流转（跨用户拒绝）', async () => {
    const env = makeEnv({ browserStreamTokenTtlMs: 60_000 })
    let hub: StreamHub | undefined
    let server: http.Server | undefined
    const sockets: WebSocket[] = []
    try {
      const users = new UserStore(env.db)
      const authSessions = new AuthSessionStore(env.db)
      const apiKeys = new ApiKeyStore(env.db)
      const auth = new AuthService({
        cfg: env.cfg,
        users,
        authSessions,
        apiKeys,
        sessions: env.sessions,
      })
      await auth.setup({ username: 'admin', password: 'Str0ngPass!x' })
      const bob = await auth.createUser({ username: 'bob', role: 'member' })
      const bobLogin = await auth.login({ username: 'bob', password: bob.initialPassword! })
      const carol = await auth.createUser({ username: 'carol', role: 'member' })
      const carolLogin = await auth.login({ username: 'carol', password: carol.initialPassword! })

      const tokens = new StreamTokenService(env.cfg.browserStreamTokenTtlMs)
      const fakeSession = {
        isClosed: () => false,
        getLastFrame: () => undefined,
        controller: 'agent',
        takeover: async () => undefined,
      }
      const runtimeStub = {
        get: (id: string) => (id === 'bs1' ? fakeSession : undefined),
      } as unknown as import('../src/browser/runtime.js').BrowserRuntime
      hub = new StreamHub(env.cfg, runtimeStub, tokens, () => ({ auth }))
      server = http.createServer()
      hub.attach(server)
      await new Promise<void>((resolve) => server!.listen(0, () => resolve()))
      const port = (server.address() as AddressInfo).port

      const connect = async (rawToken: string): Promise<{ ws: WebSocket; messages: Array<Record<string, unknown>> }> => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/stream`, {
          headers: { cookie: `sid=${rawToken}` },
        })
        const messages: Array<Record<string, unknown>> = []
        ws.on('message', (raw) => messages.push(JSON.parse(String(raw)) as Record<string, unknown>))
        sockets.push(ws)
        await new Promise<void>((resolve, reject) => {
          ws.once('open', () => resolve())
          ws.once('error', reject)
        })
        return { ws, messages }
      }
      const waitMessage = async (
        messages: Array<Record<string, unknown>>,
        predicate: (message: Record<string, unknown>) => boolean,
      ): Promise<Record<string, unknown>> => {
        const deadline = Date.now() + 2_000
        while (Date.now() < deadline) {
          const hit = messages.find(predicate)
          if (hit) return hit
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
        throw new Error('等待 WS 消息超时')
      }

      // 客户端 1（bob）：takeover 订阅成功
      const bobA = await connect(bobLogin.rawToken)
      const bobAToken = tokens.issue('browser:bs1', 'takeover', bobLogin.user.id).token
      bobA.ws.send(JSON.stringify({ type: 'subscribe', topic: 'browser:bs1', token: bobAToken }))
      await waitMessage(bobA.messages, (m) => m.type === 'subscribed')

      // 客户端 2（同用户 bob）：接管流转 —— 新视图拿到 takeover，旧视图降级观察
      const bobB = await connect(bobLogin.rawToken)
      const bobBToken = tokens.issue('browser:bs1', 'takeover', bobLogin.user.id).token
      bobB.ws.send(JSON.stringify({ type: 'subscribe', topic: 'browser:bs1', token: bobBToken }))
      const moved = await waitMessage(bobA.messages, (m) => m.type === 'error' && m.code === 'takeover_moved')
      expect(moved.code).toBe('takeover_moved')
      const bobBSubscribed = await waitMessage(bobB.messages, (m) => m.type === 'subscribed')
      expect(bobBSubscribed.mode).toBe('takeover')

      // 客户端 3（carol，跨用户）：拒绝
      const carolWs = await connect(carolLogin.rawToken)
      const carolToken = tokens.issue('browser:bs1', 'takeover', carolLogin.user.id).token
      carolWs.ws.send(JSON.stringify({ type: 'subscribe', topic: 'browser:bs1', token: carolToken }))
      const busy = await waitMessage(carolWs.messages, (m) => m.type === 'error')
      expect(busy.code).toBe('takeover_busy')

      // 订阅计数（回收判定数据源）：bob 两个视图均在订
      expect(hub.subscriberCount('browser:bs1')).toBe(2)
    } finally {
      for (const ws of sockets) ws.close()
      hub?.close()
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
      env.db.close()
    }
  })
})

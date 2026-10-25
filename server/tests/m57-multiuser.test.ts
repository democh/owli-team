/**
 * M57 测试：多用户（账号 / 登录 / 归属隔离 / 兼容模式）。
 *
 * 覆盖：
 * - 首启 setup（存量数据回填）→ 登录 → 登出（HTTP 集成，含 sid cookie）；
 * - 登录防爆破（失败计数 → 锁定）与账号禁用；
 * - 会话令牌滑动/撤销、改密吊销其它会话、API Key 校验；
 * - AccessService：跨用户 404、列表/搜索作用域；
 * - 记忆用户维度过滤（global 桶按用户）、流 token 用户绑定；
 * - 引擎 per-user 并发上限。
 */
import express from 'express'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { AuthService } from '../src/auth/service.js'
import { AccessService } from '../src/auth/access.js'
import { StreamTokenService } from '../src/browser/stream-token.js'
import type { AppConfig } from '../src/config.js'
import { createAuthMiddleware } from '../src/middleware.js'
import { createAuthRouter } from '../src/routes/auth.js'
import { ApiKeyStore, AuthSessionStore } from '../src/store/auth-sessions.js'
import { UserStore } from '../src/store/users.js'
import { makeEnv, waitRunFinished } from './helpers.js'

function makeAuthEnv(overrides: Partial<AppConfig> = {}) {
  const env = makeEnv(overrides)
  const users = new UserStore(env.db)
  const authSessions = new AuthSessionStore(env.db)
  const apiKeys = new ApiKeyStore(env.db)
  const auth = new AuthService({ cfg: env.cfg, users, authSessions, apiKeys, sessions: env.sessions })
  return { env, users, authSessions, apiKeys, auth }
}

describe('M57：多用户（P1）', () => {
  it('首启 setup → 存量数据回填 → 登录态 /me → 登出撤销', async () => {
    const { env, users, auth } = makeAuthEnv()
    // 单用户时期的历史数据（无属主）
    const legacy = env.sessions.create(['pm'], '历史会话')
    expect(env.sessions.getSession(legacy.id)?.ownerId).toBeUndefined()

    // 组装真实 HTTP（认证中间件 + 认证路由）
    const app = express()
    app.use(express.json())
    app.use('/api', createAuthMiddleware(env.cfg, auth))
    app.use(
      '/api',
      createAuthRouter({
        cfg: env.cfg,
        auth,
        users,
        loginLimiter: (_req, _res, next) => next(),
      }),
    )
    const server = app.listen(0)
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const { port } = server.address() as AddressInfo
    const base = `http://127.0.0.1:${port}`

    try {
      const status = (await (await fetch(`${base}/api/auth/status`)).json()) as {
        needsSetup: boolean
        multiUser: boolean
      }
      expect(status.needsSetup).toBe(true)
      expect(status.multiUser).toBe(false)

      const setupRes = await fetch(`${base}/api/auth/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'Str0ngPass!x', displayName: '引导管理员' }),
      })
      expect(setupRes.status).toBe(201)
      const cookie = (setupRes.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
      expect(cookie).toContain('sid=')
      const setupBody = (await setupRes.json()) as { user: { id: string; role: string }; mustChangePassword: boolean }
      expect(setupBody.user.role).toBe('admin')
      expect(setupBody.mustChangePassword).toBe(false)

      // 存量数据回填给引导管理员
      expect(env.sessions.getSession(legacy.id)?.ownerId).toBe(setupBody.user.id)
      expect(env.sessions.list(setupBody.user.id).map((s) => s.id)).toContain(legacy.id)

      // /me 登录态
      const me = (await (await fetch(`${base}/api/auth/me`, { headers: { cookie } })).json()) as {
        isAdmin: boolean
        user: { username: string }
      }
      expect(me.isAdmin).toBe(true)
      expect(me.user.username).toBe('admin')

      // 无 cookie → 401
      expect((await fetch(`${base}/api/auth/me`)).status).toBe(401)

      // 登出撤销
      expect((await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie } })).status).toBe(200)
      expect((await fetch(`${base}/api/auth/me`, { headers: { cookie } })).status).toBe(401)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      env.sessions.close()
      env.db.close()
    }
  })

  it('登出清 legacy auth_token cookie：AUTH_TOKEN 入口用户不会 reload 后又回到应用', async () => {
    const { env, users, auth } = makeAuthEnv({ authToken: 'entry-secret' })
    await auth.setup({ username: 'admin', password: 'Str0ngPass!x' })
    const app = express()
    app.use(express.json())
    app.use('/api', createAuthMiddleware(env.cfg, auth))
    app.use(
      '/api',
      createAuthRouter({ cfg: env.cfg, auth, users, loginLimiter: (_req, _res, next) => next() }),
    )
    const server = app.listen(0)
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      // 浏览器曾用 /?token= 进入：同时持有 sid 与 legacy auth_token
      const login = await auth.login({ username: 'admin', password: 'Str0ngPass!x' })
      const logout = await fetch(`${base}/api/auth/logout`, {
        method: 'POST',
        headers: { cookie: `sid=${encodeURIComponent(login.rawToken)}; auth_token=entry-secret` },
      })
      expect(logout.status).toBe(200)
      const setCookie = logout.headers.getSetCookie().join('\n')
      expect(setCookie).toContain('sid=;')
      expect(setCookie).toContain('auth_token=;')

      // 两个 cookie 都被 Max-Age=0 清除后（浏览器落地）→ /me 必须回到未登录
      expect((await fetch(`${base}/api/auth/me`)).status).toBe(401)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      env.sessions.close()
      env.db.close()
    }
  })

  it('首登强制改密：未改密前仅开放自救接口（其余 /api → 403）', async () => {
    const { env, users, auth } = makeAuthEnv()
    await auth.setup({ username: 'admin', password: 'Str0ngPass!x' })
    const bob = await auth.createUser({ username: 'bob', role: 'member' })
    const login = await auth.login({ username: 'bob', password: bob.initialPassword! })
    expect(login.mustChangePassword).toBe(true)

    const app = express()
    app.use(express.json())
    app.use('/api', createAuthMiddleware(env.cfg, auth))
    app.use(
      '/api',
      createAuthRouter({ cfg: env.cfg, auth, users, loginLimiter: (_req, _res, next) => next() }),
    )
    app.get('/api/sessions', (_req, res) => {
      res.json({ sessions: [] })
    })
    const server = app.listen(0)
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const { port } = server.address() as AddressInfo
    const base = `http://127.0.0.1:${port}`
    const cookie = `sid=${encodeURIComponent(login.rawToken)}`
    try {
      // 自救接口可访问
      expect((await fetch(`${base}/api/auth/me`, { headers: { cookie } })).status).toBe(200)
      // 其余接口 403（含客户端启动依赖的 /api/sessions）
      expect((await fetch(`${base}/api/sessions`, { headers: { cookie } })).status).toBe(403)
      // 改密后放行
      const changed = await fetch(`${base}/api/auth/password`, {
        method: 'POST',
        headers: { cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: bob.initialPassword!, newPassword: 'FreshPass2@' }),
      })
      expect(changed.status).toBe(200)
      expect((await fetch(`${base}/api/sessions`, { headers: { cookie } })).status).toBe(200)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      env.sessions.close()
      env.db.close()
    }
  })

  it('登录防爆破：连续失败达阈值 → 锁定（429）；API Key 签发 / 校验 / 撤销', async () => {
    const { auth } = makeAuthEnv()
    await auth.setup({ username: 'admin', password: 'Str0ngPass!x' })
    const bob = await auth.createUser({ username: 'bob', role: 'member' })
    expect(bob.initialPassword).toBeTruthy()

    // 初始密码登录 → 强制改密标记
    const first = await auth.login({ username: 'bob', password: bob.initialPassword! })
    expect(first.mustChangePassword).toBe(true)

    // 连续失败：前 threshold-1 次 401；第 threshold 次置锁（429）；正确密码也被锁
    const threshold = 5
    for (let i = 1; i < threshold; i++) {
      await expect(auth.login({ username: 'bob', password: 'wrong-pass-1' })).rejects.toMatchObject({ status: 401 })
    }
    await expect(auth.login({ username: 'bob', password: 'wrong-pass-1' })).rejects.toMatchObject({ status: 429 })
    await expect(auth.login({ username: 'bob', password: bob.initialPassword! })).rejects.toMatchObject({ status: 429 })

    // API Key（admin）
    const created = auth.createApiKey(bob.user.id, 'cli')
    expect(auth.verifyApiKey(created.raw)?.id).toBe(bob.user.id)
    auth.revokeApiKey(bob.user.id, created.key.id)
    expect(auth.verifyApiKey(created.raw)).toBeUndefined()
  })

  it('改密吊销其它会话（当前会话保留）；禁用即时生效', async () => {
    const { auth, authSessions } = makeAuthEnv()
    const setup = await auth.setup({ username: 'admin', password: 'PasswordA1!' })
    const l1 = await auth.login({ username: 'admin', password: 'PasswordA1!' })
    void setup
    void authSessions
    const l2 = await auth.login({ username: 'admin', password: 'PasswordA1!' })

    await auth.changePassword({
      userId: l1.user.id,
      currentPassword: 'PasswordA1!',
      newPassword: 'PasswordB2@',
      keepSessionToken: l1.rawToken,
    })
    expect(auth.verifySessionToken(l1.rawToken)).toBeDefined()
    expect(auth.verifySessionToken(l2.rawToken)).toBeUndefined()

    // 禁用 → 全部会话失效（用成员账号验证；管理员受「至少保留一名」护栏保护）
    const carol = await auth.createUser({ username: 'carol', role: 'member' })
    const l3 = await auth.login({ username: 'carol', password: carol.initialPassword! })
    expect(auth.verifySessionToken(l3.rawToken)).toBeDefined()
    auth.updateUser(carol.user.id, { status: 'disabled' })
    expect(auth.verifySessionToken(l3.rawToken)).toBeUndefined()
  })

  it('AccessService：跨用户 404；列表 / 搜索按属主过滤', () => {
    const { env, users } = makeAuthEnv()
    const access = new AccessService({
      isMultiUser: () => true,
      sessions: env.sessions,
      projects: env.projects,
      members: env.members,
    })
    const uA = users.create({ username: 'alice', displayName: 'Alice', passwordHash: 'x', role: 'member' })
    const uB = users.create({ username: 'brian', displayName: 'Brian', passwordHash: 'x', role: 'member' })
    const sA = env.sessions.create(['pm'], 'A 的会话', { ownerId: uA.id })
    const sB = env.sessions.create(['pm'], 'B 的会话', { ownerId: uB.id })
    const userA = { id: uA.id, username: 'alice', displayName: 'Alice', role: 'member' as const }
    const userB = { id: uB.id, username: 'brian', displayName: 'Brian', role: 'member' as const }

    expect(access.canAccessSession(userA, sA.id)).toBe(true)
    expect(access.canAccessSession(userA, sB.id)).toBe(false)
    expect(() => access.assertSession(userA, sB.id)).toThrowError(/会话不存在/)
    expect(() => access.assertSession(userA, 's_missing')).toThrowError(/会话不存在/)

    expect(env.sessions.list(uA.id).map((s) => s.id)).toEqual([sA.id])
    expect(env.sessions.list(uB.id).map((s) => s.id)).toEqual([sB.id])

    env.sessions.appendMessage({
      sessionId: sB.id,
      role: 'user',
      userId: uB.id,
      content: '绝密关键字xyz仅B可见',
      mentions: [],
      status: 'complete',
    })
    const hitsA = env.sessions.search('绝密关键字xyz仅B可见', 50, uA.id)
    expect(hitsA.map((h) => h.sessionId)).not.toContain(sB.id)
    const hitsB = env.sessions.search('绝密关键字xyz仅B可见', 50, uB.id)
    expect(hitsB.map((h) => h.sessionId)).toContain(sB.id)
    void userB
  })

  it('记忆用户维度：global 记忆按用户隔离；流 token 绑定用户', () => {
    const { env } = makeAuthEnv()
    const mem = env.memory
    const a = mem.upsertScoped('global', 'u_a', 'fact', '用户 A 的全局偏好：蓝色主题', { userId: 'u_a' })
    expect(a?.added).toBe(true)
    const id = a!.item.id

    expect(mem.rowsByIds([id], 'u_b')).toHaveLength(0)
    expect(mem.rowsByIds([id], 'u_a')).toHaveLength(1)
    expect(mem.listScoped('global', 'u_a', { userId: 'u_a' })).toHaveLength(1)
    // 不过滤（单用户兼容模式）仍可见
    expect(mem.listScoped('global', 'u_a')).toHaveLength(1)

    const tokens = new StreamTokenService(60_000)
    const bound = tokens.issue('browser:bs1', 'watch', 'u1').token
    expect(tokens.verify(bound, 'browser:bs1', 'watch', 'u1').ok).toBe(true)
    expect(tokens.verify(bound, 'browser:bs1', 'watch', 'u2').ok).toBe(false)
    const anon = tokens.issue('browser:bs2', 'watch').token
    expect(tokens.verify(anon, 'browser:bs2', 'watch', 'u9').ok).toBe(true)
  })

  it('引擎 per-user 并发上限：同户第二个 Run 被拒，释放后可再启动', async () => {
    const { env, users } = makeAuthEnv()
    env.cfg.runMaxPerUser = 1
    const owner = users.create({ username: 'owner', displayName: 'Owner', passwordHash: 'x', role: 'member' })
    const session = env.sessions.create(['pm'], '容量测试', { ownerId: owner.id })

    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const provider = env.provider as unknown as {
      chatStream: (req: unknown, signal: AbortSignal) => AsyncIterable<unknown>
    }
    provider.chatStream = async function* () {
      await gate
      yield { type: 'text', text: '完成。\n@用户' }
      yield { type: 'done' }
    }

    const m1 = env.sessions.appendMessage({
      sessionId: session.id,
      role: 'user',
      content: '开始 @pm',
      mentions: [],
      status: 'complete',
    })
    const first = env.engine.launch(session.id, m1.id!)

    const session2 = env.sessions.create(['pm'], '容量测试2', { ownerId: owner.id })
    const m2 = env.sessions.appendMessage({
      sessionId: session2.id,
      role: 'user',
      content: '开始 @pm',
      mentions: [],
      status: 'complete',
    })
    expect(() => env.engine.launch(session2.id, m2.id!)).toThrowError(/上限/)

    release()
    await waitRunFinished(env.engine, first.runId)

    // 释放后可再启动（上限恢复）
    const m3 = env.sessions.appendMessage({
      sessionId: session2.id,
      role: 'user',
      content: '开始 @pm',
      mentions: [],
      status: 'complete',
    })
    const second = env.engine.launch(session2.id, m3.id!)
    await waitRunFinished(env.engine, second.runId)
  })
})

/**
 * M57 P3 测试：个人连接（scope='personal'）。
 * - Store：personal 创建 / listForUser（成员：可用 system ∪ 本人 personal）/ ownsPersonal / ownerOf / removePersonalOf（绑定级联）；
 * - 执行守卫：成员自有 personal 放行；他人 personal 拒绝；member_use=1 system 仍放行；
 * - HTTP：创建（成员 → personal；媒体 403）/ 列表（自有 config 完整、system 脱敏）/ 资源级守卫（他人与 system → 404）/
 *   memberUse 开关（admin 关掉后成员不可见不可绑）/ 绑定（自有 personal 可绑）。
 */
import path from 'node:path'
import express from 'express'
import type { Server } from 'node:http'
import { describe, expect, it } from 'vitest'
import { createSessionAccessGuard } from '../src/auth/guards.js'
import type { AuthUser } from '../src/auth/service.js'
import { createConnectionUseGuard } from '../src/connections/access.js'
import { SecretVault } from '../src/connections/crypto.js'
import type { ApiDeps } from '../src/routes/index.js'
import { createConnectionsRouter } from '../src/routes/connections.js'
import { createSessionsRouter } from '../src/routes/sessions.js'
import { AuditStore } from '../src/store/audit.js'
import { ConnectionStore } from '../src/store/connections.js'
import { makeEnv } from './helpers.js'

function makeFixture() {
  const env = makeEnv()
  const vault = SecretVault.load({ keyFile: path.join(env.cfg.dataDir, 'secrets.key') })
  const connections = new ConnectionStore(env.db, vault)
  const audit = new AuditStore(env.db)
  const alice = env.users.create({ username: 'alice', displayName: 'Alice', passwordHash: 'x', role: 'member' })
  const bob = env.users.create({ username: 'bob', displayName: 'Bob', passwordHash: 'x', role: 'member' })
  const admin = env.users.create({ username: 'root', displayName: 'Root', passwordHash: 'x', role: 'admin' })
  const guard = createConnectionUseGuard({ multiUser: () => true, users: env.users, connections })
  return { env, vault, connections, audit, alice, bob, admin, guard }
}

async function mountConnApi(f: ReturnType<typeof makeFixture>): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    const uid = String(req.header('x-test-user') ?? '')
    if (uid) (req as unknown as { user?: AuthUser }).user = f.env.auth.getUser(uid) as unknown as AuthUser
    next()
  })
  const deps = {
    ...f.env,
    connections: f.connections,
    audit: f.audit,
    // PUT 路径的句柄失效依赖（最小桩；真实实现在 index 装配）
    db: { probe: async () => ({ ok: true }), invalidate: async () => undefined },
    ssh: { invalidate: async () => undefined },
    embeddings: { invalidate: () => undefined },
  } as unknown as ApiDeps
  app.use('/api/sessions/:id', createSessionAccessGuard(f.env.access))
  app.use('/api', createConnectionsRouter(deps))
  app.use('/api', createSessionsRouter(deps))
  app.use((err: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(typeof err.status === 'number' ? err.status : 500).json({ error: err.message })
  })
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s))
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

const asUser = (uid: string): Record<string, string> => ({ 'x-test-user': uid, 'content-type': 'application/json' })

describe('M57 P3：个人连接（Store）', () => {
  it('create personal / listForUser / ownsPersonal / ownerOf / removePersonalOf（绑定级联）', () => {
    const f = makeFixture()
    const system = f.connections.create({ name: '团队库', kind: 'sqlite', config: { path: '/tmp/a.db' } })
    const aliceConn = f.connections.create({ name: 'Alice 私有库', kind: 'sqlite', config: { path: '/tmp/b.db' }, scope: 'personal', ownerId: f.alice.id })
    const bobConn = f.connections.create({ name: 'Bob 私有库', kind: 'sqlite', config: { path: '/tmp/c.db' }, scope: 'personal', ownerId: f.bob.id })

    expect(aliceConn.scope).toBe('personal')
    expect(aliceConn.ownerId).toBe(f.alice.id)
    expect(system.scope).toBe('system')
    expect(system.memberUse).toBe(true)

    // 成员可见：可用 system ∪ 本人 personal（不含他人 personal）
    const aliceList = f.connections.listForUser(f.alice.id).map((c) => c.id)
    expect(aliceList).toEqual(expect.arrayContaining([system.id, aliceConn.id]))
    expect(aliceList).not.toContain(bobConn.id)

    expect(f.connections.ownsPersonal(f.alice.id, aliceConn.id)).toBe(true)
    expect(f.connections.ownsPersonal(f.alice.id, bobConn.id)).toBe(false)
    expect(f.connections.ownerOf(aliceConn.id)).toBe(f.alice.id)
    expect(f.connections.ownerOf(system.id)).toBeUndefined()

    // 删除个人连接 → 会话绑定随 FK 级联清理
    const session = f.env.sessions.create(['pm'], 'S', { ownerId: f.alice.id })
    f.connections.bind(session.id, aliceConn.id)
    expect(f.connections.connectionsOf(session.id).some((b) => b.connection.id === aliceConn.id)).toBe(true)
    expect(f.connections.removePersonalOf(f.alice.id)).toBe(1)
    expect(f.connections.get(aliceConn.id)).toBeUndefined()
    expect(f.connections.connectionsOf(session.id).some((b) => b.connection.id === aliceConn.id)).toBe(false)
    expect(f.connections.get(bobConn.id)).toBeTruthy()
  })

  it('memberUse 开关：admin 关闭后成员不可见、memberUsable=false', () => {
    const f = makeFixture()
    const conn = f.connections.create({ name: '受限库', kind: 'sqlite', config: { path: '/tmp/x.db' } })
    expect(f.connections.memberUsable(conn.id)).toBe(true)
    f.connections.update(conn.id, { memberUse: false })
    expect(f.connections.memberUsable(conn.id)).toBe(false)
    expect(f.connections.listForUser(f.alice.id).map((c) => c.id)).not.toContain(conn.id)
    // 恢复
    f.connections.update(conn.id, { memberUse: true })
    expect(f.connections.listForUser(f.alice.id).map((c) => c.id)).toContain(conn.id)
  })
})

describe('M57 P3：执行守卫（个人连接）', () => {
  it('成员自有 personal 放行；他人 personal 拒绝；member_use=1 system 仍放行', () => {
    const f = makeFixture()
    const system = f.connections.create({ name: '开放库', kind: 'sqlite', config: { path: '/tmp/a.db' } })
    const mine = f.connections.create({ name: '我的库', kind: 'sqlite', config: { path: '/tmp/b.db' }, scope: 'personal', ownerId: f.alice.id })
    const others = f.connections.create({ name: 'Bob 库', kind: 'sqlite', config: { path: '/tmp/c.db' }, scope: 'personal', ownerId: f.bob.id })
    expect(f.guard(system.id, f.alice.id)).toBeUndefined()
    expect(f.guard(mine.id, f.alice.id)).toBeUndefined()
    expect(f.guard(others.id, f.alice.id)).toContain('未对成员开放')
    expect(f.guard(others.id, f.bob.id)).toBeUndefined()
    expect(f.guard(others.id, f.admin.id)).toBeUndefined()
  })
})

describe('M57 P3：HTTP（个人连接生命周期与守卫）', () => {
  it('创建（成员 → personal；媒体 403）/ 列表区分 / 资源级 404 / 绑定', async () => {
    const f = makeFixture()
    const api = await mountConnApi(f)
    try {
      // 成员创建个人连接 → scope=personal + ownerId=me
      const created = await fetch(`${api.url}/api/connections`, {
        method: 'POST',
        headers: asUser(f.alice.id),
        body: JSON.stringify({ name: 'Alice 私有库', kind: 'sqlite', config: { path: '/tmp/alice.db' } }),
      })
      expect(created.status).toBe(200)
      const aliceConn = ((await created.json()) as { connection: { id: string; scope: string; ownerId: string } }).connection
      expect(aliceConn.scope).toBe('personal')
      expect(aliceConn.ownerId).toBe(f.alice.id)

      // 媒体连接 → 403（全局配置）
      expect(
        (
          await fetch(`${api.url}/api/connections`, {
            method: 'POST',
            headers: asUser(f.alice.id),
            body: JSON.stringify({ name: 'Alice 媒体', kind: 'media', config: {} }),
          })
        ).status,
      ).toBe(403)

      // admin 建 system 连接 + bob 建自己的私有连接
      const sysRes = await fetch(`${api.url}/api/connections`, {
        method: 'POST',
        headers: asUser(f.admin.id),
        body: JSON.stringify({ name: '团队库', kind: 'sqlite', config: { path: '/tmp/team.db' } }),
      })
      const system = ((await sysRes.json()) as { connection: { id: string } }).connection
      await fetch(`${api.url}/api/connections`, {
        method: 'POST',
        headers: asUser(f.bob.id),
        body: JSON.stringify({ name: 'Bob 私有库', kind: 'sqlite', config: { path: '/tmp/bob.db' } }),
      })

      // 成员列表：自有 personal config 完整；system config 脱敏；不含他人 personal
      const list = ((await (await fetch(`${api.url}/api/connections`, { headers: asUser(f.alice.id) })).json()) as {
        connections: Array<{ id: string; scope?: string; config: Record<string, unknown> }>
      }).connections
      const mineRow = list.find((c) => c.id === aliceConn.id)
      const sysRow = list.find((c) => c.id === system.id)
      expect(mineRow?.config.path).toBe('/tmp/alice.db')
      expect(sysRow?.config).toEqual({})
      expect(list).toHaveLength(2)

      // 资源级守卫：他人 personal / system 详情 → 404；自有 → 200
      expect((await fetch(`${api.url}/api/connections/${system.id}`, { headers: asUser(f.alice.id) })).status).toBe(404)
      expect((await fetch(`${api.url}/api/connections/${aliceConn.id}`, { headers: asUser(f.alice.id) })).status).toBe(200)

      // 成员改自有连接：改名生效；memberUse 被忽略（personal 无意义）
      const patched = await fetch(`${api.url}/api/connections/${aliceConn.id}`, {
        method: 'PUT',
        headers: asUser(f.alice.id),
        body: JSON.stringify({ name: 'Alice 私有库 v2', memberUse: false }),
      })
      expect(patched.status).toBe(200)
      expect(f.connections.get(aliceConn.id)?.name).toBe('Alice 私有库 v2')

      // 绑定：自有 personal → 200；system（member_use=1）→ 200
      const session = f.env.sessions.create(['pm'], 'Alice 会话', { ownerId: f.alice.id })
      expect(
        (
          await fetch(`${api.url}/api/sessions/${session.id}/connections`, {
            method: 'POST',
            headers: asUser(f.alice.id),
            body: JSON.stringify({ connectionId: aliceConn.id }),
          })
        ).status,
      ).toBe(200)
      expect(
        (
          await fetch(`${api.url}/api/sessions/${session.id}/connections`, {
            method: 'POST',
            headers: asUser(f.alice.id),
            body: JSON.stringify({ connectionId: system.id }),
          })
        ).status,
      ).toBe(200)
    } finally {
      await api.close()
    }
  })

  it('memberUse 关闭后：成员不可见；绑定被拒（403）', async () => {
    const f = makeFixture()
    const api = await mountConnApi(f)
    try {
      const sysRes = await fetch(`${api.url}/api/connections`, {
        method: 'POST',
        headers: asUser(f.admin.id),
        body: JSON.stringify({ name: '团队库', kind: 'sqlite', config: { path: '/tmp/team.db' } }),
      })
      const system = ((await sysRes.json()) as { connection: { id: string } }).connection
      // admin 关闭成员使用
      const off = await fetch(`${api.url}/api/connections/${system.id}`, {
        method: 'PUT',
        headers: asUser(f.admin.id),
        body: JSON.stringify({ memberUse: false }),
      })
      expect(off.status).toBe(200)
      expect(f.connections.memberUsable(system.id)).toBe(false)

      const list = ((await (await fetch(`${api.url}/api/connections`, { headers: asUser(f.alice.id) })).json()) as {
        connections: Array<{ id: string }>
      }).connections
      expect(list.map((c) => c.id)).not.toContain(system.id)

      const session = f.env.sessions.create(['pm'], 'Alice 会话', { ownerId: f.alice.id })
      expect(
        (
          await fetch(`${api.url}/api/sessions/${session.id}/connections`, {
            method: 'POST',
            headers: asUser(f.alice.id),
            body: JSON.stringify({ connectionId: system.id }),
          })
        ).status,
      ).toBe(403)
    } finally {
      await api.close()
    }
  })
})

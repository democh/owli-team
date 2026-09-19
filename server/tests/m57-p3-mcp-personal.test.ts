/**
 * M57 P3 测试：personal MCP（store / HTTP 生命周期 / 绑定守卫）。
 * - Store：create personal / listForUser / ownsPersonal / ownerOf / removePersonalOf（绑定随 FK 级联）；
 * - HTTP：成员创建 → personal（服务端定 scope/owner）；列表 = system ∪ 本人 personal；资源级 404；
 *   管理面（json-config / 授权矩阵）403；绑定（自有 personal 允许 + 自动 connect；他人 personal 404）；
 *   绑定清单防御性过滤他人 personal。
 */
import path from 'node:path'
import express from 'express'
import type { Server } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { createSessionAccessGuard } from '../src/auth/guards.js'
import type { AuthUser } from '../src/auth/service.js'
import { SecretVault } from '../src/connections/crypto.js'
import type { ApiDeps } from '../src/routes/index.js'
import { createMcpRouter } from '../src/routes/mcp.js'
import { AuditStore } from '../src/store/audit.js'
import { McpServerStore } from '../src/store/mcp-servers.js'
import { makeEnv } from './helpers.js'

function makeFixture() {
  const env = makeEnv()
  const vault = SecretVault.load({ keyFile: path.join(env.cfg.dataDir, 'secrets.key') })
  const store = new McpServerStore(env.db, vault)
  const audit = new AuditStore(env.db)
  const alice = env.users.create({ username: 'alice', displayName: 'Alice', passwordHash: 'x', role: 'member' })
  const bob = env.users.create({ username: 'bob', displayName: 'Bob', passwordHash: 'x', role: 'member' })
  const admin = env.users.create({ username: 'root', displayName: 'Root', passwordHash: 'x', role: 'admin' })
  const connect = vi.fn(async () => undefined)
  const runtime = {
    connect,
    disconnect: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
    refreshTools: vi.fn(async () => undefined),
    test: vi.fn(async () => ({ ok: true, detail: 'stub' })),
  }
  return { env, store, audit, alice, bob, admin, runtime, connect }
}

async function mountMcpApi(f: ReturnType<typeof makeFixture>): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    const uid = String(req.header('x-test-user') ?? '')
    if (uid) (req as unknown as { user?: AuthUser }).user = f.env.auth.getUser(uid) as unknown as AuthUser
    next()
  })
  const deps = {
    ...f.env,
    mcp: f.store,
    mcpRuntime: f.runtime,
    audit: f.audit,
  } as unknown as ApiDeps
  app.use('/api/sessions/:id', createSessionAccessGuard(f.env.access))
  app.use('/api', createMcpRouter(deps))
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

describe('M57 P3：personal MCP（Store）', () => {
  it('create / listForUser / ownsPersonal / ownerOf / removePersonalOf（绑定级联）', () => {
    const f = makeFixture()
    const system = f.store.create({ name: 'team-echo', transport: 'stdio', config: { command: 'stub' } })
    const aliceConn = f.store.create({
      name: 'alice-echo',
      transport: 'stdio',
      config: { command: 'stub' },
      scope: 'personal',
      ownerId: f.alice.id,
    })
    const bobConn = f.store.create({
      name: 'bob-echo',
      transport: 'stdio',
      config: { command: 'stub' },
      scope: 'personal',
      ownerId: f.bob.id,
    })

    expect(aliceConn.scope).toBe('personal')
    expect(aliceConn.ownerId).toBe(f.alice.id)
    expect(system.scope).toBe('system')

    const aliceList = f.store.listForUser(f.alice.id).map((s) => s.id)
    expect(aliceList).toEqual(expect.arrayContaining([system.id, aliceConn.id]))
    expect(aliceList).not.toContain(bobConn.id)

    expect(f.store.ownsPersonal(f.alice.id, aliceConn.id)).toBe(true)
    expect(f.store.ownsPersonal(f.alice.id, system.id)).toBe(false)
    expect(f.store.ownerOf(aliceConn.id)).toBe(f.alice.id)
    expect(f.store.ownerOf(system.id)).toBeUndefined()

    const session = f.env.sessions.create(['pm'], 'S', { ownerId: f.alice.id })
    f.store.bind(session.id, aliceConn.id)
    expect(f.store.isBound(session.id, aliceConn.id)).toBe(true)
    expect(f.store.removePersonalOf(f.alice.id)).toBe(1)
    expect(f.store.get(aliceConn.id)).toBeUndefined()
    expect(f.store.isBound(session.id, aliceConn.id)).toBe(false) // 绑定随 FK 级联
    expect(f.store.get(bobConn.id)).toBeTruthy()
  })
})

describe('M57 P3：personal MCP（HTTP）', () => {
  it('成员创建 → personal；列表分流；资源级 404；管理面 403；绑定守卫 + 自动连接', async () => {
    const f = makeFixture()
    const api = await mountMcpApi(f)
    try {
      // 成员创建 → scope/owner 服务端定
      const created = await fetch(`${api.url}/api/mcp/servers`, {
        method: 'POST',
        headers: asUser(f.alice.id),
        body: JSON.stringify({ name: 'alice-echo', transport: 'stdio', config: { command: 'stub' } }),
      })
      expect(created.status).toBe(200)
      const aliceServer = ((await created.json()) as { server: { id: string; scope: string; ownerId: string } }).server
      expect(aliceServer.scope).toBe('personal')
      expect(aliceServer.ownerId).toBe(f.alice.id)

      // admin 建 system + bob 建自己的
      const sysRes = await fetch(`${api.url}/api/mcp/servers`, {
        method: 'POST',
        headers: asUser(f.admin.id),
        body: JSON.stringify({ name: 'team-echo', transport: 'stdio', config: { command: 'stub' } }),
      })
      const system = ((await sysRes.json()) as { server: { id: string } }).server
      await fetch(`${api.url}/api/mcp/servers`, {
        method: 'POST',
        headers: asUser(f.bob.id),
        body: JSON.stringify({ name: 'bob-echo', transport: 'stdio', config: { command: 'stub' } }),
      })

      // 成员列表：system ∪ 本人 personal；不含他人 personal
      const list = ((await (await fetch(`${api.url}/api/mcp/servers`, { headers: asUser(f.alice.id) })).json()) as {
        servers: Array<{ id: string; scope?: string }>
      }).servers
      expect(list.map((s) => s.id)).toEqual(expect.arrayContaining([system.id, aliceServer.id]))
      expect(list).toHaveLength(2)

      // 资源级守卫：他人 personal / system 详情 → 404；自有 → 200
      expect((await fetch(`${api.url}/api/mcp/servers/${system.id}`, { headers: asUser(f.alice.id) })).status).toBe(404)
      expect((await fetch(`${api.url}/api/mcp/servers/${aliceServer.id}`, { headers: asUser(f.alice.id) })).status).toBe(200)

      // 成员改自有（改名）→ 200；管理面 json-config / 授权矩阵 → 403
      const patched = await fetch(`${api.url}/api/mcp/servers/${aliceServer.id}`, {
        method: 'PUT',
        headers: asUser(f.alice.id),
        body: JSON.stringify({ displayName: 'Alice 私服' }),
      })
      expect(patched.status).toBe(200)
      expect((await fetch(`${api.url}/api/mcp/json-config`, { headers: asUser(f.alice.id) })).status).toBe(403)
      expect((await fetch(`${api.url}/api/mcp/tools`, { headers: asUser(f.alice.id) })).status).toBe(403)

      // 绑定：自有 personal → 200 + 自动 connect；他人 personal → 404；system → 200
      const session = f.env.sessions.create(['pm'], 'Alice 会话', { ownerId: f.alice.id })
      const bindOwn = await fetch(`${api.url}/api/sessions/${session.id}/mcp-servers`, {
        method: 'POST',
        headers: asUser(f.alice.id),
        body: JSON.stringify({ serverId: aliceServer.id }),
      })
      expect(bindOwn.status).toBe(200)
      expect(f.connect).toHaveBeenCalledWith(aliceServer.id)

      const bobServer = f.store.listForUser(f.bob.id).find((s) => s.ownerId === f.bob.id)!
      expect(
        (
          await fetch(`${api.url}/api/sessions/${session.id}/mcp-servers`, {
            method: 'POST',
            headers: asUser(f.alice.id),
            body: JSON.stringify({ serverId: bobServer.id }),
          })
        ).status,
      ).toBe(404)

      expect(
        (
          await fetch(`${api.url}/api/sessions/${session.id}/mcp-servers`, {
            method: 'POST',
            headers: asUser(f.alice.id),
            body: JSON.stringify({ serverId: system.id }),
          })
        ).status,
      ).toBe(200)

      // 绑定清单防御性过滤：把他人 personal 直接写库（模拟脏数据）→ 对该会话属主不可见
      f.store.bind(session.id, bobServer.id)
      const bindings = ((await (await fetch(`${api.url}/api/sessions/${session.id}/mcp-servers`, { headers: asUser(f.alice.id) })).json()) as {
        bindings: Array<{ server: { id: string } }>
      }).bindings
      expect(bindings.map((b) => b.server.id)).toContain(aliceServer.id)
      expect(bindings.map((b) => b.server.id)).toContain(system.id)
      expect(bindings.map((b) => b.server.id)).not.toContain(bobServer.id)
    } finally {
      await api.close()
    }
  })
})

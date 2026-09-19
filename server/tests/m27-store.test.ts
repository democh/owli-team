/**
 * M27 测试：McpServerStore —— CRUD / 凭据加密与脱敏 / 状态与工具快照 / 会话绑定与级联。
 */
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SecretVault } from '../src/connections/crypto.js'
import { openDatabase, type AppDb } from '../src/store/db.js'
import { McpServerStore } from '../src/store/mcp-servers.js'
import { SessionStore } from '../src/store/sessions.js'
import { makeTmpDir } from './helpers.js'

function makeStore(): { db: AppDb; store: McpServerStore; sessions: SessionStore } {
  const db = openDatabase(':memory:', { memory: true, noExtensions: true })
  const vault = SecretVault.load({
    keyMaterial: 'a'.repeat(64),
    keyFile: path.join(makeTmpDir('ma-m27-vault-'), 'secrets.key'),
  })
  return { db, store: new McpServerStore(db, vault), sessions: new SessionStore(db) }
}

describe('M27：McpServerStore CRUD', () => {
  it('create：默认值落库（enabled / idle / source=ui / 空工具清单）；list / get / findByName', () => {
    const { store } = makeStore()
    const server = store.create({
      name: 'echo',
      displayName: '回显服务器',
      transport: 'stdio',
      config: { command: 'node', args: ['echo.mjs'] },
      secret: null,
    })
    expect(server.id.startsWith('mcp_')).toBe(true)
    expect(server.enabled).toBe(true)
    expect(server.status).toBe('idle')
    expect(server.source).toBe('ui')
    expect(server.tools).toEqual([])
    expect(server.secretSet).toBe(false)
    expect(server.config.command).toBe('node')

    expect(store.list()).toHaveLength(1)
    expect(store.get(server.id)?.name).toBe('echo')
    expect(store.findByName('echo')?.id).toBe(server.id)
    expect(store.get('mcp_nope')).toBeUndefined()
    expect(store.findByName('nope')).toBeUndefined()
  })

  it('create：非法 slug / 重名拒绝；enabled=false 与 source=env 可写入', () => {
    const { store } = makeStore()
    expect(() => store.create({ name: 'Bad Name', transport: 'stdio', config: {} })).toThrow(/非法/)
    expect(() => store.create({ name: '1bad', transport: 'stdio', config: {} })).toThrow(/非法/)
    const env = store.create({ name: 'seeded', transport: 'http', config: { url: 'http://x' }, enabled: false, source: 'env' })
    expect(env.enabled).toBe(false)
    expect(env.source).toBe('env')
    expect(() => store.create({ name: 'seeded', transport: 'http', config: {} })).toThrow(/已存在/)
  })

  it('凭据：加密落库（明文不出现在定义视图）/ getSecret 解密 / 置 null 清空', () => {
    const { store } = makeStore()
    const server = store.create({
      name: 'echo',
      transport: 'stdio',
      config: { command: 'node' },
      secret: { env: { API_TOKEN: 's3cret-value' } },
    })
    expect(server.secretSet).toBe(true)
    expect(store.getSecret(server.id)).toEqual({ env: { API_TOKEN: 's3cret-value' } })
    // 对外定义视图（含 JSON 序列化）绝不携带明文凭据
    expect(JSON.stringify(store.list())).not.toContain('s3cret-value')

    const cleared = store.update(server.id, { secret: null })
    expect(cleared?.secretSet).toBe(false)
    expect(store.getSecret(server.id)).toBeUndefined()
  })

  it('update：name 校验与重名拒绝 / displayName null 清空 / config·enabled 语义', () => {
    const { store } = makeStore()
    const a = store.create({ name: 'alpha', displayName: 'A', transport: 'stdio', config: { command: 'x' } })
    const b = store.create({ name: 'beta', transport: 'stdio', config: { command: 'y' } })
    expect(() => store.update(a.id, { name: 'Bad Name' })).toThrow(/非法/)
    expect(() => store.update(a.id, { name: 'beta' })).toThrow(/已存在/)
    expect(store.update('mcp_nope', { enabled: false })).toBeUndefined()

    const renamed = store.update(a.id, {
      name: 'alpha2',
      displayName: null,
      config: { command: 'x', timeoutMs: 5_000, approvalPolicy: 'always' },
      enabled: false,
    })
    expect(renamed?.name).toBe('alpha2')
    expect(renamed?.displayName).toBeUndefined()
    expect(renamed?.config.timeoutMs).toBe(5_000)
    expect(renamed?.config.approvalPolicy).toBe('always')
    expect(renamed?.enabled).toBe(false)
    expect(store.get(b.id)?.name).toBe('beta')
  })

  it('setStatus / setTools：状态与工具快照回写（错误信息截断 500）', () => {
    const { store } = makeStore()
    const server = store.create({ name: 'echo', transport: 'stdio', config: { command: 'x' } })
    store.setStatus(server.id, 'error', 'x'.repeat(600))
    const after = store.get(server.id)!
    expect(after.status).toBe('error')
    expect(after.lastError).toHaveLength(500)
    expect(after.lastCheckedAt).toBeTruthy()

    const tools = [
      { registeredName: 'mcp__echo__echo', rawName: 'echo', description: '回显', readOnly: true },
      { registeredName: 'mcp__echo__write', rawName: 'write', readOnly: false },
    ]
    store.setTools(server.id, tools)
    expect(store.get(server.id)?.tools).toEqual(tools)
  })

  it('remove：删除行；重复删除返回 false', () => {
    const { store } = makeStore()
    const server = store.create({ name: 'echo', transport: 'stdio', config: {} })
    expect(store.remove(server.id)).toBe(true)
    expect(store.remove(server.id)).toBe(false)
    expect(store.get(server.id)).toBeUndefined()
  })
})

describe('M27：会话绑定（最小权限）', () => {
  it('bind 幂等 / unbind 幂等 / serversOf 携带 grantedAt / isBound', () => {
    const { store, sessions } = makeStore()
    const session = sessions.create(['pm'], 'M27 绑定')
    const server = store.create({ name: 'echo', transport: 'stdio', config: {} })

    expect(store.isBound(session.id, server.id)).toBe(false)
    store.bind(session.id, server.id)
    store.bind(session.id, server.id) // 幂等
    expect(store.isBound(session.id, server.id)).toBe(true)

    const bound = store.serversOf(session.id)
    expect(bound).toHaveLength(1)
    expect(bound[0]!.server.id).toBe(server.id)
    expect(bound[0]!.grantedAt).toBeTruthy()
    expect(store.serversOf('sess-none')).toEqual([])

    expect(store.unbind(session.id, server.id)).toBe(true)
    expect(store.unbind(session.id, server.id)).toBe(false)
    expect(store.isBound(session.id, server.id)).toBe(false)
  })

  it('级联：删除服务器 → 绑定自动清理（FK ON DELETE CASCADE）', () => {
    const { store, sessions } = makeStore()
    const session = sessions.create(['pm'], 'M27 级联')
    const server = store.create({ name: 'echo', transport: 'stdio', config: {} })
    store.bind(session.id, server.id)

    store.remove(server.id)
    expect(store.isBound(session.id, server.id)).toBe(false)
    expect(store.serversOf(session.id)).toEqual([])
  })
})

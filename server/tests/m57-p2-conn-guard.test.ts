/**
 * M57 P2 测试：共享会话下的连接最小权限复核（SSH / 数据库）。
 *
 * 缺口背景：会话绑定是 P1 闸门，但「admin 在会话里绑定未对成员开放的连接 → 会话共享给成员」
 * 或「member_use 事后撤销」时，工具执行侧此前无复核。本批在工具解析连接后以「本 Run 触发者」
 * 复核（createConnectionUseGuard），并把触发者写入 ssh.exec / db.* 审计。
 *
 * 覆盖：守卫单元（兼容 / admin / 成员可开放 / 成员受限 / 未知触发者）；
 *       db_query 拒绝不执行 + 开放库真跑；db_list_connections 不可用标注；
 *       ssh_exec 受限拒绝 + admin 放行越过守卫（工厂注入错误可证）；审计归因 userId。
 */
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { createConnectionUseGuard } from '../src/connections/access.js'
import { SecretVault } from '../src/connections/crypto.js'
import { DbConnectionManager } from '../src/connections/db/manager.js'
import { SshConnectionManager } from '../src/connections/ssh/manager.js'
import { ArtifactStore } from '../src/store/artifacts.js'
import { AuditStore } from '../src/store/audit.js'
import { ConnectionStore } from '../src/store/connections.js'
import { MemoryStore } from '../src/store/memory.js'
import { SkillLibrary } from '../src/store/skills.js'
import { TaskStore } from '../src/store/tasks.js'
import { createToolRegistry } from '../src/tools/builtin.js'
import type { ToolOpEvent, ToolRuntime } from '../src/tools/registry.js'
import { makeEnv } from './helpers.js'

const nodeRequire = createRequire(import.meta.url)

/** 最小 SQLite 业务库夹具（users 两行） */
function makeSqliteFixture(dir: string): string {
  const file = path.join(dir, 'p2-business.db')
  const { DatabaseSync } = nodeRequire('node:sqlite') as {
    DatabaseSync: new (file: string) => { exec(sql: string): void; close(): void }
  }
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER)')
  db.exec("INSERT INTO users (name, age) VALUES ('ann', 30), ('bob', 25)")
  db.close()
  return file
}

/** 夹具：两名用户（member / admin）+ 开放库 / 受限库 / 受限 SSH + 会话绑定全部（模拟 admin 历史绑定） */
function makeFixture() {
  const env = makeEnv()
  const vault = SecretVault.load({ keyFile: path.join(env.cfg.dataDir, 'secrets.key') })
  const connections = new ConnectionStore(env.db, vault)
  const audit = new AuditStore(env.db)
  const manager = new DbConnectionManager(env.cfg, connections, audit)
  const member = env.users.create({ username: 'alice', displayName: 'Alice', passwordHash: 'x', role: 'member' })
  const admin = env.users.create({ username: 'root', displayName: 'Root', passwordHash: 'x', role: 'admin' })
  const guard = createConnectionUseGuard({ multiUser: () => true, users: env.users, connections })

  const sqliteFile = makeSqliteFixture(env.cfg.dataDir)
  const openDb = connections.create({ name: '开放库', kind: 'sqlite', config: { path: sqliteFile } })
  const restrictedDb = connections.create({ name: '受限库', kind: 'sqlite', config: { path: sqliteFile } })
  const restrictedSsh = connections.create({
    name: '受限生产机',
    kind: 'ssh',
    config: { host: '10.1.1.1', username: 'deploy', authMethod: 'password', allowExec: true },
    secret: { password: 'p' },
  })
  // member_use=0：未对成员开放（私有 / 事后撤销场景）
  env.db.run('UPDATE connections SET member_use = 0 WHERE id IN (?, ?)', restrictedDb.id, restrictedSsh.id)

  const session = env.sessions.create(['pm'], 'P2 连接复核会话')
  for (const conn of [openDb, restrictedDb, restrictedSsh]) connections.bind(session.id, conn.id)

  // SSH 工厂注入错误：放行路径越守卫后会走到这里（用于证明「守卫放行 ≠ 被拒绝」）
  const ssh = new SshConnectionManager(env.cfg, connections, audit, () => {
    throw new Error('SSH 工厂不应被调用')
  })
  const ops: ToolOpEvent[] = []
  const runtimeOf = (triggerUserId?: string): ToolRuntime => {
    const skills = new SkillLibrary(loadConfig().skillsDir)
    const artifacts = new ArtifactStore(path.join(env.cfg.dataDir, 'artifacts'))
    return {
      sessionId: session.id,
      runId: 'r-p2-conn',
      agentId: 'pm',
      triggerUserId,
      connectionGuard: guard,
      workspace: artifacts.ensureSessionDir(session.id),
      artifacts,
      skills,
      memory: new MemoryStore(env.db),
      tasks: new TaskStore(env.db),
      participants: [{ id: 'pm', name: '派蒙' }],
      todos: [],
      allowRunCommand: false,
      allowedCommands: [],
      allowSensitive: false,
      webSearch: { apiKey: '', apiUrl: '', htmlUrl: '' },
      httpUserAgent: '',
      httpMinIntervalMs: 0,
      httpTimeoutMs: 15_000,
      loadSkill: (name) => {
        const skill = skills.get(name)
        return skill ? { ok: true, body: skill.body } : { ok: false, error: `技能「${name}」不存在` }
      },
      connections,
      db: manager,
      ssh,
      opNotify: (op) => ops.push(op),
    }
  }
  return { env, member, admin, guard, connections, session, openDb, restrictedDb, restrictedSsh, ops, runtimeOf }
}

describe('M57 P2：连接使用守卫（单元）', () => {
  it('兼容模式全放行；admin / 未知触发者放行；成员仅 member_use=1 的连接', () => {
    const f = makeFixture()
    // 兼容模式（无账号体系）：即便 member_use=0 也放行（行为与旧版一致）
    const compat = createConnectionUseGuard({ multiUser: () => false, users: f.env.users, connections: f.connections })
    expect(compat(f.restrictedDb.id, f.member.id)).toBeUndefined()

    // 多用户：成员 + 开放连接 → 放行；成员 + 受限 → 拒绝
    expect(f.guard(f.openDb.id, f.member.id)).toBeUndefined()
    expect(f.guard(f.restrictedDb.id, f.member.id)).toContain('未对成员开放')
    expect(f.guard(f.restrictedSsh.id, f.member.id)).toContain('未对成员开放')
    // admin 不限；未知触发者（历史 run / 系统触发）放行
    expect(f.guard(f.restrictedDb.id, f.admin.id)).toBeUndefined()
    expect(f.guard(f.restrictedDb.id, undefined)).toBeUndefined()
  })
})

describe('M57 P2：工具执行最小权限复核', () => {
  it('db_query：成员触发受限连接 → 拒绝且不执行；开放连接 → 正常查询并归因审计', async () => {
    const f = makeFixture()
    const registry = createToolRegistry(loadConfig())

    const denied = await registry.execute('db_query', { connection: f.restrictedDb.name, sql: 'SELECT 1' }, f.runtimeOf(f.member.id))
    expect(denied.ok).toBe(false)
    expect(denied.summary).toContain('未对成员开放')
    expect(f.ops).toHaveLength(0)

    const ok = await registry.execute(
      'db_query',
      { connection: f.openDb.name, sql: 'SELECT name FROM users ORDER BY id' },
      f.runtimeOf(f.member.id),
    )
    expect(ok.ok).toBe(true)
    expect(ok.detail).toContain('ann')
    // 审计归因：db.query 行携带触发者 userId
    const row = f.env.db.get<{ user_id: string | null }>(
      "SELECT user_id FROM audit_log WHERE action = 'db.query' ORDER BY id DESC LIMIT 1",
    )
    expect(row?.user_id).toBe(f.member.id)
  })

  it('db_list_connections：未对成员开放的连接带「不可用」标注', async () => {
    const f = makeFixture()
    const registry = createToolRegistry(loadConfig())
    const listed = await registry.execute('db_list_connections', {}, f.runtimeOf(f.member.id))
    expect(listed.ok).toBe(true)
    expect(listed.detail).toContain('受限库')
    expect(listed.detail).toContain('未对成员开放，不可用')
    // admin 视角无标注
    const listedByAdmin = await registry.execute('db_list_connections', {}, f.runtimeOf(f.admin.id))
    expect(listedByAdmin.detail).not.toContain('未对成员开放')
  })

  it('ssh_exec：成员触发受限连接 → 拒绝；admin 放行越过守卫（执行失败且审计归因 admin）', async () => {
    const f = makeFixture()
    const registry = createToolRegistry(loadConfig())

    const denied = await registry.execute('ssh_exec', { connection: f.restrictedSsh.name, command: 'id' }, f.runtimeOf(f.member.id))
    expect(denied.ok).toBe(false)
    expect(denied.summary).toContain('未对成员开放')
    expect(f.ops).toHaveLength(0)

    // admin 触发：守卫放行 → 进入执行（工厂注入错误即证；失败非守卫文案）
    const passed = await registry.execute('ssh_exec', { connection: f.restrictedSsh.id, command: 'id' }, f.runtimeOf(f.admin.id))
    expect(passed.ok).toBe(false)
    expect(passed.summary).toContain('SSH 工厂不应被调用')
    expect(passed.summary).not.toContain('未对成员开放')
    // 审计归因：ssh.exec 失败行携带触发者 userId
    const row = f.env.db.get<{ user_id: string | null; ok: number }>(
      "SELECT user_id, ok FROM audit_log WHERE action = 'ssh.exec' ORDER BY id DESC LIMIT 1",
    )
    expect(row?.user_id).toBe(f.admin.id)
    expect(row?.ok).toBe(0)
  })

  it('共享会话场景：会话属主（admin）触发放行；成员触发受限连接拒绝（以触发者为准）', async () => {
    const f = makeFixture()
    const registry = createToolRegistry(loadConfig())
    // 同一会话、同一绑定：仅触发者不同 → 结论相反（证明复核以触发者而非会话属主为准）
    const asAdmin = await registry.execute(
      'db_query',
      { connection: f.restrictedDb.name, sql: 'SELECT 1' },
      f.runtimeOf(f.admin.id),
    )
    expect(asAdmin.ok).toBe(true)
    const asMember = await registry.execute(
      'db_query',
      { connection: f.restrictedDb.name, sql: 'SELECT 1' },
      f.runtimeOf(f.member.id),
    )
    expect(asMember.ok).toBe(false)
    expect(asMember.summary).toContain('未对成员开放')
  })
})

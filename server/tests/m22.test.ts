/**
 * M22 测试：连接中心地基 —— 凭据加密 / 连接存储 / SQL 护栏 / SQLite 连接器（经管理器全链路）/ 流 token。
 *
 * 覆盖策略：
 * - 护栏为纯函数：多语句 / 注释与字符串剥离 / 只读白名单 / 危险关键字（含 data-modifying CTE、SELECT INTO）；
 * - SQLite 连接器用真实临时库文件跑通「只读查询 / 只读拒绝写 / schema / 允许写入 / 会话绑定」；
 * - 凭据：密文不含明文、解密往返、换密钥后解密失败不抛错、清空语义；
 * - 流 token：watch 可复用、takeover 一次性、频道与级别不匹配、过期。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import type { AppConfig } from '../src/config.js'
import { loadConfig } from '../src/config.js'
import { SecretVault } from '../src/connections/crypto.js'
import { analyzeSql, assertReadOnlySql, assertWritableSql } from '../src/connections/db/guard.js'
import { DbConnectionManager } from '../src/connections/db/manager.js'
import { StreamTokenService } from '../src/browser/stream-token.js'
import { ArtifactStore } from '../src/store/artifacts.js'
import { AuditStore } from '../src/store/audit.js'
import { ConnectionStore } from '../src/store/connections.js'
import { openDatabase } from '../src/store/db.js'
import { MemoryStore } from '../src/store/memory.js'
import { SessionStore } from '../src/store/sessions.js'
import { SkillLibrary } from '../src/store/skills.js'
import { TaskStore } from '../src/store/tasks.js'
import { createToolRegistry } from '../src/tools/builtin.js'
import type { ToolOpEvent, ToolRuntime } from '../src/tools/registry.js'
import { makeTmpDir } from './helpers.js'

const nodeRequire = createRequire(import.meta.url)

/** 临时环境：独立 data 目录 + 真实 SQLite 主库（含迁移）+ 加密库 */
function makeEnv(): {
  dir: string
  cfg: AppConfig
  db: ReturnType<typeof openDatabase>
  vault: SecretVault
  connections: ConnectionStore
  audit: AuditStore
  manager: DbConnectionManager
} {
  const dir = makeTmpDir('ma-m22-')
  const cfg: AppConfig = { ...loadConfig(), dataDir: dir, logLevel: 'silent' }
  const db = openDatabase(path.join(dir, 'app.db'))
  const vault = SecretVault.load({ keyFile: path.join(dir, 'secrets.key') })
  const connections = new ConnectionStore(db, vault)
  const audit = new AuditStore(db)
  const manager = new DbConnectionManager(cfg, connections, audit)
  return { dir, cfg, db, vault, connections, audit, manager }
}

/** 造一个业务库文件（不自动建库的连接器要求文件已存在） */
function makeSqliteFixture(dir: string, rows = 2): string {
  const file = path.join(dir, 'business.db')
  const { DatabaseSync } = nodeRequire('node:sqlite') as {
    DatabaseSync: new (file: string) => { exec(sql: string): void; close(): void }
  }
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER)')
  db.exec(`INSERT INTO users (name, age) VALUES ('ann', 30), ('bob', 25)`)
  if (rows > 2) db.exec(`INSERT INTO users (name, age) VALUES ('cid', 40)`)
  db.close()
  return file
}

// ---------- SQL 护栏 ----------

describe('M22：SQL 护栏（guard）', () => {
  it('只读白名单：SELECT / WITH / EXPLAIN / PRAGMA 通过，写与 DDL 拒绝', () => {
    expect(assertReadOnlySql('SELECT * FROM users').ok).toBe(true)
    expect(assertReadOnlySql('  with t as (select 1) select * from t').ok).toBe(true)
    expect(assertReadOnlySql('EXPLAIN SELECT 1').ok).toBe(true)
    expect(assertReadOnlySql('PRAGMA table_info(users)').ok).toBe(true)
    expect(assertReadOnlySql('SHOW TABLES').ok).toBe(true)

    const del = assertReadOnlySql('DELETE FROM users')
    expect(del.ok).toBe(false)
    expect(del.ok === false && del.reason).toContain('只读模式仅允许')
    expect(assertReadOnlySql('UPDATE users SET age = 1').ok).toBe(false)
    expect(assertReadOnlySql('DROP TABLE users').ok).toBe(false)
    expect(assertReadOnlySql('CREATE TABLE t (a int)').ok).toBe(false)
  })

  it('多语句（含写意图）在只读与写两条路径都拒绝', () => {
    const sql = 'SELECT 1; DROP TABLE users'
    const analysis = analyzeSql(sql)
    expect(analysis.ok).toBe(false)
    expect(analysis.statements).toHaveLength(2)
    expect(analysis.reason).toContain('仅支持单条语句')
    expect(assertReadOnlySql(sql).ok).toBe(false)
    expect(assertWritableSql(sql).ok).toBe(false)
    // 写路径放行单条写语句（权限由连接开关 + 审批门控制）
    expect(assertWritableSql('UPDATE users SET age = 30 WHERE name = ?').ok).toBe(true)
  })

  it('注释与字符串字面量不参与关键字判定（分号也被正确忽略）', () => {
    const withString = analyzeSql("SELECT 'DROP TABLE users; --' AS note")
    expect(withString.ok).toBe(true)
    expect(withString.mutating).toBe(false)
    expect(withString.statements).toHaveLength(1)

    const withComment = analyzeSql('SELECT 1 -- ; DELETE FROM users\n')
    expect(withComment.ok).toBe(true)
    expect(withComment.statements).toHaveLength(1)

    const block = analyzeSql('SELECT /* DELETE FROM users */ 1')
    expect(block.ok).toBe(true)
    expect(block.mutating).toBe(false)

    const quoted = analyzeSql('SELECT "delete" FROM users')
    expect(quoted.ok).toBe(true)
    expect(quoted.mutating).toBe(false)

    const onlyComment = analyzeSql('-- nothing here')
    expect(onlyComment.ok).toBe(false)
  })

  it('骨架危险意图兜底：data-modifying CTE / SELECT INTO / 会话设置', () => {
    const cte = assertReadOnlySql('WITH d AS (DELETE FROM users RETURNING *) SELECT * FROM d')
    expect(cte.ok).toBe(false)
    expect(cte.ok === false && cte.reason).toContain('data-modifying CTE')

    expect(assertReadOnlySql('SELECT * INTO new_users FROM users').ok).toBe(false)
    expect(assertReadOnlySql("SELECT * FROM users INTO OUTFILE '/tmp/x'").ok).toBe(false)
    expect(assertReadOnlySql('SELECT 1 SET search_path = public').ok).toBe(false)
    // PRAGMA 赋值（会改变库状态）
    expect(assertReadOnlySql('PRAGMA journal_mode = WAL').ok).toBe(false)
    // 美元引号（PG 函数体）不误伤
    expect(assertReadOnlySql('SELECT $$ DELETE $$ AS body').ok).toBe(true)
  })

  it('绕过加固（回归）：大小写不敏感 / PRAGMA 赋值与括号形式 / MySQL 可执行注释', () => {
    // 小写写意图不再漏过骨架检测（此前 DANGEROUS_RE 无 i 标志）
    expect(assertReadOnlySql('with x as (select 1) delete from users').ok).toBe(false)
    expect(assertReadOnlySql('with d as (delete from users returning *) select * from d').ok).toBe(false)
    expect(analyzeSql('select * into new_users from users').mutating).toBe(true)
    // PRAGMA：任意大小写赋值与括号赋值形式（只读名单外）都按写拒绝
    expect(assertReadOnlySql('pragma journal_mode = wal').ok).toBe(false)
    expect(assertReadOnlySql('pragma writable_schema=1').ok).toBe(false)
    expect(assertReadOnlySql('PRAGMA journal_mode(wal)').ok).toBe(false)
    expect(assertReadOnlySql('PRAGMA main.writable_schema(1)').ok).toBe(false)
    // 只读 PRAGMA 括号形式仍放行（不误伤）
    expect(assertReadOnlySql('PRAGMA table_info(users)').ok).toBe(true)
    expect(assertReadOnlySql('PRAGMA index_list(users)').ok).toBe(true)
    // MySQL / MariaDB 可执行注释内容参与分析（服务器会真实执行）
    expect(assertReadOnlySql("SELECT 1 /*!40000 INTO OUTFILE '/tmp/x' */").ok).toBe(false)
    expect(assertReadOnlySql('SELECT 1 /*!40000 ; DELETE FROM users */').ok).toBe(false)
    expect(assertReadOnlySql('/*M!100100 DELETE FROM users */ SELECT 1').ok).toBe(false)
    // 普通块注释仍剥离（保持既有语义）
    expect(assertReadOnlySql('SELECT /* DELETE FROM users */ 1').ok).toBe(true)
  })
})

// ---------- 凭据加密与连接存储 ----------

describe('M22：凭据加密与连接存储', () => {
  it('secret 加密落盘、对外仅 secretSet、解密往返一致', () => {
    const env = makeEnv()
    const created = env.connections.create({
      name: '订单库',
      kind: 'postgres',
      config: { host: '127.0.0.1', database: 'orders' },
      secret: { password: 'p@ssw0rd-plain' },
    })
    expect(created.secretSet).toBe(true)
    expect(JSON.stringify(created)).not.toContain('p@ssw0rd-plain')
    expect(env.connections.getSecret(created.id)).toEqual({ password: 'p@ssw0rd-plain' })

    const row = env.db.get<{ secret_enc: string }>(
      'SELECT secret_enc FROM connections WHERE id = ?',
      created.id,
    )
    expect(row?.secret_enc).toMatch(/^v1:/)
    expect(row?.secret_enc ?? '').not.toContain('p@ssw0rd-plain')

    // 重名拒绝
    expect(() =>
      env.connections.create({ name: '订单库', kind: 'sqlite', config: { path: '/tmp/x.db' } }),
    ).toThrow(/已存在/)

    // 更新：缺省不改凭据；null 清空
    const kept = env.connections.update(created.id, { config: { host: '10.0.0.5', database: 'orders' } })
    expect(kept?.secretSet).toBe(true)
    expect(env.connections.getSecret(created.id)).toEqual({ password: 'p@ssw0rd-plain' })
    const cleared = env.connections.update(created.id, { secret: null })
    expect(cleared?.secretSet).toBe(false)
    expect(env.connections.getSecret(created.id)).toBeUndefined()
  })

  it('换密钥后解密失败返回 undefined（不抛错）；临时目录外无法枚举明文', () => {
    const env = makeEnv()
    const created = env.connections.create({
      name: '临时密钥测试',
      kind: 'mysql',
      config: { database: 'app' },
      secret: { password: 'secret-1' },
    })
    // 用另一把密钥的 vault 解同一密文：失败但不抛
    const otherVault = SecretVault.load({ keyFile: path.join(env.dir, 'other.key') })
    const raw = env.db.get<{ secret_enc: string }>(
      'SELECT secret_enc FROM connections WHERE id = ?',
      created.id,
    )
    expect(otherVault.decrypt(raw!.secret_enc)).toBeUndefined()
  })
})

// ---------- SQLite 连接器（管理器全链路） ----------

describe('M22：SQLite 连接器（管理器全链路）', () => {
  it('只读查询 / schema / 只读拒写 / allowWrites 后写入生效', async () => {
    const env = makeEnv()
    const file = makeSqliteFixture(env.dir)
    const conn = env.connections.create({
      name: '本地业务库',
      kind: 'sqlite',
      config: { path: file, readOnly: true },
    })

    expect(await env.manager.probe('sqlite')).toEqual({ ok: true })
    const probe = await env.manager.probe('postgres')
    expect(probe.ok).toBe(true)
    expect((await env.manager.probe('mysql')).ok).toBe(true)

    const query = await env.manager.exec({
      connectionId: conn.id,
      sql: 'SELECT name, age FROM users ORDER BY id',
      mode: 'query',
      actor: 'user',
    })
    expect(query.query?.columns).toEqual(['name', 'age'])
    expect(query.query?.rows).toEqual([
      { name: 'ann', age: 30 },
      { name: 'bob', age: 25 },
    ])

    const schema = await env.manager.exec({ connectionId: conn.id, mode: 'schema', actor: 'user' })
    const users = schema.schema?.tables.find((t) => t.name === 'users')
    expect(users?.columns.map((c) => c.name)).toEqual(['id', 'name', 'age'])

    // 只读连接：写语句在护栏层被拒
    await expect(
      env.manager.exec({
        connectionId: conn.id,
        sql: "INSERT INTO users (name) VALUES ('mallory')",
        mode: 'query',
        actor: 'user',
      }),
    ).rejects.toThrow(/只读模式仅允许/)
    // execute 模式在只读连接上同样拒绝
    await expect(
      env.manager.exec({
        connectionId: conn.id,
        sql: "INSERT INTO users (name) VALUES ('mallory')",
        mode: 'execute',
        actor: 'user',
      }),
    ).rejects.toThrow(/只读/)

    // 开启写入后：execute 生效且可回读
    env.connections.update(conn.id, { config: { path: file, readOnly: true, allowWrites: true } })
    const exec = await env.manager.exec({
      connectionId: conn.id,
      sql: "INSERT INTO users (name, age) VALUES ('cid', 40)",
      mode: 'execute',
      actor: 'user',
    })
    expect(exec.query?.affectedRows).toBe(1)
    const count = await env.manager.exec({
      connectionId: conn.id,
      sql: 'SELECT COUNT(*) AS n FROM users',
      mode: 'query',
      actor: 'user',
    })
    expect(count.query?.rows[0]).toEqual({ n: 3 })
  })

  it('会话绑定校验：Agent 调用必须已绑定；discoverability 与测试连通', async () => {
    const env = makeEnv()
    const file = makeSqliteFixture(env.dir)
    const conn = env.connections.create({ name: '绑定用库', kind: 'sqlite', config: { path: file } })
    const sessions = new SessionStore(env.db)
    const session = sessions.create(['a1'], 'M22 绑定测试')

    await expect(
      env.manager.exec({
        connectionId: conn.id,
        sql: 'SELECT 1 AS one',
        mode: 'query',
        actor: 'analyst',
        sessionId: session.id,
        requireBinding: true,
      }),
    ).rejects.toThrow(/未绑定/)

    env.connections.bind(session.id, conn.id)
    expect(env.connections.isBound(session.id, conn.id)).toBe(true)
    expect(env.connections.connectionsOf(session.id).map((b) => b.connection.id)).toEqual([conn.id])

    const result = await env.manager.exec({
      connectionId: conn.id,
      sql: 'SELECT 1 AS one',
      mode: 'query',
      actor: 'analyst',
      sessionId: session.id,
      requireBinding: true,
    })
    expect(result.query?.rows[0]).toEqual({ one: 1 })

    // 解绑后再次拒绝；连接测试走独立路径（重建句柄 + 状态回写）
    env.connections.unbind(session.id, conn.id)
    expect(env.connections.isBound(session.id, conn.id)).toBe(false)

    const test = await env.manager.test(conn.id, 'user')
    expect(test.ok).toBe(true)
    expect(test.detail ?? '').toContain('SQLite')
    expect(env.connections.get(conn.id)?.status).toBe('ok')

    // 禁用连接后拒绝执行
    env.connections.update(conn.id, { enabled: false })
    await expect(
      env.manager.exec({ connectionId: conn.id, sql: 'SELECT 1', mode: 'query', actor: 'user' }),
    ).rejects.toThrow(/已禁用/)

    await env.manager.closeAll()
  })

  it('审计留痕：每次执行（含失败）都落库', async () => {
    const env = makeEnv()
    const file = makeSqliteFixture(env.dir)
    const conn = env.connections.create({ name: '审计用库', kind: 'sqlite', config: { path: file } })
    await env.manager.exec({ connectionId: conn.id, sql: 'SELECT 1 AS one', mode: 'query', actor: 'user' })
    await expect(
      env.manager.exec({ connectionId: conn.id, sql: 'DROP TABLE users', mode: 'query', actor: 'user' }),
    ).rejects.toThrow()

    const entries = env.audit.list({ action: 'db.query', limit: 10 })
    expect(entries.length).toBeGreaterThanOrEqual(2)
    expect(entries.some((e) => e.ok === false)).toBe(true)
    await env.manager.closeAll()
  })
})

// ---------- 流 token ----------

describe('M22：流 token（watch / takeover 分权）', () => {
  it('watch 可复用；takeover 一次性；频道与级别严格绑定', () => {
    const tokens = new StreamTokenService(60_000)
    const topic = 'browser:bs_abc123'

    const watch = tokens.issue(topic, 'watch')
    expect(watch.topic).toBe(topic)
    expect(watch.mode).toBe('watch')
    expect(watch.expiresIn).toBe(60)
    expect(tokens.verify(watch.token, topic, 'watch').ok).toBe(true)
    expect(tokens.verify(watch.token, topic, 'watch').ok).toBe(true) // 可复用
    const asTakeover = tokens.verify(watch.token, topic, 'takeover')
    expect(asTakeover.ok).toBe(false)
    expect(asTakeover.ok === false && asTakeover.reason).toContain('权限级别')

    const takeover = tokens.issue(topic, 'takeover')
    expect(tokens.verify(takeover.token, topic, 'takeover').ok).toBe(true)
    const replay = tokens.verify(takeover.token, topic, 'takeover')
    expect(replay.ok).toBe(false)
    expect(replay.ok === false && replay.reason).toContain('已被使用')

    // 频道不匹配 / 篡改签名
    expect(tokens.verify(watch.token, 'browser:other', 'watch').ok).toBe(false)
    const tampered = `${watch.token.split('.')[0]}.AAAA`
    expect(tokens.verify(tampered, topic, 'watch').ok).toBe(false)
    expect(tokens.verify('not-a-token', topic, 'watch').ok).toBe(false)
  })

  it('过期 token 拒绝', () => {
    const tokens = new StreamTokenService(-1)
    const issued = tokens.issue('browser:bs_x', 'watch')
    const verified = tokens.verify(issued.token, 'browser:bs_x', 'watch')
    expect(verified.ok).toBe(false)
    expect(verified.ok === false && verified.reason).toContain('过期')
  })
})

// ---------- 迁移产物 ----------

describe('M22：迁移产出（五表 + 索引）', () => {
  it('v4 迁移建出连接中心全部表（幂等：重复打开不报错）', () => {
    const env = makeEnv()
    const names = env.db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .map((r) => r.name)
    for (const table of [
      'connections',
      'session_connections',
      'audit_log',
      'browser_sessions',
      'browser_steps',
    ]) {
      expect(names).toContain(table)
    }
    const again = openDatabase(env.db.file) // 再跑一次迁移（幂等）
    expect(
      again.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'")
        .length,
    ).toBeGreaterThan(0)
    expect(fs.existsSync(env.db.file)).toBe(true)
  })
})

// ---------- 工具层实时操作事件（notify:op → 直播窗 / 操作流数据源） ----------

describe('M22：db 工具实时操作事件（opNotify）', () => {
  /** 最小工具运行时：连接中心 + 数据库管理器 + 事件收集器 */
  function makeToolRuntime(
    env: ReturnType<typeof makeEnv>,
    sessionId: string,
    ops: ToolOpEvent[],
  ): ToolRuntime {
    const cfg = loadConfig()
    const skills = new SkillLibrary(cfg.skillsDir)
    const artifacts = new ArtifactStore(path.join(env.dir, 'artifacts'))
    const workspace = artifacts.ensureSessionDir(sessionId)
    return {
      sessionId,
      runId: 'r1',
      agentId: 'analyst',
      workspace,
      artifacts,
      skills,
      memory: new MemoryStore(env.db),
      tasks: new TaskStore(env.db),
      participants: [{ id: 'analyst', name: '阿析' }],
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
      connections: env.connections,
      db: env.manager,
      opNotify: (op) => ops.push(op),
    }
  }

  it('db_query 成功：推送 ok 事件 + 结果预览（前 5 行）+ SQL detail', async () => {
    const env = makeEnv()
    const file = makeSqliteFixture(env.dir, 3)
    const conn = env.connections.create({ name: '实时库', kind: 'sqlite', config: { path: file } })
    const sessions = new SessionStore(env.db)
    const session = sessions.create(['analyst'], 'M22 实时事件')
    env.connections.bind(session.id, conn.id)

    const ops: ToolOpEvent[] = []
    const registry = createToolRegistry(loadConfig())
    const result = await registry.execute(
      'db_query',
      { connection: conn.name, sql: 'SELECT name, age FROM users ORDER BY id' },
      makeToolRuntime(env, session.id, ops),
    )
    expect(result.ok).toBe(true)
    expect(ops).toHaveLength(1)
    expect(ops[0]).toMatchObject({
      kind: 'db',
      action: 'db.query',
      status: 'ok',
      target: 'conn:实时库',
    })
    expect(ops[0]?.detail).toContain('SELECT name, age FROM users')
    expect(ops[0]?.preview?.columns).toEqual(['name', 'age'])
    expect(ops[0]?.preview?.rows).toHaveLength(3)
    await env.manager.closeAll()
  })

  it('db_execute 只读拒绝：推送 error 事件（含失败摘要）', async () => {
    const env = makeEnv()
    const file = makeSqliteFixture(env.dir)
    const conn = env.connections.create({ name: '只读实时库', kind: 'sqlite', config: { path: file } })
    const sessions = new SessionStore(env.db)
    const session = sessions.create(['analyst'], 'M22 实时错误')
    env.connections.bind(session.id, conn.id)

    const ops: ToolOpEvent[] = []
    const registry = createToolRegistry(loadConfig())
    const result = await registry.execute(
      'db_execute',
      { connection: conn.id, sql: "INSERT INTO users (name) VALUES ('mallory')" },
      makeToolRuntime(env, session.id, ops),
    )
    expect(result.ok).toBe(false)
    const errOp = ops.find((o) => o.status === 'error')
    expect(errOp?.action).toBe('db.execute')
    expect(errOp?.summary ?? '').toMatch(/只读/)
    await env.manager.closeAll()
  })
})

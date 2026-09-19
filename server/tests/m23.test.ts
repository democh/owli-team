/**
 * M23 测试：数据库工作台（分页浏览防注入）+ SSH 接入（连接器 / 管理器 / 终端通道 / ssh_exec 工具）。
 *
 * 覆盖策略：
 * - quoteIdent 纯函数：方言引用 + 内部转义；
 * - tableData：真实 SQLite 业务库跑通分页（limit+1 探测 hasMore）/ 排序 / 表名列名白名单（注入拒绝）/ 钳制 / 审计；
 * - SSH 连接器：注入 FakeSshClient（EventEmitter 替身）——认证解析 / 连接建立 / 命令收集与截断 / PTY 窗口；
 * - SSH 管理器：allowExec 护栏 / 句柄缓存指纹重建 / 测试探测 / 终端独立连接 / 审计（成功与失败）；
 * - /ws/ssh 终端通道：真实 WS 客户端 —— token 一次性 / 二进制回显 / resize / ping-pong / exit；
 * - SSH「本地」预置：探测（用户名 / Agent / 默认私钥 / 22 端口；依赖注入零触网）+ 路由形状；
 * - ssh_exec 工具：会话绑定 → 管理器 → notify:op 全链路。
 */
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { describe, expect, it } from 'vitest'
import type { Client, ClientChannel, ConnectConfig } from 'ssh2'
import { WebSocket as WsClient, type RawData } from 'ws'
import type { SshLocalPreset } from '@multi-agent/shared'
import { StreamTokenService } from '../src/browser/stream-token.js'
import type { AppConfig } from '../src/config.js'
import { loadConfig } from '../src/config.js'
import { SecretVault } from '../src/connections/crypto.js'
import { DbConnectionManager } from '../src/connections/db/manager.js'
import { quoteIdent } from '../src/connections/db/types.js'
import {
  connectClient,
  execCommand,
  openShell,
  resizeShell,
  resolveConnectConfig,
  type SshClientFactory,
} from '../src/connections/ssh/connector.js'
import { SshConnectionManager } from '../src/connections/ssh/manager.js'
import { detectSshLocalPreset } from '../src/connections/ssh/local-preset.js'
import { createConnectionsRouter } from '../src/routes/connections.js'
import type { ApiDeps } from '../src/routes/index.js'
import { SshTerminalHub } from '../src/ssh-terminal.js'
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
  const dir = makeTmpDir('ma-m23-')
  const cfg: AppConfig = { ...loadConfig(), dataDir: dir, logLevel: 'silent' }
  const db = openDatabase(path.join(dir, 'app.db'))
  const vault = SecretVault.load({ keyFile: path.join(dir, 'secrets.key') })
  const connections = new ConnectionStore(db, vault)
  const audit = new AuditStore(db)
  const manager = new DbConnectionManager(cfg, connections, audit)
  return { dir, cfg, db, vault, connections, audit, manager }
}

/** 造一个业务库文件（SQLite 连接器要求文件已存在） */
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

// ---------- SSH 替身（EventEmitter 模拟 ssh2 Client / ClientChannel） ----------

/** SSH 通道替身：stdout / stderr / exit / close 由脚本触发 */
class FakeChannel extends EventEmitter {
  readonly stderr = new EventEmitter()
  readonly written: Array<Buffer | string> = []
  readonly windows: Array<[number, number, number, number]> = []
  closed = false

  /** 脚本便捷方法：退出码 → 关闭通道 */
  finish(code: number | null, signal?: string): void {
    this.emit('exit', code, signal)
    this.emit('close')
  }
  write(data: Buffer | string): boolean {
    this.written.push(data)
    this.emit('write', data)
    return true
  }
  setWindow(rows: number, cols: number, height: number, width: number): void {
    this.windows.push([rows, cols, height, width])
  }
  close(): void {
    this.closed = true
    this.emit('close')
  }
}

interface FakeSshOptions {
  /** 连接结果：'ready'（默认）| 'error' | 'close'（就绪前被关闭） */
  connectResult?: 'ready' | 'error' | 'close'
  failWith?: Error
  /** exec 脚本（默认：uname → Linux 行；其余 → ran: 命令） */
  execScript?: (command: string, channel: FakeChannel) => void
  /** shell 建立脚本（如回显输入） */
  shellScript?: (channel: FakeChannel) => void
  /** shell 建立失败 */
  shellError?: Error
}

/** 默认命令脚本：探测命令（uname / ver）返回内核行，其余返回回显 */
function defaultExecScript(command: string, channel: FakeChannel): void {
  if (command.includes('uname')) {
    channel.emit('data', Buffer.from('Linux testhost 6.1.0-ubuntu #1 SMP x86_64 GNU/Linux\n'))
  } else {
    channel.emit('data', Buffer.from(`ran: ${command}\n`))
  }
  channel.finish(0)
}

class FakeSshClient extends EventEmitter {
  readonly connects: ConnectConfig[] = []
  readonly execs: string[] = []
  readonly shellOptions: Array<Record<string, unknown>> = []
  readonly channels: FakeChannel[] = []
  ended = false
  destroyed = false

  constructor(private readonly opts: FakeSshOptions = {}) {
    super()
  }

  connect(config: ConnectConfig): void {
    this.connects.push(config)
    queueMicrotask(() => {
      const result = this.opts.connectResult ?? 'ready'
      if (result === 'error') this.emit('error', this.opts.failWith ?? new Error('SSH 连接失败'))
      else if (result === 'close') this.emit('close')
      else this.emit('ready')
    })
  }

  exec(command: string, cb: (err: Error | undefined, stream: ClientChannel) => void): void {
    this.execs.push(command)
    const channel = new FakeChannel()
    this.channels.push(channel)
    cb(undefined, channel as unknown as ClientChannel)
    const script = this.opts.execScript ?? defaultExecScript
    queueMicrotask(() => script(command, channel))
  }

  shell(window: Record<string, unknown>, cb: (err: Error | undefined, stream: ClientChannel) => void): void {
    this.shellOptions.push(window)
    if (this.opts.shellError) {
      cb(this.opts.shellError, undefined as unknown as ClientChannel)
      return
    }
    const channel = new FakeChannel()
    this.channels.push(channel)
    cb(undefined, channel as unknown as ClientChannel)
    this.opts.shellScript?.(channel)
  }

  end(): void {
    this.ended = true
    this.emit('close')
  }
  destroy(): void {
    this.destroyed = true
  }
}

/** 捕获工厂产物：既作 SshClientFactory 又收集实例（断言连接次数 / 参数） */
function makeFactory(options: FakeSshOptions = {}): { factory: SshClientFactory; clients: FakeSshClient[] } {
  const clients: FakeSshClient[] = []
  const factory: SshClientFactory = () => {
    const client = new FakeSshClient(options)
    clients.push(client)
    return client as unknown as Client
  }
  return { factory, clients }
}

/** 已就绪的替身 client（供连接器函数级测试直接调用） */
async function readyFake(options: FakeSshOptions = {}): Promise<{ client: Client; fake: FakeSshClient }> {
  const fake = new FakeSshClient(options)
  const client = await connectClient(() => fake as unknown as Client, { host: '127.0.0.1', username: 'u' })
  return { client, fake }
}

/** 轮询等待条件成立（替身旁路断言用） */
async function waitUntil(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('等待条件超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** SSH 测试环境：临时库 + SSH 连接定义 + 注入替身的连接管理器 */
function makeSshEnv(options: FakeSshOptions = {}, connectionConfig: Record<string, unknown> = {}) {
  const env = makeEnv()
  const conn = env.connections.create({
    name: '远端主机',
    kind: 'ssh',
    config: { host: '10.0.0.8', username: 'deploy', authMethod: 'password', ...connectionConfig },
    secret: { password: 'p@ss' },
  })
  const { factory, clients } = makeFactory(options)
  const ssh = new SshConnectionManager(env.cfg, env.connections, env.audit, factory)
  return { env, conn, ssh, clients }
}

// ---------- 标识符引用 ----------

describe('M23：标识符引用（quoteIdent）', () => {
  it('MySQL 反引号 / PostgreSQL・SQLite 双引号；内部引号转义', () => {
    expect(quoteIdent('mysql', 'users')).toBe('`users`')
    expect(quoteIdent('mysql', 'we`ird')).toBe('`we``ird`')
    expect(quoteIdent('postgres', 'users')).toBe('"users"')
    expect(quoteIdent('postgres', 'we"ird')).toBe('"we""ird"')
    expect(quoteIdent('sqlite', 'a"b')).toBe('"a""b"')
  })
})

// ---------- 表数据分页浏览（防注入） ----------

describe('M23：表数据分页浏览（tableData）', () => {
  it('分页：limit+1 探测 hasMore / offset 推进 / 排序（orderBy+desc）/ 审计留痕', async () => {
    const env = makeEnv()
    const file = makeSqliteFixture(env.dir, 3)
    const conn = env.connections.create({ name: '工作台库', kind: 'sqlite', config: { path: file } })

    const page1 = await env.manager.tableData({
      connectionId: conn.id,
      table: 'users',
      offset: 0,
      limit: 2,
      orderBy: 'id',
      actor: 'user',
    })
    expect(page1.columns).toEqual(['id', 'name', 'age'])
    expect(page1.rows.map((r) => r.name)).toEqual(['ann', 'bob'])
    expect(page1.hasMore).toBe(true)

    const page2 = await env.manager.tableData({
      connectionId: conn.id,
      table: 'users',
      offset: 2,
      limit: 2,
      orderBy: 'id',
      actor: 'user',
    })
    expect(page2.rows.map((r) => r.name)).toEqual(['cid'])
    expect(page2.hasMore).toBe(false)

    const sorted = await env.manager.tableData({
      connectionId: conn.id,
      table: 'users',
      offset: 0,
      limit: 10,
      orderBy: 'age',
      desc: true,
      actor: 'user',
    })
    expect(sorted.rows.map((r) => r.name)).toEqual(['cid', 'ann', 'bob'])

    const audits = env.audit.list({ action: 'db.browse' })
    expect(audits).toHaveLength(3)
    expect(audits[0]?.detail).toMatchObject({ table: 'users', offset: 0, limit: 2, hasMore: true })
    await env.manager.closeAll()
  })

  it('limit / offset 服务端钳制（1–500 / ≥0）', async () => {
    const env = makeEnv()
    const file = makeSqliteFixture(env.dir)
    const conn = env.connections.create({ name: '钳制库', kind: 'sqlite', config: { path: file } })
    const clamped = await env.manager.tableData({
      connectionId: conn.id,
      table: 'users',
      offset: -5,
      limit: 1_000,
      actor: 'user',
    })
    expect(clamped.limit).toBe(500)
    expect(clamped.offset).toBe(0)
    await env.manager.closeAll()
  })

  it('注入样例在拼 SQL 前被拒绝（表名 / 排序列白名单），业务表未受损', async () => {
    const env = makeEnv()
    const file = makeSqliteFixture(env.dir, 3)
    const conn = env.connections.create({ name: '注入靶场', kind: 'sqlite', config: { path: file } })

    await expect(
      env.manager.tableData({
        connectionId: conn.id,
        table: 'users; DROP TABLE users',
        offset: 0,
        limit: 10,
        actor: 'user',
      }),
    ).rejects.toThrow('不在结构快照中')
    await expect(
      env.manager.tableData({
        connectionId: conn.id,
        table: 'users',
        orderBy: 'age; DROP TABLE users',
        offset: 0,
        limit: 10,
        actor: 'user',
      }),
    ).rejects.toThrow('不存在于表')

    // 表未被删（拒绝发生在执行前）+ 失败审计留痕
    const still = await env.manager.tableData({ connectionId: conn.id, table: 'users', offset: 0, limit: 10, actor: 'user' })
    expect(still.rows).toHaveLength(3)
    const failed = env.audit.list({ action: 'db.browse' }).filter((entry) => !entry.ok)
    expect(failed).toHaveLength(2)
    expect(failed[0]?.error).toContain('不在结构快照中')
    await env.manager.closeAll()
  })
})

// ---------- SSH 连接器（认证解析 / 连接 / 命令 / PTY） ----------

describe('M23：SSH 连接器（认证解析）', () => {
  it('密码认证：默认主机与端口、字符串端口兼容；缺用户名 / 缺密码中文提示', () => {
    const config = resolveConnectConfig({ username: 'deploy', authMethod: 'password' }, { password: 'p@ss' })
    expect(config).toMatchObject({ host: '127.0.0.1', port: 22, username: 'deploy', password: 'p@ss' })
    expect(typeof config.readyTimeout).toBe('number')
    expect(resolveConnectConfig({ username: 'deploy', port: '2222' }, { password: 'x' }).port).toBe(2222)
    expect(() => resolveConnectConfig({ authMethod: 'password' }, { password: 'x' })).toThrow('缺少用户名')
    expect(() => resolveConnectConfig({ username: 'deploy' }, {})).toThrow('缺少密码凭据')
  })

  it('私钥认证：粘贴内容优先；文件路径读取；缺失与不存在的中文提示', () => {
    const inline = resolveConnectConfig(
      { username: 'deploy', authMethod: 'key' },
      { privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nDATA', passphrase: 'pp' },
    )
    expect((inline.privateKey as Buffer).toString()).toContain('BEGIN OPENSSH')
    expect(inline.passphrase).toBe('pp')

    const dir = makeTmpDir('ma-m23-key-')
    const keyFile = path.join(dir, 'id_ed25519')
    fs.writeFileSync(keyFile, 'KEY-FROM-FILE\n')
    const fromPath = resolveConnectConfig({ username: 'deploy', authMethod: 'key', privateKeyPath: keyFile }, {})
    expect((fromPath.privateKey as Buffer).toString()).toContain('KEY-FROM-FILE')

    expect(() => resolveConnectConfig({ username: 'deploy', authMethod: 'key' }, {})).toThrow('缺少私钥')
    expect(() =>
      resolveConnectConfig({ username: 'deploy', authMethod: 'key', privateKeyPath: path.join(dir, 'nope.key') }, {}),
    ).toThrow('私钥文件不存在')
  })

  it('agent 认证：SSH_AUTH_SOCK 透传；缺失时提示改用密码 / 私钥', () => {
    const saved = process.env.SSH_AUTH_SOCK
    try {
      delete process.env.SSH_AUTH_SOCK
      expect(() => resolveConnectConfig({ username: 'deploy', authMethod: 'agent' }, {})).toThrow('未检测到 SSH Agent')
      process.env.SSH_AUTH_SOCK = '/tmp/agent-test.sock'
      expect(resolveConnectConfig({ username: 'deploy', authMethod: 'agent' }, {}).agent).toBe('/tmp/agent-test.sock')
    } finally {
      if (saved === undefined) delete process.env.SSH_AUTH_SOCK
      else process.env.SSH_AUTH_SOCK = saved
    }
  })
})

describe('M23：SSH 连接器（连接 / 命令 / PTY）', () => {
  it('connectClient：ready 即成功；error 拒绝；就绪前 close 视为失败', async () => {
    const { client, fake } = await readyFake()
    expect(fake.connects).toHaveLength(1)

    await expect(
      connectClient(() => new FakeSshClient({ connectResult: 'error', failWith: new Error('connect ECONNREFUSED') }) as unknown as Client, {
        host: 'h',
        username: 'u',
      }),
    ).rejects.toThrow('ECONNREFUSED')
    await expect(
      connectClient(() => new FakeSshClient({ connectResult: 'close' }) as unknown as Client, { host: 'h', username: 'u' }),
    ).rejects.toThrow('就绪前被关闭')
    expect(client).toBeTruthy()
  })

  it('execCommand：收集 stdout / stderr / exit code；非零退出由调用方判断（不抛错）', async () => {
    const okRun = await readyFake()
    const result = await execCommand(okRun.client, 'uptime', { timeoutMs: 1_000, maxBytes: 10_000 })
    expect(result.stdout).toContain('ran: uptime')
    expect(result.code).toBe(0)
    expect(result.truncated).toBe(false)

    const failing = await readyFake({
      execScript: (_command, channel) => {
        channel.stderr.emit('data', Buffer.from('bash: nope: command not found\n'))
        channel.finish(127)
      },
    })
    const bad = await execCommand(failing.client, 'nope', { timeoutMs: 1_000, maxBytes: 10_000 })
    expect(bad.code).toBe(127)
    expect(bad.stderr).toContain('command not found')
  })

  it('execCommand：超过 maxBytes 截断（不无限累积）；超时强杀通道并抛错', async () => {
    const big = await readyFake({
      execScript: (_command, channel) => {
        channel.emit('data', Buffer.from('x'.repeat(4_096)))
        channel.finish(0)
      },
    })
    const truncated = await execCommand(big.client, 'big', { timeoutMs: 1_000, maxBytes: 1_024 })
    expect(truncated.truncated).toBe(true)
    expect(truncated.stdout.length).toBeLessThan(4_096)

    const hang = await readyFake({ execScript: () => undefined })
    await expect(execCommand(hang.client, 'hang', { timeoutMs: 30, maxBytes: 1_024 })).rejects.toThrow('强制终止通道')
    expect(hang.fake.channels[0]?.closed).toBe(true)
  })

  it('openShell / resizeShell：PTY 参数 + setWindow 参数序（rows, cols, height, width）+ 尺寸下限钳制', async () => {
    const { client, fake } = await readyFake()
    const stream = (await openShell(client, { cols: 120, rows: 40 })) as unknown as FakeChannel
    expect(fake.shellOptions[0]).toMatchObject({
      term: 'xterm-256color',
      cols: 120,
      rows: 40,
      width: 960,
      height: 640,
    })
    resizeShell(stream as unknown as ClientChannel, 120, 40)
    expect(stream.windows[0]).toEqual([40, 120, 640, 960])
    resizeShell(stream as unknown as ClientChannel, 2, 1)
    expect(stream.windows[1]).toEqual([5, 20, 80, 160])
  })
})

// ---------- SSH 连接管理器 ----------

describe('M23：SSH 连接管理器（护栏 / 缓存 / 终端 / 审计）', () => {
  it('test：探测成功 → 状态灯 ok + 审计；连接失败 → error 回写 + 失败审计', async () => {
    const okEnv = makeSshEnv()
    const okResult = await okEnv.ssh.test(okEnv.conn.id, 'user')
    expect(okResult.ok).toBe(true)
    expect(okResult.detail).toContain('Linux testhost')
    expect(okEnv.env.connections.get(okEnv.conn.id)?.status).toBe('ok')
    expect(okEnv.env.audit.list({ action: 'connection.test' })[0]).toMatchObject({ ok: true, resourceId: okEnv.conn.id })

    const badEnv = makeSshEnv({ connectResult: 'error', failWith: new Error('connect ECONNREFUSED 10.0.0.8:22') })
    const badResult = await badEnv.ssh.test(badEnv.conn.id, 'user')
    expect(badResult.ok).toBe(false)
    expect(badResult.error).toContain('ECONNREFUSED')
    expect(badEnv.env.connections.get(badEnv.conn.id)?.status).toBe('error')
    const failure = badEnv.env.audit.list({ action: 'connection.test' })[0]
    expect(failure?.ok).toBe(false)
    expect(failure?.error).toContain('ECONNREFUSED')
    await okEnv.ssh.closeAll()
    await badEnv.ssh.closeAll()
  })

  it('exec：未开 allowExec 前置拒绝（含指引）；开启后执行成功；命令过长拒绝', async () => {
    const closed = makeSshEnv()
    await expect(
      closed.ssh.exec({ connectionId: closed.conn.id, command: 'id', actor: 'analyst', sessionId: 's1' }),
    ).rejects.toThrow('未开启「允许 Agent 执行命令」')
    expect(closed.env.audit.list({ action: 'ssh.exec' })[0]?.ok).toBe(false)

    const allowed = makeSshEnv({}, { allowExec: true })
    const result = await allowed.ssh.exec({
      connectionId: allowed.conn.id,
      command: 'systemctl status nginx',
      actor: 'analyst',
      runId: 'r1',
    })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('ran: systemctl status nginx')
    const okEntry = allowed.env.audit.list({ action: 'ssh.exec' }).find((entry) => entry.ok)
    expect(okEntry?.detail).toMatchObject({ code: 0, truncated: false })
    await expect(
      allowed.ssh.exec({ connectionId: allowed.conn.id, command: 'x'.repeat(4_100), actor: 'analyst' }),
    ).rejects.toThrow('命令过长')
    await closed.ssh.closeAll()
    await allowed.ssh.closeAll()
  })

  it('exec：非零退出返回结果（不抛错），审计记录 exit code 与 stderr 判据', async () => {
    const env = makeSshEnv(
      {
        execScript: (_command, channel) => {
          channel.stderr.emit('data', Buffer.from('sudo: a password is required\n'))
          channel.finish(1)
        },
      },
      { allowExec: true },
    )
    const result = await env.ssh.exec({ connectionId: env.conn.id, command: 'sudo systemctl restart nginx', actor: 'analyst' })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('a password is required')
    expect(env.env.audit.list({ action: 'ssh.exec' })[0]?.detail).toMatchObject({ code: 1 })
    await env.ssh.closeAll()
  })

  it('句柄缓存：同配置复用（只连一次）；配置变更后指纹失效自动重建', async () => {
    const env = makeSshEnv({}, { allowExec: true })
    await env.ssh.exec({ connectionId: env.conn.id, command: 'hostname', actor: 'analyst' })
    await env.ssh.exec({ connectionId: env.conn.id, command: 'uptime', actor: 'analyst' })
    expect(env.clients).toHaveLength(1)
    expect(env.clients[0]?.connects).toHaveLength(1)

    env.env.connections.update(env.conn.id, {
      config: { host: '10.0.0.9', username: 'deploy', authMethod: 'password', allowExec: true },
    })
    await env.ssh.exec({ connectionId: env.conn.id, command: 'hostname', actor: 'analyst' })
    expect(env.clients).toHaveLength(2)
    expect(env.clients[1]?.connects[0]?.host).toBe('10.0.0.9')

    await env.ssh.closeAll()
    expect(env.clients[1]?.ended).toBe(true)
  })

  it('非 SSH 连接拒绝；禁用连接拒绝', async () => {
    const env = makeEnv()
    const file = makeSqliteFixture(env.dir)
    const dbConn = env.connections.create({ name: '数据库连接', kind: 'sqlite', config: { path: file } })
    const { factory } = makeFactory()
    const ssh = new SshConnectionManager(env.cfg, env.connections, env.audit, factory)
    await expect(ssh.exec({ connectionId: dbConn.id, command: 'id', actor: 'analyst' })).rejects.toThrow('不是 SSH 类型')

    const sshConn = env.connections.create({
      name: '停用主机',
      kind: 'ssh',
      config: { host: 'h', username: 'u', authMethod: 'password', allowExec: true },
      secret: { password: 'p' },
      enabled: false,
    })
    await expect(ssh.test(sshConn.id, 'user')).resolves.toMatchObject({ ok: false })
    expect((await ssh.test(sshConn.id, 'user')).error).toContain('已禁用')
    await ssh.closeAll()
    await env.manager.closeAll()
  })

  it('openTerminal：独立连接（不复用缓存句柄）；成功 / 失败均审计', async () => {
    const env = makeSshEnv({}, { allowExec: true })
    await env.ssh.exec({ connectionId: env.conn.id, command: 'hostname', actor: 'analyst' })
    const terminal = await env.ssh.openTerminal(env.conn.id, { cols: 100, rows: 30 }, 'user')
    expect(env.clients).toHaveLength(2) // 终端不复用缓存句柄
    expect(env.clients[1]?.shellOptions[0]).toMatchObject({ cols: 100, rows: 30, term: 'xterm-256color' })
    expect(terminal.connection.id).toBe(env.conn.id)
    const okEntry = env.env.audit.list({ action: 'ssh.terminal' })[0]
    expect(okEntry).toMatchObject({ ok: true, resourceId: env.conn.id })
    expect(okEntry?.detail).toMatchObject({ host: '10.0.0.8', port: 22, cols: 100, rows: 30 })

    const badEnv = makeSshEnv({ shellError: new Error('PTY request rejected') })
    await expect(badEnv.ssh.openTerminal(badEnv.conn.id, { cols: 80, rows: 24 }, 'user')).rejects.toThrow('PTY request rejected')
    expect(badEnv.env.audit.list({ action: 'ssh.terminal' })[0]?.ok).toBe(false)
    await env.ssh.closeAll()
    await badEnv.ssh.closeAll()
  })
})

// ---------- /ws/ssh 终端通道（真实 WS 客户端） ----------

interface WsMessage {
  binary: boolean
  payload: Buffer
}

/** 测试邮箱：收集 WS 消息并支持「等待首个满足条件的消息」 */
class WsMailbox {
  readonly messages: WsMessage[] = []
  private readonly waiters: Array<() => void> = []

  constructor(readonly socket: WsClient) {
    socket.on('message', (data: RawData, isBinary: boolean) => {
      const payload = Array.isArray(data)
        ? Buffer.concat(data as Buffer[])
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data as ArrayBuffer)
      this.messages.push({ binary: isBinary, payload })
      for (const wake of this.waiters.splice(0)) wake()
    })
  }

  async waitFor(predicate: (message: WsMessage) => boolean, timeoutMs = 3_000): Promise<WsMessage> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const hit = this.messages.find(predicate)
      if (hit) return hit
      if (Date.now() > deadline) throw new Error(`等待 WS 消息超时（已收 ${this.messages.length} 条）`)
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve)
        setTimeout(resolve, 20).unref?.()
      })
    }
  }
}

function connectWs(url: string): Promise<WsMailbox> {
  return new Promise((resolve, reject) => {
    const socket = new WsClient(url)
    socket.on('open', () => resolve(new WsMailbox(socket)))
    socket.on('error', reject)
  })
}

describe('M23：SSH 交互终端通道（/ws/ssh）', () => {
  it('token 一次性授权 → ready → 输入回显（二进制帧）→ resize → ping-pong → exit', async () => {
    const { env, conn, ssh, clients } = makeSshEnv({
      shellScript: (channel) => channel.on('write', (data) => channel.emit('data', data)),
    })
    const tokens = new StreamTokenService(60_000)
    const hub = new SshTerminalHub(env.cfg, ssh, tokens)
    const server = http.createServer((_req, res) => res.end('ok'))
    hub.attach(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as AddressInfo).port
    const url = (token: string): string =>
      `ws://127.0.0.1:${port}/ws/ssh?connectionId=${conn.id}&token=${encodeURIComponent(token)}`
    const issued = tokens.issue(`ssh:${conn.id}`, 'takeover')
    try {
      // 无效 token：拒绝升级
      await expect(connectWs(url('bad-token'))).rejects.toBeTruthy()

      const mail = await connectWs(url(issued.token))
      const ready = await mail.waitFor((message) => !message.binary)
      expect(JSON.parse(ready.payload.toString())).toMatchObject({ type: 'ready', cols: 80, rows: 24 })

      // 键盘输入（二进制）→ 远程字节原样回传（二进制帧）
      mail.socket.send(Buffer.from('ls -la\n'), { binary: true })
      const echo = await mail.waitFor((message) => message.binary)
      expect(echo.payload.toString()).toBe('ls -la\n')
      expect(clients[0]?.channels[0]?.written).toEqual([Buffer.from('ls -la\n')])

      // resize（JSON）→ PTY 窗口更新
      mail.socket.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }))
      await waitUntil(() => clients[0]?.channels[0]?.windows.length === 1)
      expect(clients[0]?.channels[0]?.windows[0]).toEqual([40, 120, 640, 960])

      // ping → pong
      mail.socket.send(JSON.stringify({ type: 'ping' }))
      const pong = await mail.waitFor((message) => !message.binary && message.payload.toString().includes('pong'))
      expect(JSON.parse(pong.payload.toString())).toMatchObject({ type: 'pong' })

      // 远程退出 → exit 控制帧 + 通道回收
      clients[0]?.channels[0]?.finish(0)
      const exit = await mail.waitFor((message) => !message.binary && message.payload.toString().includes('exit'))
      expect(JSON.parse(exit.payload.toString())).toMatchObject({ type: 'exit', code: 0 })
      expect(env.audit.list({ action: 'ssh.terminal' })[0]?.ok).toBe(true)

      // token 一次性：复用被拒
      await expect(connectWs(url(issued.token))).rejects.toBeTruthy()
    } finally {
      hub.close()
      await ssh.closeAll()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await env.manager.closeAll()
    }
  })

  it('连接失败：先回 error 控制帧再关闭（不泄漏 SSH 连接）', async () => {
    const { env, conn, ssh } = makeSshEnv({ connectResult: 'error', failWith: new Error('connect ETIMEDOUT') })
    const tokens = new StreamTokenService(60_000)
    const hub = new SshTerminalHub(env.cfg, ssh, tokens)
    const server = http.createServer((_req, res) => res.end('ok'))
    hub.attach(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as AddressInfo).port
    const issued = tokens.issue(`ssh:${conn.id}`, 'takeover')
    try {
      const mail = await connectWs(
        `ws://127.0.0.1:${port}/ws/ssh?connectionId=${conn.id}&token=${encodeURIComponent(issued.token)}`,
      )
      const error = await mail.waitFor((message) => !message.binary && message.payload.toString().includes('error'))
      expect(JSON.parse(error.payload.toString())).toMatchObject({ type: 'error' })
      expect((JSON.parse(error.payload.toString()) as { message: string }).message).toContain('ETIMEDOUT')
    } finally {
      hub.close()
      await ssh.closeAll()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

// ---------- ssh_exec 工具（会话绑定 → 管理器 → notify:op） ----------

describe('M23：ssh_exec 工具', () => {
  /** 最小工具运行时：连接中心 + 数据库管理器 + SSH 管理器 + 事件收集器 */
  function makeToolRuntime(
    env: ReturnType<typeof makeEnv>,
    sessionId: string,
    ops: ToolOpEvent[],
    ssh: SshConnectionManager,
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
      ssh,
      opNotify: (op) => ops.push(op),
    }
  }

  /** 建 SSH 连接 + 会话绑定 + 运行时（返回断言所需句柄） */
  function makeBoundSession(options: FakeSshOptions = {}, connectionConfig: Record<string, unknown> = {}) {
    const env = makeEnv()
    const conn = env.connections.create({
      name: '生产机',
      kind: 'ssh',
      config: { host: '10.1.1.1', username: 'deploy', authMethod: 'password', ...connectionConfig },
      secret: { password: 'p' },
    })
    const { factory } = makeFactory(options)
    const ssh = new SshConnectionManager(env.cfg, env.connections, env.audit, factory)
    const sessions = new SessionStore(env.db)
    const session = sessions.create(['analyst'], 'M23 SSH 工具')
    env.connections.bind(session.id, conn.id)
    const ops: ToolOpEvent[] = []
    const runtime = makeToolRuntime(env, session.id, ops, ssh)
    return { env, conn, ssh, ops, runtime }
  }

  it('成功：exit 0 → ok 事件（kind ssh / target conn:名称 / detail 含命令与输出）', async () => {
    const session = makeBoundSession({}, { allowExec: true })
    const registry = createToolRegistry(loadConfig())
    const result = await registry.execute(
      'ssh_exec',
      { connection: session.conn.name, command: 'systemctl status nginx' },
      session.runtime,
    )
    expect(result.ok).toBe(true)
    expect(result.summary).toContain('命令完成')
    expect(session.ops).toHaveLength(1)
    expect(session.ops[0]).toMatchObject({
      kind: 'ssh',
      action: 'ssh.exec',
      status: 'ok',
      target: `conn:${session.conn.name}`,
    })
    expect(session.ops[0]?.detail).toContain('$ systemctl status nginx')
    await session.ssh.closeAll()
    await session.env.manager.closeAll()
  })

  it('未开启 allowExec：工具返回失败 + error 事件（含开启指引）', async () => {
    const session = makeBoundSession()
    const registry = createToolRegistry(loadConfig())
    const result = await registry.execute('ssh_exec', { connection: session.conn.id, command: 'id' }, session.runtime)
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('未开启')
    expect(session.ops).toHaveLength(1)
    expect(session.ops[0]).toMatchObject({ kind: 'ssh', action: 'ssh.exec', status: 'error' })
    expect(session.ops[0]?.summary).toContain('未开启')
    await session.ssh.closeAll()
    await session.env.manager.closeAll()
  })

  it('未绑定会话：拒绝并给出绑定指引（不发操作事件）', async () => {
    const env = makeEnv()
    const conn = env.connections.create({
      name: '未绑定机',
      kind: 'ssh',
      config: { host: 'h', username: 'u', authMethod: 'password', allowExec: true },
      secret: { password: 'p' },
    })
    const { factory } = makeFactory()
    const ssh = new SshConnectionManager(env.cfg, env.connections, env.audit, factory)
    const sessions = new SessionStore(env.db)
    const session = sessions.create(['analyst'], 'M23 未绑定')
    const ops: ToolOpEvent[] = []
    const registry = createToolRegistry(loadConfig())
    const result = await registry.execute(
      'ssh_exec',
      { connection: conn.name, command: 'id' },
      makeToolRuntime(env, session.id, ops, ssh),
    )
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('未绑定任何 SSH 连接')
    expect(ops).toHaveLength(0)
    await ssh.closeAll()
    await env.manager.closeAll()
  })
})

// ---------- SSH「本地」预置（探测 / 路由） ----------

describe('M23：SSH「本地」预置（探测）', () => {
  /** 临时 home：按需造 ~/.ssh 默认私钥（零触网） */
  function makeHome(keys: string[] = []): string {
    const home = makeTmpDir('ma-m23-home-')
    fs.mkdirSync(path.join(home, '.ssh'), { recursive: true })
    for (const key of keys) fs.writeFileSync(path.join(home, '.ssh', key), 'KEY')
    return home
  }
  const offline = async (): Promise<boolean> => false

  it('默认键：名称「本地」/ 主机 127.0.0.1 / 端口 22 / 用户名透传', async () => {
    const preset = await detectSshLocalPreset({ homeDir: makeHome(), env: {}, username: 'ann', probePort: offline })
    expect(preset).toMatchObject({ name: '本地', host: '127.0.0.1', port: 22, username: 'ann' })
    expect(preset.agentAvailable).toBe(false)
    expect(preset.sshdReachable).toBe(false)
  })

  it('认证优先级：agent（SSH_AUTH_SOCK）> key（默认私钥）> password；私钥序 ed25519 → rsa', async () => {
    // 无 agent 无私钥 → password（不带 privateKeyPath）
    const pwd = await detectSshLocalPreset({ homeDir: makeHome(), env: {}, username: 'ann', probePort: offline })
    expect(pwd.authMethod).toBe('password')
    expect(pwd.privateKeyPath).toBeUndefined()
    // 仅 id_rsa → key + ~/.ssh/id_rsa
    const rsa = await detectSshLocalPreset({ homeDir: makeHome(['id_rsa']), env: {}, username: 'ann', probePort: offline })
    expect(rsa.authMethod).toBe('key')
    expect(rsa.privateKeyPath).toBe('~/.ssh/id_rsa')
    // ed25519 + rsa → 取 ed25519（候选优先级）
    const both = await detectSshLocalPreset({
      homeDir: makeHome(['id_ed25519', 'id_rsa']),
      env: {},
      username: 'ann',
      probePort: offline,
    })
    expect(both.privateKeyPath).toBe('~/.ssh/id_ed25519')
    // agent 在场 → 优先 agent（即使默认私钥存在也不带 privateKeyPath）
    const agent = await detectSshLocalPreset({
      homeDir: makeHome(['id_ed25519']),
      env: { SSH_AUTH_SOCK: '/tmp/agent.sock' },
      username: 'ann',
      probePort: offline,
    })
    expect(agent.authMethod).toBe('agent')
    expect(agent.agentAvailable).toBe(true)
    expect(agent.privateKeyPath).toBeUndefined()
  })

  it('22 端口探测：可达 / 不可达两态透传；探测参数为本机 127.0.0.1:22', async () => {
    const reachable = await detectSshLocalPreset({
      homeDir: makeHome(),
      env: {},
      username: 'ann',
      probePort: async () => true,
    })
    expect(reachable.sshdReachable).toBe(true)
    const calls: Array<[string, number]> = []
    const unreachable = await detectSshLocalPreset({
      homeDir: makeHome(),
      env: {},
      username: 'ann',
      probePort: async (host, port) => {
        calls.push([host, port])
        return false
      },
    })
    expect(unreachable.sshdReachable).toBe(false)
    expect(calls).toEqual([['127.0.0.1', 22]])
  })
})

/** 最小路由夹具（单用户模式：管理面守卫直通；本文件仅访问 ssh-preset） */
async function startConnApi(partial: Record<string, unknown>): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express()
  app.use(express.json())
  app.use('/api', createConnectionsRouter({ access: { multiUser: false }, ...partial } as unknown as ApiDeps))
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

describe('M23：SSH「本地」预置（路由）', () => {
  it('GET /api/connections/ssh-preset：真实环境探测的有界形状（不受本机 sshd / 私钥存在与否影响）', async () => {
    const env = makeEnv()
    const api = await startConnApi({ connections: env.connections, audit: env.audit })
    try {
      const res = await fetch(`${api.url}/api/connections/ssh-preset`)
      expect(res.status).toBe(200)
      const { preset } = (await res.json()) as { preset: SshLocalPreset }
      expect(preset.name).toBe('本地')
      expect(preset.host).toBe('127.0.0.1')
      expect(preset.port).toBe(22)
      expect(preset.username).toBe(os.userInfo().username)
      expect(['agent', 'key', 'password']).toContain(preset.authMethod)
      expect(typeof preset.agentAvailable).toBe('boolean')
      expect(typeof preset.sshdReachable).toBe('boolean')
    } finally {
      await api.close()
    }
  })

  it('路由优先于 /connections/:id（不得被 id 参数吞没为 404）', async () => {
    const env = makeEnv()
    const api = await startConnApi({ connections: env.connections, audit: env.audit })
    try {
      // 无连接时 /connections/ssh-preset 仍为巡检面而非「连接不存在」
      const res = await fetch(`${api.url}/api/connections/ssh-preset`)
      expect(res.status).toBe(200)
      expect((await res.json()) as { preset?: unknown }).toHaveProperty('preset')
    } finally {
      await api.close()
    }
  })
})

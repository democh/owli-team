/**
 * SSH 连接管理器（M23）：连接缓存 / 测试 / Agent 命令执行 / 交互终端会话。
 *
 * 职责：
 * - 句柄缓存：按 connectionId 缓存（配置 / 凭据指纹变化时重建；空闲回收；close 事件自动失效）；
 * - 权限链（Agent 命令）：enabled → allowExec 开关（默认关，Agent 任意远程命令属最高危）；
 * - 终端：每会话独立连接（隔离性好，一个终端异常不影响其他终端）；
 * - 审计：test / ssh.exec / ssh.terminal 全量留痕（失败带 error）。
 */
import { createHash } from 'node:crypto'
import { Client } from 'ssh2'
import type { ClientChannel } from 'ssh2'
import type { ConnectionDefinition, ConnectionTestResult, SshExecResultDto } from '@multi-agent/shared'
import type { AppConfig } from '../../config.js'
import type { AuditStore } from '../../store/audit.js'
import type { ConnectionStore } from '../../store/connections.js'
import { cfgBool } from '../db/types.js'
import {
  connectClient,
  execCommand,
  openShell,
  resolveConnectConfig,
  type SshClientFactory,
} from './connector.js'

/** 空闲句柄回收阈值（SSH 连接不宜长缓存：10 分钟无使用即断开） */
const SSH_IDLE_MS = 10 * 60_000
const EXEC_DEFAULT_TIMEOUT_MS = 30_000
const EXEC_MAX_TIMEOUT_MS = 120_000
const EXEC_MAX_BYTES = 256 * 1024

interface HandleEntry {
  client: Client
  fingerprint: string
  lastUsedAt: number
}

export interface SshExecInput {
  connectionId: string
  command: string
  timeoutMs?: number
  /** 'user' | agentId */
  actor: string
  sessionId?: string
  runId?: string
}

export class SshConnectionManager {
  private readonly handles = new Map<string, HandleEntry>()
  /** 并发合并：同一连接的句柄建立只发一次 */
  private readonly inflight = new Map<string, Promise<Client>>()
  private sweeper?: NodeJS.Timeout

  constructor(
    private readonly cfg: AppConfig,
    private readonly store: ConnectionStore,
    private readonly audit: AuditStore,
    private readonly clientFactory: SshClientFactory = () => new Client(),
  ) {}

  /** 启动空闲句柄回收（index.ts 组装时调用；进程退出前 closeAll） */
  start(): void {
    if (this.sweeper) return
    this.sweeper = setInterval(() => this.sweepIdle(), 60_000)
    this.sweeper.unref?.()
  }

  async closeAll(): Promise<void> {
    if (this.sweeper) {
      clearInterval(this.sweeper)
      this.sweeper = undefined
    }
    const entries = [...this.handles.values()]
    this.handles.clear()
    this.inflight.clear()
    for (const entry of entries) {
      try {
        entry.client.end()
      } catch {
        // 已断开：忽略
      }
    }
  }

  private sweepIdle(): void {
    const deadline = Date.now() - SSH_IDLE_MS
    for (const [id, entry] of [...this.handles.entries()]) {
      if (entry.lastUsedAt >= deadline) continue
      this.handles.delete(id)
      try {
        entry.client.end()
      } catch {
        // 忽略
      }
    }
  }

  /** 解析连接 + 基础校验（kind / enabled） */
  private resolve(connectionId: string): ConnectionDefinition {
    const connection = this.store.get(connectionId)
    if (!connection) throw new Error('连接不存在')
    if (connection.kind !== 'ssh')
      throw new Error(`连接「${connection.name}」不是 SSH 类型（${connection.kind}）`)
    if (!connection.enabled) throw new Error(`连接「${connection.name}」已禁用`)
    return connection
  }

  private fingerprintOf(connection: ConnectionDefinition, secret: Record<string, unknown>): string {
    return createHash('sha256')
      .update(JSON.stringify(connection.config))
      .update('|')
      .update(JSON.stringify(secret))
      .digest('hex')
      .slice(0, 16)
  }

  /** 取得（或建立）连接句柄；close 事件自动失效缓存 */
  private async ensure(connection: ConnectionDefinition): Promise<Client> {
    const secret = this.store.getSecret(connection.id) ?? {}
    const fingerprint = this.fingerprintOf(connection, secret)
    const cached = this.handles.get(connection.id)
    if (cached && cached.fingerprint === fingerprint) {
      cached.lastUsedAt = Date.now()
      return cached.client
    }
    const pending = this.inflight.get(connection.id)
    if (pending) return pending

    const task = (async (): Promise<Client> => {
      const config = resolveConnectConfig(connection.config, secret)
      const client = await connectClient(this.clientFactory, config)
      const old = this.handles.get(connection.id)
      this.handles.set(connection.id, { client, fingerprint, lastUsedAt: Date.now() })
      if (old) {
        try {
          old.client.end()
        } catch {
          // 旧连接关闭失败无妨
        }
      }
      // 断线自动失效（下次调用重建）
      client.on('close', () => {
        const entry = this.handles.get(connection.id)
        if (entry && entry.client === client) this.handles.delete(connection.id)
      })
      return client
    })()
    this.inflight.set(connection.id, task)
    try {
      return await task
    } finally {
      this.inflight.delete(connection.id)
    }
  }

  /** 连接测试（回写状态灯 + 审计）：强制重建句柄 → 探测命令（uname / ver） */
  async test(connectionId: string, actor: string): Promise<ConnectionTestResult> {
    const started = Date.now()
    let connection: ConnectionDefinition
    try {
      connection = this.resolve(connectionId)
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
    try {
      // 测试时强制重建（避免命中陈旧缓存掩盖配置错误）
      await this.invalidate(connection.id)
      const client = await this.ensure(connection)
      const probe = await execCommand(client, 'uname -a || ver', { timeoutMs: 8_000, maxBytes: 8_192 })
      const latencyMs = Date.now() - started
      const detail =
        probe.stdout.trim().split('\n')[0]?.trim() ||
        probe.stderr.trim().split('\n')[0]?.trim() ||
        (probe.code === null ? '已连接' : `已连接（exit ${probe.code}）`)
      this.store.setStatus(connection.id, 'ok')
      this.audit.record({
        actor,
        action: 'connection.test',
        resourceType: 'connection',
        resourceId: connection.id,
        detail: { latencyMs, detail },
      })
      return { ok: true, latencyMs, detail }
    } catch (err) {
      const message = (err as Error).message
      this.store.setStatus(connection.id, 'error', message)
      this.audit.record({
        actor,
        action: 'connection.test',
        resourceType: 'connection',
        resourceId: connection.id,
        ok: false,
        error: message,
      })
      return { ok: false, error: message }
    }
  }

  /** 一次性命令执行（Agent ssh_exec / 审计）：allowExec 必须显式开启 */
  async exec(input: SshExecInput): Promise<SshExecResultDto> {
    let connection: ConnectionDefinition | undefined
    try {
      connection = this.resolve(input.connectionId)
      if (!cfgBool(connection.config, 'allowExec', false)) {
        throw new Error(
          `连接「${connection.name}」未开启「允许 Agent 执行命令」：请在连接设置中显式开启后再试（远程命令属高风险操作）`,
        )
      }
      const command = input.command.trim()
      if (!command) throw new Error('命令为空')
      if (command.length > 4_000) throw new Error('命令过长（上限 4000 字符）')
      const timeoutMs = Math.min(
        Math.max(input.timeoutMs ?? EXEC_DEFAULT_TIMEOUT_MS, 1_000),
        EXEC_MAX_TIMEOUT_MS,
      )
      const client = await this.ensure(connection)
      const result = await execCommand(client, command, { timeoutMs, maxBytes: EXEC_MAX_BYTES })
      this.audit.record({
        actor: input.actor,
        action: 'ssh.exec',
        resourceType: 'connection',
        resourceId: connection.id,
        sessionId: input.sessionId,
        runId: input.runId,
        detail: {
          command: command.slice(0, 500),
          code: result.code,
          signal: result.signal,
          durationMs: result.durationMs,
          truncated: result.truncated,
        },
      })
      return result
    } catch (err) {
      this.audit.record({
        actor: input.actor,
        action: 'ssh.exec',
        resourceType: 'connection',
        resourceId: input.connectionId,
        sessionId: input.sessionId,
        runId: input.runId,
        ok: false,
        detail: { command: input.command.slice(0, 500) },
        error: (err as Error).message,
      })
      throw err
    }
  }

  /**
   * 交互终端：独立连接 + PTY（不复用缓存句柄——终端间互相隔离）。
   * 返回的 client / stream 由调用方（WS Hub）负责生命周期。
   */
  async openTerminal(
    connectionId: string,
    opts: { cols: number; rows: number },
    actor: string,
  ): Promise<{ client: Client; stream: ClientChannel; connection: ConnectionDefinition }> {
    const connection = this.resolve(connectionId)
    const secret = this.store.getSecret(connection.id) ?? {}
    const config = resolveConnectConfig(connection.config, secret)
    const client = await connectClient(this.clientFactory, config)
    try {
      const stream = await openShell(client, opts)
      this.audit.record({
        actor,
        action: 'ssh.terminal',
        resourceType: 'connection',
        resourceId: connection.id,
        detail: { host: config.host, port: config.port, cols: opts.cols, rows: opts.rows },
      })
      return { client, stream, connection }
    } catch (err) {
      client.end()
      this.audit.record({
        actor,
        action: 'ssh.terminal',
        resourceType: 'connection',
        resourceId: connection.id,
        ok: false,
        error: (err as Error).message,
      })
      throw err
    }
  }

  /** 连接移除 / 更新后的句柄失效（路由层在 delete/update 后调用） */
  async invalidate(connectionId: string): Promise<void> {
    const entry = this.handles.get(connectionId)
    if (!entry) return
    this.handles.delete(connectionId)
    try {
      entry.client.end()
    } catch {
      // 忽略
    }
  }
}

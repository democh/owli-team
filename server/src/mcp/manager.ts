/**
 * M27：MCP 运行时管理器 —— 连接生命周期 / 工具注入注册表 / 会话可用性 / 调用执行。
 *
 * 职责：
 * - 生命周期：start（启动连接全部启用服务器）/ connect / disconnect / restart / refreshTools / test / stopAll；
 *   每服务器串行锁（boot 连接与用户操作不打架）；单台失败不影响其余（状态置 error 并广播）；
 * - 工具注入：`mcp__<slug>__<tool>` 注册进 ToolRegistry（含 readOnlyHint 判定），
 *   工具清单变化（连接 / 刷新 / tools/list_changed 通知）即同步注册表并写回快照；
 * - 可用性：会话绑定 + 服务器启用 + 已连接（引擎按回合过滤 + 执行期再校验）；
 * - 调用：超时（服务器配置 > 全局默认）、ctx.signal 透传、结果扁平化与截断（client.ts）。
 */
import type { McpApprovalPolicy, McpServerConfig, McpServerDefinition, McpServerTestResult, McpToolInfo } from '@multi-agent/shared'
import { z } from 'zod'
import { getLogger } from '../logger.js'
import type { McpServerStore } from '../store/mcp-servers.js'
import { toolAbortError, type AgentTool, type ToolRegistry, type ToolResult, type ToolRuntime } from '../tools/registry.js'
import { createSdkMcpClient, type McpClientFactory, type McpConnectionHandle, type McpRemoteToolDef } from './client.js'
import { isMcpToolName, planToolNames } from './naming.js'

/** 工具快照 / 注册描述的长度上限（防超长描述污染 DB 与提示词） */
const MAX_TOOL_DESCRIPTION = 1_000

/** MCP 工具参数不透明（透传远端 JSON Schema；合法性由远端校验） */
const toolArgsSchema = z.unknown()

/** 只读判定：override > annotations.readOnlyHint > 保守写类 */
function resolveReadOnly(config: McpServerConfig, def: McpRemoteToolDef | undefined): boolean {
  const override = config.readOnlyOverride ?? 'auto'
  if (override === 'readonly') return true
  if (override === 'write') return false
  return def?.annotations?.readOnlyHint === true
}

export interface McpManagerOptions {
  store: McpServerStore
  registry: ToolRegistry
  /** 应用根目录（stdio cwd 缺省值） */
  rootDir: string
  /** 全局默认工具调用超时（缺省 = TOOL_TIMEOUT_MS） */
  defaultTimeoutMs: number
  /** 状态 / 工具清单变化的广播（index 注入：notify:mcp-changed；测试可缺省） */
  publish?: (payload: { serverId?: string; action: string }) => void
  /** 客户端工厂（测试注入 InMemoryTransport 版；缺省 = SDK stdio / http） */
  factory?: McpClientFactory
}

interface ServerRuntime {
  handle: McpConnectionHandle
  /** 本服务器当前注册进注册表的工具：registeredName → rawName */
  registered: Map<string, string>
  serverInfo?: { name: string; version: string }
  /** stdio 子进程 pid（进程退出兜底同步强杀用） */
  childPid?: number
}

/** MCP 协议 RequestTimeout 错误码（SDK McpError.code） */
const MCP_REQUEST_TIMEOUT_CODE = -32001

export class McpRuntimeManager {
  private readonly store: McpServerStore
  private readonly registry: ToolRegistry
  private readonly rootDir: string
  private readonly defaultTimeoutMs: number
  private readonly publish: (payload: { serverId?: string; action: string }) => void
  private readonly factory: McpClientFactory
  private readonly runtimes = new Map<string, ServerRuntime>()
  /** registeredName → serverId（会话过滤与审批策略的快速索引） */
  private readonly toolOwner = new Map<string, string>()
  /** 每服务器串行锁（连接 / 断开 / 刷新互斥） */
  private readonly locks = new Map<string, Promise<unknown>>()
  private stopped = false

  constructor(opts: McpManagerOptions) {
    this.store = opts.store
    this.registry = opts.registry
    this.rootDir = opts.rootDir
    this.defaultTimeoutMs = opts.defaultTimeoutMs
    this.publish = opts.publish ?? (() => undefined)
    this.factory = opts.factory ?? createSdkMcpClient
  }

  /** 启动：连接全部启用服务器（非阻塞调用方；失败仅置状态，不阻断启动） */
  async start(): Promise<void> {
    const servers = this.store.list().filter((s) => s.enabled)
    if (servers.length === 0) return
    getLogger().info(`MCP：开始连接 ${servers.length} 个已启用服务器（${servers.map((s) => s.name).join('、')}）`)
    await Promise.all(servers.map((s) => this.connect(s.id).catch(() => undefined)))
  }

  // ---------- 生命周期 ----------

  /** 连接（幂等：先释放旧连接再建新）；成功注册工具并回写快照，失败置 error 状态 */
  async connect(serverId: string): Promise<void> {
    await this.withLock(serverId, async () => {
      await this.releaseRuntime(serverId)
      const server = this.store.get(serverId)
      if (!server || !server.enabled || this.stopped) return
      let handle: McpConnectionHandle | undefined
      try {
        handle = await this.factory({
          transport: server.transport,
          config: server.config,
          secret: this.store.getSecret(serverId),
          rootDir: this.rootDir,
        })
        const remote = await handle.listTools()
        const runtime: ServerRuntime = {
          handle,
          registered: new Map(),
          serverInfo: handle.serverInfo,
          childPid: handle.childPid,
        }
        this.runtimes.set(serverId, runtime)
        // tools/list_changed 通知 → 自动刷新（失败静默，状态由刷新路径维护）
        handle.onToolsChanged(() => {
          void this.refreshTools(serverId).catch(() => undefined)
        })
        const tools = this.syncServerTools(server, runtime, remote)
        this.store.setTools(serverId, tools)
        this.store.setStatus(serverId, 'ok')
        getLogger().info({ server: server.name, tools: tools.length }, 'MCP 服务器已连接')
        this.publish({ serverId, action: 'connected' })
      } catch (err) {
        if (handle) await handle.close().catch(() => undefined)
        const message = (err as Error).message || String(err)
        this.store.setStatus(serverId, 'error', message)
        getLogger().warn({ server: server.name, err: message }, 'MCP 服务器连接失败')
        this.publish({ serverId, action: 'error' })
      }
    })
  }

  /** 断开（禁用 / 更新配置 / 删除前调用）：注销工具 + 关闭连接 + 状态 idle */
  async disconnect(serverId: string): Promise<void> {
    await this.withLock(serverId, async () => {
      const server = this.store.get(serverId)
      await this.releaseRuntime(serverId)
      if (server) {
        this.store.setStatus(serverId, 'idle')
        this.store.setTools(serverId, [])
        this.publish({ serverId, action: 'disconnected' })
      }
    })
  }

  /** 重连（配置 / 凭据更新后） */
  async restart(serverId: string): Promise<void> {
    await this.withLock(serverId, async () => {
      await this.releaseRuntime(serverId)
    })
    await this.connect(serverId)
  }

  /** 刷新工具清单（未连接时退化为连接；tools/list_changed 通知与手动刷新共用） */
  async refreshTools(serverId: string): Promise<void> {
    const runtime = this.runtimes.get(serverId)
    const server = this.store.get(serverId)
    if (!runtime?.handle || !server) {
      if (server?.enabled) await this.connect(serverId)
      return
    }
    await this.withLock(serverId, async () => {
      const current = this.store.get(serverId)
      const active = this.runtimes.get(serverId)
      if (!current || !active?.handle) return
      try {
        const remote = await active.handle.listTools()
        const tools = this.syncServerTools(current, active, remote)
        this.store.setTools(serverId, tools)
        this.store.setStatus(serverId, 'ok')
        this.publish({ serverId, action: 'tools' })
      } catch (err) {
        const message = (err as Error).message || String(err)
        this.store.setStatus(serverId, 'error', message)
        this.publish({ serverId, action: 'error' })
      }
    })
  }

  /**
   * 测试连接：已连接时直接回报现状；否则执行真实连接（工具同时完成注入）。
   * 返回结果同时回写状态（连接失败时 lastError 可读）。
   */
  async test(serverId: string): Promise<McpServerTestResult> {
    const server = this.store.get(serverId)
    if (!server) return { ok: false, error: 'MCP 服务器不存在' }
    const started = Date.now()
    const active = this.runtimes.get(serverId)
    if (active?.handle && server.status === 'ok') {
      const info = active.serverInfo ? `${active.serverInfo.name} v${active.serverInfo.version}` : server.name
      return { ok: true, latencyMs: 0, detail: `已连接（${info}）`, toolCount: server.tools.length }
    }
    await this.connect(serverId)
    const after = this.store.get(serverId)
    if (after?.status === 'ok') {
      const runtime = this.runtimes.get(serverId)
      const info = runtime?.serverInfo ? `${runtime.serverInfo.name} v${runtime.serverInfo.version}` : after.name
      return {
        ok: true,
        latencyMs: Date.now() - started,
        detail: `连接成功（${info}）`,
        toolCount: after.tools.length,
      }
    }
    return { ok: false, latencyMs: Date.now() - started, error: after?.lastError ?? '连接失败（未知原因）' }
  }

  /** 关停：注销全部工具 + 关闭全部连接（进程退出前调用） */
  async stopAll(): Promise<void> {
    this.stopped = true
    for (const [serverId, runtime] of [...this.runtimes]) {
      this.unregisterRuntimeTools(serverId, runtime)
      await runtime.handle.close().catch(() => undefined)
      this.runtimes.delete(serverId)
    }
  }

  /** 进程退出兜底：同步强杀全部 stdio 子进程（close 异步来不及等待时由 process.on('exit') 调用） */
  killOrphansSync(): void {
    for (const runtime of this.runtimes.values()) {
      if (runtime.childPid === undefined) continue
      try {
        process.kill(runtime.childPid, 'SIGKILL')
      } catch {
        /* 子进程已退出 */
      }
    }
  }

  // ---------- 工具可用性（引擎按回合过滤 + 执行期校验） ---------- */

  /** 会话可用过滤：非 MCP 工具原样保留；MCP 工具要求服务器启用 + 已连接 + 会话已绑定 */
  filterForSession(sessionId: string, tools: AgentTool[]): AgentTool[] {
    return tools.filter((tool) => !isMcpToolName(tool.name) || this.isToolUsable(sessionId, tool.name))
  }

  isToolUsable(sessionId: string, registeredName: string): boolean {
    const serverId = this.toolOwner.get(registeredName)
    if (!serverId) return false
    const server = this.store.get(serverId)
    const runtime = this.runtimes.get(serverId)
    if (!server || !server.enabled || server.status !== 'ok' || !runtime?.handle) return false
    return this.store.isBound(sessionId, serverId)
  }

  /** 审批策略（引擎 approvalGate）：未注册的工具返回 undefined（按内置规则处理） */
  approvalInfoFor(registeredName: string): { policy: McpApprovalPolicy; slug: string } | undefined {
    const serverId = this.toolOwner.get(registeredName)
    if (!serverId) return undefined
    const server = this.store.get(serverId)
    if (!server) return undefined
    return { policy: server.config.approvalPolicy ?? 'risky', slug: server.name }
  }

  // ---------- 调用执行 ----------

  /**
   * 执行注册的 MCP 工具调用（由注册闭包调用）：
   * 可用性再校验（最小权限）→ 超时（服务器配置 > 全局默认）→ ctx.signal 透传 → 结果扁平化。
   */
  async executeRegisteredTool(
    serverId: string,
    rawName: string,
    registeredName: string,
    args: unknown,
    ctx: ToolRuntime,
  ): Promise<ToolResult> {
    const server = this.store.get(serverId)
    const runtime = this.runtimes.get(serverId)
    if (!server || !runtime?.handle) {
      return { ok: false, summary: `MCP 服务器不可用（未连接）：请稍后在 MCP 管理台重试` }
    }
    if (!server.enabled) return { ok: false, summary: `MCP 服务器「${server.name}」已禁用` }
    if (!this.store.isBound(ctx.sessionId, serverId)) {
      return {
        ok: false,
        summary: `会话未绑定 MCP 服务器「${server.name}」（最小权限：请在 MCP 管理台绑定后重试）`,
      }
    }
    const timeoutMs = server.config.timeoutMs ?? this.defaultTimeoutMs
    try {
      const outcome = await runtime.handle.callTool(rawName, args, { timeoutMs, signal: ctx.signal })
      return {
        ok: outcome.ok,
        summary: outcome.ok
          ? `MCP ${server.name}/${rawName} 调用完成（${outcome.blockCount} 块）`
          : `MCP ${server.name}/${rawName} 调用失败（服务器返回错误）`,
        detail: outcome.content,
      }
    } catch (err) {
      // 中断（回合停止 / 超时联动）：与内置工具一致上抛 AbortError，由注册表护栏收敛
      if (ctx.signal?.aborted) throw toolAbortError()
      const code = (err as { code?: number }).code
      if (code === MCP_REQUEST_TIMEOUT_CODE) {
        return {
          ok: false,
          summary: `MCP ${server.name}/${rawName} 调用超时（>${Math.round(timeoutMs / 1000)}s），已中断`,
        }
      }
      const message = (err as Error).message || String(err)
      return { ok: false, summary: `MCP ${server.name}/${rawName} 调用失败：${message.slice(0, 200)}` }
    }
  }

  // ---------- 内部 ----------

  /** 释放运行时：注销工具 + 关闭连接（不写状态，由调用方决定语义） */
  private async releaseRuntime(serverId: string): Promise<void> {
    const runtime = this.runtimes.get(serverId)
    if (!runtime) return
    this.unregisterRuntimeTools(serverId, runtime)
    await runtime.handle.close().catch(() => undefined)
    this.runtimes.delete(serverId)
  }

  private unregisterRuntimeTools(serverId: string, runtime: ServerRuntime): void {
    for (const registeredName of runtime.registered.keys()) {
      this.registry.unregister(registeredName)
      this.toolOwner.delete(registeredName)
    }
    runtime.registered.clear()
    void serverId
  }

  /** 远端工具 → 注册表条目 + 快照（先注销旧集再注册新集，保证清单与注册表一致） */
  private syncServerTools(
    server: McpServerDefinition,
    runtime: ServerRuntime,
    remote: McpRemoteToolDef[],
  ): McpToolInfo[] {
    this.unregisterRuntimeTools(server.id, runtime)
    const planned = planToolNames(
      server.name,
      remote.map((tool) => tool.name).filter((name) => typeof name === 'string' && name.length > 0),
    )
    const byRaw = new Map(remote.map((tool) => [tool.name, tool]))
    // M28：延迟范围 —— MCP 工具默认按需发现（服务器 config.eagerLoad=true 时全部常驻）
    const eager = server.config.eagerLoad === true
    const infos: McpToolInfo[] = []
    for (const { rawName, registeredName } of planned) {
      const def = byRaw.get(rawName)
      const readOnly = resolveReadOnly(server.config, def)
      const description = def?.description?.slice(0, MAX_TOOL_DESCRIPTION)
      const tool: AgentTool = {
        name: registeredName,
        description:
          (description ?? `MCP 工具（来自 ${server.name}，${rawName}）`) + `（外部 MCP 工具，来源 server=${server.name}）`,
        parameters: def?.inputSchema ?? { type: 'object', properties: {} },
        schema: toolArgsSchema,
        readOnly,
        tier: eager ? 'core' : 'deferred',
        execute: (args: unknown, ctx: ToolRuntime) =>
          this.executeRegisteredTool(server.id, rawName, registeredName, args, ctx),
      }
      this.registry.register(tool)
      runtime.registered.set(registeredName, rawName)
      this.toolOwner.set(registeredName, server.id)
      infos.push({ registeredName, rawName, description, readOnly, deferByDefault: !eager })
    }
    return infos
  }

  /** 每服务器串行锁：前序操作（无论成败）完成后执行 fn */
  private withLock<T>(serverId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(serverId) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    this.locks.set(
      serverId,
      next.catch(() => undefined),
    )
    return next
  }
}

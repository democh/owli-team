/**
 * SSH 工具集（M23）：ssh_exec —— 在远程主机执行一次性命令。
 *
 * 安全链（多层）：
 * 1. 会话绑定校验（未绑定的连接 Agent 不可见、不可用）；
 * 2. allowExec 开关（连接级，默认关；显式开启 = 用户确认 Agent 可在该机执行命令）；
 * 3. 审批门（engine approvalGate：ssh_exec 每次调用都需用户批准）；
 * 4. 超时（默认 30s，上限 120s）/ 输出截断（256KB）/ 结果回灌截断。
 */
import { z } from 'zod'
import type { ConnectionDefinition, SshExecResultDto } from '@multi-agent/shared'
import type { AgentTool, ToolResult, ToolRuntime } from './registry.js'

/** 会话可用的 SSH 连接（已绑定 + 启用 + ssh 类型） */
function boundSshConnections(ctx: ToolRuntime): ConnectionDefinition[] {
  if (!ctx.connections) return []
  return ctx.connections
    .connectionsOf(ctx.sessionId)
    .map((x) => x.connection)
    .filter((c) => c.enabled && c.kind === 'ssh')
}

/** 解析连接参数（支持 id 或名称）；未命中时返回可用清单提示 */
function resolveConnection(
  ctx: ToolRuntime,
  nameOrId: string,
): { ok: true; connection: ConnectionDefinition } | { ok: false; message: string } {
  const list = boundSshConnections(ctx)
  if (list.length === 0) {
    return {
      ok: false,
      message: '本会话未绑定任何 SSH 连接。请在会话头部「资源」入口绑定 SSH 连接后再试。',
    }
  }
  const hit = list.find((c) => c.id === nameOrId) ?? list.find((c) => c.name === nameOrId)
  if (!hit) {
    return {
      ok: false,
      message: `未找到 SSH 连接「${nameOrId}」。本会话可用：${list.map((c) => c.name).join('、')}`,
    }
  }
  // M57 P2：共享会话最小权限复核（成员禁触达未开放连接；未装配 = 不复核）
  const denied = ctx.connectionGuard?.(hit.id, ctx.triggerUserId)
  if (denied) return { ok: false, message: denied }
  return { ok: true, connection: hit }
}

function requireServices(ctx: ToolRuntime): string | undefined {
  if (!ctx.ssh) return 'SSH 工具未启用（服务端未装配连接中心）'
  if (!ctx.connections) return '连接中心未装配'
  return undefined
}

/** 操作事件序号：同一毫秒内的并行调用也不重复（notify:op 按 id 去重） */
let opSeq = 0
function makeOpId(connectionId: string): string {
  return `ssh:${connectionId}:${Date.now()}:${++opSeq}`
}

/** 结果 → 回灌文本（stdout / stderr 分段 + 截断标记） */
function formatExecResult(result: SshExecResultDto, command: string): string {
  const parts: string[] = [`$ ${command}`]
  if (result.stdout.trim()) parts.push(result.stdout.trimEnd())
  if (result.stderr.trim()) parts.push(`[stderr]\n${result.stderr.trimEnd()}`)
  parts.push(`[exit ${result.code ?? result.signal ?? '未知'} · ${result.durationMs}ms${result.truncated ? ' · 输出已截断' : ''}]`)
  return parts.join('\n')
}

/** M39（§93，SR-2）：证据卡输出上限（stdout+stderr 合并文本；超长截断并标记） */
const SSH_META_OUTPUT_MAX = 2000

function sshMetaOutput(result: SshExecResultDto): { text: string; truncated: boolean } {
  const parts: string[] = []
  if (result.stdout.trim()) parts.push(result.stdout.trimEnd())
  if (result.stderr.trim()) parts.push(`[stderr]\n${result.stderr.trimEnd()}`)
  const text = parts.join('\n')
  if (text.length <= SSH_META_OUTPUT_MAX) return { text, truncated: false }
  return { text: `${text.slice(0, SSH_META_OUTPUT_MAX)}…`, truncated: true }
}

const sshExecTool: AgentTool<{ connection: string; command: string; timeout_ms?: number }> = {
  name: 'ssh_exec',
  description:
    '在已绑定的 SSH 连接上执行一次性命令（如查看服务状态、拉取日志、部署脚本）。需要用户已在连接设置中开启「允许 Agent 执行命令」，且每次调用都会经过用户审批。适合非交互命令；需要交互的完整会话请提示用户在「终端」页签操作。',
  parameters: {
    type: 'object',
    properties: {
      connection: { type: 'string', description: '连接名称或 id' },
      command: { type: 'string', description: '要执行的远程命令（单条，非交互）' },
      timeout_ms: { type: 'number', description: '超时毫秒（默认 30000，上限 120000）' },
    },
    required: ['connection', 'command'],
  },
  schema: z.object({
    connection: z.string().min(1),
    command: z.string().min(1).max(4000),
    timeout_ms: z.number().int().min(1000).max(120_000).optional(),
  }),
  async execute(args, ctx: ToolRuntime): Promise<ToolResult> {
    const guard = requireServices(ctx)
    if (guard) return { ok: false, summary: guard }
    const resolved = resolveConnection(ctx, args.connection)
    if (!resolved.ok) return { ok: false, summary: resolved.message }
    try {
      const result = await ctx.ssh!.exec({
        connectionId: resolved.connection.id,
        command: args.command,
        timeoutMs: args.timeout_ms,
        actor: ctx.agentId,
        sessionId: ctx.sessionId,
        runId: ctx.runId,
        // M57 P2：归因（触发者；兼容模式缺省）
        actorUserId: ctx.triggerUserId,
      })
      // 实时操作事件（直播窗/操作流）：远程命令执行
      ctx.opNotify?.({
        id: makeOpId(resolved.connection.id),
        kind: 'ssh',
        action: 'ssh.exec',
        target: `conn:${resolved.connection.name}`,
        status: result.code === 0 ? 'ok' : 'error',
        durationMs: result.durationMs,
        summary: `exit ${result.code ?? result.signal ?? '未知'}（${result.durationMs}ms）`,
        detail: `$ ${args.command.slice(0, 500)}${result.stdout.trim() ? `\n${result.stdout.trim().slice(0, 600)}` : ''}${result.stderr.trim() ? `\n[stderr]\n${result.stderr.trim().slice(0, 300)}` : ''}`,
      })
      const ok = result.code === 0
      const out = sshMetaOutput(result)
      return {
        ok,
        summary: `${ok ? '命令完成' : '命令失败'}：exit ${result.code ?? result.signal ?? '未知'}（${result.durationMs}ms）`,
        detail: formatExecResult(result, args.command),
        // M39（§93，SR-2）：证据卡数据源（命令 / exit / 耗时 / 输出≤2000 字与截断标记）
        meta: {
          command: args.command.slice(0, 500),
          exitCode: result.code ?? null,
          durationMs: result.durationMs,
          output: out.text,
          truncated: result.truncated || out.truncated,
        },
      }
    } catch (err) {
      ctx.opNotify?.({
        id: makeOpId(resolved.connection.id),
        kind: 'ssh',
        action: 'ssh.exec',
        target: `conn:${resolved.connection.name}`,
        status: 'error',
        summary: `命令执行失败：${(err as Error).message}`,
        detail: `$ ${args.command.slice(0, 500)}`,
      })
      return { ok: false, summary: `命令执行失败：${(err as Error).message}` }
    }
  },
}

export function createSshTools(): Array<AgentTool<never>> {
  // M28：SSH 工具默认延迟（不在常驻清单；经 tool_search 激活后本 Run 内可用）
  return [{ ...sshExecTool, tier: 'deferred' as const }] as unknown as Array<AgentTool<never>>
}

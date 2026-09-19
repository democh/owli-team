/**
 * 数据库工具集（M22）：db_list_connections / db_schema / db_query / db_execute。
 *
 * 安全链（多层）：
 * 1. 会话绑定校验（未绑定的连接 Agent 不可见、不可用）；
 * 2. 只读护栏（guard.ts：单语句 + 白名单首关键字 + 危险关键字兜底）；
 * 3. 连接开关（允许写入 = 显式开启；db_execute 另经审批门）；
 * 4. 行数 / 超时 / 结果截断（防止大结果拖垮上下文与内存）。
 */
import { z } from 'zod'
import type { ConnectionDefinition } from '@multi-agent/shared'
import type { AgentTool, ToolResult, ToolRuntime } from './registry.js'
import type { DbQueryResult } from '../connections/db/types.js'

/** 会话可用的数据库连接（已绑定 + 启用 + 数据库类型） */
function boundDbConnections(ctx: ToolRuntime): ConnectionDefinition[] {
  if (!ctx.connections) return []
  return ctx.connections
    .connectionsOf(ctx.sessionId)
    .map((x) => x.connection)
    .filter(
      (c) => c.enabled && (c.kind === 'postgres' || c.kind === 'mysql' || c.kind === 'sqlite'),
    )
}

/** 解析连接参数（支持 id 或名称）；未命中时返回可用清单提示 */
function resolveConnection(
  ctx: ToolRuntime,
  nameOrId: string,
): { ok: true; connection: ConnectionDefinition } | { ok: false; message: string } {
  const list = boundDbConnections(ctx)
  if (list.length === 0) {
    return {
      ok: false,
      message:
        '本会话未绑定任何数据库连接。请在会话头部「资源」入口绑定 PostgreSQL / MySQL / SQLite 连接后再试。',
    }
  }
  const hit = list.find((c) => c.id === nameOrId) ?? list.find((c) => c.name === nameOrId)
  if (!hit) {
    return {
      ok: false,
      message: `未找到连接「${nameOrId}」。本会话可用：${list.map((c) => `${c.name}(${c.kind})`).join('、')}`,
    }
  }
  // M57 P2：共享会话最小权限复核（成员禁触达未开放连接；未装配 = 不复核）
  const denied = ctx.connectionGuard?.(hit.id, ctx.triggerUserId)
  if (denied) return { ok: false, message: denied }
  return { ok: true, connection: hit }
}

function requireServices(ctx: ToolRuntime): string | undefined {
  if (!ctx.db) return '数据库工具未启用（服务端未装配连接中心）'
  if (!ctx.connections) return '连接中心未装配'
  return undefined
}

/** 操作事件序号：同一毫秒内的并行只读调用也不重复（notify:op 按 id 去重） */
let opSeq = 0
function makeOpId(connectionId: string): string {
  return `db:${connectionId}:${Date.now()}:${++opSeq}`
}

/** SQL 文本归一化（上报事件的 detail；超长截断） */
function sqlDetail(sql: string): string {
  return sql.length > 1000 ? `${sql.slice(0, 1000)}…` : sql
}

/** 查询结果 → 紧凑文本（列头 + 分层展示 + 截断提示） */
function formatQueryResult(result: DbQueryResult, displayLimit = 30): string {
  if (result.rows.length === 0) {
    return `（0 行）${result.truncated ? '' : ''}`
  }
  const shown = result.rows.slice(0, displayLimit)
  const lines: string[] = []
  lines.push(result.columns.join(' | '))
  lines.push(result.columns.map(() => '---').join(' | '))
  for (const row of shown) {
    lines.push(
      result.columns
        .map((col) => {
          const value = row[col]
          if (value === null || value === undefined) return 'NULL'
          if (typeof value === 'object') return JSON.stringify(value)
          return String(value)
        })
        .join(' | '),
    )
  }
  const notes: string[] = []
  if (shown.length < result.rows.length) notes.push(`共 ${result.rows.length} 行，已展示前 ${shown.length} 行`)
  if (result.truncated) notes.push(`结果超出上限（共 ${result.rowCount} 行），已截断——请加 LIMIT / WHERE 缩小范围`)
  if (notes.length > 0) lines.push(`\n[${notes.join('；')}]`)
  return lines.join('\n')
}

const dbListConnectionsTool: AgentTool<Record<string, never>> = {
  name: 'db_list_connections',
  readOnly: true,
  description:
    '列出本会话已绑定的数据库连接（PostgreSQL / MySQL / SQLite）及其状态。开始任何数据库工作前先看一眼可用连接。',
  parameters: { type: 'object', properties: {} },
  schema: z.object({}),
  async execute(_args, ctx: ToolRuntime): Promise<ToolResult> {
    const guard = requireServices(ctx)
    if (guard) return { ok: false, summary: guard }
    const list = boundDbConnections(ctx)
    if (list.length === 0) {
      return {
        ok: true,
        summary: '本会话未绑定数据库连接',
        detail: '请在会话头部「资源」入口绑定连接（团队连接由管理员在连接中心维护；成员可在「设置 → 我的连接」自建个人连接）。',
      }
    }
    const lines = list.map((c) => {
      // M57 P2：未对成员开放的连接标注不可用（复核文案不直接回灌，仅提示）
      const denied = ctx.connectionGuard?.(c.id, ctx.triggerUserId) ? '（未对成员开放，不可用）' : ''
      return `- ${c.name} [${c.kind}] 状态=${c.status}${c.config.readOnly === false || c.config.allowWrites ? '（允许写入）' : '（只读）'}${denied}`
    })
    return { ok: true, summary: `${list.length} 个可用数据库连接`, detail: lines.join('\n') }
  },
}

const dbSchemaTool: AgentTool<{ connection: string; max_tables?: number }> = {
  name: 'db_schema',
  readOnly: true,
  description:
    '读取某个数据库连接的表结构快照（表 / 视图 + 字段）。写 SQL 前先用它确认真实表名字段名，避免猜测导致查询失败。',
  parameters: {
    type: 'object',
    properties: {
      connection: { type: 'string', description: '连接名称或 id（见 db_list_connections）' },
      max_tables: { type: 'number', description: '最多返回表数（默认 60）' },
    },
    required: ['connection'],
  },
  schema: z.object({ connection: z.string().min(1), max_tables: z.number().int().min(1).max(200).default(60) }),
  async execute(args, ctx: ToolRuntime): Promise<ToolResult> {
    const guard = requireServices(ctx)
    if (guard) return { ok: false, summary: guard }
    const resolved = resolveConnection(ctx, args.connection)
    if (!resolved.ok) return { ok: false, summary: resolved.message }
    try {
      const outcome = await ctx.db!.exec({
        connectionId: resolved.connection.id,
        mode: 'schema',
        actor: ctx.agentId,
        sessionId: ctx.sessionId,
        runId: ctx.runId,
        requireBinding: true,
        // M57 P2：归因（触发者；兼容模式缺省）
        actorUserId: ctx.triggerUserId,
      })
      const snapshot = outcome.schema!
      const tables = snapshot.tables.slice(0, args.max_tables)
      // 实时操作事件（直播窗/操作流）：schema 读取
      ctx.opNotify?.({
        id: makeOpId(resolved.connection.id),
        kind: 'db',
        action: 'db.schema',
        target: `conn:${resolved.connection.name}`,
        status: 'ok',
        durationMs: outcome.durationMs,
        summary: `已读取 ${tables.length} 张表结构`,
      })
      if (tables.length === 0) return { ok: true, summary: '数据库中没有表', detail: '（空 schema）' }
      const lines = tables.map((t) => {
        const cols = t.columns.map((c) => `${c.name}${c.type ? `:${c.type}` : ''}`).join(', ')
        const prefix = t.schema ? `${t.schema}.` : ''
        return `- ${prefix}${t.name}${t.kind === 'view' ? '（视图）' : ''}: ${cols || '（无字段信息）'}`
      })
      return {
        ok: true,
        summary: `已读取 ${resolved.connection.name} 的 ${tables.length} 张表结构`,
        detail: lines.join('\n') + (snapshot.truncated ? '\n[表数量已截断，请用 max_tables 调整]' : ''),
      }
    } catch (err) {
      ctx.opNotify?.({
        id: makeOpId(resolved.connection.id),
        kind: 'db',
        action: 'db.schema',
        target: `conn:${resolved.connection.name}`,
        status: 'error',
        summary: `读取表结构失败：${(err as Error).message}`,
      })
      return { ok: false, summary: `读取表结构失败：${(err as Error).message}` }
    }
  },
}

const dbQueryTool: AgentTool<{ connection: string; sql: string; params?: unknown[] }> = {
  name: 'db_query',
  readOnly: true,
  description:
    '执行只读 SQL 查询（SELECT / WITH / SHOW / EXPLAIN 等，单条语句）。结果默认展示前 30 行；大表请自带 LIMIT / WHERE。需要写操作（INSERT/UPDATE/DDL）用 db_execute。',
  parameters: {
    type: 'object',
    properties: {
      connection: { type: 'string', description: '连接名称或 id' },
      sql: { type: 'string', description: '单条只读 SQL（不支持多条拼接）' },
      params: { type: 'array', description: '参数化占位值（? 或 $1 视驱动）', items: {} },
    },
    required: ['connection', 'sql'],
  },
  schema: z.object({
    connection: z.string().min(1),
    sql: z.string().min(1),
    params: z.array(z.unknown()).max(100).optional(),
  }),
  async execute(args, ctx: ToolRuntime): Promise<ToolResult> {
    const guard = requireServices(ctx)
    if (guard) return { ok: false, summary: guard }
    const resolved = resolveConnection(ctx, args.connection)
    if (!resolved.ok) return { ok: false, summary: resolved.message }
    try {
      const outcome = await ctx.db!.exec({
        connectionId: resolved.connection.id,
        sql: args.sql,
        params: args.params,
        mode: 'query',
        actor: ctx.agentId,
        sessionId: ctx.sessionId,
        runId: ctx.runId,
        requireBinding: true,
        // M57 P2：归因（触发者；兼容模式缺省）
        actorUserId: ctx.triggerUserId,
      })
      const result = outcome.query!
      // 实时操作事件（直播窗/操作流）：查询 + 结果预览（最多 5 行）
      ctx.opNotify?.({
        id: makeOpId(resolved.connection.id),
        kind: 'db',
        action: 'db.query',
        target: `conn:${resolved.connection.name}`,
        status: 'ok',
        durationMs: result.durationMs,
        summary: `${result.rowCount} 行（${result.durationMs}ms）`,
        detail: sqlDetail(args.sql),
        preview: result.rows.length > 0 ? { columns: result.columns, rows: result.rows.slice(0, 5) } : undefined,
      })
      return {
        ok: true,
        summary: `查询完成：${result.rowCount} 行（${result.durationMs}ms）`,
        detail: formatQueryResult(result),
        // M39（§93，BI-1）：取数管道卡数据源（≤5 行预览；单元格文本化并截断，控制消息负载）
        meta: {
          columns: result.columns,
          rows: result.rows.slice(0, 5).map((row) => {
            const out: Record<string, string> = {}
            for (const col of result.columns) {
              const v = row[col]
              const text = v === null || v === undefined ? 'NULL' : typeof v === 'object' ? JSON.stringify(v) : String(v)
              out[col] = text.length > 160 ? `${text.slice(0, 160)}…` : text
            }
            return out
          }),
          rowCount: result.rowCount,
          durationMs: result.durationMs,
        },
      }
    } catch (err) {
      ctx.opNotify?.({
        id: makeOpId(resolved.connection.id),
        kind: 'db',
        action: 'db.query',
        target: `conn:${resolved.connection.name}`,
        status: 'error',
        summary: `查询失败：${(err as Error).message}`,
        detail: sqlDetail(args.sql),
      })
      return { ok: false, summary: `查询失败：${(err as Error).message}` }
    }
  },
}

const dbExecuteTool: AgentTool<{ connection: string; sql: string; params?: unknown[] }> = {
  name: 'db_execute',
  description:
    '执行数据库写语句（INSERT / UPDATE / DELETE / DDL，单条）。需要三个前提：连接已开启「允许写入」、会话已绑定、用户审批通过。执行前先用 db_query 确认影响范围。',
  parameters: {
    type: 'object',
    properties: {
      connection: { type: 'string', description: '连接名称或 id' },
      sql: { type: 'string', description: '单条写 SQL' },
      params: { type: 'array', description: '参数化占位值', items: {} },
    },
    required: ['connection', 'sql'],
  },
  schema: z.object({
    connection: z.string().min(1),
    sql: z.string().min(1),
    params: z.array(z.unknown()).max(100).optional(),
  }),
  async execute(args, ctx: ToolRuntime): Promise<ToolResult> {
    const guard = requireServices(ctx)
    if (guard) return { ok: false, summary: guard }
    const resolved = resolveConnection(ctx, args.connection)
    if (!resolved.ok) return { ok: false, summary: resolved.message }
    try {
      const outcome = await ctx.db!.exec({
        connectionId: resolved.connection.id,
        sql: args.sql,
        params: args.params,
        mode: 'execute',
        actor: ctx.agentId,
        sessionId: ctx.sessionId,
        runId: ctx.runId,
        requireBinding: true,
        // M57 P2：归因（触发者；兼容模式缺省）
        actorUserId: ctx.triggerUserId,
      })
      const affected = outcome.query!.affectedRows
      // 实时操作事件（直播窗/操作流）：写操作（已经审批门）
      ctx.opNotify?.({
        id: makeOpId(resolved.connection.id),
        kind: 'db',
        action: 'db.execute',
        target: `conn:${resolved.connection.name}`,
        status: 'ok',
        durationMs: outcome.durationMs,
        summary: `影响 ${affected ?? '未知'} 行（${outcome.durationMs}ms）`,
        detail: sqlDetail(args.sql),
      })
      return {
        ok: true,
        summary: `写入完成：影响 ${affected ?? '未知'} 行（${outcome.durationMs}ms）`,
        detail: `SQL：${args.sql.slice(0, 500)}\n影响行数：${affected ?? '未知'}`,
      }
    } catch (err) {
      ctx.opNotify?.({
        id: makeOpId(resolved.connection.id),
        kind: 'db',
        action: 'db.execute',
        target: `conn:${resolved.connection.name}`,
        status: 'error',
        summary: `写入失败：${(err as Error).message}`,
        detail: sqlDetail(args.sql),
      })
      return { ok: false, summary: `写入失败：${(err as Error).message}` }
    }
  },
}

export function createDbTools(): Array<AgentTool<never>> {
  // M28：数据库工具组默认延迟（不在常驻清单；经 tool_search 激活后本 Run 内可用）
  return [
    dbListConnectionsTool,
    dbSchemaTool,
    dbQueryTool,
    dbExecuteTool,
  ].map((tool) => ({ ...tool, tier: 'deferred' as const })) as unknown as Array<AgentTool<never>>
}

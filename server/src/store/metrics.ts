/**
 * 工具指标（M5）：tool_metrics 落库 + 聚合（次数 / 失败率 / 平均耗时）。
 * 明细由引擎在每次 execWithAbort 后写入；聚合供 GET /api/metrics/tools（M9 指标面板复用）。
 */
import type { AppDb } from './db.js'
import { nowIso } from './sessions.js'

export interface ToolMetricInput {
  toolName: string
  ok: boolean
  durationMs: number
  agentId?: string
  sessionId?: string
}

export interface ToolMetricSummaryRow {
  toolName: string
  calls: number
  failures: number
  failureRate: number
  avgDurationMs: number
  maxDurationMs: number
}

interface RawRow {
  tool_name: string
  calls: number
  failures: number
  avg_ms: number | null
  max_ms: number | null
}

export class ToolMetricsStore {
  constructor(private readonly db: AppDb) {}

  /** 写入一条工具执行明细（失败不影响主流程，由调用方兜底 try/catch） */
  record(input: ToolMetricInput): void {
    this.db.run(
      `INSERT INTO tool_metrics (tool_name, ok, duration_ms, agent_id, session_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      input.toolName,
      input.ok ? 1 : 0,
      Math.max(0, Math.round(input.durationMs)),
      input.agentId ?? null,
      input.sessionId ?? null,
      nowIso(),
    )
  }

  /** 按工具聚合（可选时间窗：近 sinceMs 毫秒；缺省全量） */
  summary(sinceMs?: number): ToolMetricSummaryRow[] {
    const where = sinceMs ? 'WHERE created_at >= ?' : ''
    const params: string[] = sinceMs ? [new Date(Date.now() - sinceMs).toISOString()] : []
    const rows = this.db.all<RawRow>(
      `SELECT tool_name,
              COUNT(*) AS calls,
              COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS failures,
              AVG(duration_ms) AS avg_ms,
              MAX(duration_ms) AS max_ms
       FROM tool_metrics ${where}
       GROUP BY tool_name
       ORDER BY calls DESC`,
      ...params,
    )
    return rows.map((r) => {
      const calls = Number(r.calls)
      const failures = Number(r.failures)
      return {
        toolName: r.tool_name,
        calls,
        failures,
        failureRate: calls > 0 ? Math.round((failures / calls) * 1000) / 1000 : 0,
        avgDurationMs: Math.round(Number(r.avg_ms ?? 0)),
        maxDurationMs: Math.round(Number(r.max_ms ?? 0)),
      }
    })
  }
}

/**
 * 运行轨迹存储（M9）：run_events 表记录一次 Run 的全链路事件。
 *
 * 事件类型（type）：
 * - run:start / run:end  —— Run 起止（payload: queue / reason, error, turns）
 * - turn:start / turn:end —— 回合起止（payload: agentId, messageId, durationMs, promptTokens, completionTokens）
 * - tool                 —— 工具执行（payload: name, ok, durationMs, summary）
 * - compression          —— 上下文压缩（payload: untilSeq, beforeTokens, afterTokens, degraded）
 * - schedule             —— 调度决策（payload: accepted, dropped[{id, reason}], handedToUser, loopSuppressed）
 *
 * 观测写入失败绝不打断主流程（调用方兜底 try/catch）。
 */
import type { SchedulingStats, TraceEntry } from '@multi-agent/shared'
import type { AppDb } from './db.js'
import { nowIso } from './sessions.js'

export interface RunEventInput {
  runId: string
  sessionId: string
  turnIndex?: number
  type: string
  payload?: Record<string, unknown>
  /** M57：用户归因（users.id；缺省 = 单用户兼容模式） */
  userId?: string
}

export interface RunEventStats {
  runs: number
  turns: number
  compressions: number
  avgTurnMs: number
}

interface TraceRow {
  id: number
  run_id: string
  session_id: string
  turn_index: number
  type: string
  payload: string
  ts: string
}

export class RunEventStore {
  constructor(private readonly db: AppDb) {}

  record(input: RunEventInput): void {
    this.db.run(
      `INSERT INTO run_events (run_id, session_id, turn_index, type, payload, user_id, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      input.runId,
      input.sessionId,
      Math.max(0, Math.round(input.turnIndex ?? 0)),
      input.type,
      JSON.stringify(input.payload ?? {}),
      input.userId ?? null,
      nowIso(),
    )
  }

  /** 单 Run 轨迹（时间序）；limit 限制返回条数（取最后 limit 条后仍按时间序） */
  listByRun(runId: string, limit = 500): TraceEntry[] {
    const rows = this.db.all<TraceRow>(
      `SELECT * FROM run_events WHERE run_id = ? ORDER BY id DESC LIMIT ?`,
      runId,
      Math.max(1, Math.round(limit)),
    )
    return rows.reverse().map((r) => ({
      id: Number(r.id),
      runId: r.run_id,
      sessionId: r.session_id,
      turnIndex: Number(r.turn_index),
      type: r.type,
      payload: parsePayload(r.payload),
      ts: r.ts,
    }))
  }

  /** 聚合统计（指标接口来源）：Run 数 / 回合数 / 压缩次数 / 平均回合耗时 */
  stats(sinceMs?: number): RunEventStats {
    const where = sinceMs ? 'AND ts >= ?' : ''
    const params: string[] = sinceMs ? [new Date(Date.now() - sinceMs).toISOString()] : []
    const runs = this.count(`type = 'run:start' ${where}`, params)
    const turns = this.count(`type = 'turn:end' ${where}`, params)
    const compressions = this.count(`type = 'compression' ${where}`, params)
    // 平均回合耗时：JS 侧解析 payload（避免依赖 JSON1 扩展）
    const rows = this.db.all<{ payload: string }>(
      `SELECT payload FROM run_events WHERE type = 'turn:end' ${where}`,
      ...params,
    )
    let total = 0
    let n = 0
    for (const row of rows) {
      const ms = Number(parsePayload(row.payload).durationMs)
      if (Number.isFinite(ms) && ms >= 0) {
        total += ms
        n++
      }
    }
    return { runs, turns, compressions, avgTurnMs: n > 0 ? Math.round(total / n) : 0 }
  }

  /** M61-D6：调度健康聚合（路由 / 波次 / 抑制 / 冲突 / 接单）——payload 条件在 JS 侧判定 */
  schedulingStats(sinceMs?: number): SchedulingStats {
    const where = sinceMs ? 'AND ts >= ?' : ''
    const params: string[] = sinceMs ? [new Date(Date.now() - sinceMs).toISOString()] : []
    const payloads = (type: string): Array<Record<string, unknown>> =>
      this.db
        .all<{ payload: string }>(`SELECT payload FROM run_events WHERE type = ? ${where}`, type, ...params)
        .map((r) => parsePayload(r.payload))
    const routeAll = payloads('routing:dispatched')
    const scheduleAll = payloads('schedule')
    const waves = payloads('wave:start')
    return {
      runs: this.count(`type = 'run:start' ${where}`, params),
      routes: routeAll.filter((p) => p.fallback !== true).length,
      routeFallbacks: routeAll.filter((p) => p.fallback === true).length,
      waves: waves.length,
      parallelWaves: waves.filter((p) => p.parallel === true).length,
      loopSuppressed: scheduleAll.filter((p) => p.loopSuppressed === true).length,
      stallSuppressed: scheduleAll.filter((p) => p.stallSuppressed === true).length,
      writeConflicts: this.count(`type = 'wave:write-conflict' ${where}`, params),
      handoffAccepted: this.count(`type = 'handoff:accepted' ${where}`, params),
    }
  }

  private count(where: string, params: string[]): number {
    const row = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM run_events WHERE ${where}`, ...params)
    return Number(row?.n ?? 0)
  }
}

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

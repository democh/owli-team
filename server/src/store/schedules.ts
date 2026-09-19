/**
 * M35：定时任务存储（scheduled_tasks 表）。
 *
 * 语义：
 * - **DB 为唯一真相**（无内存缓存）——任务量级为个位数，调度索引即 next_run_at 列，
 *   跨进程重启后由服务端 tick 直接以表恢复，比「缓存 + 落库」少一层同步负担；
 * - `settle`（真实触发结算）/ `skip`（忙时 / 错过跳过）/ `pause`（自动暂停）/ `resume`（恢复）
 *   四个状态迁移覆盖服务端全部写路径，更新窗口都在单事务内；
 * - 会话删除由外键级联（ON DELETE CASCADE）清理任务，无需手工维护。
 */
import type { ScheduleActionKind, ScheduleLastStatus, ScheduleSpec, ScheduledTask } from '@multi-agent/shared'
import type { AppDb } from './db.js'
import { newId, nowIso } from './sessions.js'

interface ScheduleRow {
  id: string
  session_id: string
  title: string
  kind: string
  instruction: string
  target_agent_id: string | null
  spec: string
  timezone: string
  enabled: number
  created_by: string
  next_run_at: string | null
  last_run_at: string | null
  last_run_id: string | null
  last_status: string | null
  last_error: string | null
  run_count: number
  fail_streak: number
  created_at: string
  updated_at: string
}

/** 反序列化规格；解析失败回退为「永不触发」的 once 空值（绝不静默变成另一个规则） */
function parseSpec(raw: string): ScheduleSpec {
  try {
    const parsed = JSON.parse(raw) as ScheduleSpec
    if (parsed && (parsed.kind === 'once' || parsed.kind === 'cron')) return parsed
  } catch {
    // 数据损坏：回退到不可触发态，等待人工修正
  }
  return { kind: 'once', at: '' }
}

function rowToSchedule(row: ScheduleRow): ScheduledTask {
  return {
    id: row.id,
    sessionId: row.session_id,
    title: row.title,
    kind: row.kind as ScheduleActionKind,
    instruction: row.instruction,
    targetAgentId: row.target_agent_id ?? undefined,
    spec: parseSpec(row.spec),
    timezone: row.timezone,
    enabled: Number(row.enabled) === 1,
    createdBy: row.created_by,
    nextRunAt: row.next_run_at ?? undefined,
    lastRunAt: row.last_run_at ?? undefined,
    lastRunId: row.last_run_id ?? undefined,
    lastStatus: (row.last_status as ScheduleLastStatus | null) ?? undefined,
    lastError: row.last_error ?? undefined,
    runCount: Number(row.run_count),
    failStreak: Number(row.fail_streak),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export interface ScheduleCreateInput {
  sessionId: string
  title: string
  kind: ScheduleActionKind
  instruction: string
  targetAgentId?: string
  spec: ScheduleSpec
  timezone: string
  createdBy: string
  nextRunAt?: string
  enabled?: boolean
}

export interface ScheduleUpdatePatch {
  title?: string
  instruction?: string
  targetAgentId?: string | null
  spec?: ScheduleSpec
  timezone?: string
  nextRunAt?: string | null
  enabled?: boolean
}

/** 真实触发（含失败）的结算入参 */
export interface ScheduleSettlement {
  status: 'ok' | 'error'
  runId?: string
  error?: string
  /** 下一次触发时刻；null = 清空（once 已消费 / 无法计算） */
  nextRunAt: string | null
}

export class ScheduleStore {
  constructor(private readonly db: AppDb) {}

  create(input: ScheduleCreateInput): ScheduledTask {
    const id = newId('sch')
    const ts = nowIso()
    this.db.run(
      `INSERT INTO scheduled_tasks (
         id, session_id, title, kind, instruction, target_agent_id, spec, timezone, enabled,
         created_by, next_run_at, run_count, fail_streak, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
      id,
      input.sessionId,
      input.title,
      input.kind,
      input.instruction,
      input.targetAgentId ?? null,
      JSON.stringify(input.spec),
      input.timezone,
      input.enabled === false ? 0 : 1,
      input.createdBy,
      input.nextRunAt ?? null,
      ts,
      ts,
    )
    return this.get(id)!
  }

  get(id: string): ScheduledTask | undefined {
    const row = this.db.get<ScheduleRow>('SELECT * FROM scheduled_tasks WHERE id = ?', id)
    return row ? rowToSchedule(row) : undefined
  }

  /** 全部任务（服务端 tick / 恢复扫描；按下次触发升序） */
  all(): ScheduledTask[] {
    return this.db
      .all<ScheduleRow>('SELECT * FROM scheduled_tasks ORDER BY next_run_at IS NULL, next_run_at ASC')
      .map(rowToSchedule)
  }

  listBySession(sessionId: string): ScheduledTask[] {
    return this.db
      .all<ScheduleRow>(
        'SELECT * FROM scheduled_tasks WHERE session_id = ? ORDER BY created_at ASC',
        sessionId,
      )
      .map(rowToSchedule)
  }

  countBySession(sessionId: string): number {
    const row = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM scheduled_tasks WHERE session_id = ?', sessionId)
    return Number(row?.n ?? 0)
  }

  /** 到期任务（enabled=1 且 next_run_at <= now；按触发时刻升序） */
  due(nowIsoStr: string, limit = 20): ScheduledTask[] {
    return this.db
      .all<ScheduleRow>(
        `SELECT * FROM scheduled_tasks
         WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
         ORDER BY next_run_at ASC LIMIT ?`,
        nowIsoStr,
        limit,
      )
      .map(rowToSchedule)
  }

  update(id: string, patch: ScheduleUpdatePatch): ScheduledTask | undefined {
    const current = this.get(id)
    if (!current) return undefined
    const ts = nowIso()
    this.db.run(
      `UPDATE scheduled_tasks SET
         title = ?, instruction = ?, target_agent_id = ?, spec = ?, timezone = ?,
         next_run_at = ?, enabled = ?, updated_at = ?
       WHERE id = ?`,
      patch.title ?? current.title,
      patch.instruction ?? current.instruction,
      patch.targetAgentId === undefined ? (current.targetAgentId ?? null) : patch.targetAgentId,
      JSON.stringify(patch.spec ?? current.spec),
      patch.timezone ?? current.timezone,
      patch.nextRunAt === undefined ? (current.nextRunAt ?? null) : patch.nextRunAt,
      patch.enabled === undefined ? (current.enabled ? 1 : 0) : patch.enabled ? 1 : 0,
      ts,
      id,
    )
    return this.get(id)
  }

  remove(id: string): boolean {
    return this.db.run('DELETE FROM scheduled_tasks WHERE id = ?', id).changes > 0
  }

  /** 真实触发的结算：ok 归零失败计数；error 累加（返回更新后的任务，调用方据此决定是否暂停） */
  settle(id: string, s: ScheduleSettlement): ScheduledTask | undefined {
    const current = this.get(id)
    if (!current) return undefined
    const ts = nowIso()
    const failStreak = s.status === 'error' ? current.failStreak + 1 : 0
    const runCount = s.status === 'ok' ? current.runCount + 1 : current.runCount
    this.db.run(
      `UPDATE scheduled_tasks SET
         last_run_at = ?, last_run_id = ?, last_status = ?, last_error = ?,
         next_run_at = ?, run_count = ?, fail_streak = ?, updated_at = ?
       WHERE id = ?`,
      ts,
      s.runId ?? null,
      s.status,
      s.error ?? null,
      s.nextRunAt,
      runCount,
      failStreak,
      ts,
      id,
    )
    return this.get(id)
  }

  /** 跳过结算（忙时 / 错过补跑窗口）：不计 run_count / fail_streak，仅推进 next_run_at 并留痕 */
  skip(id: string, s: { status: 'skipped-busy' | 'skipped-missed'; note: string; nextRunAt: string | null }): ScheduledTask | undefined {
    const ts = nowIso()
    this.db.run(
      `UPDATE scheduled_tasks SET last_status = ?, last_error = ?, next_run_at = ?, updated_at = ? WHERE id = ?`,
      s.status,
      s.note,
      s.nextRunAt,
      ts,
      id,
    )
    return this.get(id)
  }

  /** 自动暂停（连续失败达阈值；任务保留，用户或 Agent 可 resume） */
  pause(id: string, error: string): ScheduledTask | undefined {
    const ts = nowIso()
    this.db.run(
      `UPDATE scheduled_tasks SET enabled = 0, last_status = 'paused', last_error = ?, updated_at = ? WHERE id = ?`,
      error,
      ts,
      id,
    )
    return this.get(id)
  }

  /** 恢复启用：重置失败计数并写入重新计算的 next_run_at */
  resume(id: string, nextRunAt: string): ScheduledTask | undefined {
    const ts = nowIso()
    this.db.run(
      `UPDATE scheduled_tasks SET enabled = 1, fail_streak = 0, next_run_at = ?, updated_at = ? WHERE id = ?`,
      nextRunAt,
      ts,
      id,
    )
    return this.get(id)
  }
}

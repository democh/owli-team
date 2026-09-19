/**
 * 运行快照存储（M3：Run 持久化与断点恢复）。
 *
 * 引擎在关键节点（launch / 每回合结束 / 插话 / 收尾）写入快照；
 * 进程启动时把遗留的活跃态 Run 标记为 interrupted，
 * 前端据此展示「从断点继续」（复用队列 + 发言史 + 已产出消息）。
 */
import type { RunSnapshot } from '@multi-agent/shared'
import { getLogger } from '../logger.js'
import type { AppDb } from './db.js'
import { nowIso } from './sessions.js'

interface RunRow {
  id: string
  session_id: string
  state: string
  queue: string
  spoken: string
  turn_index: number
  fallback_used: number
  handed_to_user: number
  pending_user_messages: string
  error: string | null
  created_at: string
  updated_at: string
  ended_at: string | null
}

function parseArray(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown
    return Array.isArray(value) ? value.map(String) : []
  } catch {
    return []
  }
}

function rowToSnapshot(row: RunRow): RunSnapshot {
  return {
    id: row.id,
    sessionId: row.session_id,
    state: row.state as RunSnapshot['state'],
    queue: parseArray(row.queue),
    spoken: parseArray(row.spoken),
    turnIndex: Number(row.turn_index),
    fallbackUsed: Number(row.fallback_used) === 1,
    handedToUser: Number(row.handed_to_user) === 1,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    endedAt: row.ended_at ?? undefined,
  }
}

export interface RunCreateInput {
  id: string
  sessionId: string
  state: RunSnapshot['state']
  queue: string[]
}

export interface RunStateUpdate {
  state?: RunSnapshot['state']
  queue?: string[]
  spoken?: string[]
  turnIndex?: number
  fallbackUsed?: boolean
  handedToUser?: boolean
  pendingUserMessages?: string[]
  error?: string | null
  endedAt?: string | null
}

export class RunStore {
  constructor(private readonly db: AppDb) {
    this.recoverInterrupted()
  }

  /** 启动恢复：上次进程中断遗留的活跃态 Run → interrupted（§M3） */
  private recoverInterrupted(): void {
    const result = this.db.run(
      `UPDATE runs SET state = 'interrupted', updated_at = ?
       WHERE state IN ('waiting', 'running', 'awaiting_approval', 'awaiting_plan')`,
      nowIso(),
    )
    if (result.changes > 0) {
      getLogger().warn({ count: result.changes }, '检测到进程中断遗留的运行，已标记为 interrupted')
    }
  }

  create(input: RunCreateInput): void {
    const ts = nowIso()
    this.db.run(
      `INSERT INTO runs (id, session_id, state, queue, spoken, turn_index, fallback_used, handed_to_user, pending_user_messages, created_at, updated_at)
       VALUES (?, ?, ?, ?, '[]', 0, 0, 0, '[]', ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      input.id,
      input.sessionId,
      input.state,
      JSON.stringify(input.queue),
      ts,
      ts,
    )
  }

  get(id: string): RunSnapshot | undefined {
    const row = this.db.get<RunRow>('SELECT * FROM runs WHERE id = ?', id)
    return row ? rowToSnapshot(row) : undefined
  }

  /** 会话最近一次运行（含 interrupted） */
  latest(sessionId: string): RunSnapshot | undefined {
    const row = this.db.get<RunRow>(
      'SELECT * FROM runs WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
      sessionId,
    )
    return row ? rowToSnapshot(row) : undefined
  }

  latestInterrupted(sessionId: string): RunSnapshot | undefined {
    const row = this.db.get<RunRow>(
      `SELECT * FROM runs WHERE session_id = ? AND state = 'interrupted'
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      sessionId,
    )
    return row ? rowToSnapshot(row) : undefined
  }

  /** 部分更新：缺省字段保留当前值（读-改-写，调用点均在同步段内） */
  update(id: string, patch: RunStateUpdate): void {
    const row = this.db.get<RunRow>('SELECT * FROM runs WHERE id = ?', id)
    if (!row) return
    const pick = <T>(key: keyof RunStateUpdate, current: T): T =>
      key in patch ? (patch[key] as unknown as T) : current
    this.db.run(
      `UPDATE runs SET state = ?, queue = ?, spoken = ?, turn_index = ?, fallback_used = ?,
        handed_to_user = ?, pending_user_messages = ?, error = ?, updated_at = ?, ended_at = ?
       WHERE id = ?`,
      pick('state', row.state),
      JSON.stringify(pick('queue', parseArray(row.queue))),
      JSON.stringify(pick('spoken', parseArray(row.spoken))),
      pick('turnIndex', Number(row.turn_index)),
      pick('fallbackUsed', Number(row.fallback_used) === 1) ? 1 : 0,
      pick('handedToUser', Number(row.handed_to_user) === 1) ? 1 : 0,
      JSON.stringify(pick('pendingUserMessages', parseArray(row.pending_user_messages))),
      pick('error', row.error),
      nowIso(),
      pick('endedAt', row.ended_at),
      id,
    )
  }
}

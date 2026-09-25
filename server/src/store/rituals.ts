/**
 * P4：仪式订阅存储（ritual_subscriptions 表）。
 *
 * 语义：
 * - **DB 为唯一真相**（无内存缓存）——订阅量级为个位数，调度索引即 next_run_at 列，
 *   重启后由 tick 直接以表恢复；与 scheduled_tasks（M35）同构但独立成表（任务在触发时
 *   才新建会话，不绑定 session 外键）；
 * - **归属即隔离**：list / remove / find 均带 user_id 条件（跨用户一律读不到、删不掉）；
 * - 写路径两个：`settle`（触发结算：推进 next + 留痕会话/错误）与 `remove`（退订删行）。
 */
import type { RitualSubscription } from '@multi-agent/shared'
import type { AppDb } from './db.js'
import { newId, nowIso } from './sessions.js'

interface RitualRow {
  id: string
  user_id: string
  scene_id: string
  ritual_id: string | null
  title: string
  cron: string
  timezone: string
  opener: string
  members: string
  space_id: string | null
  enabled: number
  next_run_at: string | null
  last_run_at: string | null
  last_session_id: string | null
  last_error: string | null
  created_at: string
  updated_at: string
}

function parseMembers(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === 'string')
  } catch {
    // 数据损坏：按空编制回退（建会话走 PRS 组队，语义安全）
  }
  return []
}

function rowToRitual(row: RitualRow): RitualSubscription {
  return {
    id: row.id,
    userId: row.user_id,
    sceneId: row.scene_id,
    ritualId: row.ritual_id ?? undefined,
    title: row.title,
    cron: row.cron,
    timezone: row.timezone,
    opener: row.opener,
    members: parseMembers(row.members),
    spaceId: row.space_id ?? undefined,
    enabled: Number(row.enabled) === 1,
    nextRunAt: row.next_run_at ?? undefined,
    lastRunAt: row.last_run_at ?? undefined,
    lastSessionId: row.last_session_id ?? undefined,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export interface RitualCreateInput {
  userId: string
  sceneId: string
  /** P5：系统仪式 id（缺省 = 场景声明来源） */
  ritualId?: string
  title: string
  cron: string
  timezone: string
  opener: string
  members: string[]
  spaceId?: string
  nextRunAt?: string
}

export class RitualStore {
  constructor(private readonly db: AppDb) {}

  create(input: RitualCreateInput): RitualSubscription {
    const ts = nowIso()
    const id = newId('rt')
    this.db.run(
      `INSERT INTO ritual_subscriptions
         (id, user_id, scene_id, ritual_id, title, cron, timezone, opener, members, space_id, enabled, next_run_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      id,
      input.userId,
      input.sceneId,
      input.ritualId ?? null,
      input.title,
      input.cron,
      input.timezone,
      input.opener,
      JSON.stringify(input.members),
      input.spaceId ?? null,
      input.nextRunAt ?? null,
      ts,
      ts,
    )
    const created = this.get(id)
    if (!created) throw new Error('仪式订阅写入失败')
    return created
  }

  get(id: string): RitualSubscription | undefined {
    const row = this.db.get<RitualRow>('SELECT * FROM ritual_subscriptions WHERE id = ?', id)
    return row ? rowToRitual(row) : undefined
  }

  /** 本人订阅清单（按订阅时间升序） */
  listByUser(userId: string): RitualSubscription[] {
    return this.db
      .all<RitualRow>(
        'SELECT * FROM ritual_subscriptions WHERE user_id = ? ORDER BY created_at ASC',
        userId,
      )
      .map(rowToRitual)
  }

  /** 同用户同场景去重依据 */
  findByUserScene(userId: string, sceneId: string): RitualSubscription | undefined {
    const row = this.db.get<RitualRow>(
      'SELECT * FROM ritual_subscriptions WHERE user_id = ? AND scene_id = ?',
      userId,
      sceneId,
    )
    return row ? rowToRitual(row) : undefined
  }

  /** P5：去重依据（系统仪式按 ritual_id；场景声明按 scene_id 且 ritual_id 为空——两类命名空间独立） */
  findByUserRef(userId: string, ref: { sceneId?: string; ritualId?: string }): RitualSubscription | undefined {
    const row = ref.ritualId
      ? this.db.get<RitualRow>(
          'SELECT * FROM ritual_subscriptions WHERE user_id = ? AND ritual_id = ?',
          userId,
          ref.ritualId,
        )
      : this.db.get<RitualRow>(
          'SELECT * FROM ritual_subscriptions WHERE user_id = ? AND ritual_id IS NULL AND scene_id = ?',
          userId,
          ref.sceneId ?? '',
        )
    return row ? rowToRitual(row) : undefined
  }

  countByUser(userId: string): number {
    const row = this.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM ritual_subscriptions WHERE user_id = ?',
      userId,
    )
    return row ? Number(row.n) : 0
  }

  /** 到期订阅（tick 用；LIMIT 防单轮爆炸） */
  listDue(nowIsoStr: string): RitualSubscription[] {
    return this.db
      .all<RitualRow>(
        `SELECT * FROM ritual_subscriptions
         WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
         ORDER BY next_run_at ASC LIMIT 20`,
        nowIsoStr,
      )
      .map(rowToRitual)
  }

  /** 退订（仅本人；跨用户视为不存在） */
  remove(userId: string, id: string): boolean {
    const row = this.get(id)
    if (!row || row.userId !== userId) return false
    this.db.run('DELETE FROM ritual_subscriptions WHERE id = ?', id)
    return true
  }

  /** 更新（启停 / 改 cron；nextRunAt 由服务层重算后传入，缺省保留现值） */
  update(
    id: string,
    patch: { enabled?: boolean; cron?: string; timezone?: string; nextRunAt?: string },
  ): RitualSubscription | undefined {
    const cur = this.get(id)
    if (!cur) return undefined
    this.db.run(
      `UPDATE ritual_subscriptions
         SET enabled = ?, cron = ?, timezone = ?, next_run_at = ?, updated_at = ?
       WHERE id = ?`,
      patch.enabled === undefined ? (cur.enabled ? 1 : 0) : patch.enabled ? 1 : 0,
      patch.cron ?? cur.cron,
      patch.timezone ?? cur.timezone,
      patch.nextRunAt ?? cur.nextRunAt ?? null,
      nowIso(),
      id,
    )
    return this.get(id)
  }

  /** 触发结算：推进 next + 记录本次会话/错误（sessionId 缺省保留上次值） */
  settle(
    id: string,
    patch: { nextRunAt?: string; lastRunAt: string; sessionId?: string; error?: string },
  ): RitualSubscription | undefined {
    this.db.run(
      `UPDATE ritual_subscriptions
         SET next_run_at = ?, last_run_at = ?, last_session_id = COALESCE(?, last_session_id), last_error = ?, updated_at = ?
       WHERE id = ?`,
      patch.nextRunAt ?? null,
      patch.lastRunAt,
      patch.sessionId ?? null,
      patch.error ?? null,
      nowIso(),
      id,
    )
    return this.get(id)
  }
}

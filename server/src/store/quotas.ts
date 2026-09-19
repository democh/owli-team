/**
 * M57 P3：用户配额存储（user_quotas 表；NULL 列 = 不限 / 用系统默认）。
 *
 * 语义：
 * - 无行 = 全部不限（兼容模式 / 未配置用户零变化）；
 * - maxConcurrentRuns 覆盖系统默认 RUN_MAX_PER_USER（仅在该默认开启时语义叠加：取更小者）；
 * - 其余四项（dailyTokens / monthlyCostUsd / maxSessions / maxStorageMb）= 硬上限，NULL 不限。
 * 强制点见 [quota/service.ts]（launch / 波次边界 / 会话创建 / 上传）。
 */
import type { AppDb } from './db.js'
import { nowIso } from './sessions.js'

export interface UserQuota {
  userId: string
  /** 同时进行任务数上限（缺省 = 系统 RUN_MAX_PER_USER；两者都空 = 不限） */
  maxConcurrentRuns?: number
  /** 日 token 配额（prompt + completion 合计；缺省 = 不限） */
  dailyTokens?: number
  /** 月成本配额（美元；缺省 = 不限） */
  monthlyCostUsd?: number
  /** 会话数上限（缺省 = 不限） */
  maxSessions?: number
  /** 存储上限 MB（工作区目录总体积；缺省 = 不限） */
  maxStorageMb?: number
  updatedAt: string
}

/** 可写入的配额字段（null = 清除该项回到不限） */
export interface UserQuotaPatch {
  maxConcurrentRuns?: number | null
  dailyTokens?: number | null
  monthlyCostUsd?: number | null
  maxSessions?: number | null
  maxStorageMb?: number | null
}

interface QuotaRow {
  user_id: string
  max_concurrent_runs: number | null
  daily_tokens: number | null
  monthly_cost_usd: number | null
  max_sessions: number | null
  max_storage_mb: number | null
  updated_at: string
}

function rowToQuota(row: QuotaRow): UserQuota {
  return {
    userId: row.user_id,
    maxConcurrentRuns: row.max_concurrent_runs ?? undefined,
    dailyTokens: row.daily_tokens ?? undefined,
    monthlyCostUsd: row.monthly_cost_usd ?? undefined,
    maxSessions: row.max_sessions ?? undefined,
    maxStorageMb: row.max_storage_mb ?? undefined,
    updatedAt: row.updated_at,
  }
}

export class QuotaStore {
  constructor(private readonly db: AppDb) {}

  get(userId: string): UserQuota | undefined {
    const row = this.db.get<QuotaRow>('SELECT * FROM user_quotas WHERE user_id = ?', userId)
    return row ? rowToQuota(row) : undefined
  }

  list(): UserQuota[] {
    return this.db.all<QuotaRow>('SELECT * FROM user_quotas ORDER BY updated_at DESC').map(rowToQuota)
  }

  /** 写入 / 更新（部分字段；undefined = 不改动，null = 清除回不限） */
  upsert(userId: string, patch: UserQuotaPatch): UserQuota {
    const current = this.get(userId)
    const next: Omit<UserQuota, 'updatedAt'> = {
      userId,
      maxConcurrentRuns: patch.maxConcurrentRuns !== undefined ? (patch.maxConcurrentRuns ?? undefined) : current?.maxConcurrentRuns,
      dailyTokens: patch.dailyTokens !== undefined ? (patch.dailyTokens ?? undefined) : current?.dailyTokens,
      monthlyCostUsd: patch.monthlyCostUsd !== undefined ? (patch.monthlyCostUsd ?? undefined) : current?.monthlyCostUsd,
      maxSessions: patch.maxSessions !== undefined ? (patch.maxSessions ?? undefined) : current?.maxSessions,
      maxStorageMb: patch.maxStorageMb !== undefined ? (patch.maxStorageMb ?? undefined) : current?.maxStorageMb,
    }
    const ts = nowIso()
    this.db.run(
      `INSERT INTO user_quotas (user_id, max_concurrent_runs, daily_tokens, monthly_cost_usd, max_sessions, max_storage_mb, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         max_concurrent_runs = excluded.max_concurrent_runs,
         daily_tokens = excluded.daily_tokens,
         monthly_cost_usd = excluded.monthly_cost_usd,
         max_sessions = excluded.max_sessions,
         max_storage_mb = excluded.max_storage_mb,
         updated_at = excluded.updated_at`,
      userId,
      next.maxConcurrentRuns ?? null,
      next.dailyTokens ?? null,
      next.monthlyCostUsd ?? null,
      next.maxSessions ?? null,
      next.maxStorageMb ?? null,
      ts,
    )
    // 全空行无意义（= 不限）：清理避免僵尸行
    if (
      next.maxConcurrentRuns === undefined &&
      next.dailyTokens === undefined &&
      next.monthlyCostUsd === undefined &&
      next.maxSessions === undefined &&
      next.maxStorageMb === undefined
    ) {
      this.db.run('DELETE FROM user_quotas WHERE user_id = ?', userId)
    }
    return this.get(userId) ?? { ...next, updatedAt: ts }
  }

  remove(userId: string): void {
    this.db.run('DELETE FROM user_quotas WHERE user_id = ?', userId)
  }
}

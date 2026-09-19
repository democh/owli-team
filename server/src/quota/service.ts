/**
 * M57 P3：配额服务 —— 限额解析 / 用量汇总 / 强制点断言（单一事实源）。
 *
 * 强制点（调用方）：
 * - 并发：Engine.assertUserCapacity（limitsOf().maxConcurrentRuns；缺省回退 RUN_MAX_PER_USER）；
 * - 用量：Engine 波次边界（blockedReason：日 token / 月成本；超限 → reason='quota' 收束本 Run）；
 * - 会话创建：routes/sessions.ts POST（assertSessionCreate）；
 * - 上传：attachments / canvas media upload（assertUploadAllowed，按工作区目录体积估算）。
 *
 * 语义：无配额行 = 全部不限（兼容模式 / 未配置用户零变化）；金额单位为美元，存储为 MB。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { QuotaLimits, UsageSummary } from '@multi-agent/shared'
import type { AppConfig } from '../config.js'
import type { QuotaStore } from '../store/quotas.js'
import type { SessionStore } from '../store/sessions.js'
import type { UsageStore } from '../store/usage.js'
import { HttpError } from '../util/http-error.js'

export interface QuotaServiceDeps {
  cfg: AppConfig
  quotas: QuotaStore
  sessions: SessionStore
  usage: UsageStore
  /** 会话工作区目录解析（存储体积统计；缺省 = 跳过存储计量） */
  dirOf?: (sessionId: string) => string
  /** M68：用户素材库目录解析（`workspace/_library/u_<uid>`；计入存储体积；缺省 = 不计量素材） */
  libraryUserDirOf?: (userId: string) => string
}

/** 本地时区今日零点（ISO） */
function startOfTodayIso(): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

/** 本地时区本月一日零点（ISO） */
function startOfMonthIso(): string {
  const d = new Date()
  d.setDate(1)
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

/** 目录体积（字节；超过 cap 提前退出——配额校验只关心是否越界） */
function dirSizeBytes(dir: string, capBytes: number): number {
  let total = 0
  const walk = (current: string): boolean => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return true
    }
    for (const entry of entries) {
      if (total >= capBytes) return false
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (!walk(full)) return false
      } else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size
        } catch {
          // 并发删除 / 权限：忽略该文件
        }
      }
    }
    return true
  }
  try {
    if (fs.existsSync(dir)) walk(dir)
  } catch {
    // 目录不可读：计 0
  }
  return total
}

export class QuotaService {
  constructor(private readonly deps: QuotaServiceDeps) {}

  /** 生效限额（配额行 + 系统默认合并；未配置项 = undefined 不限） */
  limitsOf(userId: string): QuotaLimits {
    const quota = this.deps.quotas.get(userId)
    const systemConcurrent = this.deps.cfg.runMaxPerUser || undefined
    const maxConcurrentRuns =
      quota?.maxConcurrentRuns !== undefined
        ? systemConcurrent !== undefined
          ? Math.min(quota.maxConcurrentRuns, systemConcurrent)
          : quota.maxConcurrentRuns
        : systemConcurrent
    return {
      maxConcurrentRuns,
      dailyTokens: quota?.dailyTokens,
      monthlyCostUsd: quota?.monthlyCostUsd,
      maxSessions: quota?.maxSessions,
      maxStorageMb: quota?.maxStorageMb,
    }
  }

  /** 用户用量汇总（个人「我的用量」/ admin 逐用户视图；storageMb 一位小数） */
  usageOf(userId: string): UsageSummary {
    const limits = this.limitsOf(userId)
    const today = this.deps.usage.sumByUser(userId, startOfTodayIso())
    const month = this.deps.usage.sumByUser(userId, startOfMonthIso())
    const sessions = this.deps.sessions.countForUser(userId)
    const storageBytes = this.storageBytesOf(userId, limits.maxStorageMb)
    return {
      userId,
      todayTokens: today.promptTokens + today.completionTokens,
      monthCostUsd: Math.round(month.costUsd * 10000) / 10000,
      sessions,
      storageMb: Math.round((storageBytes / (1024 * 1024)) * 10) / 10,
      limits,
    }
  }

  /** 工作区体积（字节；无上限时按 512MB 安全帽提前退出；M68：含用户素材库目录） */
  private storageBytesOf(userId: string, maxStorageMb?: number): number {
    const capBytes = ((maxStorageMb ?? 512) + 1) * 1024 * 1024
    let total = 0
    if (this.deps.dirOf) {
      for (const summary of this.deps.sessions.list(userId)) {
        if (total >= capBytes) break
        const dir = this.deps.dirOf(summary.id)
        total += dirSizeBytes(dir, capBytes - total)
      }
    }
    if (total < capBytes && this.deps.libraryUserDirOf) {
      total += dirSizeBytes(this.deps.libraryUserDirOf(userId), capBytes - total)
    }
    return total
  }

  /**
   * 用量闸门（波次边界调用）：日 token / 月成本超限 → 返回终止文案；未超限 undefined。
   * 注意：仅在配置了对应上限时比较（无配额行 / NULL 项 = 不限 → 零开销路径）。
   */
  blockedReason(userId: string): string | undefined {
    const quota = this.deps.quotas.get(userId)
    if (!quota) return undefined
    if (quota.dailyTokens !== undefined) {
      const today = this.deps.usage.sumByUser(userId, startOfTodayIso())
      const used = today.promptTokens + today.completionTokens
      if (used >= quota.dailyTokens) {
        return `今日 token 配额已用尽（${used.toLocaleString()} / ${quota.dailyTokens.toLocaleString()}）：明日零点重置，或请联系管理员调整配额`
      }
    }
    if (quota.monthlyCostUsd !== undefined) {
      const month = this.deps.usage.sumByUser(userId, startOfMonthIso())
      if (month.costUsd >= quota.monthlyCostUsd) {
        return `本月成本配额已用尽（$${month.costUsd.toFixed(2)} / $${quota.monthlyCostUsd.toFixed(2)}）：下月一日重置，或请联系管理员调整配额`
      }
    }
    return undefined
  }

  /** 管理侧：读取原始配额行（未配置 = undefined） */
  quotaOf(userId: string): import('../store/quotas.js').UserQuota | undefined {
    return this.deps.quotas.get(userId)
  }

  /** 管理侧：写入配额（undefined = 不改动，null = 清除该项；全空行自动清理） */
  setQuota(userId: string, patch: import('../store/quotas.js').UserQuotaPatch): import('../store/quotas.js').UserQuota {
    return this.deps.quotas.upsert(userId, patch)
  }

  /** 会话创建闸门（POST /sessions；超限 403） */
  assertSessionCreate(userId: string): void {
    const quota = this.deps.quotas.get(userId)
    if (!quota?.maxSessions) return
    const count = this.deps.sessions.countForUser(userId)
    if (count >= quota.maxSessions) {
      throw new HttpError(403, `会话数已达上限（${quota.maxSessions} 个）：请删除不再使用的会话，或联系管理员调整配额`)
    }
  }

  /** 上传闸门（附件 / 画布素材；按工作区目录体积 + 本次增量估算；超限 403） */
  assertUploadAllowed(sessionId: string, extraBytes: number): void {
    const ownerId = this.deps.sessions.getSession(sessionId)?.ownerId
    if (!ownerId) return
    this.assertUserStorageAllowed(ownerId, extraBytes)
  }

  /** M68：用户级存储闸门（素材库上传等无会话场景；工作区 + 素材库体积 + 本次增量；超限 403） */
  assertUserStorageAllowed(userId: string, extraBytes: number): void {
    const quota = this.deps.quotas.get(userId)
    if (!quota?.maxStorageMb) return
    const limitBytes = quota.maxStorageMb * 1024 * 1024
    const current = this.storageBytesOf(userId, quota.maxStorageMb)
    if (current + extraBytes > limitBytes) {
      const usedMb = Math.round((current / (1024 * 1024)) * 10) / 10
      throw new HttpError(
        403,
        `存储空间不足（已用 ${usedMb} MB / 上限 ${quota.maxStorageMb} MB）：请删除不再使用的会话或文件，或联系管理员调整配额`,
      )
    }
  }
}

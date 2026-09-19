/**
 * 用量与成本存储（M4）：每次真实 LLM 调用产出一条 usage 记录。
 * - kind：turn（引擎回合）/ summary（压缩摘要）/ judge（评测裁判，M9）；
 * - cost_usd 按 LLM_PRICING_JSON（每 1K token 美元）估算，模型名支持前缀匹配；
 * - M9 的指标接口将基于本表聚合。
 */
import type { UsageSnapshot } from '@multi-agent/shared'
import type { AppDb } from './db.js'
import { nowIso } from './sessions.js'

export interface UsageRecordInput {
  runId: string
  sessionId: string
  agentId?: string
  model: string
  promptTokens: number
  completionTokens: number
  kind: UsageSnapshot['kind']
  /** M57：用户归因（users.id；缺省 = 单用户兼容模式） */
  userId?: string
}

export interface UsageSum {
  promptTokens: number
  completionTokens: number
  costUsd: number
}

/** M9：跨 Run 聚合（指标接口） */
export interface UsageAggregate extends UsageSum {
  calls: number
  byKind: Record<string, UsageSum & { calls: number }>
}

interface UsageRow {
  prompt_tokens: number
  completion_tokens: number
  cost_usd: number
}

export class UsageStore {
  constructor(
    private readonly db: AppDb,
    private readonly pricing: Record<string, { prompt: number; completion: number }> = {},
  ) {}

  /** 写入一条用量，返回本次估算费用（美元） */
  record(input: UsageRecordInput): number {
    const costUsd = this.costOf(input.model, input.promptTokens, input.completionTokens)
    this.db.run(
      `INSERT INTO usage (run_id, session_id, agent_id, model, prompt_tokens, completion_tokens, cost_usd, kind, user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.runId,
      input.sessionId,
      input.agentId ?? null,
      input.model,
      input.promptTokens,
      input.completionTokens,
      costUsd,
      input.kind,
      input.userId ?? null,
      nowIso(),
    )
    return costUsd
  }

  /** 单价表：精确名优先，其次双向前缀匹配（如 deepseek-flash 命中 deepseek-flash-20250101） */
  costOf(model: string, promptTokens: number, completionTokens: number): number {
    const price = this.matchPricing(model)
    if (!price) return 0
    return (promptTokens / 1000) * price.prompt + (completionTokens / 1000) * price.completion
  }

  private matchPricing(model: string): { prompt: number; completion: number } | undefined {
    const exact = this.pricing[model]
    if (exact) return exact
    const lower = model.toLowerCase()
    for (const [key, price] of Object.entries(this.pricing)) {
      const k = key.toLowerCase()
      if (lower.startsWith(k) || k.startsWith(lower)) return price
    }
    return undefined
  }

  /** 单 Run 汇总（M8 展示「本 Run 费用」/ M9 指标） */
  sumByRun(runId: string): UsageSum {
    const row = this.db.get<UsageRow>(
      `SELECT COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
              COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
              COALESCE(SUM(cost_usd), 0) AS cost_usd
       FROM usage WHERE run_id = ?`,
      runId,
    )
    return {
      promptTokens: row?.prompt_tokens ?? 0,
      completionTokens: row?.completion_tokens ?? 0,
      costUsd: row?.cost_usd ?? 0,
    }
  }

  /** 单会话汇总（跨 Run） */
  sumBySession(sessionId: string): UsageSum {
    const row = this.db.get<UsageRow>(
      `SELECT COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
              COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
              COALESCE(SUM(cost_usd), 0) AS cost_usd
       FROM usage WHERE session_id = ?`,
      sessionId,
    )
    return {
      promptTokens: row?.prompt_tokens ?? 0,
      completionTokens: row?.completion_tokens ?? 0,
      costUsd: row?.cost_usd ?? 0,
    }
  }

  /** M57 P3：用户维度时间窗聚合（配额校验 / 用量看板；sinceIso 缺省 = 不限时间） */
  sumByUser(userId: string, sinceIso?: string): UsageSum & { calls: number } {
    const row = this.db.get<UsageRow & { calls: number }>(
      `SELECT COUNT(*) AS calls,
              COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
              COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
              COALESCE(SUM(cost_usd), 0) AS cost_usd
       FROM usage WHERE user_id = ?${sinceIso ? ' AND created_at >= ?' : ''}`,
      ...(sinceIso ? [userId, sinceIso] : [userId]),
    )
    return {
      calls: Number(row?.calls ?? 0),
      promptTokens: row?.prompt_tokens ?? 0,
      completionTokens: row?.completion_tokens ?? 0,
      costUsd: row?.cost_usd ?? 0,
    }
  }

  /** M9：全局聚合（可选时间窗）：总调用数 / token / 费用 + 按 kind 分组 */
  summary(sinceMs?: number): UsageAggregate {
    const where = sinceMs ? 'WHERE created_at >= ?' : ''
    const params: string[] = sinceMs ? [new Date(Date.now() - sinceMs).toISOString()] : []
    const rows = this.db.all<{
      kind: string
      calls: number
      prompt_tokens: number
      completion_tokens: number
      cost_usd: number
    }>(
      `SELECT kind, COUNT(*) AS calls,
              COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
              COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
              COALESCE(SUM(cost_usd), 0) AS cost_usd
       FROM usage ${where}
       GROUP BY kind`,
      ...params,
    )
    const aggregate: UsageAggregate = { calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, byKind: {} }
    for (const row of rows) {
      const entry = {
        calls: Number(row.calls),
        promptTokens: Number(row.prompt_tokens),
        completionTokens: Number(row.completion_tokens),
        costUsd: Number(row.cost_usd),
      }
      aggregate.calls += entry.calls
      aggregate.promptTokens += entry.promptTokens
      aggregate.completionTokens += entry.completionTokens
      aggregate.costUsd += entry.costUsd
      aggregate.byKind[row.kind] = entry
    }
    return aggregate
  }
}

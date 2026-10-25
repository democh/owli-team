/**
 * 评审记录存储（M24：评审范式的结构化判定落库）。
 *
 * 语义：submit_review 每次调用追加一条记录（不覆盖）——评审历史可追溯；
 * target 为统一寻址：plan:<id> / step:<id> / artifact:<path> / message:<id>。
 * fail 的结构性后果（步骤 blocked / 计划 blocked）由工具与引擎处理，本存储只负责留痕。
 */
import type { ReviewRecord, ReviewVerdict } from '@multi-agent/shared'
import type { AppDb } from './db.js'
import { newId, nowIso } from './sessions.js'

interface ReviewRow {
  id: string
  session_id: string
  run_id: string | null
  agent_id: string
  plan_id: string | null
  step_id: string | null
  target: string
  verdict: string
  findings: string
  evidence: string
  created_at: string
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function rowToReview(row: ReviewRow): ReviewRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    runId: row.run_id ?? undefined,
    agentId: row.agent_id,
    planId: row.plan_id ?? undefined,
    stepId: row.step_id ?? undefined,
    target: row.target,
    verdict: row.verdict as ReviewVerdict,
    findings: parseJson<string[]>(row.findings, []),
    evidence: parseJson<string[]>(row.evidence, []),
    createdAt: row.created_at,
  }
}

export interface ReviewInput {
  sessionId: string
  runId?: string
  agentId: string
  planId?: string
  stepId?: string
  target: string
  verdict: ReviewVerdict
  findings?: string[]
  evidence?: string[]
}

export class ReviewStore {
  constructor(private readonly db: AppDb) {}

  create(input: ReviewInput): ReviewRecord {
    const record: ReviewRecord = {
      id: newId('rv'),
      sessionId: input.sessionId,
      runId: input.runId,
      agentId: input.agentId,
      planId: input.planId,
      stepId: input.stepId,
      target: input.target,
      verdict: input.verdict,
      findings: input.findings ?? [],
      evidence: input.evidence ?? [],
      createdAt: nowIso(),
    }
    this.db.run(
      `INSERT INTO reviews (id, session_id, run_id, agent_id, plan_id, step_id, target, verdict, findings, evidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.sessionId,
      record.runId ?? null,
      record.agentId,
      record.planId ?? null,
      record.stepId ?? null,
      record.target,
      record.verdict,
      JSON.stringify(record.findings),
      JSON.stringify(record.evidence),
      record.createdAt,
    )
    return record
  }

  listBySession(sessionId: string, limit = 200): ReviewRecord[] {
    return this.db
      .all<ReviewRow>('SELECT * FROM reviews WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', sessionId, limit)
      .map(rowToReview)
  }

  listByPlan(planId: string): ReviewRecord[] {
    return this.db
      .all<ReviewRow>('SELECT * FROM reviews WHERE plan_id = ? ORDER BY created_at ASC, rowid ASC', planId)
      .map(rowToReview)
  }

  /** 某步骤的最近一次判定（复合键隔离不同计划的同名步骤）。 */
  latestByStep(sessionId: string, stepId: string, planId?: string): ReviewRecord | undefined {
    const rows = planId
      ? this.db.all<ReviewRow>(
          `SELECT * FROM reviews WHERE session_id = ? AND plan_id = ? AND step_id = ?
           ORDER BY created_at DESC, rowid DESC LIMIT 1`,
          sessionId,
          planId,
          stepId,
        )
      : this.db.all<ReviewRow>(
          `SELECT * FROM reviews WHERE session_id = ? AND step_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
          sessionId,
          stepId,
        )
    return rows.length > 0 ? rowToReview(rows[0]) : undefined
  }

  /** M89：按评审人聚合（次数 / 未通过次数；可选时间窗）——角色级质量指标数据源 */
  statsByAgent(sinceMs?: number): Array<{ agentId: string; reviews: number; fails: number }> {
    const where = sinceMs ? 'WHERE created_at >= ?' : ''
    const params: string[] = sinceMs ? [new Date(Date.now() - sinceMs).toISOString()] : []
    const rows = this.db.all<{ agent_id: string; reviews: number; fails: number }>(
      `SELECT agent_id,
              COUNT(*) AS reviews,
              COALESCE(SUM(CASE WHEN verdict = 'fail' THEN 1 ELSE 0 END), 0) AS fails
       FROM reviews ${where}
       GROUP BY agent_id`,
      ...params,
    )
    return rows.map((r) => ({ agentId: r.agent_id, reviews: Number(r.reviews), fails: Number(r.fails) }))
  }
}

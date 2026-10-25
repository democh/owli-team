/**
 * 协作计划存储（M24：规划范式产出的生命周期落库）。
 *
 * 生命周期：submitted（已提交，待批准）→ approved（已批准，待派发）→ executing（执行中）
 *   → done（全部步骤完成）| blocked（评审 fail / 步骤阻塞）；
 *   驳回 → rejected（作者可同 Run 修订重提：版本递增回 submitted）；
 *   被新计划取代 → superseded（重规划 / 并行多计划只批其一）。
 *
 * 约定：
 * - steps/risks 为 JSON 列；步骤 id 在计划内唯一（s1..sN，提交时分配；PUT 编辑可保留已有 id）；
 * - 编辑（updateDraft）仅限 submitted 状态——进入审批/执行后不可改，只能驳回或重规划。
 */
import type { Plan, PlanStatus, PlanStep, PlanStepStatus } from '@multi-agent/shared'
import type { AppDb } from './db.js'
import { newId, nowIso } from './sessions.js'

interface PlanRow {
  id: string
  session_id: string
  run_id: string | null
  agent_id: string
  title: string
  goal: string
  steps: string
  risks: string
  status: string
  version: number
  feedback: string | null
  created_at: string
  updated_at: string
  approved_at: string | null
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function rowToPlan(row: PlanRow): Plan {
  return {
    id: row.id,
    sessionId: row.session_id,
    runId: row.run_id ?? undefined,
    agentId: row.agent_id,
    title: row.title,
    goal: row.goal,
    steps: parseJson<PlanStep[]>(row.steps, []),
    risks: parseJson<string[]>(row.risks, []),
    status: row.status as PlanStatus,
    version: Number(row.version),
    feedback: row.feedback ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    approvedAt: row.approved_at ?? undefined,
  }
}

/** 工具 / API 提交的步骤输入（id/status 由存储分配） */
export interface PlanStepInput {
  content: string
  ownerAgentId?: string
  mode?: 'execute' | 'review'
  expectedOutput?: string
  acceptance?: string
}

export interface PlanCreateInput {
  sessionId: string
  runId?: string
  agentId: string
  title: string
  goal: string
  steps: PlanStepInput[]
  risks?: string[]
}

export interface PlanDraftPatch {
  title?: string
  goal?: string
  /** 全量替换步骤（保留已存在的 id；新步骤自动分配） */
  steps?: Array<PlanStepInput & { id?: string }>
  risks?: string[]
}

/** 仍处于生命周期中的状态（supersede 的作用域） */
export const ACTIVE_PLAN_STATUSES: PlanStatus[] = ['submitted', 'approved', 'executing', 'blocked']

/** 步骤输入 → 步骤实体（分配 id；保留已有 id；缺省状态 pending） */
function normalizeSteps(steps: Array<PlanStepInput & { id?: string; status?: PlanStepStatus }>): PlanStep[] {
  const used = new Set<string>()
  let counter = 0
  return steps.map((step) => {
    counter += 1
    let id = step.id?.trim()
    if (!id || used.has(id)) {
      id = `s${counter}`
      while (used.has(id)) {
        counter += 1
        id = `s${counter}`
      }
    }
    used.add(id)
    return {
      id,
      content: step.content,
      ownerAgentId: step.ownerAgentId,
      mode: step.mode === 'review' ? 'review' : undefined,
      expectedOutput: step.expectedOutput,
      acceptance: step.acceptance,
      status: step.status ?? 'pending',
    }
  })
}

export class PlanStore {
  constructor(private readonly db: AppDb) {}

  list(sessionId: string): Plan[] {
    return this.db
      .all<PlanRow>('SELECT * FROM plans WHERE session_id = ? ORDER BY created_at ASC, rowid ASC', sessionId)
      .map(rowToPlan)
  }

  get(planId: string): Plan | undefined {
    const row = this.db.get<PlanRow>('SELECT * FROM plans WHERE id = ?', planId)
    return row ? rowToPlan(row) : undefined
  }

  /** 会话内指定状态的计划（执行派发 / 待批准角标等） */
  byStatus(sessionId: string, statuses: PlanStatus[]): Plan[] {
    return this.list(sessionId).filter((p) => statuses.includes(p.status))
  }

  /** 最近一次该 Run 该成员的 rejected 计划（驳回后现场修订 v2 的判定依据） */
  latestRejected(runId: string, agentId: string): Plan | undefined {
    const rows = this.db.all<PlanRow>(
      `SELECT * FROM plans WHERE run_id = ? AND agent_id = ? AND status = 'rejected'
       ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
      runId,
      agentId,
    )
    return rows.length > 0 ? rowToPlan(rows[0]) : undefined
  }

  /** 按步骤 id 反查所属计划与步骤（submit_review 的 step:<id> 目标解析） */
  findByStepId(sessionId: string, stepId: string): { plan: Plan; step: PlanStep } | undefined {
    for (const plan of this.list(sessionId)) {
      const step = plan.steps.find((s) => s.id === stepId)
      if (step) return { plan, step }
    }
    return undefined
  }

  create(input: PlanCreateInput): Plan {
    const ts = nowIso()
    const plan: Plan = {
      id: newId('pl'),
      sessionId: input.sessionId,
      runId: input.runId,
      agentId: input.agentId,
      title: input.title,
      goal: input.goal,
      steps: normalizeSteps(input.steps),
      risks: input.risks ?? [],
      status: 'submitted',
      version: 1,
      createdAt: ts,
      updatedAt: ts,
    }
    this.db.run(
      `INSERT INTO plans (id, session_id, run_id, agent_id, title, goal, steps, risks, status, version, feedback, created_at, updated_at, approved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      plan.id,
      plan.sessionId,
      plan.runId ?? null,
      plan.agentId,
      plan.title,
      plan.goal,
      JSON.stringify(plan.steps),
      JSON.stringify(plan.risks),
      plan.status,
      plan.version,
      null,
      ts,
      ts,
      null,
    )
    return plan
  }

  /** 驳回后修订重提：同一计划 id，版本递增，回到 submitted（清空反馈与批准时间） */
  revise(planId: string, input: { title?: string; goal: string; steps: PlanStepInput[]; risks?: string[]; runId?: string }): Plan | undefined {
    const current = this.get(planId)
    if (!current) return undefined
    const ts = nowIso()
    this.db.run(
      `UPDATE plans SET run_id = ?, title = ?, goal = ?, steps = ?, risks = ?, status = 'submitted', version = version + 1,
         feedback = NULL, approved_at = NULL, updated_at = ? WHERE id = ?`,
      input.runId ?? current.runId ?? null,
      input.title ?? current.title,
      input.goal,
      JSON.stringify(normalizeSteps(input.steps)),
      JSON.stringify(input.risks ?? current.risks),
      ts,
      planId,
    )
    return this.get(planId)
  }

  /** 草稿编辑（仅 submitted）：标题 / 目标 / 步骤（改负责人、调序、增删）/ 风险 */
  updateDraft(planId: string, patch: PlanDraftPatch): Plan | undefined {
    const current = this.get(planId)
    if (!current || current.status !== 'submitted') return undefined
    const ts = nowIso()
    this.db.run(
      `UPDATE plans SET title = ?, goal = ?, steps = ?, risks = ?, updated_at = ? WHERE id = ?`,
      patch.title ?? current.title,
      patch.goal ?? current.goal,
      patch.steps ? JSON.stringify(normalizeSteps(patch.steps)) : JSON.stringify(current.steps),
      patch.risks ? JSON.stringify(patch.risks) : JSON.stringify(current.risks),
      ts,
      planId,
    )
    return this.get(planId)
  }

  /** 步骤进度（update_plan_step 工具 / 引擎置 in_progress 用） */
  setStepStatus(planId: string, stepId: string, status: PlanStepStatus, note?: string): Plan | undefined {
    const current = this.get(planId)
    if (!current) return undefined
    const step = current.steps.find((s) => s.id === stepId)
    if (!step) return undefined
    step.status = status
    if (note !== undefined) step.note = note.trim() || undefined
    const ts = nowIso()
    this.db.run('UPDATE plans SET steps = ?, updated_at = ? WHERE id = ?', JSON.stringify(current.steps), ts, planId)
    return this.get(planId)
  }

  /** 状态迁移（approve / reject / executing / done / blocked） */
  setStatus(planId: string, status: PlanStatus, opts: { feedback?: string | null; approved?: boolean } = {}): Plan | undefined {
    const current = this.get(planId)
    if (!current) return undefined
    const ts = nowIso()
    const feedback = opts.feedback === undefined ? current.feedback ?? null : opts.feedback
    const approvedAt = opts.approved ? ts : status === 'approved' ? ts : null
    this.db.run(
      `UPDATE plans SET status = ?, feedback = ?, approved_at = CASE WHEN ? IS NULL THEN approved_at ELSE ? END, updated_at = ? WHERE id = ?`,
      status,
      feedback,
      approvedAt,
      approvedAt,
      ts,
      planId,
    )
    return this.get(planId)
  }

  /** 将会话内其余生命周期中的计划置为 superseded（重规划 / 并行多计划只批其一） */
  supersede(sessionId: string, keepPlanId?: string): Plan[] {
    const targets = this.byStatus(sessionId, ACTIVE_PLAN_STATUSES).filter((p) => p.id !== keepPlanId)
    const ts = nowIso()
    for (const plan of targets) {
      this.db.run(`UPDATE plans SET status = 'superseded', updated_at = ? WHERE id = ?`, ts, plan.id)
    }
    return targets.map((p) => ({ ...p, status: 'superseded' as PlanStatus, updatedAt: ts }))
  }

  /**
   * M89：按步骤负责人聚合完成 / 阻塞数（owner 缺省 = 计划作者）。
   * 时间窗按 plans.updated_at 过滤；只统计步骤非 pending 的结果，用于角色级推进质量。
   */
  stepStatsByAgent(sinceMs?: number): Array<{ agentId: string; done: number; blocked: number }> {
    const where = sinceMs ? 'WHERE updated_at >= ?' : ''
    const params: string[] = sinceMs ? [new Date(Date.now() - sinceMs).toISOString()] : []
    const rows = this.db.all<{ agent_id: string; steps: string }>(
      `SELECT agent_id, steps FROM plans ${where}`,
      ...params,
    )
    const map = new Map<string, { done: number; blocked: number }>()
    for (const row of rows) {
      for (const step of parseJson<PlanStep[]>(row.steps, [])) {
        const owner = step.ownerAgentId ?? row.agent_id
        const entry = map.get(owner) ?? { done: 0, blocked: 0 }
        if (step.status === 'done' || step.status === 'skipped') entry.done++
        if (step.status === 'blocked') entry.blocked++
        map.set(owner, entry)
      }
    }
    return [...map.entries()].map(([agentId, v]) => ({ agentId, ...v }))
  }
}

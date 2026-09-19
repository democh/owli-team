/**
 * 计划审批服务（M24）：规划范式提交的计划挂起当前 Run，等待用户批准 / 驳回后才继续。
 *
 * 与 ApprovalService（M7）同构：create 登记 → wait（signal 取消）→ resolve 结算回灌。
 * 差异：
 * - 等待对象是「计划」而非「危险动作」：pending 键 = planId（同一计划只挂起一次）；
 * - 默认无限等待（timeoutMs=0）——规划是用户主动选择的回合，审批不应超时流失；
 *   配置 PLAN_REVIEW_TIMEOUT_MS>0 时超时按驳回收敛（反馈提示重新规划）；
 * - 取消（Run 停止）不动计划状态：计划保持 submitted，可稍后于任务面板批准 / 驳回。
 *
 * 计划状态迁移（approved / rejected）由本服务经 PlanStore 完成（保证状态与唤醒原子）；
 * 引擎负责把 outcome 回灌 write_plan 工具并发事件。
 */
import type { Plan } from '@multi-agent/shared'
import type { PlanStore } from './store/plans.js'

export interface PlanResolution {
  decision: 'approve' | 'reject'
  /** 驳回反馈（用户填写；空 = 重新规划） */
  feedback?: string
  /** 超时（用户未响应） */
  timedOut?: boolean
  /** 运行停止导致的取消（计划保持 submitted，可稍后批准） */
  cancelled?: boolean
  /** 被同会话并行批准的其它计划取代（计划置 superseded，不再执行） */
  superseded?: boolean
}

interface PendingEntry {
  planId: string
  runId: string
  sessionId: string
  resolve: (outcome: PlanResolution) => void
  promise: Promise<PlanResolution>
  timer?: NodeJS.Timeout
}

export interface PlanReviewServiceDeps {
  plans: PlanStore
  /** 超时毫秒（PLAN_REVIEW_TIMEOUT_MS）；0 = 无限等待（默认） */
  timeoutMs?: number
}

export class PlanReviewService {
  private entries = new Map<string, PendingEntry>()

  constructor(private readonly deps: PlanReviewServiceDeps) {}

  /** 登记挂起（幂等：同一计划已在挂起时直接返回）；引擎先行广播 plan:submitted 再 wait */
  create(plan: Plan): void {
    if (this.entries.has(plan.id)) return
    let resolveFn!: (outcome: PlanResolution) => void
    const promise = new Promise<PlanResolution>((resolve) => {
      resolveFn = resolve
    })
    const timeoutMs = this.deps.timeoutMs ?? 0
    let timer: NodeJS.Timeout | undefined
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        const feedback = '用户未响应（计划审批超时），请重新规划或交还用户确认'
        this.deps.plans.setStatus(plan.id, 'rejected', { feedback })
        this.settle(plan.id, { decision: 'reject', feedback, timedOut: true })
      }, timeoutMs)
      timer.unref?.()
    }
    this.entries.set(plan.id, {
      planId: plan.id,
      runId: plan.runId ?? '',
      sessionId: plan.sessionId,
      resolve: resolveFn,
      promise,
      timer,
    })
  }

  /** 等待决定；signal 中止（Run 被停止）→ 以 reject+cancelled 收敛，计划保持 submitted */
  async wait(planId: string, signal?: AbortSignal): Promise<PlanResolution> {
    const entry = this.entries.get(planId)
    if (!entry) {
      // 已被决定（或从未挂起）→ 按计划当前状态回灌（resolve 先行于 wait 的竞态安全）
      const plan = this.deps.plans.get(planId)
      const approved = plan
        ? plan.status === 'approved' || plan.status === 'executing' || plan.status === 'done'
        : false
      return { decision: approved ? 'approve' : 'reject', feedback: plan?.feedback }
    }
    if (!signal) return entry.promise
    if (signal.aborted) {
      this.cancel(entry)
      return entry.promise
    }
    const onAbort = (): void => this.cancel(entry)
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      return await entry.promise
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  /**
   * 用户决定（聊天卡 / 任务面板共用）：迁移计划状态 → 唤醒等待者。
   * 无挂起条目 → null（路由侧改走「稍后批准」路径：直接 launchPlanExecution）。
   */
  resolve(planId: string, decision: 'approve' | 'reject', feedback?: string): Plan | null {
    const entry = this.entries.get(planId)
    if (!entry) return null
    const trimmed = feedback?.trim() || undefined
    const plan =
      decision === 'approve'
        ? (this.deps.plans.setStatus(planId, 'approved') ?? null)
        : (this.deps.plans.setStatus(planId, 'rejected', { feedback: trimmed ?? null }) ?? null)
    this.settle(planId, { decision, feedback: trimmed })
    // 并行波多计划：批准其一 → 同 Run 其余挂起计划自动 superseded（等待方以「已被取代」收敛）
    if (decision === 'approve') {
      for (const other of [...this.entries.values()]) {
        if (other.sessionId !== entry.sessionId || other.runId !== entry.runId) continue
        this.deps.plans.setStatus(other.planId, 'superseded')
        this.settle(other.planId, {
          decision: 'reject',
          feedback: '已被并行批准的其它计划取代，无需再执行',
          superseded: true,
        })
      }
    }
    return plan
  }

  has(planId: string): boolean {
    return this.entries.has(planId)
  }

  /** 某会话当前挂起的计划（SSE 重附着 / 任务面板展示） */
  pendingOf(sessionId: string): Plan[] {
    const out: Plan[] = []
    for (const entry of this.entries.values()) {
      if (entry.sessionId !== sessionId) continue
      const plan = this.deps.plans.get(entry.planId)
      if (plan) out.push(plan)
    }
    return out
  }

  /** 某 Run 挂起的计划 */
  forRun(runId: string): Plan[] {
    const out: Plan[] = []
    for (const entry of this.entries.values()) {
      if (entry.runId !== runId) continue
      const plan = this.deps.plans.get(entry.planId)
      if (plan) out.push(plan)
    }
    return out
  }

  /** 结算：清理计时器 → 移除挂起 → resolve */
  private settle(planId: string, outcome: PlanResolution): void {
    const entry = this.entries.get(planId)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    this.entries.delete(planId)
    entry.resolve(outcome)
  }

  /** 运行停止 → 挂起取消（计划保持 submitted 供稍后处理；等待者以 cancelled 区别于用户驳回） */
  private cancel(entry: PendingEntry): void {
    this.settle(entry.planId, {
      decision: 'reject',
      feedback: '运行已停止，计划审批取消（计划保持待批准，可在任务面板稍后批准或驳回）',
      cancelled: true,
    })
  }
}

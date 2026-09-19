/**
 * 人机协同审批服务（M7）：危险动作挂起 Run，等待用户决定后才继续。
 *
 * 生命周期：
 *   create()  登记审批请求（status=pending + 超时计时器）→ 返回 ApprovalRequest（引擎先行广播 SSE / 通知）
 *   wait()    等待决定（approve / reject / custom / timeout / 运行停止取消）；create 与 decide 任意先后均安全
 *   decide()  用户决定（POST /api/runs/:runId/approvals/:approvalId）；重复决定返回 null
 *
 * 超时（APPROVAL_TIMEOUT_MS，默认 600s）视为拒绝：回灌「用户未响应，请改换方案」。
 * Run 被停止（signal abort）→ 以 reject 收敛并标注 cancelled，工具立即返回让引擎走 stopped 路径。
 */
import crypto from 'node:crypto'
import type { ApprovalRequest, ApprovalStatus } from '@multi-agent/shared'
import { getLogger } from './logger.js'
import type { AppDb } from './store/db.js'

export type ApprovalDecision = 'approve' | 'reject' | 'custom'

export interface ApprovalOutcome {
  approval: ApprovalRequest
  decision: ApprovalDecision | 'timeout'
  feedback?: string
  /** 超时（含运行停止取消） */
  timedOut: boolean
  /** 运行被停止导致审批取消（区别于用户未响应） */
  cancelled?: boolean
}

export interface ApprovalInput {
  runId: string
  sessionId: string
  agentId?: string
  action: string
  detail: string
  options?: string[]
}

interface PendingEntry {
  approval: ApprovalRequest
  resolve: (outcome: ApprovalOutcome) => void
  promise: Promise<ApprovalOutcome>
  timer: NodeJS.Timeout
}

export interface ApprovalServiceDeps {
  /** 超时毫秒（APPROVAL_TIMEOUT_MS） */
  timeoutMs: number
  /** 审核 M-4：审批留痕落库（approvals 表：请求 / 决定 / 超时 / 取消）；缺省 = 仅内存 */
  db?: AppDb
}

/** 历史保留上限（前端重附着 / 审计视图用） */
const HISTORY_LIMIT = 50

export class ApprovalService {
  private entries = new Map<string, PendingEntry>()
  private history: ApprovalRequest[] = []

  constructor(private readonly deps: ApprovalServiceDeps) {}

  /** 登记审批请求并启动超时倒计时（不阻塞；引擎拿到 approval 后广播再 wait） */
  create(input: ApprovalInput): ApprovalRequest {
    const approval: ApprovalRequest = {
      id: crypto.randomUUID(),
      runId: input.runId,
      sessionId: input.sessionId,
      agentId: input.agentId,
      action: input.action,
      detail: input.detail,
      options: input.options ?? ['approve', 'reject'],
      status: 'pending',
      createdAt: new Date().toISOString(),
    }
    let resolveFn!: (outcome: ApprovalOutcome) => void
    const promise = new Promise<ApprovalOutcome>((resolve) => {
      resolveFn = resolve
    })
    const timer = setTimeout(() => {
      this.settle(approval.id, 'timeout', {
        decision: 'timeout',
        feedback: '用户未响应（审批超时），请改换方案或交还用户确认',
        timedOut: true,
      })
    }, this.deps.timeoutMs)
    timer.unref?.()
    this.entries.set(approval.id, { approval, resolve: resolveFn, promise, timer })
    this.persist(approval)
    return approval
  }

  /** 等待决定；signal 中止（Run 被停止）→ 以 reject 收敛并标注 cancelled */
  async wait(approvalId: string, signal?: AbortSignal): Promise<ApprovalOutcome> {
    const entry = this.entries.get(approvalId)
    if (!entry) {
      const done = this.history.find((a) => a.id === approvalId)
      return {
        approval: done ?? this.detached(approvalId),
        decision: (done?.status === 'approved' ? 'approve' : 'reject') as ApprovalDecision,
        feedback: done?.feedback,
        timedOut: done?.status === 'timeout',
      }
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

  /** 用户决定；不存在或已决定 → null */
  decide(runId: string, approvalId: string, decision: ApprovalDecision, feedback?: string): ApprovalRequest | null {
    const entry = this.entries.get(approvalId)
    if (!entry || entry.approval.runId !== runId) return null
    const status: ApprovalStatus = decision === 'reject' ? 'rejected' : 'approved'
    this.settle(approvalId, status, {
      decision,
      feedback: feedback?.trim() || undefined,
      timedOut: false,
    })
    return { ...entry.approval }
  }

  get(approvalId: string): ApprovalRequest | undefined {
    return this.entries.get(approvalId)?.approval ?? this.history.find((a) => a.id === approvalId)
  }

  /** 某 Run 当前挂起的审批（SSE 重附着 / 前端恢复时展示） */
  pendingOf(runId: string): ApprovalRequest[] {
    return [...this.entries.values()].filter((e) => e.approval.runId === runId).map((e) => e.approval)
  }

  /** 某 Run 的全部审批（挂起 + 历史） */
  forRun(runId: string): ApprovalRequest[] {
    return [...this.pendingOf(runId), ...this.history.filter((a) => a.runId === runId)]
  }

  /** 结算：更新状态 → resolve → 移入历史 */
  private settle(
    approvalId: string,
    status: ApprovalStatus,
    outcome: { decision: ApprovalOutcome['decision']; feedback?: string; timedOut: boolean; cancelled?: boolean },
  ): void {
    const entry = this.entries.get(approvalId)
    if (!entry) return
    clearTimeout(entry.timer)
    this.entries.delete(approvalId)
    entry.approval.status = status
    entry.approval.decision = status === 'timeout' ? undefined : outcome.decision
    entry.approval.feedback = outcome.feedback
    entry.approval.decidedAt = new Date().toISOString()
    entry.resolve({ approval: entry.approval, decision: outcome.decision, feedback: outcome.feedback, timedOut: outcome.timedOut, cancelled: outcome.cancelled })
    this.history.push(entry.approval)
    if (this.history.length > HISTORY_LIMIT) this.history.splice(0, this.history.length - HISTORY_LIMIT)
    this.persist(entry.approval)
  }

  /** 审核 M-4：审批留痕落库（upsert 幂等；写失败不阻断审批主流程，仅记日志） */
  private persist(approval: ApprovalRequest): void {
    const db = this.deps.db
    if (!db) return
    try {
      db.run(
        `INSERT INTO approvals (id, run_id, session_id, agent_id, action, detail, options, status, decision, feedback, created_at, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           decision = excluded.decision,
           feedback = excluded.feedback,
           decided_at = excluded.decided_at`,
        approval.id,
        approval.runId,
        approval.sessionId,
        approval.agentId ?? null,
        approval.action,
        approval.detail,
        JSON.stringify(approval.options ?? []),
        approval.status,
        approval.decision ?? null,
        approval.feedback ?? null,
        approval.createdAt,
        approval.decidedAt ?? null,
      )
    } catch (err) {
      getLogger().warn({ approvalId: approval.id, err }, '审批留痕落库失败（不影响审批流程）')
    }
  }

  /** 运行停止 → 审批取消（以 reject 语义收敛，工具回灌文案区分「取消」） */
  private cancel(entry: PendingEntry): void {
    this.settle(entry.approval.id, 'rejected', {
      decision: 'reject',
      feedback: '运行已停止，审批取消',
      timedOut: true,
      cancelled: true,
    })
  }

  private detached(approvalId: string): ApprovalRequest {
    return {
      id: approvalId,
      runId: '',
      sessionId: '',
      action: '',
      detail: '',
      options: [],
      status: 'timeout',
      createdAt: new Date().toISOString(),
    }
  }
}

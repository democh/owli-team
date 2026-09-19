/**
 * 计划与评审（M24）：plans / reviews 的前端镜像（聊天计划卡 + 任务面板 2.0 数据源）。
 * - 双通道刷新：SSE plan:submitted / plan:updated / review:submitted（run-store 转发） +
 *   WS notify:plan-submitted / notify:plan-updated（ws-store 转发；SSE 未挂接 / 非当前 Run 时兜底）；
 * - 按会话隔离：load 先绑定 sessionId，跨会话迟到响应被守卫丢弃（仿 task-store 竞态守卫）；
 * - resolve：有挂起 → 结算（驳回反馈回灌作者）；无挂起批准 → 服务端新起执行 Run（launched）→ 本地挂接播放。
 */
import { create } from 'zustand'
import type { Plan, ReviewRecord } from '@multi-agent/shared'
import { apiGet, apiPost, apiPut } from '../lib/api'
import { useRunStore } from './run-store'

/** 编辑补丁步骤（id 缺省 = 新增；与 PUT /plans/:id 的 planEditSchema 对齐） */
export interface PlanStepPatch {
  id?: string
  content: string
  ownerAgentId?: string
  mode?: 'execute' | 'review'
  expectedOutput?: string
  acceptance?: string
}

/** 编辑补丁（仅 submitted 计划可编辑） */
export interface PlanPatch {
  title?: string
  goal?: string
  steps?: PlanStepPatch[]
  risks?: string[]
}

interface PlanState {
  /** 当前已加载的会话 id（与 session-store.currentId 比对，避免串会话展示） */
  sessionId?: string
  plans: Plan[]
  reviews: ReviewRecord[]
  loading: boolean
  load: (sessionId: string) => Promise<void>
  /** 单条归约：同 id 覆盖，新 id 追加（SSE / WS 双通道幂等；sessionId 缺省沿用当前绑定） */
  applyPlan: (plan: Plan, sessionId?: string) => void
  applyReview: (review: ReviewRecord, sessionId?: string) => void
  /** 就地编辑（仅 submitted）：标题 / 目标 / 步骤（改负责人 / 调序 / 增删）/ 风险 */
  updatePlan: (planId: string, patch: PlanPatch) => Promise<Plan>
  /** 批准并执行（无挂起时服务端新起执行 Run，本地自动挂接流转）/ 驳回带反馈 */
  resolve: (planId: string, decision: 'approve' | 'reject', feedback?: string) => Promise<Plan>
  reset: () => void
}

const MAX_REVIEWS = 200

export const usePlanStore = create<PlanState>((set, get) => ({
  plans: [],
  reviews: [],
  loading: false,

  load: async (sessionId) => {
    set({ sessionId, loading: true })
    try {
      const res = await apiGet<{ plans: Plan[]; reviews: ReviewRecord[] }>(`/api/sessions/${sessionId}/plans`)
      if (get().sessionId !== sessionId) return // 切换竞态守卫
      set({ plans: res.plans, reviews: res.reviews })
    } catch {
      // 会话可能已删除：静默降级为空列表
      if (get().sessionId === sessionId) set({ plans: [], reviews: [] })
    } finally {
      if (get().sessionId === sessionId) set({ loading: false })
    }
  },

  applyPlan: (plan, sessionId) =>
    set((s) => {
      if (sessionId && s.sessionId !== sessionId) return {}
      const idx = s.plans.findIndex((p) => p.id === plan.id)
      if (idx !== -1 && plan.updatedAt < s.plans[idx].updatedAt) {
        // 迟到回包守卫（M24）：resolve/PUT 回包或 WS 兜底可能晚于更新的 SSE 事件到达
        // （驳回后引擎立即续跑 v2 重提，回包快照仍是旧版本）——旧快照不得覆盖新状态。
        return {}
      }
      const next = [...s.plans]
      if (idx === -1) next.push(plan)
      else next[idx] = plan
      // 新版本 / 新提交置前（面板最近优先），其余保持稳定顺序
      next.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      return { plans: next }
    }),

  applyReview: (review, sessionId) =>
    set((s) => {
      if (sessionId && s.sessionId !== sessionId) return {}
      const next = [...s.reviews.filter((r) => r.id !== review.id), review].slice(-MAX_REVIEWS)
      return { reviews: next }
    }),

  updatePlan: async (planId, patch) => {
    const sessionId = get().sessionId
    if (!sessionId) throw new Error('未绑定会话')
    const res = await apiPut<{ plan: Plan }>(`/api/sessions/${sessionId}/plans/${planId}`, patch)
    get().applyPlan(res.plan)
    return res.plan
  },

  resolve: async (planId, decision, feedback) => {
    const sessionId = get().sessionId
    if (!sessionId) throw new Error('未绑定会话')
    const res = await apiPost<{ plan: Plan; launched: { runId: string; queue: string[]; queued: boolean } | null }>(
      `/api/sessions/${sessionId}/plans/${planId}/resolve`,
      { decision, feedback },
    )
    // plan 可能为 null（极端竞态）：保底拉取当前绑定会话快照
    if (res.plan) get().applyPlan(res.plan)
    else void get().load(sessionId)
    // 稍后批准：服务端已新起执行 Run → 本地挂接流（与 send 后的 attach 语义一致）
    if (res.launched) useRunStore.getState().attach(res.launched.runId, sessionId)
    return res.plan
  },

  reset: () => set({ plans: [], reviews: [], sessionId: undefined, loading: false }),
}))

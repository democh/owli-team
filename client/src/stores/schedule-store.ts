/**
 * 定时任务（M35）：scheduled_tasks 的前端镜像（右栏「定时」面板数据源）。
 * - 双通道刷新：操作回包（create / update / remove / 启停 / run_now）+ WS notify:schedule-changed
 *   （ws-store 转发；SSE 未挂接 / 非当前会话时兜底）；remind 触发的消息条由 ws-store 落定；
 * - 按会话隔离：load 先绑定 sessionId，跨会话迟到响应被守卫丢弃（仿 plan-store 竞态守卫）；
 * - 排序：next_run_at 升序（缺省末尾），与服务端清单一致。
 */
import { create } from 'zustand'
import type { ScheduledTask, ScheduleSpec } from '@multi-agent/shared'
import { apiDelete, apiGet, apiPatch, apiPost } from '../lib/api'

export interface ScheduleCreateInput {
  title: string
  kind: 'run' | 'remind'
  instruction: string
  targetAgentId?: string
  spec: ScheduleSpec
}

export interface ScheduleUpdateInput {
  title?: string
  instruction?: string
  targetAgentId?: string | null
  spec?: ScheduleSpec
}

/** run_now 结果（skipped = 自动触发被跳过；手动触发 busy 时报错） */
export interface ScheduleRunResult {
  task?: ScheduledTask
  runId?: string
  messageId?: string
  skipped?: 'busy' | 'missed'
}

interface ScheduleState {
  /** 当前已加载的会话 id（与 session-store.currentId 比对，避免串会话展示） */
  sessionId?: string
  tasks: ScheduledTask[]
  loading: boolean
  load: (sessionId: string) => Promise<void>
  /** 单条归约：同 id 覆盖，新 id 追加（WS / 回包双通道幂等；sessionId 缺省沿用当前绑定） */
  applyTask: (task: ScheduledTask, sessionId?: string) => void
  /** 删除归约（notify:schedule-changed action='deleted'） */
  dropTask: (id: string, sessionId?: string) => void
  create: (input: ScheduleCreateInput) => Promise<ScheduledTask>
  update: (id: string, patch: ScheduleUpdateInput) => Promise<ScheduledTask>
  remove: (id: string) => Promise<void>
  /** 启停（resume 时服务端重算 next 并重置失败计数） */
  setEnabled: (id: string, enabled: boolean) => Promise<ScheduledTask>
  /** 立即触发一次（不推进调度节奏；会话忙报错） */
  runNow: (id: string) => Promise<ScheduleRunResult>
  reset: () => void
}

function sortTasks(tasks: ScheduledTask[]): ScheduledTask[] {
  return [...tasks].sort((a, b) => {
    if (a.nextRunAt === b.nextRunAt) return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0
    if (!a.nextRunAt) return 1
    if (!b.nextRunAt) return -1
    return a.nextRunAt < b.nextRunAt ? -1 : 1
  })
}

export const useScheduleStore = create<ScheduleState>((set, get) => ({
  tasks: [],
  loading: false,

  load: async (sessionId) => {
    set({ sessionId, loading: true })
    try {
      const res = await apiGet<{ schedules: ScheduledTask[] }>(`/api/sessions/${sessionId}/schedules`)
      if (get().sessionId !== sessionId) return // 切换竞态守卫
      set({ tasks: sortTasks(res.schedules) })
    } catch {
      // 会话可能已删除 / 服务未装配：静默降级为空列表
      if (get().sessionId === sessionId) set({ tasks: [] })
    } finally {
      if (get().sessionId === sessionId) set({ loading: false })
    }
  },

  applyTask: (task, sessionId) =>
    set((s) => {
      // 跨会话守卫：已绑定其他会话时丢弃（未绑定直接归约，面板打开时 load 快照覆盖）
      if (sessionId && s.sessionId && s.sessionId !== sessionId) return {}
      const idx = s.tasks.findIndex((t) => t.id === task.id)
      const next = [...s.tasks]
      if (idx === -1) next.push(task)
      else next[idx] = task
      return { tasks: sortTasks(next) }
    }),

  dropTask: (id, sessionId) =>
    set((s) => {
      if (sessionId && s.sessionId && s.sessionId !== sessionId) return {}
      return { tasks: s.tasks.filter((t) => t.id !== id) }
    }),

  create: async (input) => {
    const sessionId = get().sessionId
    if (!sessionId) throw new Error('未绑定会话')
    const res = await apiPost<{ task: ScheduledTask }>(`/api/sessions/${sessionId}/schedules`, input)
    get().applyTask(res.task)
    return res.task
  },

  update: async (id, patch) => {
    const res = await apiPatch<{ task: ScheduledTask }>(`/api/schedules/${id}`, patch)
    get().applyTask(res.task)
    return res.task
  },

  remove: async (id) => {
    await apiDelete(`/api/schedules/${id}`)
    get().dropTask(id)
  },

  setEnabled: async (id, enabled) => {
    const res = await apiPost<{ task: ScheduledTask }>(`/api/schedules/${id}/${enabled ? 'resume' : 'pause'}`)
    if (res.task) get().applyTask(res.task)
    return res.task
  },

  runNow: async (id) => {
    const res = await apiPost<ScheduleRunResult>(`/api/schedules/${id}/run`)
    if (res.task) get().applyTask(res.task)
    return res
  },

  reset: () => set({ tasks: [], sessionId: undefined, loading: false }),
}))

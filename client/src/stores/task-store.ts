/**
 * 任务清单（M8）：`write_todos` 落库的 task_items 的前端镜像。
 * - 右栏「任务」视图与 ⌘K 消费；
 * - 双通道刷新：SSE `task:updated`（run-store 转发） + WS `notify:task-updated`（ws-store 转发）；
 * - 按会话隔离：load 会先绑定 sessionId，跨会话的迟到响应被守卫丢弃。
 */
import { create } from 'zustand'
import type { TaskItem } from '@multi-agent/shared'
import { apiGet } from '../lib/api'

interface TaskState {
  /** 当前已加载的会话 id（与 session-store.currentId 比对，避免串会话展示） */
  sessionId?: string
  tasks: TaskItem[]
  loading: boolean
  load: (sessionId: string) => Promise<void>
  /** SSE task:updated 全量替换（sessionId 缺省沿用当前绑定） */
  apply: (tasks: TaskItem[], sessionId?: string) => void
  reset: () => void
}

export const useTaskStore = create<TaskState>((set, get) => ({
  tasks: [],
  loading: false,

  load: async (sessionId) => {
    set({ sessionId, loading: true })
    try {
      const res = await apiGet<{ tasks: TaskItem[] }>(`/api/sessions/${sessionId}/tasks`)
      if (get().sessionId !== sessionId) return // 切换竞态守卫
      set({ tasks: res.tasks })
    } catch {
      // 会话可能已删除：静默降级为空列表
      if (get().sessionId === sessionId) set({ tasks: [] })
    } finally {
      if (get().sessionId === sessionId) set({ loading: false })
    }
  },

  apply: (tasks, sessionId) => set((s) => ({ tasks, sessionId: sessionId ?? s.sessionId })),

  reset: () => set({ tasks: [], sessionId: undefined, loading: false }),
}))

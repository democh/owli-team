/**
 * M57 P2：会话共享状态（共享面板数据 + 邀请 / 改角色 / 移出 / 自助退出）。
 *
 * 契约（服务端已冻结，见 docs/api.md §18）：
 * - GET    /api/sessions/:id/shares          → { owner?, members: SessionShare[] }
 * - POST   /api/sessions/:id/shares          → 邀请（{ username, role }）
 * - PATCH  /api/sessions/:id/shares/:userId  → 改角色（{ role }）
 * - DELETE /api/sessions/:id/shares/:userId  → 移出
 * - POST   /api/sessions/:id/leave           → 自助退出
 * 每次写操作响应回传最新共享视图（服务端为真相）；面板打开时按 sessionId 懒加载。
 */
import { create } from 'zustand'
import type { UserAvatar, SessionShare, SessionShareRole } from '@multi-agent/shared'
import { apiDelete, apiGet, apiPatch, apiPost } from '../lib/api'

export interface SharesView {
  owner?: {
    userId: string
    username: string
    displayName: string
    /** M79-B：画像投影（与成员行一致） */
    headline?: string
    avatar?: UserAvatar
  }
  members: SessionShare[]
}

export interface ShareState {
  /** 当前面板绑定的会话（load 时写入；null = 未打开） */
  sessionId?: string
  view: SharesView | null
  loading: boolean
  busy: boolean
  load: (sessionId: string) => Promise<void>
  invite: (sessionId: string, username: string, role: SessionShareRole) => Promise<void>
  setRole: (sessionId: string, userId: string, role: SessionShareRole) => Promise<void>
  remove: (sessionId: string, userId: string) => Promise<void>
  leave: (sessionId: string) => Promise<void>
  /** notify:share-changed：面板正打开该会话 → 静默刷新（其余情况由 ws-store 刷新会话列表） */
  refreshIfOpen: (sessionId: string) => void
  /** 面板关闭（释放绑定；下次打开重新加载） */
  close: () => void
}

export const useShareStore = create<ShareState>((set, get) => ({
  view: null,
  loading: false,
  busy: false,

  load: async (sessionId) => {
    set({ sessionId, loading: true })
    try {
      const view = await apiGet<SharesView>(`/api/sessions/${sessionId}/shares`)
      if (get().sessionId !== sessionId) return // 切换竞态守卫
      set({ view })
    } finally {
      if (get().sessionId === sessionId) set({ loading: false })
    }
  },

  invite: async (sessionId, username, role) => {
    set({ busy: true })
    try {
      const view = await apiPost<SharesView>(`/api/sessions/${sessionId}/shares`, { username, role })
      set({ view })
    } finally {
      set({ busy: false })
    }
  },

  setRole: async (sessionId, userId, role) => {
    set({ busy: true })
    try {
      const view = await apiPatch<SharesView>(`/api/sessions/${sessionId}/shares/${userId}`, { role })
      set({ view })
    } finally {
      set({ busy: false })
    }
  },

  remove: async (sessionId, userId) => {
    set({ busy: true })
    try {
      const view = await apiDelete<SharesView>(`/api/sessions/${sessionId}/shares/${userId}`)
      set({ view })
    } finally {
      set({ busy: false })
    }
  },

  leave: async (sessionId) => {
    set({ busy: true })
    try {
      await apiPost<{ ok: true }>(`/api/sessions/${sessionId}/leave`, {})
      set({ view: null })
    } finally {
      set({ busy: false })
    }
  },

  refreshIfOpen: (sessionId) => {
    if (get().sessionId === sessionId) void get().load(sessionId)
  },

  close: () => set({ sessionId: undefined, view: null }),
}))

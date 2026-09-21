/**
 * M57：多用户会话状态（客户端）。
 *
 * 启动引导（AuthGate 消费）：
 *   GET /auth/status（公开）→ 无账号且本机开放 → 直接进入（合成管理员）；
 *   无账号 + 配了 AUTH_TOKEN（Docker/局域网）→ 令牌入口页（引导 `/?token=` 种 cookie）；
 *   有账号 → GET /auth/me：200 进入（mustChangePassword 时先改密）/ 401 登录页。
 *
 * 登录 / 首启 / 改密成功后整页 reload：以干净状态重建全部 store（避免半初始化残留）。
 * 全局 401：api 层回调 handleUnauthorized —— 仅在 ready 态触发（登录接口自身 401 不误伤）。
 */
import { create } from 'zustand'
import type { UserAvatar } from '@multi-agent/shared'
import { ApiError, apiGet, apiPost, setUnauthorizedHandler } from '../lib/api'

export interface AuthUserInfo {
  id: string
  username: string
  displayName: string
  role: 'admin' | 'member'
  mustChangePassword?: boolean
  /** 单用户兼容模式的合成管理员（无账号体系） */
  legacy?: boolean
  /** M79-B：画像（头衔 / 简介 / 头像；缺省 = 未设置） */
  headline?: string
  bio?: string
  avatar?: UserAvatar
}

export interface AuthStatus {
  needsSetup: boolean
  authRequired: boolean
  multiUser: boolean
}

export type AuthPhase = 'loading' | 'setup' | 'token' | 'login' | 'force-password' | 'ready'

interface AuthState {
  phase: AuthPhase
  user: AuthUserInfo | null
  isAdmin: boolean
  status: AuthStatus
  error: string | null
  bootstrap: () => Promise<void>
  login: (username: string, password: string) => Promise<void>
  setup: (username: string, password: string, displayName?: string) => Promise<void>
  logout: () => Promise<void>
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>
  /** api 层全局 401 回调（仅 ready 态翻转到登录页） */
  handleUnauthorized: () => void
  /** 兼容模式下主动发起首启初始化（账号弹窗入口 → 首启向导页） */
  openSetup: () => void
  setError: (message: string | null) => void
  /** M79-B：本地应用画像补丁（保存成功后就地更新，免整页刷新） */
  applyProfile: (patch: Partial<AuthUserInfo>) => void
}

const reload = (): void => {
  if (typeof window !== 'undefined') window.location.reload()
}

export const useAuthStore = create<AuthState>((set, get) => ({
  phase: 'loading',
  user: null,
  isAdmin: false,
  status: { needsSetup: false, authRequired: false, multiUser: false },
  error: null,

  async bootstrap() {
    set({ phase: 'loading', error: null })
    let status: AuthStatus
    try {
      status = await apiGet<AuthStatus>('/api/auth/status')
    } catch (err) {
      // 服务端不可达 / 异常：停在错误态（登录页展示错误 + 可重试）
      set({ phase: 'login', error: (err as Error).message })
      return
    }
    set({ status })
    try {
      const me = await apiGet<{ user: AuthUserInfo; isAdmin: boolean }>('/api/auth/me')
      const mustChange = Boolean(me.user.mustChangePassword) && !me.user.legacy
      set({ phase: mustChange ? 'force-password' : 'ready', user: me.user, isAdmin: me.isAdmin })
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        // 无账号 + 需令牌（AUTH_TOKEN 部署）→ 令牌入口；其余 → 登录页
        set({ phase: status.needsSetup ? 'token' : 'login', user: null, isAdmin: false })
        return
      }
      set({ phase: 'login', error: (err as Error).message })
    }
  },

  async login(username, password) {
    set({ error: null })
    const res = await apiPost<{ user: AuthUserInfo; mustChangePassword: boolean }>('/api/auth/login', {
      username,
      password,
    })
    if (res.mustChangePassword) {
      set({ phase: 'force-password', user: res.user, isAdmin: res.user.role === 'admin' })
      return
    }
    reload()
  },

  async setup(username, password, displayName) {
    set({ error: null })
    await apiPost('/api/auth/setup', { username, password, displayName: displayName?.trim() || undefined })
    reload()
  },

  async logout() {
    try {
      await apiPost('/api/auth/logout')
    } catch {
      // 登出失败（会话已失效等）也回到登录页
    }
    reload()
  },

  async changePassword(currentPassword, newPassword) {
    await apiPost('/api/auth/password', { currentPassword, newPassword })
    reload()
  },

  handleUnauthorized() {
    if (get().phase !== 'ready') return
    set({ phase: 'login', user: null, isAdmin: false, error: '登录已失效，请重新登录' })
  },

  openSetup() {
    // 仅在尚无账号时可用（服务端 setup 会再校验一次）
    set({ phase: 'setup', error: null })
  },

  setError: (message) => set({ error: message }),

  applyProfile: (patch) => {
    const current = get().user
    if (!current) return
    set({ user: { ...current, ...patch } })
  },
}))

// 注册全局 401 处理（lib/api.ts 在任意请求 401 时回调；登录/首启等公开接口的 401 由页面自行处理）
setUnauthorizedHandler(() => useAuthStore.getState().handleUnauthorized())

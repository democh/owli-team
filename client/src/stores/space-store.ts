/**
 * 空间（Space）store：工作生活一体的一级信息架构（docs/work-life-fusion-design.md）。
 *
 * - `currentId` 持久化于 localStorage（跨重启保留所选空间；服务端空间被删除时回退 default）；
 * - 会话过滤为纯前端行为：Session.spaceId 缺省 = default（我的空间），与存量零差异；
 * - 新建会话经 CreateSessionDialog 读取当前空间随行提交（createSession 的 spaceId 参数）。
 */
import { create } from 'zustand'
import type { Space } from '@multi-agent/shared'
import { DEFAULT_SPACE_ID } from '@multi-agent/shared'
import { apiDelete, apiGet, apiPost } from '../lib/api'

const STORAGE_KEY = 'owli.currentSpace'

function readStored(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || DEFAULT_SPACE_ID
  } catch {
    return DEFAULT_SPACE_ID
  }
}

export interface SpaceState {
  spaces: Space[]
  /** 当前选中空间（默认 default = 我的空间） */
  currentId: string
  loaded: boolean
  loadSpaces: () => Promise<void>
  setCurrent: (id: string) => void
  createSpace: (name: string, kind?: Space['kind'], icon?: string) => Promise<Space>
  removeSpace: (id: string) => Promise<{ sessionsDetached: number }>
}

export const useSpaceStore = create<SpaceState>((set, get) => ({
  spaces: [],
  currentId: readStored(),
  loaded: false,

  loadSpaces: async () => {
    try {
      const res = await apiGet<{ spaces: Space[] }>('/api/spaces')
      const ids = new Set(res.spaces.map((s) => s.id))
      // 所选空间已不存在（被删除）→ 回退我的空间
      const currentId = ids.has(get().currentId) ? get().currentId : DEFAULT_SPACE_ID
      set({ spaces: res.spaces, currentId, loaded: true })
    } catch {
      // /spaces 未装配（旧服务端 / 测试桩）→ 保持空列表，UI 隐藏切换器
      set({ loaded: true })
    }
  },

  setCurrent: (id) => {
    set({ currentId: id })
    try {
      localStorage.setItem(STORAGE_KEY, id)
    } catch {
      /* 隐私模式等场景静默 */
    }
  },

  createSpace: async (name, kind, icon) => {
    const res = await apiPost<{ space: Space }>('/api/spaces', { name, kind, icon })
    set((s) => ({ spaces: [...s.spaces, res.space].sort((a, b) => a.sort - b.sort) }))
    return res.space
  },

  removeSpace: async (id) => {
    const res = await apiDelete<{ ok: boolean; sessionsDetached: number }>(`/api/spaces/${id}`)
    set((s) => ({
      spaces: s.spaces.filter((x) => x.id !== id),
      currentId: s.currentId === id ? DEFAULT_SPACE_ID : s.currentId,
    }))
    return { sessionsDetached: res.sessionsDetached }
  },
}))

/** 会话归属空间 id（缺省 = 我的空间） */
export function spaceIdOf(session: { spaceId?: string }): string {
  return session.spaceId ?? DEFAULT_SPACE_ID
}

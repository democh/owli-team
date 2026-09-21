/**
 * M79-C：好友 store（客户端；设计 §14.2）。
 *
 * - 数据源：GET /friends（好友 + 在线态）+ GET /friends/requests（收发请求）；
 * - WS 归约：notify:friends-changed → load() 重拉；notify:presence → applyPresence 就地更新在线点；
 * - 写操作透传服务端文案（404 / 403 / 429 等），成功后统一重拉（列表小体量，简单可靠）。
 */
import { create } from 'zustand'
import type { FriendEntry, FriendRequest, UserSearchHit } from '@multi-agent/shared'
import { apiDelete, apiGet, apiPost } from '../lib/api'

interface FriendsState {
  friends: FriendEntry[]
  incoming: FriendRequest[]
  outgoing: FriendRequest[]
  /** 联系人页签角标（待处理 incoming 数） */
  pendingCount: number
  loading: boolean
  error?: string
  load: () => Promise<void>
  search: (q: string) => Promise<UserSearchHit[]>
  request: (input: { userId?: string; username?: string; message?: string }) => Promise<void>
  accept: (id: string) => Promise<void>
  reject: (id: string) => Promise<void>
  remove: (userId: string) => Promise<void>
  block: (userId: string) => Promise<void>
  unblock: (userId: string) => Promise<void>
  /** notify:presence 归约（好友面在线点就地更新） */
  applyPresence: (events: Array<{ userId: string; online: boolean; lastSeenAt?: string }>) => void
  reset: () => void
}

export const useFriendsStore = create<FriendsState>((set, get) => ({
  friends: [],
  incoming: [],
  outgoing: [],
  pendingCount: 0,
  loading: false,

  load: async () => {
    set({ loading: get().friends.length === 0 && get().incoming.length === 0 })
    try {
      const [friends, requests] = await Promise.all([
        apiGet<{ friends: FriendEntry[] }>('/api/friends'),
        apiGet<{ incoming: FriendRequest[]; outgoing: FriendRequest[] }>('/api/friends/requests'),
      ])
      set({
        friends: friends.friends,
        incoming: requests.incoming,
        outgoing: requests.outgoing,
        pendingCount: requests.incoming.length,
        loading: false,
        error: undefined,
      })
    } catch (err) {
      set({ loading: false, error: (err as Error).message })
    }
  },

  search: async (q) => {
    const res = await apiGet<{ users: UserSearchHit[] }>(`/api/users/search?q=${encodeURIComponent(q)}`)
    return res.users
  },

  request: async (input) => {
    await apiPost('/api/friends/requests', input)
    await get().load()
  },
  accept: async (id) => {
    await apiPost(`/api/friends/requests/${id}/accept`)
    await get().load()
  },
  reject: async (id) => {
    await apiPost(`/api/friends/requests/${id}/reject`)
    await get().load()
  },
  remove: async (userId) => {
    await apiDelete(`/api/friends/${userId}`)
    await get().load()
  },
  block: async (userId) => {
    await apiPost(`/api/friends/${userId}/block`)
    await get().load()
  },
  unblock: async (userId) => {
    await apiPost(`/api/friends/${userId}/unblock`)
    await get().load()
  },

  applyPresence: (events) => {
    if (events.length === 0) return
    const map = new Map(events.map((e) => [e.userId, e]))
    set((s) => ({
      friends: s.friends.map((f) => {
        const hit = map.get(f.userId)
        if (!hit) return f
        return { ...f, online: hit.online, ...(hit.lastSeenAt ? { lastSeenAt: hit.lastSeenAt } : {}) }
      }),
    }))
  },

  reset: () =>
    set({ friends: [], incoming: [], outgoing: [], pendingCount: 0, loading: false, error: undefined }),
}))

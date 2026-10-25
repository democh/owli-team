/**
 * M79-A：收件箱 store（客户端；设计 §9.3 三层投递的消费端）。
 *
 * - 权威层 = 服务端 user_inbox 表；本 store 是视图缓存（联系请求 / 邀请 / 提及 / 持球）；
 * - WS `notify:inbox` 实时 ingest（幂等 by id；seq 缺口检测 → REST 补齐）；
 * - `sync()` = REST 增量（since 游标；init / resync / 缺口时调用）；
 * - `ackAll()` = 整段已读（打开联系人 / 请求面板时；本地即时 + 服务端 upTo）。
 */
import { create } from 'zustand'
import type { InboxItem } from '@multi-agent/shared'
import { apiGet, apiPost } from '../lib/api'

interface InboxState {
  items: InboxItem[]
  /** 已接收游标（seq 水位；REST 增量依据） */
  cursor: number
  unreadCount: number
  loading: boolean
  error?: string
  /** REST 增量对齐（init / resync / 缺口补齐） */
  sync: () => Promise<void>
  /** WS 实时入箱（幂等 + 缺口检测） */
  ingest: (item: InboxItem) => void
  /** 整段已读（本地即时 + 服务端 upTo） */
  ackAll: () => Promise<void>
  /** M79-I：单项 / 多项已读（通知中心点击；本地即时 + 服务端 ids） */
  ack: (ids: string[]) => Promise<void>
  reset: () => void
}

/** 视图缓存上限（防长会话内存膨胀；更早的条目按需重新从服务端拉取） */
const MAX_ITEMS = 200
let syncing = false
let syncAgain = false
let generation = 0

export const useInboxStore = create<InboxState>((set, get) => ({
  items: [],
  cursor: 0,
  unreadCount: 0,
  loading: false,

  sync: async () => {
    if (syncing) { syncAgain = true; return }
    syncing = true
    const token = generation
    set({ loading: get().items.length === 0 })
    try {
      let more = false
      do {
        syncAgain = false
        const since = get().cursor
        const res = await apiGet<{ items: InboxItem[]; cursor: number; nextCursor?: number; hasMore?: boolean; unreadCount: number }>(
          `/api/inbox?since=${since}&limit=200`,
        )
        if (token !== generation) return
        // 兼容旧服务端也只推进至真正收到的条目，不能采用全局最大游标。
        const received = res.items.reduce((max, item) => Math.max(max, item.seq), since)
        const next = Math.max(since, Math.min(res.nextCursor ?? received, received))
        more = (res.hasMore ?? res.items.length === 200) && next > since
        set((state) => {
          const merged = new Map(state.items.map((i) => [i.id, i]))
          for (const item of res.items) merged.set(item.id, item)
          return {
            items: [...merged.values()].sort((a, b) => a.seq - b.seq).slice(-MAX_ITEMS),
            cursor: Math.max(state.cursor, next),
            unreadCount: res.unreadCount,
            loading: false,
            error: undefined,
          }
        })
      } while (more || syncAgain)
    } catch (err) {
      if (token === generation) set({ loading: false, error: (err as Error).message })
    } finally {
      if (token === generation) syncing = false
    }
  },

  ingest: (item) => {
    const state = get()
    if (state.items.some((i) => i.id === item.id)) return // 幂等（WS 补发 / 轮询交叉）
    // 缺口检测：seq 跳跃（含首帧 cursor=0 且 seq>1）→ REST 补齐（不吞事件）
    if (syncing || (state.cursor === 0 ? item.seq > 1 : item.seq > state.cursor + 1)) {
      void get().sync()
      return
    }
    set({
      items: [...state.items, item].slice(-MAX_ITEMS),
      cursor: Math.max(state.cursor, item.seq),
      unreadCount: state.unreadCount + (item.readAt ? 0 : 1),
    })
  },

  ackAll: async () => {
    const { cursor } = get()
    if (cursor <= 0) return
    const ts = new Date().toISOString()
    set((s) => ({
      unreadCount: 0,
      items: s.items.map((i) => (i.readAt ? i : { ...i, readAt: ts })),
    }))
    await apiPost('/api/inbox/read', { upTo: cursor }).catch(() => undefined)
  },

  ack: async (ids) => {
    if (ids.length === 0) return
    const ts = new Date().toISOString()
    set((s) => {
      const target = new Set(ids)
      let cleared = 0
      const items = s.items.map((i) => {
        if (!target.has(i.id) || i.readAt) return i
        cleared += 1
        return { ...i, readAt: ts }
      })
      return { items, unreadCount: Math.max(0, s.unreadCount - cleared) }
    })
    await apiPost('/api/inbox/read', { ids }).catch(() => undefined)
  },

  reset: () => {
    generation++
    syncing = false
    syncAgain = false
    set({ items: [], cursor: 0, unreadCount: 0, loading: false, error: undefined })
  },
}))

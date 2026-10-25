/** IM 待发箱：按账号、逐条持久化；重试始终复用提交标识，不把网络失败退回输入框。 */
import { create } from 'zustand'
import { toast } from 'sonner'
import type { ChatMessage, MessageAttachment, TurnMode } from '@multi-agent/shared'
import { ApiError, apiPost } from '../lib/api'
import { useAuthStore } from './auth-store'
import { useSessionStore } from './session-store'

export interface MessageSendResult {
  message: ChatMessage
  runId?: string
  queue?: string[]
  queued?: boolean
  injected?: boolean
  position?: number
  deduplicated?: boolean
  dispatchError?: string
}

export interface PendingMessage {
  id: string
  ownerId: string
  sessionId: string
  content: string
  mode?: TurnMode
  attachments?: MessageAttachment[]
  replyToMessageId?: string
  createdAt: string
  status: 'queued' | 'sending' | 'failed'
  error?: string
}

interface OutboxState {
  ownerId?: string
  items: PendingMessage[]
  restore: () => void
  enqueue: (
    sessionId: string,
    content: string,
    mode?: TurnMode,
    attachments?: MessageAttachment[],
    replyToMessageId?: string,
  ) => void
  flush: (sessionId: string) => Promise<void>
  retry: (id: string) => void
  discard: (id: string) => void
  acknowledge: (message: ChatMessage) => void
}

const ownerOf = (): string => useAuthStore.getState().user?.id ?? ''
const prefixOf = (owner: string): string => `ma:outbox:${encodeURIComponent(owner || 'local')}:`
const keyOf = (item: PendingMessage): string => `${prefixOf(item.ownerId)}${item.id}`
const draining = new Set<string>()
/** 已确认但磁盘删除失败的条目：本次会话内不再恢复，避免幽灵待发。 */
const confirmed = new Set<string>()
let delivered: ((result: MessageSendResult, sessionId: string, selectionVersion: number) => void) | undefined

export function setMessageDeliveryHandler(handler: typeof delivered): void {
  delivered = handler
}

function save(item: PendingMessage): void {
  try {
    localStorage.setItem(keyOf(item), JSON.stringify(item))
  } catch {
    throw new Error('无法保存待发送消息，请检查浏览器存储空间；输入内容已保留')
  }
}

export const useOutboxStore = create<OutboxState>((set, get) => ({
  items: [],
  restore: () => {
    const ownerId = ownerOf()
    const prefix = prefixOf(ownerId)
    const items: PendingMessage[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key?.startsWith(prefix)) continue
      try {
        const item = JSON.parse(localStorage.getItem(key) ?? '') as PendingMessage
        if (confirmed.has(item.id)) continue
        if (
          item.ownerId !== ownerId ||
          keyOf(item) !== key ||
          typeof item.sessionId !== 'string' ||
          typeof item.content !== 'string'
        )
          continue
        if (!['queued', 'sending', 'failed'].includes(item.status)) continue
        // 崩溃/刷新后的在途请求结果未知，用户确认后幂等重试，不自动重复唤起 AI。
        items.push(
          item.status === 'sending'
            ? { ...item, status: 'failed', error: '发送结果待确认，请点击重试' }
            : item,
        )
      } catch {
        /* 损坏条目保留原盘，不影响其他待发消息恢复。 */
      }
    }
    // 同在途请求可能仍由本页掌握：只在目标账号未变时保留内存中的 sending，避免重复提交。
    const memory = get().ownerId === ownerId ? get().items : []
    const merged = new Map(items.map((item) => [item.id, item]))
    for (const item of memory) {
      if (item.ownerId !== ownerId) continue
      if (item.status === 'sending' || !merged.has(item.id)) merged.set(item.id, item)
    }
    set({ ownerId, items: [...merged.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)) })
  },

  enqueue: (sessionId, content, mode, attachments, replyToMessageId) => {
    if (!content.trim() && !attachments?.length) throw new Error('消息内容或附件至少提供一个')
    if (content.length > 20_000) throw new Error('消息过长（上限 20000 字符）')
    if (attachments && attachments.length > 10) throw new Error('单条消息最多 10 个附件')
    if (get().ownerId !== ownerOf()) get().restore()
    if (get().items.length >= 100) throw new Error('待发送消息已达 100 条，请先处理失败消息')
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    const item: PendingMessage = {
      id: [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(''),
      ownerId: ownerOf(),
      sessionId,
      content,
      mode,
      attachments,
      replyToMessageId,
      createdAt: new Date().toISOString(),
      status: 'queued',
    }
    save(item)
    set((s) => ({ items: [...s.items, item] }))
    if (navigator.onLine === false) toast.info('当前离线：消息已存入待发箱，联网后自动发送')
    void get().flush(sessionId)
  },

  flush: async (sessionId) => {
    const owner = ownerOf()
    const lane = JSON.stringify([owner, sessionId])
    if (draining.has(lane) || navigator.onLine === false) return
    draining.add(lane)
    try {
      while (owner === ownerOf()) {
        const item = get().items.find((m) => m.ownerId === owner && m.sessionId === sessionId)
        // 同会话保序：前一条失败时，后续消息等待确认；其他会话不受影响。
        if (!item || item.status !== 'queued') break
        try {
          const sending: PendingMessage = { ...item, status: 'sending', error: undefined }
          save(sending)
          set((s) => ({ items: s.items.map((m) => (m.id === item.id ? sending : m)) }))
          const selectionVersion = useSessionStore.getState().selectionVersion
          const result = await apiPost<MessageSendResult>(
            `/api/sessions/${sessionId}/messages`,
            {
              content: item.content,
              clientMessageId: item.id,
              ...(item.mode ? { mode: item.mode } : {}),
              ...(item.attachments?.length ? { attachments: item.attachments } : {}),
              ...(item.replyToMessageId ? { replyToMessageId: item.replyToMessageId } : {}),
            },
            { timeoutMs: 20_000 },
          )
          if (owner !== ownerOf()) break
          if (!result.message?.id || result.message.sessionId !== sessionId)
            throw new Error('发送响应无效，请重试确认')
          get().acknowledge({ ...result.message, clientMessageId: item.id })
          useSessionStore.getState().upsertMessage(result.message)
          useSessionStore.getState().noteIncoming(sessionId, result.message)
          if (result.dispatchError) toast.info(`消息已发送，AI 未完成启动：${result.dispatchError}`)
          // 消息确认与运行挂接解耦：UI/SSE 出错不能把已发送消息退回失败态。
          try {
            delivered?.(result, sessionId, selectionVersion)
          } catch {
            toast.info('消息已发送，可重新打开会话查看 AI 运行状态')
          }
        } catch (err) {
          if (owner !== ownerOf()) break
          if (!get().items.some((m) => m.id === item.id)) continue // WS 已先确认
          const status = err instanceof ApiError ? err.status : 0
          // 会话不存在 / 消息已删：继续重试只会永久堵住同会话后续消息。
          if (status === 404 || status === 409 || status === 410) {
            confirmed.add(item.id)
            try {
              localStorage.removeItem(keyOf(item))
            } catch {
              /* 已内存确认，不阻断队列。 */
            }
            set((s) => ({ items: s.items.filter((m) => m.id !== item.id) }))
            toast.info(
              status === 410 ? '该消息此前已发送并被删除，无需重试' : '待发送目标已失效，已移出待发箱',
            )
            continue
          }
          const failed: PendingMessage = {
            ...item,
            status: 'failed',
            error: (err as Error).message || '网络异常，请重试确认',
          }
          try {
            save(failed)
          } catch {
            /* 原待发内容仍在磁盘；保留内存错误供用户处理。 */
          }
          set((s) => ({ items: s.items.map((m) => (m.id === item.id ? failed : m)) }))
          toast.error(`消息发送失败，已保留在待发箱：${failed.error}`)
          break
        }
      }
    } finally {
      draining.delete(lane)
    }
  },

  retry: (id) => {
    const item = get().items.find((m) => m.id === id && m.ownerId === ownerOf())
    if (!item || item.status === 'sending') return
    const next: PendingMessage = { ...item, status: 'queued', error: undefined }
    save(next)
    set((s) => ({ items: s.items.map((m) => (m.id === id ? next : m)) }))
    void get().flush(item.sessionId)
  },

  discard: (id) => {
    const item = get().items.find((m) => m.id === id && m.ownerId === ownerOf())
    if (!item || item.status === 'sending') return
    confirmed.add(id)
    localStorage.removeItem(keyOf(item))
    set((s) => ({ items: s.items.filter((m) => m.id !== id) }))
    void get().flush(item.sessionId)
  },

  acknowledge: (message) => {
    // 单用户兼容模式消息无 userId；本地同会话同提交标识即足够确认归属。
    if (!message.clientMessageId) return
    const item = get().items.find(
      (m) => m.id === message.clientMessageId && m.ownerId === ownerOf() && m.sessionId === message.sessionId,
    )
    if (!item) return
    confirmed.add(item.id)
    try {
      localStorage.removeItem(keyOf(item))
    } catch {
      /* 下次恢复仍可幂等确认。 */
    }
    set((s) => ({ items: s.items.filter((m) => m.id !== item.id) }))
  },
}))

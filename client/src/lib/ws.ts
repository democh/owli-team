/**
 * WebSocket 通知客户端（§18.5）：
 * - 指数退避重连（1s → 2s → … → 30s 无限重试）；
 * - 心跳应答（服务端 ping → 客户端 pong）；
 * - 断线期间暂存待发订阅，重连后带 since 游标补发。
 */
import type { NotifyEnvelope } from '@multi-agent/shared'

export type WsStatus = 'connecting' | 'open' | 'closed'

export interface WsClientHandlers {
  onStatus: (status: WsStatus) => void
  onNotify: (envelope: NotifyEnvelope) => void
  /** 重连成功后返回「每会话游标」，用于补发 */
  getCursors: () => Record<string, number>
  getSubscriptions: () => string[]
}

const BACKOFF_BASE = 1000
const BACKOFF_MAX = 30_000

export class NotifySocket {
  private socket?: WebSocket
  private retries = 0
  private timer?: ReturnType<typeof setTimeout>
  private closedByUser = false

  constructor(private readonly handlers: WsClientHandlers) {}

  connect(): void {
    this.closedByUser = false
    this.open()
  }

  close(): void {
    this.closedByUser = true
    if (this.timer) clearTimeout(this.timer)
    this.socket?.close()
    this.socket = undefined
  }

  /** M8：手动重连（断线提示条的「重连」按钮）——重置退避立即发起连接 */
  reconnect(): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) return
    if (this.timer) clearTimeout(this.timer)
    this.retries = 0
    this.closedByUser = false
    this.open()
  }

  /** 增量订阅（断线时暂存，重连自动带上） */
  subscribe(sessionIds: string[]): void {
    this.send({ type: 'subscribe', sessionIds, cursors: this.handlers.getCursors() })
  }

  unsubscribe(sessionIds: string[]): void {
    this.send({ type: 'unsubscribe', sessionIds })
  }

  private open(): void {
    if (typeof WebSocket === 'undefined') return
    this.handlers.onStatus('connecting')
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const url = `${scheme}://${window.location.host}/ws`
    let socket: WebSocket
    try {
      socket = new WebSocket(url)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.socket = socket

    socket.onopen = () => {
      this.retries = 0
      this.handlers.onStatus('open')
      // 重连恢复：重新订阅全部会话并携带 since 游标
      const subs = this.handlers.getSubscriptions()
      if (subs.length > 0) this.subscribe(subs)
    }

    socket.onmessage = (raw) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(String(raw.data)) as Record<string, unknown>
      } catch {
        return
      }
      const type = String(msg.type ?? '')
      if (type === 'ping') {
        this.send({ type: 'pong' })
        return
      }
      if (type === 'pong' || type === 'welcome' || type === 'subscribed' || type === 'ack-ok') return
      if (type.startsWith('notify:')) {
        this.handlers.onNotify(msg as unknown as NotifyEnvelope)
      }
    }

    socket.onclose = () => {
      this.handlers.onStatus('closed')
      if (!this.closedByUser) this.scheduleReconnect()
    }

    socket.onerror = () => {
      socket.close()
    }
  }

  private scheduleReconnect(): void {
    const delay = Math.min(BACKOFF_MAX, BACKOFF_BASE * 2 ** this.retries)
    this.retries++
    this.timer = setTimeout(() => this.open(), delay)
  }

  private send(data: Record<string, unknown>): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(data))
    }
  }
}

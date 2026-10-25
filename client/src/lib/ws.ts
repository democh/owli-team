/**
 * WebSocket 通知客户端（§18.5 + M79-A 稳定化）：
 * - 指数退避重连（1s → 2s → … → 30s 无限重试）+ 向下抖动（0.8–1.0×；多端错峰，防重连风暴）；
 * - 心跳应答（服务端 ping → 客户端 pong）；客户端侧 60s 无帧主动探活（应对半开连接）；
 *   M79-AC：探活闭环——无应答 ≥2× 阈值判定半开 → 强制关闭走常规重连（此前假 OPEN 永久挂起，只能刷新）；
 * - 断线期间暂存待发订阅，重连后带 since 游标补发；
 * - M79-A：`resync`（背压断开前通知 → 上层走 REST 补齐）/ `error`（conn_evicted / acl-changed 策略事件）；
 *   已读上报（`read`）与收件箱整段已读（`inbox-ack`）；前台恢复立即重连（绕过退避）。
 */
import type { NotifyEnvelope } from '@multi-agent/shared'

export type WsStatus = 'connecting' | 'open' | 'closed'

export interface WsClientHandlers {
  onStatus: (status: WsStatus) => void
  onNotify: (envelope: NotifyEnvelope) => void
  onEpoch?: (epoch: string) => void
  /** 重连成功后返回「每会话游标」，用于补发 */
  getCursors: () => Record<string, number>
  getSubscriptions: () => string[]
  /** M79-A：服务端要求静默补齐（resync：背压等原因主动断开前通知；上层应拉 REST 快照） */
  onResync?: (reason: string) => void
  /** M79-A：连接级策略事件（conn_evicted = 连接被新连接替代；acl-changed = 权限变更） */
  onPolicyError?: (code: string, message: string, sessionId?: string) => void
}

const BACKOFF_BASE = 1000
const BACKOFF_MAX = 30_000
/** M79-A：无帧探活阈值（ms）与检查周期（ms） */
const PROBE_IDLE_MS = 60_000
const PROBE_INTERVAL_MS = 30_000

export class NotifySocket {
  private socket?: WebSocket
  private retries = 0
  private timer?: ReturnType<typeof setTimeout>
  private closedByUser = false
  private probeTimer?: ReturnType<typeof setInterval>
  private lastFrameAt = 0
  /** M79-AC：半开关闭的兜底定时器（关闭握手挂起时直接弃用连接重连） */
  private closeFallbackTimer?: ReturnType<typeof setTimeout>

  constructor(private readonly handlers: WsClientHandlers) {}

  connect(): void {
    this.closedByUser = false
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibility)
    if (!this.probeTimer) this.probeTimer = setInterval(() => this.probe(), PROBE_INTERVAL_MS)
    this.open()
  }

  close(): void {
    this.closedByUser = true
    if (this.timer) clearTimeout(this.timer)
    if (this.closeFallbackTimer) clearTimeout(this.closeFallbackTimer)
    if (this.probeTimer) {
      clearInterval(this.probeTimer)
      this.probeTimer = undefined
    }
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility)
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

  /** M79-A：会话已读上报（服务端落库 + 多端广播；断线时静默丢弃——REST 兜底由上层保证） */
  read(sessionId: string, seq: number): void {
    this.send({ type: 'read', sessionId, seq })
  }

  /** M79-A：收件箱整段已读（打开联系人 / 请求面板时） */
  inboxAck(upTo: number): void {
    this.send({ type: 'inbox-ack', upTo })
  }

  /** IM：正在输入（临时帧；由上层节流，服务端再兜底） */
  typing(sessionId: string): void {
    this.send({ type: 'typing', sessionId })
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
      if (this.socket !== socket) return // M79-AC：旧连接的迟到事件（已被替换/弃用）
      this.retries = 0
      this.lastFrameAt = Date.now()
      this.handlers.onStatus('open')
      // 重连恢复：重新订阅全部会话并携带 since 游标
      const subs = this.handlers.getSubscriptions()
      if (subs.length > 0) this.subscribe(subs)
    }

    socket.onmessage = (raw) => {
      if (this.socket !== socket) return // M79-AC：旧连接的迟到帧
      this.lastFrameAt = Date.now()
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
      if (type === 'welcome') {
        if (typeof msg.epoch === 'string') this.handlers.onEpoch?.(msg.epoch)
        return
      }
      if (type === 'pong' || type === 'subscribed' || type === 'ack-ok') return
      // M79-A：背压断开前通知（上层转 REST 补齐；连接随后由服务端断开，走常规重连）
      if (type === 'resync') {
        this.handlers.onResync?.(String(msg.reason ?? 'unknown'))
        return
      }
      // M79-A：策略错误（不关闭连接的服务端提示；conn_evicted 随后由服务端 terminate）
      if (type === 'error') {
        this.handlers.onPolicyError?.(
          String(msg.code ?? 'unknown'),
          String(msg.message ?? ''),
          msg.sessionId ? String(msg.sessionId) : undefined,
        )
        return
      }
      if (type.startsWith('notify:')) {
        this.handlers.onNotify(msg as unknown as NotifyEnvelope)
      }
    }

    socket.onclose = () => {
      if (this.socket !== socket) return // M79-AC：旧连接的迟到 close（防双重重连 / 状态错乱）
      this.handlers.onStatus('closed')
      if (!this.closedByUser) this.scheduleReconnect()
    }

    socket.onerror = () => {
      socket.close()
    }
  }

  private scheduleReconnect(): void {
    const base = Math.min(BACKOFF_MAX, BACKOFF_BASE * 2 ** this.retries)
    // M79-A：向下抖动 0.8–1.0×（错峰重连；保持首跳 ≤ 基准，既有退避测试口径不变）
    const delay = Math.round(base * (0.8 + Math.random() * 0.2))
    this.retries++
    this.timer = setTimeout(() => this.open(), delay)
  }

  /** M79-A：无帧探活（半开连接兜底；pong 由 onmessage 刷新计时）
   *  M79-AC：探活闭环——60s 无帧发 ping；持续无应答（≥2× 阈值）判定半开 → 强制关闭触发常规重连。
   *  半开场景（TCP 假死：readyState 仍 OPEN、浏览器收不到 close 事件）此前会永久挂起：
   *  横幅不出现、推送静默丢失、用户只能刷新页面恢复。 */
  private probe(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return
    const idle = Date.now() - this.lastFrameAt
    if (idle > PROBE_IDLE_MS * 2) {
      const stale = this.socket
      stale.close()
      // 半开的关闭握手可能长期挂起——兜底：8s 后仍未 CLOSED 则弃用该连接直接重连
      if (this.closeFallbackTimer) clearTimeout(this.closeFallbackTimer)
      this.closeFallbackTimer = setTimeout(() => {
        this.closeFallbackTimer = undefined
        if (this.socket === stale && stale.readyState !== WebSocket.CLOSED) {
          this.socket = undefined
          this.scheduleReconnect()
        }
      }, 8000)
      return
    }
    if (idle > PROBE_IDLE_MS) this.send({ type: 'ping' })
  }

  /** M79-A：前台恢复立即重连（后台标签定时器节流后常见 readyState 已断；绕过退避） */
  private readonly onVisibility = (): void => {
    if (typeof document === 'undefined' || document.visibilityState !== 'visible') return
    if (this.closedByUser) return
    if (this.socket && this.socket.readyState === WebSocket.OPEN) return
    if (this.timer) clearTimeout(this.timer)
    this.retries = 0
    this.open()
  }

  private send(data: Record<string, unknown>): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(data))
    }
  }
}

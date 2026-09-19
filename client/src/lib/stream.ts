/**
 * 帧流客户端（M22 · StreamHub `/ws/stream`）：
 * - 一个连接多频道（topic = `browser:<browserSessionId>`），订阅携带流 token（watch 只读 / takeover 可输入）；
 * - 重连退避 1s → 30s；重连后按登记的订阅自动恢复（token 失效由上层刷新后重订）；
 * - 帧节流 / 合并 / 丢帧完全由服务端负责，客户端只做渲染与状态回传。
 */
import type { BrowserState } from '@multi-agent/shared'

export type StreamStatus = 'closed' | 'connecting' | 'open'

export interface StreamFrame {
  seq: number
  /** base64 JPEG */
  data: string
  ts: number
  url?: string
  width?: number
  height?: number
}

export interface StreamStep {
  browserSessionId?: string
  seq: number
  actor: 'agent' | 'human'
  action: string
  args?: Record<string, unknown>
  url?: string
  screenshotPath?: string
  ok: boolean
  durationMs?: number
  detail?: string
  ts: string
}

export interface StreamHandlers {
  onStatus: (status: StreamStatus) => void
  onSubscribed?: (topic: string, mode: 'watch' | 'takeover', maxFps: number) => void
  onFrame: (topic: string, frame: StreamFrame) => void
  onState: (topic: string, state: BrowserState, controller: 'agent' | 'human') => void
  onStep: (topic: string, step: StreamStep) => void
  onSessionClosed: (topic: string, reason: string) => void
  onError: (topic: string | undefined, message: string, code?: string) => void
}

interface Channel {
  token: string
  mode: 'watch' | 'takeover'
}

const BACKOFF_BASE = 1000
const BACKOFF_MAX = 30_000

export class StreamSocket {
  private socket?: WebSocket
  private retries = 0
  private timer?: ReturnType<typeof setTimeout>
  private closedByUser = false
  /** topic → 订阅凭据（重连恢复用；token 由上层保证尽量新鲜） */
  private readonly channels = new Map<string, Channel>()

  constructor(private readonly handlers: StreamHandlers) {}

  connect(): void {
    this.closedByUser = false
    this.open()
  }

  /** 登记并订阅（重复订阅同 topic 时覆盖 token） */
  subscribe(topic: string, token: string, mode: 'watch' | 'takeover', maxFps?: number): void {
    this.channels.set(topic, { token, mode })
    if (maxFps !== undefined) this.setMaxFps(maxFps)
    this.send({ type: 'subscribe', topic, token })
  }

  /** 更新已登记频道的 token（token 换发后重订，如 watch → takeover） */
  resubscribe(topic: string, token: string, mode: 'watch' | 'takeover'): void {
    this.subscribe(topic, token, mode)
  }

  unsubscribe(topic: string): void {
    this.channels.delete(topic)
    this.send({ type: 'unsubscribe', topic })
  }

  /** 人工输入（需 takeover 订阅；服务端会做二次校验） */
  input(topic: string, payload: Record<string, unknown>): void {
    this.send({ type: 'input', topic, payload })
  }

  /** 归还控制权（takeover → watch；服务端同时把控制权交还 Agent） */
  release(topic: string): void {
    const channel = this.channels.get(topic)
    if (channel) channel.mode = 'watch'
    this.send({ type: 'release', topic })
  }

  setMaxFps(fps: number): void {
    this.send({ type: 'config', maxFps: fps })
  }

  topics(): string[] {
    return [...this.channels.keys()]
  }

  /** 仅保留给定 topic 的订阅（会话切换剪枝：过期频道的本地登记与服务端订阅一并清理） */
  keepOnly(topic: string): void {
    for (const t of [...this.channels.keys()]) {
      if (t !== topic) this.unsubscribe(t)
    }
  }

  close(): void {
    this.closedByUser = true
    if (this.timer) clearTimeout(this.timer)
    this.channels.clear()
    this.socket?.close()
    this.socket = undefined
  }

  private open(): void {
    if (typeof WebSocket === 'undefined') return
    this.handlers.onStatus('connecting')
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
    let socket: WebSocket
    try {
      socket = new WebSocket(`${scheme}://${window.location.host}/ws/stream`)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.socket = socket

    socket.onopen = () => {
      this.retries = 0
      this.handlers.onStatus('open')
      for (const [topic, channel] of this.channels) {
        this.send({ type: 'subscribe', topic, token: channel.token })
      }
    }

    socket.onmessage = (raw) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(String(raw.data)) as Record<string, unknown>
      } catch {
        return
      }
      this.dispatch(msg)
    }

    socket.onclose = () => {
      this.handlers.onStatus('closed')
      if (!this.closedByUser) this.scheduleReconnect()
    }

    socket.onerror = () => {
      socket.close()
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    const topic = typeof msg.topic === 'string' ? msg.topic : undefined
    switch (String(msg.type ?? '')) {
      case 'hello':
      case 'pong':
        return
      case 'subscribed': {
        const mode = msg.mode === 'takeover' ? 'takeover' : 'watch'
        if (topic) {
          const channel = this.channels.get(topic)
          if (channel) channel.mode = mode
        }
        this.handlers.onSubscribed?.(topic ?? '', mode, Number(msg.maxFps ?? 0))
        return
      }
      case 'frame': {
        if (!topic) return
        this.handlers.onFrame(topic, {
          seq: Number(msg.seq ?? 0),
          data: String(msg.data ?? ''),
          ts: Number(msg.ts ?? Date.now()),
          url: typeof msg.url === 'string' ? msg.url : undefined,
          width: typeof msg.width === 'number' ? msg.width : undefined,
          height: typeof msg.height === 'number' ? msg.height : undefined,
        })
        return
      }
      case 'state': {
        if (!topic) return
        this.handlers.onState(
          topic,
          String(msg.state ?? 'ready') as BrowserState,
          msg.controller === 'human' ? 'human' : 'agent',
        )
        return
      }
      case 'step': {
        if (!topic || !msg.step) return
        this.handlers.onStep(topic, msg.step as unknown as StreamStep)
        return
      }
      case 'closed': {
        if (topic) this.channels.delete(topic)
        this.handlers.onSessionClosed(topic ?? '', String(msg.reason ?? '已关闭'))
        return
      }
      case 'error': {
        this.handlers.onError(topic, String(msg.message ?? '流错误'), typeof msg.code === 'string' ? msg.code : undefined)
        return
      }
      default:
        return
    }
  }

  private scheduleReconnect(): void {
    const delay = Math.min(BACKOFF_MAX, BACKOFF_BASE * 2 ** this.retries)
    this.retries++
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.open(), delay)
  }

  private send(data: Record<string, unknown>): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(data))
    }
  }
}

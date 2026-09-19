/**
 * CDP 薄客户端（M22）：基于既有 `ws` 依赖的极简 Chrome DevTools Protocol 客户端。
 *
 * 设计要点：
 * - flat session 模式：Target.attachToTarget { flatten: true } 后，所有命令带 sessionId 走同一连接
 *   （避免嵌套 session 的连接翻倍问题）；默认 session 可切换（多标签页跟随：attachToTarget / detachSession）；
 * - 端点归一化：ws(s):// 直连；http(s):// 先经 /json/version 拿 webSocketDebuggerUrl；
 * - 请求超时：每条命令独立计时（默认 15s），超时 reject 并清理 pending；
 * - 事件订阅：on(method, handler) 返回取消函数；handler 第二参为事件所属 sessionId（browser 级事件为 undefined，
 *   页面级事件可用作旧页残留过滤）；
 * - 保活（半开检测）：静默期（无任何入站）发送协议层 ping；再过一周期仍无任何入站（pong / 响应 / 事件）
 *   判定连接已死 → 主动 terminate 并触发 close 事件（交由会话层重连）。覆盖睡眠唤醒、远程端点
 *   NAT 静默丢包这类「TCP 已死但无 FIN」的场景——否则连接会僵尸化，后续命令全部超时。
 */
import { WebSocket } from 'ws'

/** 保活周期（ms）：静默一个周期发 ping；两周期无任何入站判定半开 */
const DEFAULT_KEEPALIVE_MS = 15_000

interface PendingEntry {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
  method: string
}

export interface CdpClientOptions {
  /** 保活周期（ms）；0 = 关闭保活（测试可注入小值） */
  keepaliveMs?: number
}

export interface CdpTargetInfo {
  targetId: string
  type: string
  url: string
  title?: string
  /** 打开该 target 的父 target（window.open / target=_blank / 新标签页的 opener 链） */
  openerId?: string
}

/** 把 http(s)://host:port 或 host:port 归一化为 webSocketDebuggerUrl */
export async function resolveCdpEndpoint(input: string, timeoutMs = 10_000): Promise<string> {
  const raw = input.trim()
  if (!raw) throw new Error('CDP 端点为空')
  if (raw.startsWith('ws://') || raw.startsWith('wss://')) return raw
  const base = /^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`
  const url = new URL(base)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`不支持的端点协议：${url.protocol}（支持 ws/wss/http/https）`)
  }
  const res = await fetch(new URL('/json/version', url).toString(), {
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`CDP 端点探测失败：${url.host} 返回 ${res.status}`)
  const data = (await res.json()) as { webSocketDebuggerUrl?: string }
  if (!data.webSocketDebuggerUrl) throw new Error(`CDP 端点未返回 webSocketDebuggerUrl：${url.host}`)
  return data.webSocketDebuggerUrl
}

export class CdpClient {
  private ws?: WebSocket
  private nextId = 1
  private readonly pending = new Map<number, PendingEntry>()
  private readonly listeners = new Map<string, Set<(params: unknown, sessionId?: string) => void>>()
  private readonly closeListeners = new Set<(reason: string) => void>()
  private sessionId?: string
  private targetId?: string
  private closedByUser = false

  /** 保活状态：最近入站时间（消息 / pong）+ 探测悬挂标记 */
  private readonly keepaliveMs: number
  private keepaliveTimer?: NodeJS.Timeout
  private lastInboundAt = 0
  private pingProbePending = false

  constructor(opts: CdpClientOptions = {}) {
    this.keepaliveMs = opts.keepaliveMs ?? DEFAULT_KEEPALIVE_MS
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  get pageSessionId(): string | undefined {
    return this.sessionId
  }

  /** 当前附加的 page target id（页面跟随判定用） */
  get pageTargetId(): string | undefined {
    return this.targetId
  }

  async connect(wsUrl: string, timeoutMs = 10_000): Promise<void> {
    if (this.ws) throw new Error('CdpClient 已连接（一个实例只连一个端点）')
    const ws = new WebSocket(wsUrl, { handshakeTimeout: timeoutMs, maxPayload: 64 * 1024 * 1024 })
    this.ws = ws
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP 连接超时（${timeoutMs}ms）：${wsUrl}`)), timeoutMs)
      ws.once('open', () => {
        clearTimeout(timer)
        resolve()
      })
      ws.once('error', (err) => {
        clearTimeout(timer)
        reject(new Error(`CDP 连接失败：${err.message}`))
      })
    })
    ws.on('message', (raw) => this.handleMessage(raw.toString()))
    ws.on('pong', () => {
      this.lastInboundAt = Date.now()
      this.pingProbePending = false
    })
    ws.on('close', (code, reason) => {
      this.stopKeepalive()
      const text = reason?.toString() || `code=${code}`
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer)
        entry.reject(new Error(`CDP 连接已关闭（${entry.method} 中断）：${text}`))
      }
      this.pending.clear()
      if (!this.closedByUser) {
        for (const fn of this.closeListeners) {
          try {
            fn(text)
          } catch {
            // 监听器异常不影响其它监听器
          }
        }
      }
    })
    ws.on('error', () => {
      // 连接级错误已由 close 统一收敛；此处仅防未处理异常
    })
    this.lastInboundAt = Date.now()
    this.startKeepalive()
  }

  /** 保活：静默期 ping；ping 后一周期无任何入站 → 判定半开（terminate 触发 close → 会话层重连） */
  private startKeepalive(): void {
    this.stopKeepalive()
    if (this.keepaliveMs <= 0) return
    this.keepaliveTimer = setInterval(() => this.tickKeepalive(), this.keepaliveMs)
    this.keepaliveTimer.unref?.()
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer)
    this.keepaliveTimer = undefined
  }

  private tickKeepalive(): void {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const now = Date.now()
    if (now - this.lastInboundAt < this.keepaliveMs) {
      this.pingProbePending = false // 上一周期有入站：连接健在
      return
    }
    if (this.pingProbePending) {
      // ping 后整整一周期无 pong / 无任何消息：TCP 半开，主动断开（close → onUnexpectedClose）
      try {
        ws.terminate()
      } catch {
        // close 事件兜底
      }
      return
    }
    this.pingProbePending = true
    try {
      ws.ping()
    } catch {
      // 发送失败：close 事件兜底
    }
  }

  private handleMessage(text: string): void {
    this.lastInboundAt = Date.now()
    let msg: {
      id?: number
      method?: string
      params?: unknown
      result?: unknown
      sessionId?: string
      error?: { code: number; message: string }
    }
    try {
      msg = JSON.parse(text) as typeof msg
    } catch {
      return
    }
    if (typeof msg.id === 'number' && (msg.result !== undefined || msg.error !== undefined)) {
      const entry = this.pending.get(msg.id)
      if (!entry) return
      this.pending.delete(msg.id)
      clearTimeout(entry.timer)
      if (msg.error)
        entry.reject(new Error(`CDP ${entry.method} 失败（${msg.error.code}）：${msg.error.message}`))
      else entry.resolve(msg.result)
      return
    }
    if (msg.method) {
      const set = this.listeners.get(msg.method)
      if (!set) return
      for (const fn of set) {
        try {
          fn(msg.params, msg.sessionId)
        } catch {
          // 单个监听器异常不影响其它
        }
      }
    }
  }

  /** 发送命令（默认按当前 page sessionId 路由；sessionId 传 '' 表示走 browser 级） */
  async send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    opts: { sessionId?: string | null; timeoutMs?: number } = {},
  ): Promise<T> {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error(`CDP 未连接：${method}`)
    const id = this.nextId++
    const sessionId = opts.sessionId === null ? undefined : (opts.sessionId ?? this.sessionId)
    const payload: Record<string, unknown> = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    const timeoutMs = opts.timeoutMs ?? 15_000
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} 超时（${timeoutMs}ms）`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
        method,
      })
      try {
        ws.send(JSON.stringify(payload))
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error(`CDP 发送失败（${method}）：${(err as Error).message}`))
      }
    })
  }

  /** 订阅事件（返回取消函数；handler 第二参为事件所属 sessionId） */
  on(method: string, handler: (params: unknown, sessionId?: string) => void): () => void {
    const set = this.listeners.get(method) ?? new Set()
    set.add(handler)
    this.listeners.set(method, set)
    return () => {
      set.delete(handler)
      if (set.size === 0) this.listeners.delete(method)
    }
  }

  /** 连接关闭通知（非用户主动 close） */
  onUnexpectedClose(handler: (reason: string) => void): () => void {
    this.closeListeners.add(handler)
    return () => this.closeListeners.delete(handler)
  }

  /** 发现页面 target 并 flat attach（无 page 时新建 about:blank；preferUrl 命中时优先） */
  async attachToPage(preferUrl?: string): Promise<{ sessionId: string; targetId: string }> {
    const { targetInfos } = await this.send<{ targetInfos: CdpTargetInfo[] }>(
      'Target.getTargets',
      {},
      { sessionId: null },
    )
    const pages = targetInfos.filter((t) => t.type === 'page')
    let target = preferUrl ? pages.find((p) => p.url.includes(preferUrl)) : undefined
    target = target ?? pages[0]
    if (!target) {
      const created = await this.send<{ targetId: string }>(
        'Target.createTarget',
        { url: 'about:blank' },
        { sessionId: null },
      )
      target = { targetId: created.targetId, type: 'page', url: 'about:blank' }
    }
    const { sessionId } = await this.send<{ sessionId: string }>(
      'Target.attachToTarget',
      { targetId: target.targetId, flatten: true },
      { sessionId: null },
    )
    this.sessionId = sessionId
    this.targetId = target.targetId
    return { sessionId, targetId: target.targetId }
  }

  /** 全部 page target（多标签页感知 / 跟随判定；browser 级查询） */
  async getPageTargets(): Promise<CdpTargetInfo[]> {
    const { targetInfos } = await this.send<{ targetInfos: CdpTargetInfo[] }>(
      'Target.getTargets',
      {},
      { sessionId: null },
    )
    return targetInfos.filter((info) => info.type === 'page')
  }

  /** 附加到指定页面 target（页面跟随切换用；调用方负责先处理旧 session） */
  async attachToTarget(targetId: string): Promise<string> {
    const { sessionId } = await this.send<{ sessionId: string }>(
      'Target.attachToTarget',
      { targetId, flatten: true },
      { sessionId: null },
    )
    this.sessionId = sessionId
    this.targetId = targetId
    return sessionId
  }

  /** detach 指定 session（该页面停止事件投递；页面本身不关闭） */
  async detachSession(sessionId: string): Promise<void> {
    await this.send('Target.detachFromTarget', { sessionId }, { sessionId: null, timeoutMs: 5_000 })
    if (this.sessionId === sessionId) {
      this.sessionId = undefined
      this.targetId = undefined
    }
  }

  /** 关闭与 detach（suppressClose 时不触发 onUnexpectedClose） */
  async close(): Promise<void> {
    this.closedByUser = true
    this.stopKeepalive()
    const ws = this.ws
    this.ws = undefined
    if (!ws) return
    try {
      if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'client close')
      else ws.terminate()
    } catch {
      // 忽略
    }
  }
}

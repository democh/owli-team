/**
 * StreamHub（M22）：单连接多频道实时流（浏览器帧 / 状态 / 步骤 + 人工输入通道）。
 *
 * 路径：/ws/stream（noServer 模式，与通知通道 /ws 并存、互不干扰）
 *
 * 协议 v1：
 *   client → server：
 *     { type:'subscribe', topic, token }        订阅（token 经 StreamTokenService 校验，mode 从 token 得出）
 *     { type:'unsubscribe', topic }
 *     { type:'config', topic?, maxFps }         调整本连接帧率（上限 = 服务端 browserFrameMaxFps）
 *     { type:'input', topic, payload }          人工输入（需 takeover 权限；自动懒接管）
 *     { type:'release', topic }                 归还控制权给 Agent
 *     { type:'ping' }
 *   server → client：
 *     { type:'hello', clientId }
 *     { type:'subscribed', topic, mode, maxFps }
 *     { type:'frame', topic, seq, data, ts, url }       （节流 + 丢帧计数）
 *     { type:'state', topic, state, controller }
 *     { type:'step', topic, step }
 *     { type:'closed', topic, reason }
 *     { type:'error', topic?, message, code? }          （takeover_moved：同用户接管流转，旧视图降级观察）
 *     { type:'pong' }
 *
 * 帧交付（对标 agent-browser 生产实践）：
 * - 订阅即回放 lastFrame（覆盖槽最新帧，立即出画）；
 * - per-client token bucket（maxFps，默认 12）+ pending 合并槽（慢客户端看最新帧，不排队）；
 * - socket.bufferedAmount > 2MB 时直接丢帧（连拥塞的链路不喂数据）；
 * - 帧通道与输入通道共用连接但互不阻塞（input 直接 dispatch，不过 pacing）。
 */
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, Server as HttpServer } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import type { AppConfig } from './config.js'
import { getLogger } from './logger.js'
import { AUTH_COOKIE, parseCookie, resolveUserFromHeaders, safeEqual } from './middleware.js'
import type { AuthService } from './auth/service.js'
import type { BrowserRuntime } from './browser/runtime.js'
import type { HumanInput } from './browser/session.js'
import type { StreamTokenService } from './browser/stream-token.js'

interface SubState {
  topic: string
  mode: 'watch' | 'takeover'
  lastSentAt: number
  /** 帧合并槽：节流窗口内的最新帧 */
  pendingFrame?: Record<string, unknown>
  flushTimer?: NodeJS.Timeout
  droppedFrames: number
}

interface Client {
  id: string
  socket: WebSocket
  alive: boolean
  maxFps: number
  subs: Map<string, SubState>
  /** M57：连接用户（流 token 绑定比对） */
  userId?: string
}

interface ClientMessage {
  type?: string
  topic?: string
  token?: string
  maxFps?: number
  payload?: HumanInput & { type?: string }
}

/** 单帧触发的连接缓冲上限（超出直接丢帧） */
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024

export class StreamHub {
  private wss?: WebSocketServer
  private readonly clients = new Map<string, Client>()
  /** topic → 当前 takeover 持有者 clientId（同一频道同一时间仅一个输入源） */
  private readonly takeoverHolders = new Map<string, string>()
  private heartbeatTimer?: NodeJS.Timeout

  constructor(
    private readonly cfg: AppConfig,
    private readonly runtime: BrowserRuntime,
    private readonly tokens: StreamTokenService,
    /** M57：认证依赖（惰性读取；缺省 = 旧语义（仅 token 校验，测试兼容）） */
    private readonly getAuthDeps?: () => { auth: AuthService },
  ) {}

  attach(server: HttpServer): void {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 })
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname !== '/ws/stream') return // 其他升级请求交由其它监听器处理
      const verdict = this.authorize(req, url)
      if (!verdict.ok) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      this.wss?.handleUpgrade(req, socket, head, (ws) => {
        this.wss?.emit('connection', ws, req, verdict.userId)
      })
    })
    this.wss.on('connection', (socket: WebSocket, _req: IncomingMessage, userId?: string) =>
      this.onConnection(socket, userId),
    )
    this.heartbeatTimer = setInterval(() => this.tick(), this.cfg.wsHeartbeatMs)
    this.heartbeatTimer.unref?.()
  }

  /**
   * 握手鉴权（M57）：已注入认证依赖时解析登录态；未注入时沿用 AUTH_TOKEN 校验（测试兼容）。
   * 用户 id 随连接保存，订阅时与流 token 的绑定用户比对（M57）。
   */
  private authorize(req: IncomingMessage, url: URL): { ok: boolean; userId?: string } {
    const deps = this.getAuthDeps?.()
    if (deps) {
      const user = resolveUserFromHeaders(deps.auth, this.cfg, req.headers, url.searchParams.get('token') ?? '')
      if (user) return { ok: true, userId: user.id }
      if (!deps.auth.multiUser && !this.cfg.authToken) return { ok: true }
      return { ok: false }
    }
    if (!this.cfg.authToken) return { ok: true }
    const header = req.headers.authorization ?? ''
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : ''
    const cookieToken = parseCookie(req.headers.cookie ?? '', AUTH_COOKIE)
    const queryToken = url.searchParams.get('token') ?? ''
    const ok =
      safeEqual(bearer, this.cfg.authToken) ||
      safeEqual(cookieToken, this.cfg.authToken) ||
      safeEqual(queryToken, this.cfg.authToken)
    return { ok }
  }

  private onConnection(socket: WebSocket, userId?: string): void {
    const client: Client = {
      id: `sc_${randomUUID().slice(0, 8)}`,
      socket,
      alive: true,
      maxFps: this.cfg.browserFrameMaxFps,
      subs: new Map(),
      userId,
    }
    this.clients.set(client.id, client)
    this.send(client, { type: 'hello', clientId: client.id, maxFps: client.maxFps })

    socket.on('message', (raw) => {
      void this.handleMessage(client, raw.toString())
    })
    socket.on('pong', () => {
      client.alive = true
    })
    socket.on('close', () => {
      this.dropClient(client)
    })
    socket.on('error', () => {
      this.dropClient(client)
    })
  }

  private dropClient(client: Client): void {
    for (const sub of client.subs.values()) {
      if (sub.flushTimer) clearTimeout(sub.flushTimer)
      if (this.takeoverHolders.get(sub.topic) === client.id) this.takeoverHolders.delete(sub.topic)
    }
    client.subs.clear()
    this.clients.delete(client.id)
  }

  private async handleMessage(client: Client, raw: string): Promise<void> {
    let msg: ClientMessage
    try {
      msg = JSON.parse(raw) as ClientMessage
    } catch {
      this.send(client, { type: 'error', message: '消息不是合法 JSON' })
      return
    }
    switch (msg.type) {
      case 'ping':
        this.send(client, { type: 'pong' })
        return
      case 'subscribe':
        await this.handleSubscribe(client, msg)
        return
      case 'unsubscribe': {
        const topic = msg.topic ?? ''
        const sub = client.subs.get(topic)
        if (sub?.flushTimer) clearTimeout(sub.flushTimer)
        client.subs.delete(topic)
        if (this.takeoverHolders.get(topic) === client.id) this.takeoverHolders.delete(topic)
        return
      }
      case 'config': {
        const fps = Number(msg.maxFps)
        if (Number.isFinite(fps)) {
          client.maxFps = Math.min(Math.max(Math.round(fps), 1), this.cfg.browserFrameMaxFps)
        }
        this.send(client, { type: 'hello', clientId: client.id, maxFps: client.maxFps })
        return
      }
      case 'input':
        await this.handleInput(client, msg)
        return
      case 'release':
        await this.handleRelease(client, msg)
        return
      default:
        this.send(client, { type: 'error', message: `未知消息类型：${msg.type ?? '(空)'}` })
    }
  }

  private async handleSubscribe(client: Client, msg: ClientMessage): Promise<void> {
    const topic = msg.topic ?? ''
    const match = /^browser:([A-Za-z0-9_-]+)$/.exec(topic)
    if (!match) {
      this.send(client, { type: 'error', topic, message: 'topic 格式非法（期望 browser:<id>）' })
      return
    }
    const session = this.runtime.get(match[1]!)
    if (!session || session.isClosed()) {
      this.send(client, { type: 'error', topic, message: '浏览器会话不存在或已关闭', code: 'session_gone' })
      return
    }
    // token 校验：优先 takeover（权限更高），失败再试 watch；M57：与连接用户绑定比对
    let mode: 'watch' | 'takeover' | undefined
    const token = msg.token ?? ''
    if (token) {
      if (this.tokens.verify(token, topic, 'takeover', client.userId).ok) mode = 'takeover'
      else if (this.tokens.verify(token, topic, 'watch', client.userId).ok) mode = 'watch'
    }
    if (!mode) {
      this.send(client, { type: 'error', topic, message: '缺少有效的流 token', code: 'token_invalid' })
      return
    }
    if (mode === 'takeover' && !this.acquireTakeover(topic, client.id)) {
      // M62：同用户接管流转（右栏面板 / 直播窗 / 多标签页常态）：旧客户端降级观察；跨用户保持拒绝
      const holderId = this.takeoverHolders.get(topic)
      const holder = holderId ? this.clients.get(holderId) : undefined
      const sameUser = Boolean(client.userId && holder?.userId && client.userId === holder.userId)
      if (sameUser && holder) {
        const holderSub = holder.subs.get(topic)
        if (holderSub) holderSub.mode = 'watch'
        this.takeoverHolders.set(topic, client.id)
        this.send(holder, {
          type: 'error',
          topic,
          message: '接管已转移到你打开的另一视图（本视图降级为观察）',
          code: 'takeover_moved',
        })
      } else {
        this.send(client, { type: 'error', topic, message: '已有其他客户端接管中', code: 'takeover_busy' })
        return
      }
    }
    const existing = client.subs.get(topic)
    if (existing?.flushTimer) clearTimeout(existing.flushTimer)
    client.subs.set(topic, { topic, mode, lastSentAt: 0, droppedFrames: 0 })
    this.send(client, { type: 'subscribed', topic, mode, maxFps: client.maxFps })
    // 订阅即回放 lastFrame：立即出画（不等下一帧）
    const last = session.getLastFrame()
    if (last) {
      this.send(client, { type: 'frame', topic, seq: last.seq, data: last.data, ts: last.ts, url: last.url })
    }
    if (mode === 'takeover' && session.controller !== 'human') {
      await session.takeover('panel')
    }
    getLogger().debug({ clientId: client.id, topic, mode }, 'StreamHub 订阅建立')
  }

  private acquireTakeover(topic: string, clientId: string): boolean {
    const holder = this.takeoverHolders.get(topic)
    if (holder && holder !== clientId && this.clients.has(holder)) return false
    this.takeoverHolders.set(topic, clientId)
    return true
  }

  private async handleInput(client: Client, msg: ClientMessage): Promise<void> {
    const topic = msg.topic ?? ''
    const sub = client.subs.get(topic)
    if (!sub || sub.mode !== 'takeover') {
      this.send(client, { type: 'error', topic, message: '输入通道需要 takeover 订阅', code: 'input_denied' })
      return
    }
    const match = /^browser:(.+)$/.exec(topic)
    const session = match ? this.runtime.get(match[1]!) : undefined
    if (!session || session.isClosed()) {
      this.send(client, { type: 'error', topic, message: '浏览器会话不存在或已关闭', code: 'session_gone' })
      return
    }
    const raw = msg.payload
    if (!raw || typeof raw !== 'object' || typeof raw.kind !== 'string') {
      this.send(client, { type: 'error', topic, message: '输入 payload 非法' })
      return
    }
    // 懒接管：第一个有效输入即视为接管（面板按钮同样会走 subscribe takeover）
    if (session.controller !== 'human') {
      await session.takeover('input')
    }
    try {
      await session.handleHumanInput(raw as HumanInput)
    } catch (err) {
      this.send(client, { type: 'error', topic, message: (err as Error).message })
    }
  }

  /** 归还控制权（面板「归还」按钮）：takeover 订阅降级为 watch + 会话侧 release */
  private async handleRelease(client: Client, msg: ClientMessage): Promise<void> {
    const topic = msg.topic ?? ''
    const sub = client.subs.get(topic)
    if (!sub) {
      this.send(client, { type: 'error', topic, message: '未订阅该频道' })
      return
    }
    if (sub.mode === 'takeover') {
      sub.mode = 'watch'
      if (this.takeoverHolders.get(topic) === client.id) this.takeoverHolders.delete(topic)
    }
    const match = /^browser:(.+)$/.exec(topic)
    const session = match ? this.runtime.get(match[1]!) : undefined
    if (session && !session.isClosed() && session.controller === 'human') {
      await session.release('panel')
    }
    this.send(client, { type: 'subscribed', topic, mode: sub.mode, maxFps: client.maxFps })
  }

  /** 帧 / 步骤 / 状态发布（runtime → hub） */
  publish(topic: string, message: Record<string, unknown>): void {
    for (const client of this.clients.values()) {
      const sub = client.subs.get(topic)
      if (!sub) continue
      this.deliver(client, sub, message)
    }
  }

  /** M62：频道订阅者计数（浏览器实例空闲回收判定；0 = 无观察者） */
  subscriberCount(topic: string): number {
    let count = 0
    for (const client of this.clients.values()) {
      if (client.subs.has(topic)) count += 1
    }
    return count
  }

  private deliver(client: Client, sub: SubState, message: Record<string, unknown>): void {
    const type = message.type
    if (type === 'frame') {
      this.deliverFrame(client, sub, message)
      return
    }
    this.send(client, { ...message, topic: sub.topic })
  }

  /** 帧节流：token bucket（maxFps）+ 合并槽（pending 只保留最新） */
  private deliverFrame(client: Client, sub: SubState, frame: Record<string, unknown>): void {
    const now = Date.now()
    const interval = 1000 / Math.max(client.maxFps, 1)
    const elapsed = now - sub.lastSentAt
    if (elapsed >= interval) {
      this.sendFrame(client, sub, frame)
      return
    }
    sub.pendingFrame = frame
    if (sub.flushTimer) return
    sub.flushTimer = setTimeout(
      () => {
        sub.flushTimer = undefined
        const pending = sub.pendingFrame
        sub.pendingFrame = undefined
        if (pending) this.sendFrame(client, sub, pending)
      },
      Math.max(interval - elapsed, 4),
    )
    sub.flushTimer.unref?.()
  }

  private sendFrame(client: Client, sub: SubState, frame: Record<string, unknown>): void {
    // 链路拥塞（帧积压超阈值）→ 直接丢帧，不喂数据
    if (client.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      sub.droppedFrames += 1
      if (sub.droppedFrames % 30 === 1) {
        this.send(client, { type: 'error', topic: sub.topic, message: `链路拥塞，已丢弃 ${sub.droppedFrames} 帧`, code: 'frames_dropped' })
      }
      return
    }
    this.send(client, { ...frame, topic: sub.topic })
    sub.lastSentAt = Date.now()
  }

  private send(client: Client, message: Record<string, unknown>): void {
    const socket = client.socket
    if (socket.readyState !== WebSocket.OPEN) return
    try {
      socket.send(JSON.stringify(message))
    } catch {
      // 发送失败（连接正在关闭）：下一轮心跳清理
    }
  }

  private tick(): void {
    for (const client of this.clients.values()) {
      if (!client.alive) {
        client.socket.terminate()
        this.dropClient(client)
        continue
      }
      client.alive = false
      try {
        client.socket.ping()
      } catch {
        // 忽略
      }
    }
  }

  close(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    for (const client of this.clients.values()) {
      for (const sub of client.subs.values()) {
        if (sub.flushTimer) clearTimeout(sub.flushTimer)
      }
      client.socket.terminate()
    }
    this.clients.clear()
    this.takeoverHolders.clear()
    this.wss?.close()
  }
}

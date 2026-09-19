/**
 * WsHub（§18.3）：应用级通知总线。
 * - 连接表 + 30s 心跳（2 周期无响应剔除）；
 * - 订阅表：增量订阅会话通知；
 * - NotificationCenter：每会话环形重放缓冲（WS_REPLAY_BUFFER=200）+ since 游标补发；
 * - 降级：GET /api/notifications?since=… 走同一数据源；
 * - 鉴权（M10）：配置 AUTH_TOKEN 时握手校验 cookie / query token / Bearer，否则 401 拒绝升级。
 */
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, Server as HttpServer } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import type { NotifyEnvelope, NotifyListResponse, NotifyType } from '@multi-agent/shared'
import type { AppConfig } from './config.js'
import type { AccessService } from './auth/access.js'
import type { AuthService, AuthUser } from './auth/service.js'
import { AUTH_COOKIE, parseCookie, resolveUserFromHeaders, safeEqual } from './middleware.js'

interface Client {
  id: string
  socket: WebSocket
  subscriptions: Set<string>
  alive: boolean
  /** M57：登录态（多用户订阅 ACL 依据） */
  user?: AuthUser
}

interface ClientMessage {
  type?: string
  sessionIds?: string[]
  cursors?: Record<string, number>
  cursor?: number
}

export interface PublishInput {
  type: NotifyType
  sessionId: string
  runId?: string
  payload: Record<string, unknown>
}

export class NotifyHub {
  private wss?: WebSocketServer
  private clients = new Map<string, Client>()
  private buffers = new Map<string, { seq: number; events: NotifyEnvelope[] }>()
  private heartbeatTimer?: ReturnType<typeof setInterval>

  constructor(
    private readonly cfg: AppConfig,
    /** M57：认证 / 访问控制依赖（惰性读取；缺省 = 旧语义（仅 token 校验，测试兼容）） */
    private readonly getAuthDeps?: () => { auth: AuthService; access: AccessService },
  ) {}

  attach(server: HttpServer): void {
    // M10：改用 noServer 模式，握手前完成鉴权（浏览器自动携带 cookie；CLI 可用 ?token= 或 Bearer）
    this.wss = new WebSocketServer({ noServer: true })
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname !== '/ws') return // 非 /ws 的升级请求交由其他监听器处理（与原 path 过滤行为一致）
      const verdict = this.authorize(req, url)
      if (!verdict.ok) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      this.wss?.handleUpgrade(req, socket, head, (ws) => {
        this.wss?.emit('connection', ws, req, verdict.user)
      })
    })
    this.wss.on('connection', (socket: WebSocket, _req: IncomingMessage, user?: AuthUser) =>
      this.onConnection(socket, user),
    )
    this.heartbeatTimer = setInterval(() => this.tick(), this.cfg.wsHeartbeatMs)
    this.heartbeatTimer.unref?.()
  }

  /**
   * 握手鉴权（M57）：
   * - 已注入认证依赖：登录态解析（sid cookie / Bearer API Key / legacy AUTH_TOKEN / ?token=）；
   * - 未注入（老测试路径）：沿用 AUTH_TOKEN 校验语义（未配置 token 时放行）。
   */
  private authorize(req: IncomingMessage, url: URL): { ok: boolean; user?: AuthUser } {
    const deps = this.getAuthDeps?.()
    if (!deps) {
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
    const user = resolveUserFromHeaders(deps.auth, this.cfg, req.headers, url.searchParams.get('token') ?? '')
    if (user) return { ok: true, user }
    // 单用户兼容模式（无账号且未配置 AUTH_TOKEN）：放行
    if (!deps.auth.multiUser && !this.cfg.authToken) return { ok: true }
    return { ok: false }
  }

  close(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    for (const client of this.clients.values()) client.socket.terminate()
    this.clients.clear()
    this.wss?.close()
  }

  /** engine 生命周期埋点入口 */
  publish(input: PublishInput): NotifyEnvelope {
    const buf = this.buffers.get(input.sessionId) ?? { seq: 0, events: [] }
    const envelope: NotifyEnvelope = {
      v: 1,
      id: `n_${randomUUID().slice(0, 8)}`,
      seq: ++buf.seq,
      type: input.type,
      ts: new Date().toISOString(),
      sessionId: input.sessionId,
      runId: input.runId,
      payload: input.payload,
    }
    buf.events.push(envelope)
    if (buf.events.length > this.cfg.wsReplayBuffer) buf.events.shift()
    this.buffers.set(input.sessionId, buf)

    const frame = JSON.stringify(envelope)
    for (const client of this.clients.values()) {
      if (client.subscriptions.has(input.sessionId) && client.socket.readyState === WebSocket.OPEN) {
        client.socket.send(frame)
      }
    }
    return envelope
  }

  /** 降级轮询 / 重连补发数据源：sessionId 缺省时跨会话合并返回 */
  list(sessionId: string | undefined, since: number): NotifyListResponse {
    if (sessionId) {
      const buf = this.buffers.get(sessionId)
      if (!buf) return { notifications: [], cursor: 0 }
      const notifications = buf.events.filter((e) => e.seq > since)
      const minSeq = buf.events[0]?.seq ?? buf.seq
      return {
        notifications,
        cursor: buf.seq,
        truncated: since > 0 && since < minSeq - 1 ? true : undefined,
      }
    }
    const all: NotifyEnvelope[] = []
    let cursor = 0
    let truncated = false
    for (const buf of this.buffers.values()) {
      cursor = Math.max(cursor, buf.seq)
      const minSeq = buf.events[0]?.seq ?? buf.seq
      if (since > 0 && since < minSeq - 1) truncated = true
      all.push(...buf.events.filter((e) => e.seq > since))
    }
    all.sort((a, b) => a.ts.localeCompare(b.ts))
    return { notifications: all, cursor, truncated: truncated || undefined }
  }

  private onConnection(socket: WebSocket, user?: AuthUser): void {
    const client: Client = {
      id: `c_${randomUUID().slice(0, 8)}`,
      socket,
      subscriptions: new Set(),
      alive: true,
      user,
    }
    this.clients.set(client.id, client)

    socket.on('message', (raw) => {
      client.alive = true
      let msg: ClientMessage
      try {
        msg = JSON.parse(String(raw)) as ClientMessage
      } catch {
        return
      }
      switch (msg.type) {
        case 'subscribe': {
          for (const id of msg.sessionIds ?? []) {
            // M57：订阅 ACL——全局主题（__mcp__ / __assets__ 等）仅 admin；会话主题需归属可见
            if (!this.canSubscribe(client, id)) continue
            client.subscriptions.add(id)
            // 按 since 游标补发（重连恢复；补发内容同样受 ACL 约束）
            const cursor = msg.cursors?.[id]
            if (typeof cursor === 'number') {
              const buf = this.buffers.get(id)
              if (buf) {
                for (const env of buf.events.filter((e) => e.seq > cursor)) {
                  this.sendRaw(client, env)
                }
              }
            }
          }
          this.send(client, { type: 'subscribed', sessionIds: [...client.subscriptions] })
          break
        }
        case 'unsubscribe': {
          for (const id of msg.sessionIds ?? []) client.subscriptions.delete(id)
          break
        }
        case 'ping': {
          this.send(client, { type: 'pong' })
          break
        }
        case 'ack': {
          // 已读游标仅用于前端未读计数，服务端确认即可
          this.send(client, { type: 'ack-ok', cursor: msg.cursor ?? 0 })
          break
        }
        default:
          break
      }
    })
    socket.on('close', () => this.clients.delete(client.id))
    socket.on('error', () => this.clients.delete(client.id))
    this.send(client, { type: 'welcome', heartbeatMs: this.cfg.wsHeartbeatMs })
  }

  private tick(): void {
    const frame = JSON.stringify({ type: 'ping', ts: Date.now() })
    for (const client of this.clients.values()) {
      if (!client.alive) {
        // 2 周期无任何消息 → 剔除并释放订阅
        client.socket.terminate()
        this.clients.delete(client.id)
        continue
      }
      client.alive = false
      if (client.socket.readyState === WebSocket.OPEN) client.socket.send(frame)
    }
  }

  /** 订阅 ACL：全局主题（`__` 前缀）仅 admin；会话主题需归属可见（未注入认证依赖时沿用旧行为） */
  private canSubscribe(client: Client, topic: string): boolean {
    const deps = this.getAuthDeps?.()
    if (!deps) return true
    if (!deps.auth.multiUser) return true
    if (topic.startsWith('__')) return client.user?.role === 'admin'
    return client.user ? deps.access.canAccessSession(client.user, topic) : false
  }

  private send(client: Client, data: Record<string, unknown>): void {
    if (client.socket.readyState === WebSocket.OPEN) client.socket.send(JSON.stringify(data))
  }

  private sendRaw(client: Client, envelope: NotifyEnvelope): void {
    if (client.socket.readyState === WebSocket.OPEN) client.socket.send(JSON.stringify(envelope))
  }
}

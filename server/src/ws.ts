/**
 * NotifyHub（§18.3）：应用级通知总线。
 * - 连接表 + 30s 心跳（2 周期无响应剔除）；
 * - 订阅表：增量订阅会话通知；
 * - NotificationCenter：每会话环形重放缓冲（WS_REPLAY_BUFFER=200）+ since 游标补发；
 * - 降级：GET /api/notifications?since=… 走同一数据源；
 * - 鉴权（M10）：配置 AUTH_TOKEN 时握手校验 cookie / query token / Bearer，否则 401 拒绝升级。
 *
 * M79-A（社交协作基座；设计 §9）：
 * - 用户主题 `u:<userId>`：握手后自动绑定本人身份（`publishToUser` 定向投递；他人不可订阅）；
 * - 背压：单连接待写队列上限（WS_SEND_QUEUE_MAX）→ 发 `resync` 后断开（客户端 REST 补齐，不丢事件）；
 * - 每用户连接上限（WS_MAX_CONNS_PER_USER）：超限踢最旧（`error code=conn_evicted`）；
 * - 新帧：client→`read` / `inbox-ack`；server→`notify:inbox` / `notify:read-state` / `notify:presence` / `resync` / `error`；
 * - ACL 撤销即时化：`revokeSession`（移出会话）/ `kickUser`（账号禁用）主动退订 + 断开；
 * - 观测：`stats()`（连接 / 队列水位 / 踢出与 resync 计数）。
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
  /** M79-A：待写队列计数（send 回调递减；背压判定依据） */
  pending: number
}

interface ClientMessage {
  type?: string
  sessionIds?: string[]
  cursors?: Record<string, number>
  cursor?: number
  /** M79-A：已读上报 */
  sessionId?: string
  seq?: number
  /** M79-A：收件箱整段已读 */
  upTo?: number
}

export interface PublishInput {
  type: NotifyType
  sessionId: string
  runId?: string
  payload: Record<string, unknown>
}

/** M79-A：用户主题前缀（`u:<userId>`；会话 id 为 `s_` 前缀，无碰撞） */
export const USER_TOPIC_PREFIX = 'u:'

/** M79-L：跨实例总线条目（memory 模式不产生；db 模式由传输层持久化/分发） */
export interface NotifyBusEntry {
  /** M79-Y：revoke（ACL 撤销）/ kick（账号踢出）同样跨实例生效（安全面） */
  kind: 'session' | 'user' | 'revoke' | 'kick'
  /** kind=session/revoke → 会话 id；kind=user/kick → 目标 userId */
  target: string
  /** 通知类型（revoke/kick 无帧语义，可缺省） */
  type?: NotifyType
  runId?: string
  payload: Record<string, unknown>
}

/** M79-L：总线传输（实现：DbNotifyBus；测试可用内存实现） */
export interface NotifyBusTransport {
  /** 本实例发布（实现必须保证不回调本实例 onEntry——origin 排除防回环） */
  publish(entry: NotifyBusEntry): void
  /** 启动消费（poll 由实现负责）；回调 = 其他实例的条目 */
  start(onEntry: (entry: NotifyBusEntry) => void): void
  dispose(): void
  stats(): Record<string, number | string>
}

export class NotifyHub {
  private wss?: WebSocketServer
  private clients = new Map<string, Client>()
  private buffers = new Map<string, { seq: number; events: NotifyEnvelope[] }>()
  private heartbeatTimer?: ReturnType<typeof setInterval>
  /** M79-A：观测计数 */
  private evictions = 0
  private resyncs = 0
  /** M79-L：跨实例总线传输（memory 模式缺省 = 不挂载，现状零变化） */
  private transport?: NotifyBusTransport

  constructor(
    private readonly cfg: AppConfig,
    /** M57：认证 / 访问控制依赖（惰性读取；缺省 = 旧语义（仅 token 校验，测试兼容）） */
    private readonly getAuthDeps?: () => { auth: AuthService; access: AccessService },
    /** M79-A：收件箱 / 已读存储（惰性读取；缺省 = 对应帧静默忽略） */
    private readonly getSocialDeps?: () => {
      inbox?: { markReadUpTo(userId: string, upTo: number): number }
      reads?: { set(userId: string, sessionId: string, seq: number): number }
    },
    /** M79-A：在线状态钩子（连接建立 / 关闭；缺省 = 不跟踪） */
    private readonly presenceHooks?: { onConnect?: (userId: string) => void; onDisconnect?: (userId: string) => void },
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
    // M79-L：停止总线消费（轮询停止；总线行保留期由装配层清理定时器负责）
    this.transport?.dispose()
    this.wss?.close()
  }

  /** engine 生命周期埋点入口（会话主题广播；M79-L：db 总线模式下同时写总线供其他实例投递） */
  publish(input: PublishInput): NotifyEnvelope {
    const envelope = this.fanoutSession(input.sessionId, input.type, input.payload, input.runId)
    this.transport?.publish({
      kind: 'session',
      target: input.sessionId,
      type: input.type,
      ...(input.runId ? { runId: input.runId } : {}),
      payload: input.payload,
    })
    return envelope
  }

  /** M79-L：挂载跨实例总线传输（memory 模式不调用 = 现状零变化） */
  attachTransport(transport: NotifyBusTransport): void {
    this.transport = transport
    transport.start((entry) => this.deliverRemote(entry))
  }

  /** 本实例会话主题下发（本地 seq 分配 + 重放缓冲 + 订阅者扇出） */
  private fanoutSession(
    sessionId: string,
    type: NotifyType,
    payload: Record<string, unknown>,
    runId?: string,
  ): NotifyEnvelope {
    const buf = this.buffers.get(sessionId) ?? { seq: 0, events: [] }
    const envelope: NotifyEnvelope = {
      v: 1,
      id: `n_${randomUUID().slice(0, 8)}`,
      seq: ++buf.seq,
      type,
      ts: new Date().toISOString(),
      sessionId,
      runId,
      payload,
    }
    buf.events.push(envelope)
    if (buf.events.length > this.cfg.wsReplayBuffer) buf.events.shift()
    this.buffers.set(sessionId, buf)

    const frame = JSON.stringify(envelope)
    for (const client of this.clients.values()) {
      if (client.subscriptions.has(sessionId)) this.sendTracked(client, frame)
    }
    return envelope
  }

  /** M79-L：远程条目 → 本地投递（不再回写总线，防回环） */
  private deliverRemote(entry: NotifyBusEntry): void {
    // M79-Y：ACL 撤销 / 账号踢出跨实例（本地连接的退订与断开）
    if (entry.kind === 'revoke') {
      const userId = String(entry.payload.userId ?? '')
      const message = typeof entry.payload.message === 'string' ? entry.payload.message : '会话访问权限已变更'
      if (userId) this.revokeSessionLocal(userId, entry.target, message)
      return
    }
    if (entry.kind === 'kick') {
      const message = typeof entry.payload.message === 'string' ? entry.payload.message : '账号状态已变更，请重新登录'
      this.kickUserLocal(entry.target, message)
      return
    }
    if (entry.kind === 'session') {
      if (!entry.type) return // 防御：session 条目必带类型（revoke/kick 已在前分支处理）
      this.fanoutSession(entry.target, entry.type, entry.payload, entry.runId)
      return
    }
    // kind=user：仅投给该用户的本地连接（跨实例来源无 excludeClientId 语义）
    if (!entry.type) return
    const envelope: NotifyEnvelope = {
      v: 1,
      id: `n_${randomUUID().slice(0, 8)}`,
      seq: 0,
      type: entry.type,
      ts: new Date().toISOString(),
      sessionId: `${USER_TOPIC_PREFIX}${entry.target}`,
      payload: entry.payload,
    }
    const frame = JSON.stringify(envelope)
    for (const client of this.clients.values()) {
      if (client.user?.id === entry.target) this.sendTracked(client, frame)
    }
  }

  /**
   * M79-A：用户主题定向投递（收件箱 / 已读推进 / presence / 关系变更）。
   * - 仅投递给该用户自己的连接（多端 / 多标签页各自收）；admin 不可代收；
   * - 不进入会话重放缓冲（权威层为 user_inbox 表；重连由 REST since 补齐）；
   * - opts.excludeClientId：跳过触发源连接（如已读上报者自身——多端同步语义）。
   */
  publishToUser(
    userId: string,
    type: NotifyType,
    payload: Record<string, unknown>,
    opts: { excludeClientId?: string } = {},
  ): NotifyEnvelope {
    const envelope: NotifyEnvelope = {
      v: 1,
      id: `n_${randomUUID().slice(0, 8)}`,
      seq: 0,
      type,
      ts: new Date().toISOString(),
      sessionId: `${USER_TOPIC_PREFIX}${userId}`,
      payload,
    }
    const frame = JSON.stringify(envelope)
    for (const client of this.clients.values()) {
      if (client.user?.id !== userId) continue
      if (opts.excludeClientId && client.id === opts.excludeClientId) continue
      this.sendTracked(client, frame)
    }
    // M79-L：写总线供其他实例投递该用户的本地连接（excludeClientId 仅本实例语义——触发源连接必在本实例）
    this.transport?.publish({ kind: 'user', target: userId, type, payload })
    return envelope
  }

  /**
   * M79-A：会话级 ACL 撤销（被移出会话 / 退出共享）——主动退订 + 通知客户端本地清理。
   * 幂等：未订阅的连接不受影响。
   */
  revokeSession(userId: string, sessionId: string, message = '会话访问权限已变更'): void {
    this.revokeSessionLocal(userId, sessionId, message)
    // M79-Y：跨实例（被移出者的连接可能在其他实例上——退订与提示同步生效）
    this.transport?.publish({ kind: 'revoke', target: sessionId, payload: { userId, message } })
  }

  /** 本实例退订 + 提示（幂等；远程总线条目复用同一实现） */
  private revokeSessionLocal(userId: string, sessionId: string, message: string): void {
    for (const client of this.clients.values()) {
      if (client.user?.id !== userId) continue
      if (!client.subscriptions.delete(sessionId)) continue
      this.sendRawFrame(client, { type: 'error', code: 'acl-changed', sessionId, message })
    }
  }

  /** M79-A：账号级踢出（禁用 / 删除）——全部连接断开（error 提示后 terminate） */
  kickUser(userId: string, message = '账号状态已变更，请重新登录'): void {
    this.kickUserLocal(userId, message)
    // M79-Y：跨实例（其他实例上该账号的连接同样断开）
    this.transport?.publish({ kind: 'kick', target: userId, payload: { message } })
  }

  /** 本实例断开该用户全部连接（远程总线条目复用同一实现） */
  private kickUserLocal(userId: string, message: string): void {
    for (const client of [...this.clients.values()]) {
      if (client.user?.id !== userId) continue
      this.sendRawFrame(client, { type: 'error', code: 'acl-changed', message })
      client.socket.terminate()
      this.clients.delete(client.id)
    }
  }

  /** M79-A：观测快照（GET /api/ws/stats；admin） */
  stats(): {
    connections: number
    users: number
    maxPending: number
    evictions: number
    resyncs: number
    topics: number
    /** M79-L：总线传输观测（memory 模式 = { mode: 'memory' }） */
    bus: Record<string, number | string>
  } {
    let maxPending = 0
    const users = new Set<string>()
    for (const client of this.clients.values()) {
      maxPending = Math.max(maxPending, client.pending)
      if (client.user) users.add(client.user.id)
    }
    return {
      connections: this.clients.size,
      users: users.size,
      maxPending,
      evictions: this.evictions,
      resyncs: this.resyncs,
      topics: this.buffers.size,
      bus: this.transport?.stats() ?? { mode: 'memory' },
    }
  }

  /**
   * 降级轮询 / 重连补发数据源：sessionId 缺省时跨会话合并返回。
   * M79-AF：可选 per-session 游标映射（`cursors[sid]` 优先于 since）——跨会话轮询不再全量拉取，
   * 只回各会话增量（各会话 seq 独立计数器，单值 since 无法跨会话表达）；缺省行为与旧版逐字节一致。
   */
  list(sessionId: string | undefined, since: number, cursors?: Record<string, number>): NotifyListResponse {
    /** 该会话的过滤下界（per-session 游标优先；非法值回退 since） */
    const floorOf = (sid: string): number => {
      const perSession = cursors?.[sid]
      return typeof perSession === 'number' && Number.isFinite(perSession) ? perSession : since
    }
    if (sessionId) {
      const buf = this.buffers.get(sessionId)
      if (!buf) return { notifications: [], cursor: 0 }
      const floor = floorOf(sessionId)
      const notifications = buf.events.filter((e) => e.seq > floor)
      const minSeq = buf.events[0]?.seq ?? buf.seq
      return {
        notifications,
        cursor: buf.seq,
        truncated: floor > 0 && floor < minSeq - 1 ? true : undefined,
      }
    }
    const all: NotifyEnvelope[] = []
    let cursor = 0
    let truncated = false
    for (const [sid, buf] of this.buffers.entries()) {
      cursor = Math.max(cursor, buf.seq)
      const floor = floorOf(sid)
      const minSeq = buf.events[0]?.seq ?? buf.seq
      if (floor > 0 && floor < minSeq - 1) truncated = true
      all.push(...buf.events.filter((e) => e.seq > floor))
    }
    all.sort((a, b) => a.ts.localeCompare(b.ts))
    return { notifications: all, cursor, truncated: truncated || undefined }
  }

  private onConnection(socket: WebSocket, user?: AuthUser): void {
    // M79-A：每用户连接上限——超限先踢最旧（error 提示后 terminate；防标签页泄漏）
    if (user && this.cfg.wsMaxConnsPerUser > 0) {
      const mine = [...this.clients.values()].filter((c) => c.user?.id === user.id)
      while (mine.length >= this.cfg.wsMaxConnsPerUser) {
        const oldest = mine.shift()!
        this.evictions++
        this.sendRawFrame(oldest, {
          type: 'error',
          code: 'conn_evicted',
          message: `同一账号连接数超限（${this.cfg.wsMaxConnsPerUser}）：本连接已由新连接替代`,
        })
        oldest.socket.terminate()
        this.clients.delete(oldest.id)
      }
    }

    const client: Client = {
      id: `c_${randomUUID().slice(0, 8)}`,
      socket,
      subscriptions: new Set(),
      alive: true,
      user,
      pending: 0,
    }
    this.clients.set(client.id, client)
    let presenceNotified = false
    if (user) {
      presenceNotified = true
      this.presenceHooks?.onConnect?.(user.id)
    }

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
            // M79-A：用户主题（u:<userId>）仅本人；他人（含 admin）不可订阅
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
        case 'read': {
          // M79-A：已读上报（本人会话；落库 + 广播本人其他端；不回执给对方）
          if (!client.user || typeof msg.sessionId !== 'string' || typeof msg.seq !== 'number') break
          const authDeps = this.getAuthDeps?.()
          if (authDeps && !authDeps.access.canAccessSession(client.user, msg.sessionId)) break
          const reads = this.getSocialDeps?.()?.reads
          if (!reads) break
          const effective = reads.set(client.user.id, msg.sessionId, msg.seq)
          this.publishToUser(
            client.user.id,
            'notify:read-state',
            { sessionId: msg.sessionId, lastReadSeq: effective, ts: Date.now() },
            { excludeClientId: client.id },
          )
          break
        }
        case 'inbox-ack': {
          // M79-A：收件箱整段已读（openUpTo 语义；客户端打开面板时调用）
          if (!client.user || typeof msg.upTo !== 'number') break
          const inbox = this.getSocialDeps?.()?.inbox
          if (!inbox) break
          inbox.markReadUpTo(client.user.id, msg.upTo)
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
    socket.on('close', () => {
      this.clients.delete(client.id)
      if (presenceNotified && user) this.presenceHooks?.onDisconnect?.(user.id)
    })
    socket.on('error', () => {
      // terminate 也可能只触发 error（close 兜底）；presence 计数只在 close 处理，防双扣
      if (this.clients.delete(client.id) && presenceNotified && user) {
        this.presenceHooks?.onDisconnect?.(user.id)
        presenceNotified = false
      }
    })
    this.send(client, { type: 'welcome', heartbeatMs: this.cfg.wsHeartbeatMs })
  }

  private tick(): void {
    const frame = JSON.stringify({ type: 'ping', ts: Date.now() })
    for (const client of [...this.clients.values()]) {
      if (!client.alive) {
        // 2 周期无任何消息 → 剔除并释放订阅
        client.socket.terminate()
        this.clients.delete(client.id)
        continue
      }
      client.alive = false
      this.sendTracked(client, frame)
    }
  }

  /** 订阅 ACL：用户主题仅本人；全局主题（`__` 前缀）仅 admin；会话主题需归属可见（未注入认证依赖时沿用旧行为） */
  private canSubscribe(client: Client, topic: string): boolean {
    const deps = this.getAuthDeps?.()
    if (!deps) return true
    if (!deps.auth.multiUser) return true
    if (topic.startsWith(USER_TOPIC_PREFIX)) return !!client.user && topic === `${USER_TOPIC_PREFIX}${client.user.id}`
    if (topic.startsWith('__')) return client.user?.role === 'admin'
    return client.user ? deps.access.canAccessSession(client.user, topic) : false
  }

  /**
   * M79-A：带背压跟踪的发送。
   * 待写队列超限（WS_SEND_QUEUE_MAX；0=不限）→ 发 resync 通知后主动断开（客户端重连走 REST 补齐，不丢事件）。
   */
  private sendTracked(client: Client, frame: string): void {
    if (client.socket.readyState !== WebSocket.OPEN) return
    const max = this.cfg.wsSendQueueMax
    if (max > 0 && client.pending >= max) {
      this.resyncs++
      try {
        client.socket.send(JSON.stringify({ type: 'resync', reason: 'backpressure' }))
      } catch {
        // 已断开：忽略
      }
      client.socket.terminate()
      this.clients.delete(client.id)
      return
    }
    client.pending++
    try {
      client.socket.send(frame, () => {
        client.pending = Math.max(0, client.pending - 1)
      })
    } catch {
      client.pending = Math.max(0, client.pending - 1)
    }
  }

  private send(client: Client, data: Record<string, unknown>): void {
    this.sendTracked(client, JSON.stringify(data))
  }

  private sendRaw(client: Client, envelope: NotifyEnvelope): void {
    this.sendTracked(client, JSON.stringify(envelope))
  }

  /** 不经背压计数的小控制帧（error 提示先于断开；尽力送达） */
  private sendRawFrame(client: Client, data: Record<string, unknown>): void {
    if (client.socket.readyState !== WebSocket.OPEN) return
    try {
      client.socket.send(JSON.stringify(data))
    } catch {
      // 已断开：忽略
    }
  }
}

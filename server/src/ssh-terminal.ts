/**
 * SshTerminalHub（M23）：SSH 交互终端 WS 通道（/ws/ssh）。
 *
 * 路径：/ws/ssh（noServer 模式，与 /ws、/ws/stream 并存、互不干扰）
 *
 * 协议：
 * - 升级：`/ws/ssh?connectionId=<id>&token=<流token>`（token 一次性，握手即消费；通道级鉴权同 /ws）；
 * - server → client：二进制帧 = 终端输出（原样字节，避免多字节被 JSON 切断）；JSON 文本帧 = 控制（ready / exit / error / pong）；
 * - client → server：二进制帧 = 键盘输入；JSON 文本帧 = { type:'resize', cols, rows } / { type:'ping' }。
 *
 * 生命周期：每终端一条独立 SSH 连接（不与缓存句柄共享）；ws 关闭即断开（幂等清理）。
 */
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, Server as HttpServer } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import type { Client, ClientChannel } from 'ssh2'
import type { AppConfig } from './config.js'
import { getLogger } from './logger.js'
import { AUTH_COOKIE, parseCookie, safeEqual } from './middleware.js'
import type { StreamTokenService } from './browser/stream-token.js'
import type { SshConnectionManager } from './connections/ssh/manager.js'
import { resizeShell } from './connections/ssh/connector.js'

/** 初始 PTY 尺寸（前端 fit 后立即发 resize 覆盖） */
const INITIAL_COLS = 80
const INITIAL_ROWS = 24

interface TerminalEntry {
  id: string
  socket: WebSocket
  client: Client
  stream: ClientChannel
  alive: boolean
}

export class SshTerminalHub {
  private wss?: WebSocketServer
  private readonly entries = new Map<string, TerminalEntry>()
  private heartbeatTimer?: NodeJS.Timeout

  constructor(
    private readonly cfg: AppConfig,
    private readonly ssh: SshConnectionManager,
    private readonly tokens: StreamTokenService,
  ) {}

  attach(server: HttpServer): void {
    this.wss = new WebSocketServer({ noServer: true })
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname !== '/ws/ssh') return // 其他升级请求交由其它监听器处理
      if (!this.authorized(req, url)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      const connectionId = url.searchParams.get('connectionId') ?? ''
      const token = url.searchParams.get('token') ?? ''
      const verdict = this.tokens.verify(token, `ssh:${connectionId}`, 'takeover')
      if (!verdict.ok) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      this.wss?.handleUpgrade(req, socket, head, (ws) => {
        this.wss?.emit('connection', ws, req)
      })
    })
    this.wss.on('connection', (socket, req) => {
      void this.onConnection(socket, req as IncomingMessage)
    })
    this.heartbeatTimer = setInterval(() => this.tick(), this.cfg.wsHeartbeatMs)
    this.heartbeatTimer.unref?.()
  }

  /** 握手鉴权（与 /ws、/ws/stream 一致：cookie / query token / Bearer） */
  private authorized(req: IncomingMessage, url: URL): boolean {
    if (!this.cfg.authToken) return true
    const header = req.headers.authorization ?? ''
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : ''
    const cookieToken = parseCookie(req.headers.cookie ?? '', AUTH_COOKIE)
    const queryToken = url.searchParams.get('token') ?? ''
    return (
      safeEqual(bearer, this.cfg.authToken) ||
      safeEqual(cookieToken, this.cfg.authToken) ||
      safeEqual(queryToken, this.cfg.authToken)
    )
  }

  private async onConnection(socket: WebSocket, req: IncomingMessage): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const connectionId = url.searchParams.get('connectionId') ?? ''
    let opened: Awaited<ReturnType<SshConnectionManager['openTerminal']>>
    try {
      opened = await this.ssh.openTerminal(connectionId, { cols: INITIAL_COLS, rows: INITIAL_ROWS }, 'user')
    } catch (err) {
      this.sendJson(socket, { type: 'error', message: (err as Error).message })
      socket.close()
      return
    }
    // 连接期间客户端可能已断开：直接回收
    if (socket.readyState !== WebSocket.OPEN) {
      try {
        opened.stream.close()
      } catch {
        // 忽略
      }
      opened.client.end()
      return
    }
    const entry: TerminalEntry = {
      id: `st_${randomUUID().slice(0, 8)}`,
      socket,
      client: opened.client,
      stream: opened.stream,
      alive: true,
    }
    this.entries.set(entry.id, entry)

    // 远程 → 浏览器：原样字节（不掺 JSON，避免 UTF-8 多字节被切断）
    const forward = (chunk: Buffer): void => {
      if (socket.readyState === WebSocket.OPEN) socket.send(chunk, { binary: true })
    }
    opened.stream.on('data', forward)
    opened.stream.stderr.on('data', forward)
    opened.stream.on('exit', (code: number | null, signal?: string) => {
      this.sendJson(socket, { type: 'exit', code, signal: signal ?? undefined })
    })
    opened.stream.on('close', () => {
      this.drop(entry.id)
    })

    // 浏览器 → 远程
    socket.on('message', (raw, isBinary) => {
      entry.alive = true
      if (isBinary) {
        try {
          entry.stream.write(raw as Buffer)
        } catch {
          // 通道已关闭：忽略（close 事件会清理）
        }
        return
      }
      try {
        const msg = JSON.parse(raw.toString()) as { type?: string; cols?: number; rows?: number }
        if (msg.type === 'resize' && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
          resizeShell(entry.stream, msg.cols!, msg.rows!)
        } else if (msg.type === 'ping') {
          this.sendJson(socket, { type: 'pong' })
        }
      } catch {
        // 非法文本帧：忽略
      }
    })
    socket.on('pong', () => {
      entry.alive = true
    })
    socket.on('close', () => this.drop(entry.id))
    socket.on('error', () => this.drop(entry.id))

    this.sendJson(socket, { type: 'ready', cols: INITIAL_COLS, rows: INITIAL_ROWS })
    getLogger().debug({ connectionId, terminalId: entry.id }, 'SSH 终端通道建立')
  }

  /** 幂等清理：关闭 ws / channel / ssh 连接 */
  private drop(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    this.entries.delete(id)
    try {
      entry.stream.close()
    } catch {
      // 忽略
    }
    try {
      entry.client.end()
    } catch {
      // 忽略
    }
    if (entry.socket.readyState === WebSocket.OPEN || entry.socket.readyState === WebSocket.CONNECTING) {
      try {
        entry.socket.close()
      } catch {
        // 忽略
      }
    }
  }

  private tick(): void {
    for (const entry of this.entries.values()) {
      if (!entry.alive) {
        this.drop(entry.id)
        continue
      }
      entry.alive = false
      try {
        entry.socket.ping()
      } catch {
        // 忽略
      }
    }
  }

  private sendJson(socket: WebSocket, message: Record<string, unknown>): void {
    if (socket.readyState !== WebSocket.OPEN) return
    try {
      socket.send(JSON.stringify(message))
    } catch {
      // 发送失败：下一轮心跳清理
    }
  }

  close(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    for (const id of [...this.entries.keys()]) this.drop(id)
    this.wss?.close()
  }
}

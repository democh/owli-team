/**
 * SSH 终端（M23）：多会话管理 + /ws/ssh 协议驱动。
 *
 * 协议（服务端 SshTerminalHub）：
 * - 升级：/ws/ssh?connectionId=<id>&token=<一次性流token>（token 握手即消费，不进 URL 长期暴露）；
 * - server → client：二进制帧 = 终端输出字节；JSON 文本帧 = ready / exit / error / pong；
 * - client → server：二进制帧 = 键盘输入；JSON 文本帧 = resize / ping。
 *
 * 生命周期：
 * - open(connection)：同一连接已有活动会话（connecting/open）则聚焦，否则新开（独立 SSH 连接）；
 * - 断线不静默重连（避免半可信网络里状态不明的重放）：置 closed 并提示，工具栏「重连」重新取 token；
 * - close(id)：关 WS + dispose 运行时（多会话互不影响）。
 *
 * 输出镜像（只读直播）：服务端字节流旁路一份进行缓冲（lib/terminal-mirror 清洗），
 * 直播窗 SSH tab 展示；「通知 + 拉取」订阅（subscribeMirror / mirrorOf），不进 zustand。
 *
 * 可测试性：运行时（xterm）经工厂注入（__setRuntimeFactory），测试用替身驱动协议状态机。
 */
import { create } from 'zustand'
import type { ConnectionDefinition, SshTerminalServerMessage, StreamTokenResponse } from '@multi-agent/shared'
import { apiGet } from '../lib/api'
import { appendMirrorLines } from '../lib/terminal-mirror'
import { createXtermRuntime, type TerminalRuntime } from '../lib/terminal-runtime'

export type TerminalStatus = 'connecting' | 'open' | 'closed' | 'error'

export interface TerminalSessionInfo {
  id: string
  connectionId: string
  title: string
  status: TerminalStatus
  message?: string
  size: { cols: number; rows: number }
}

interface TerminalState {
  sessions: TerminalSessionInfo[]
  activeId?: string
  /** 打开终端（同连接活动会话直接聚焦）；返回会话 id（失败返回 undefined） */
  open: (connection: Pick<ConnectionDefinition, 'id' | 'name'>) => Promise<string | undefined>
  close: (id: string) => void
  activate: (id: string) => void
  /** 断开后重连：复用同一终端画面，重新取 token 建 WS */
  reconnect: (id: string) => Promise<void>
  /** 运行时句柄（视图读取 element 上屏） */
  runtimeOf: (id: string) => TerminalRuntime | undefined
}

/** 非序列化句柄（不进 zustand state，避免无意义的响应式依赖） */
interface SessionRuntime {
  runtime: TerminalRuntime
  socket?: WebSocket
  encoder: TextEncoder
  /** 输出镜像：流式解码器 + 清洗后的行缓冲（只读直播用） */
  decoder: TextDecoder
  mirror: string[]
  offData?: () => void
  offResize?: () => void
  /** 用户主动关闭：onclose 不再改写状态 */
  manualClose: boolean
}

const runtimes = new Map<string, SessionRuntime>()

/** 输出镜像订阅（直播窗 SSH tab）：「通知 + 拉取」模式，避免高吞吐终端流触发 zustand 重渲染 */
const mirrorListeners = new Set<() => void>()

function emitMirror(): void {
  for (const listener of mirrorListeners) listener()
}

/** 订阅镜像变化（返回退订函数）；行数据用 mirrorOf(id) 拉取 */
export function subscribeMirror(listener: () => void): () => void {
  mirrorListeners.add(listener)
  return () => {
    mirrorListeners.delete(listener)
  }
}

/** 某终端会话的镜像行缓冲（未创建 / 已关闭 → 空数组） */
export function mirrorOf(id: string): string[] {
  return runtimes.get(id)?.mirror ?? []
}

/** 字节流写入镜像（流式解码，跨 chunk 多字节安全） */
function pushMirror(id: string, entry: SessionRuntime, bytes: Uint8Array): void {
  entry.mirror = appendMirrorLines(entry.mirror, entry.decoder.decode(bytes, { stream: true }))
  emitMirror()
}

/** 本地提示双写：进 xterm 画面 + 镜像缓冲 */
function notice(id: string, entry: SessionRuntime, text: string): void {
  entry.runtime.writeNotice(text)
  entry.mirror = appendMirrorLines(entry.mirror, `\n${text}\n`)
  emitMirror()
}

let seq = 0
const nextSessionId = (): string => `term_${Date.now().toString(36)}_${++seq}`

let runtimeFactory: () => TerminalRuntime = createXtermRuntime
/** 测试注入替身（生产永不调用） */
export function __setRuntimeFactory(factory: () => TerminalRuntime): void {
  runtimeFactory = factory
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** 跨 realm 安全的 ArrayBuffer 判定（iframe / worker 克隆消息的 Buffer 不共享 realm 原型链） */
function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return Object.prototype.toString.call(value) === '[object ArrayBuffer]'
}

function patchSession(id: string, next: Partial<TerminalSessionInfo>): void {
  useTerminalStore.setState((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? { ...x, ...next } : x)) }))
}

/** 建立 / 重建一次 WS 会话（复用已有运行时 → 重连时终端画面保留） */
async function startSession(id: string, connectionId: string): Promise<boolean> {
  let entry = runtimes.get(id)
  if (!entry) {
    const runtime = runtimeFactory()
    const created: SessionRuntime = {
      runtime,
      encoder: new TextEncoder(),
      decoder: new TextDecoder(),
      mirror: [],
      manualClose: false,
    }
    runtimes.set(id, created)
    // 键盘输入 → 二进制帧
    created.offData = runtime.onData((data) => {
      const socket = created.socket
      if (socket && socket.readyState === WebSocket.OPEN) socket.send(created.encoder.encode(data))
    })
    // fit / 手动 resize → JSON 帧（服务端 setWindow）
    created.offResize = runtime.onResize((cols, rows) => {
      const socket = created.socket
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'resize', cols, rows }))
        patchSession(id, { size: { cols, rows } })
      }
    })
    entry = created
  }
  const session = entry
  // 清理上一次连接（重连路径）
  try {
    session.socket?.close()
  } catch {
    // 已关闭：忽略
  }
  session.socket = undefined
  session.manualClose = false
  patchSession(id, { status: 'connecting', message: undefined })

  let token: StreamTokenResponse
  try {
    token = await apiGet<StreamTokenResponse>(`/api/connections/${connectionId}/ssh/terminal-token`)
  } catch (err) {
    const message = errorMessage(err)
    notice(id, session, `无法获取终端令牌：${message}`)
    patchSession(id, { status: 'error', message })
    return false
  }

  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const url = `${protocol}://${window.location.host}/ws/ssh?connectionId=${encodeURIComponent(connectionId)}&token=${encodeURIComponent(token.token)}`
  let socket: WebSocket
  try {
    socket = new WebSocket(url)
  } catch (err) {
    notice(id, session, `终端通道创建失败：${errorMessage(err)}`)
    patchSession(id, { status: 'error', message: errorMessage(err) })
    return false
  }
  socket.binaryType = 'arraybuffer'
  session.socket = socket

  socket.onopen = () => {
    // 打开即上报真实尺寸（服务端初始 PTY 为 80x24）
    const { cols, rows } = session.runtime.size()
    socket.send(JSON.stringify({ type: 'resize', cols, rows }))
  }

  socket.onmessage = (event: MessageEvent) => {
    const data = event.data
    if (typeof data === 'string') {
      let message: SshTerminalServerMessage
      try {
        message = JSON.parse(data) as SshTerminalServerMessage
      } catch {
        return // 非法控制帧：忽略
      }
      if (message.type === 'ready') {
        patchSession(id, { status: 'open', size: { cols: message.cols, rows: message.rows } })
        session.runtime.fit()
        session.runtime.focus()
      } else if (message.type === 'exit') {
        const detail = message.code ?? message.signal ?? '未知'
        notice(id, session, `远程进程已退出（exit ${detail}）`)
        patchSession(id, { status: 'closed', message: `进程已退出（exit ${detail}）` })
      } else if (message.type === 'error') {
        notice(id, session, `连接失败：${message.message}`)
        patchSession(id, { status: 'error', message: message.message })
      }
      return
    }
    if (isArrayBuffer(data)) {
      const bytes = new Uint8Array(data)
      session.runtime.writeBytes(bytes)
      pushMirror(id, session, bytes)
    } else if (typeof Blob !== 'undefined' && data instanceof Blob) {
      void data.arrayBuffer().then((buffer) => {
        const bytes = new Uint8Array(buffer)
        session.runtime.writeBytes(bytes)
        pushMirror(id, session, bytes)
      })
    }
  }

  socket.onclose = () => {
    if (session.manualClose) return
    const current = useTerminalStore.getState().sessions.find((s) => s.id === id)
    if (!current || current.status === 'error' || current.status === 'closed') return
    if (current.status === 'open') notice(id, session, '连接已断开（可点击工具栏「重连」）')
    patchSession(id, {
      status: 'closed',
      message: current.status === 'open' ? '连接已断开' : '连接未建立（token 失效或网络异常）',
    })
  }

  socket.onerror = () => {
    if (session.manualClose) return
    patchSession(id, { status: 'error', message: '终端通道错误（网络异常）' })
  }
  return true
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  sessions: [],

  open: async (connection) => {
    // 同连接的活动会话直接聚焦（避免误开多份同名终端）
    const live = get().sessions.find((s) => s.connectionId === connection.id && (s.status === 'connecting' || s.status === 'open'))
    if (live) {
      set({ activeId: live.id })
      return live.id
    }
    const id = nextSessionId()
    const siblings = get().sessions.filter((s) => s.connectionId === connection.id).length
    set((s) => ({
      sessions: [
        ...s.sessions,
        {
          id,
          connectionId: connection.id,
          title: siblings > 0 ? `${connection.name} ·${siblings + 1}` : connection.name,
          status: 'connecting',
          size: { cols: 80, rows: 24 },
        },
      ],
      activeId: id,
    }))
    const ok = await startSession(id, connection.id)
    return ok ? id : undefined
  },

  close: (id) => {
    const entry = runtimes.get(id)
    if (entry) {
      entry.manualClose = true
      try {
        entry.socket?.close()
      } catch {
        // 忽略
      }
      entry.offData?.()
      entry.offResize?.()
      entry.runtime.dispose()
      runtimes.delete(id)
      emitMirror()
    }
    set((s) => {
      const index = s.sessions.findIndex((x) => x.id === id)
      const sessions = s.sessions.filter((x) => x.id !== id)
      let activeId = s.activeId
      if (activeId === id) {
        const next = sessions[index] ?? sessions[index - 1] ?? sessions[0]
        activeId = next?.id
      }
      return { sessions, activeId }
    })
  },

  activate: (id) => set({ activeId: id }),

  reconnect: async (id) => {
    const session = get().sessions.find((s) => s.id === id)
    if (!session) return
    await startSession(id, session.connectionId)
  },

  runtimeOf: (id) => runtimes.get(id)?.runtime,
}))

/**
 * 浏览器可视化（M22）：帧流订阅 / 控制权（接管·归还）/ 步骤时间轴 / 会话生命周期。
 *
 * 链路：面板 → 流 token（watch/takeover 服务端分权）→ `/ws/stream` 订阅 → 帧与步骤事件；
 * 输入（鼠标/键盘/滚轮/文本）走同一连接的 `input` 消息，服务端仅接受 takeover 订阅。
 *
 * 降级约定：
 * - token 失效（重启换密钥 / 一次性 takeover 已消费）→ 自动换发 watch token 重订（观察态）；
 * - 链路抖动 → StreamSocket 指数退避重连并按登记频道自动重订；
 * - 会话已不存在（服务端重启/销毁后的过期订阅）→ 静默回源对齐，不弹红条、不自动重开。
 */
import { create } from 'zustand'
import type { BrowserSessionInfo, BrowserStepInfo, BrowserState as BState, StreamTokenResponse } from '@multi-agent/shared'
import { apiGet, apiPost, ApiError } from '../lib/api'
import { StreamSocket, type StreamFrame, type StreamStatus, type StreamStep } from '../lib/stream'

interface BrowserPanelState {
  sessionId?: string
  session: BrowserSessionInfo | null
  history: BrowserSessionInfo[]
  steps: BrowserStepInfo[]
  /** 当前画面（服务端节流后的最新帧） */
  frame: StreamFrame | null
  streamStatus: StreamStatus
  mode: 'watch' | 'takeover'
  maxFps: number
  loading: boolean
  busy: boolean
  error?: string
  load: (sessionId: string) => Promise<void>
  /** 面板「打开浏览器」（backend / headless 缺省 = 服务端配置） */
  start: (opts?: { backend?: 'managed' | 'local' | 'remote'; url?: string; headless?: boolean }) => Promise<void>
  watch: () => Promise<void>
  takeover: () => Promise<void>
  release: () => Promise<void>
  setMaxFps: (fps: number) => void
  /** 人工输入（懒接管：未接管先接管再发） */
  sendInput: (payload: Record<string, unknown>) => Promise<void>
  openExternal: (url: string) => Promise<void>
  closeSession: () => Promise<void>
  /** 面板卸载：断开流（会话本身保留，Agent 可继续操作） */
  detach: () => void
  /** 视图持有流连接（右栏面板 / 直播窗各持一份；引用计数归零才断流） */
  retainView: () => void
  /** 视图释放流连接（与 retainView 成对） */
  releaseView: () => void
}

let socket: StreamSocket | undefined
/** 流连接的视图持有计数（右栏面板 / 直播窗）：归零才断开，避免一方卸载误杀另一方 */
let viewHolders = 0
/** 步骤滚动上限（时间轴保留最近 N 条） */
const STEP_CAP = 400

/** 步骤截图的服务端 URL（绝对路径 → /api/browser/screenshots/<bsid>/<name>） */
export function screenshotUrlOf(step: BrowserStepInfo): string | undefined {
  const raw = step.screenshotPath
  if (!raw) return undefined
  const parts = raw.split('/').filter(Boolean)
  const name = parts.pop()
  const bsid = parts.pop()
  if (!name || !bsid) return undefined
  return `/api/browser/screenshots/${encodeURIComponent(bsid)}/${encodeURIComponent(name)}`
}

function mergeSteps(current: BrowserStepInfo[], incoming: BrowserStepInfo[]): BrowserStepInfo[] {
  const bySeq = new Map<number, BrowserStepInfo>()
  for (const step of current) bySeq.set(step.seq, step)
  for (const step of incoming) bySeq.set(step.seq, step)
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq).slice(-STEP_CAP)
}

/** 会话已不存在或已关闭（服务端 404）：接管/归还等 REST 路径需静默回源对齐 */
function isSessionGoneError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404 && err.message.includes('浏览器会话')
}

export const useBrowserStore = create<BrowserPanelState>((set, get) => {
  /** 拉取流 token（watch 可复用 / takeover 一次性） */
  const issueToken = async (bsid: string, mode: 'watch' | 'takeover'): Promise<StreamTokenResponse> =>
    await apiGet<StreamTokenResponse>(`/api/browser/sessions/${bsid}/stream-token?mode=${mode}`)

  const loadSteps = async (bsid: string): Promise<void> => {
    try {
      const res = await apiGet<{ steps: BrowserStepInfo[] }>(`/api/browser/sessions/${bsid}/steps?limit=200`)
      set({ steps: mergeSteps([], res.steps) })
    } catch {
      // 步骤拉取失败不阻断画面
    }
  }

  /** 会话失效回源对齐：重载当前会话的浏览器列表（active 归 null → 面板回退未连接引导） */
  const reconcile = (): void => {
    const state = get()
    if (state.session) void get().load(state.session.sessionId)
  }

  const ensureSocket = (): StreamSocket => {
    if (socket) return socket
    socket = new StreamSocket({
      onStatus: (status) => set({ streamStatus: status }),
      onSubscribed: (_topic, mode) => set({ mode }),
      onFrame: (topic, frame) => {
        const state = get()
        if (!state.session || topic !== state.session.topic) return
        if (state.frame && frame.seq < state.frame.seq) return // 回放帧晚到：保留更新帧
        set({ frame })
      },
      onState: (topic, nextState, controller) => {
        const state = get()
        if (!state.session || topic !== state.session.topic) return
        set({ session: { ...state.session, state: nextState as BState, controller } })
      },
      onStep: (topic, step: StreamStep) => {
        const state = get()
        if (!state.session || topic !== state.session.topic) return
        set({
          steps: mergeSteps(state.steps, [
            { ...step, browserSessionId: state.session.id, sessionId: state.session.sessionId } as BrowserStepInfo,
          ]),
        })
      },
      onSessionClosed: (topic, reason) => {
        const state = get()
        if (!state.session || topic !== state.session.topic) return
        set({
          session: { ...state.session, state: 'closed', closedAt: new Date().toISOString() },
          error: reason || undefined,
        })
        void get().load(state.session.sessionId)
      },
      onError: (topic, message, code) => {
        if (code === 'frames_dropped') return // 拥塞提示不打断体验
        if (code === 'session_gone') {
          // 服务端已销毁该会话（dev 重启 / 关闭后的回溯重订）：当前频道静默对齐，
          // 过期频道（会话切换残留）直接忽略——两者都不弹红条
          const state = get()
          if (state.session && topic === state.session.topic) {
            set({ error: undefined })
            reconcile()
          }
          return
        }
        set({ error: message })
        // 一键降级：一次性 takeover token 已消费 / 轮换失效 → 换发 watch 重订
        if (code === 'token_invalid' && topic) {
          const state = get()
          if (!state.session) return
          void issueToken(state.session.id, 'watch')
            .then((issued) => socket?.resubscribe(topic, issued.token, 'watch'))
            .catch((err: Error) => {
              // 换发时会话已消失：同样静默对齐，不弹红条
              if (isSessionGoneError(err)) reconcile()
            })
        }
      },
    })
    return socket
  }

  return {
    session: null,
    history: [],
    steps: [],
    frame: null,
    streamStatus: 'closed',
    mode: 'watch',
    maxFps: 12,
    loading: false,
    busy: false,

    load: async (sessionId) => {
      set({ sessionId, loading: true, error: undefined })
      try {
        const res = await apiGet<{ active: BrowserSessionInfo | null; history: BrowserSessionInfo[] }>(
          `/api/sessions/${sessionId}/browser`,
        )
        if (get().sessionId !== sessionId) return
        set({ session: res.active, history: res.history })
        if (res.active && res.active.state !== 'closed') {
          set({ frame: null, steps: [] })
          await loadSteps(res.active.id)
          await get().watch()
        } else {
          set({ frame: null, steps: [] })
        }
      } catch (err) {
        if (get().sessionId === sessionId) set({ error: (err as Error).message })
      } finally {
        if (get().sessionId === sessionId) set({ loading: false })
      }
    },

    start: async (opts) => {
      const sessionId = get().sessionId
      if (!sessionId) throw new Error('请先选择会话')
      set({ busy: true, error: undefined })
      try {
        const res = await apiPost<{ session: BrowserSessionInfo }>(`/api/sessions/${sessionId}/browser`, opts ?? {})
        set({ session: res.session, frame: null, steps: [] })
        await loadSteps(res.session.id)
        await get().watch()
      } catch (err) {
        set({ error: (err as Error).message })
        throw err
      } finally {
        set({ busy: false })
      }
    },

    watch: async () => {
      const session = get().session
      if (!session) return
      const issued = await issueToken(session.id, 'watch')
      const s = ensureSocket()
      s.connect()
      // 会话切换剪枝：去掉历史频道的登记，避免重连时对已销毁会话重订换来 session_gone
      s.keepOnly(issued.topic)
      s.subscribe(issued.topic, issued.token, 'watch', get().maxFps)
      set({ mode: 'watch' })
    },

    takeover: async () => {
      const session = get().session
      if (!session) return
      set({ busy: true, error: undefined })
      try {
        const issued = await issueToken(session.id, 'takeover')
        const s = ensureSocket()
        s.connect()
        s.resubscribe(issued.topic, issued.token, 'takeover')
        set({ mode: 'takeover', session: { ...session, controller: 'human' } })
      } catch (err) {
        if (isSessionGoneError(err)) {
          // 会话已不存在：静默对齐（面板回到未连接引导），不弹「会话不存在」红条
          reconcile()
          throw err
        }
        set({ error: (err as Error).message })
        throw err
      } finally {
        set({ busy: false })
      }
    },

    release: async () => {
      const session = get().session
      if (!session) return
      // 先走 WS 归还（服务端同时降级订阅为 watch），链路不可用时回退 REST
      if (socket && get().streamStatus === 'open') {
        socket.release(session.topic)
        set({ mode: 'watch', session: { ...session, controller: 'agent' } })
        return
      }
      try {
        const res = await apiPost<{ session: BrowserSessionInfo }>(`/api/browser/sessions/${session.id}/release`)
        set({ session: res.session, mode: 'watch' })
        await get().watch()
      } catch (err) {
        if (isSessionGoneError(err)) {
          reconcile()
          return
        }
        set({ error: (err as Error).message })
      }
    },

    setMaxFps: (fps) => {
      const next = Math.min(Math.max(Math.round(fps), 1), 30)
      set({ maxFps: next })
      socket?.setMaxFps(next)
    },

    sendInput: async (payload) => {
      const state = get()
      if (!state.session) return
      // 懒接管：观察态下先接管再输入（服务端二次校验，失败回显）
      if (state.mode !== 'takeover') {
        await get().takeover()
      }
      socket?.input(state.session.topic, payload)
    },

    openExternal: async (url) => {
      await apiPost('/api/browser/open-external', { url })
    },

    closeSession: async () => {
      const session = get().session
      if (!session) return
      set({ busy: true })
      try {
        await apiPost(`/api/browser/sessions/${session.id}/close`)
        set({ session: null, frame: null, mode: 'watch' })
        const sessionId = get().sessionId
        if (sessionId) {
          const res = await apiGet<{ active: BrowserSessionInfo | null; history: BrowserSessionInfo[] }>(
            `/api/sessions/${sessionId}/browser`,
          )
          set({ history: res.history })
        }
      } catch (err) {
        set({ error: (err as Error).message })
      } finally {
        set({ busy: false })
      }
    },

    detach: () => {
      viewHolders = 0
      socket?.close()
      socket = undefined
      set({ streamStatus: 'closed', frame: null })
    },

    retainView: () => {
      viewHolders++
    },

    releaseView: () => {
      viewHolders = Math.max(0, viewHolders - 1)
      if (viewHolders === 0) get().detach()
    },
  }
})

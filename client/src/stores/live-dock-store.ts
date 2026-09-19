/**
 * 操作直播窗（LiveDock，M22+）：Agent / 用户操作浏览器 / 数据库 / SSH 时的页面级悬浮直播层。
 *
 * 双视图分工：右栏面板 = 控制中心（管理 / 复盘 / 深度接管）；直播窗 = 实时观看 + 应急接管。
 * 两者共用 browser-store / connections-store，状态天然一致，无需同步代码。
 *
 * 规则（与设计稿一致）：
 * - 自动滑入：本 Run 首次 browser_* / db_* / ssh_exec 操作到达且未静音 → 展开为卡片；
 * - M49 让位协同：宽屏（>900px）且右栏正停在「实况」面板（操作已在右栏可见）→ 不自动滑入，
 *   仅对齐 tab 供手动展开（不消费 autoRunId）；手动 openDock 不受限，窄屏兜底不变；
 * - 静音：「关闭」= 本次运行不再自动弹出（命令面板 / 入口按钮可随时重开）；
 * - 回落：Run 结束 3s 后自动折叠为胶囊（保留复盘入口；新操作到达则取消回落）；
 * - 持久化：位置 / 尺寸存 localStorage（折叠态与展开态不持久，刷新后从关闭开始）。
 */
import { create } from 'zustand'
import type { OpEvent } from '@multi-agent/shared'
import { useSessionStore } from './session-store'
import { useUiStore } from './ui-store'

export type DockTab = 'browser' | 'db' | 'ssh'
export type DockMode = 'dock' | 'pill'

export interface DockPos {
  x: number
  y: number
}

export interface DockSize {
  w: number
  h: number
}

export const DOCK_DEFAULT_SIZE: DockSize = { w: 420, h: 320 }
export const DOCK_MIN_SIZE: DockSize = { w: 320, h: 200 }
export const DOCK_MAX_SIZE: DockSize = { w: 720, h: 640 }
/** 右下角默认锚点与视口边距 */
export const DOCK_ANCHOR_MARGIN = 16
/** 底部避让（composer 高度 + 间距） */
export const DOCK_BOTTOM_CLEARANCE = 88

const POS_KEY = 'ma.live-dock'

interface PersistedLayout {
  pos?: DockPos
  size?: DockSize
}

function loadLayout(): PersistedLayout {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(POS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as PersistedLayout
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

interface LiveDockState {
  /** 是否可见（胶囊或卡片均可） */
  visible: boolean
  mode: DockMode
  tab: DockTab
  /** 卡片左上角坐标；null = 未拖动过（按右下锚定自适应） */
  pos: DockPos | null
  size: DockSize
  /** 本次运行静音（不自动滑入） */
  muted: boolean
  /** 已自动滑入过的 runId（同一 Run 只弹一次） */
  autoRunId?: string
  /** 用户手动切 tab 的时间戳（60s 内不跟随操作类型抢切） */
  tabLockedAt?: number
  /** 最近一次操作事件（胶囊文案 / 数据库页数据源） */
  lastOp?: OpEvent
  /** 操作事件入口（ws-store 转发） */
  noteOp: (op: OpEvent) => void
  /** Run 开始：重置静音与自动弹出标记 */
  beginRun: () => void
  /** Run 结束：3s 后回落胶囊（新操作到达则取消） */
  finishRun: () => void
  openDock: (tab?: DockTab) => void
  setTab: (tab: DockTab) => void
  /** 折叠为胶囊（保留可见） */
  minimize: () => void
  /** 关闭（本次运行静音） */
  close: () => void
  /** 命令面板循环：隐藏 → 展开 → 折叠 → 展开 */
  toggle: () => void
  move: (x: number, y: number) => void
  resize: (w: number, h: number) => void
  /** 恢复默认布局（清除持久化位置） */
  resetLayout: () => void
}

/** 回落计时器（模块级：跨组件生命周期独立） */
let collapseTimer: ReturnType<typeof setTimeout> | undefined
/** 布局持久化防抖 */
let persistTimer: ReturnType<typeof setTimeout> | undefined

function cancelCollapse(): void {
  if (collapseTimer) {
    clearTimeout(collapseTimer)
    collapseTimer = undefined
  }
}

function schedulePersist(get: () => LiveDockState): void {
  if (typeof localStorage === 'undefined') return
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = undefined
    try {
      const { pos, size } = get()
      localStorage.setItem(POS_KEY, JSON.stringify({ pos, size }))
    } catch {
      // 存储不可用：忽略（布局仅内存生效）
    }
  }, 400)
}

const saved = loadLayout()

export const useLiveDockStore = create<LiveDockState>((set, get) => ({
  visible: false,
  mode: 'dock',
  tab: 'browser',
  pos: saved.pos ?? null,
  size: saved.size ?? DOCK_DEFAULT_SIZE,
  muted: false,

  noteOp: (op) => {
    const currentId = useSessionStore.getState().currentId
    if (op.sessionId && currentId && op.sessionId !== currentId) return // 仅当前会话的实况
    set({ lastOp: op })
    const asTab: DockTab | undefined =
      op.kind === 'browser' || op.kind === 'browser-input' || op.kind === 'takeover'
        ? 'browser'
        : op.kind === 'db'
          ? 'db'
          : op.kind === 'ssh'
            ? 'ssh'
            : undefined
    if (!asTab) return // 连接管理等非实况操作不驱动直播窗
    const s = get()
    cancelCollapse() // 新操作到达 → 取消回落
    const followTab = !s.tabLockedAt || Date.now() - s.tabLockedAt > 60_000
    if (s.visible) {
      // 可见（卡片或胶囊）：跟随操作类型切 tab（用户手动切过则 60s 内不抢），胶囊不展开
      const patch: Partial<LiveDockState> = {}
      if (followTab && s.tab !== asTab) patch.tab = asTab
      if (Object.keys(patch).length > 0) set(patch)
      return
    }
    if (s.muted) return
    // M49 让位协同：宽屏且右栏停在实况（面板可见操作）→ 不自动滑入；
    // 仅对齐 tab 供手动展开（不消费 autoRunId：离开实况后同 Run 仍可兜底滑入）
    // 右栏收起（rightPanelOpen=false）不算「可见」——照常兜底滑入，否则隐藏右栏后操作全不可见
    if (
      typeof window !== 'undefined' &&
      window.innerWidth > 900 &&
      useUiStore.getState().rightView === 'live' &&
      useUiStore.getState().rightPanelOpen
    ) {
      if (followTab && s.tab !== asTab) set({ tab: asTab })
      return
    }
    if (op.runId && s.autoRunId === op.runId) return // 同一 Run 只自动弹一次
    set({ visible: true, mode: 'dock', tab: asTab, autoRunId: op.runId ?? s.autoRunId })
  },

  beginRun: () => {
    cancelCollapse()
    set({ muted: false, autoRunId: undefined, tabLockedAt: undefined })
  },

  finishRun: () => {
    cancelCollapse()
    // 运行结束：3s 后回落为胶囊（保留复盘入口；期间新操作到达会取消）
    collapseTimer = setTimeout(() => {
      collapseTimer = undefined
      const s = get()
      if (s.visible && s.mode === 'dock') set({ mode: 'pill' })
    }, 3000)
  },

  openDock: (tab) => {
    cancelCollapse()
    set((s) => ({ visible: true, mode: 'dock', muted: false, tab: tab ?? s.tab, tabLockedAt: Date.now() }))
  },

  setTab: (tab) => {
    cancelCollapse()
    set({ visible: true, mode: 'dock', tab, tabLockedAt: Date.now() })
  },

  minimize: () => {
    cancelCollapse()
    set({ visible: true, mode: 'pill' })
  },

  close: () => {
    cancelCollapse()
    set({ visible: false, muted: true, mode: 'dock' })
  },

  toggle: () => {
    const s = get()
    if (!s.visible) get().openDock()
    else if (s.mode === 'dock') get().minimize()
    else get().openDock()
  },

  move: (x, y) => {
    set({ pos: { x, y } })
    schedulePersist(get)
  },

  resize: (w, h) => {
    set({ size: { w, h } })
    schedulePersist(get)
  },

  resetLayout: () => {
    set({ pos: null, size: DOCK_DEFAULT_SIZE })
    schedulePersist(get)
  },
}))

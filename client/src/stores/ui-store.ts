/**
 * UI 视图状态：主区 Tab、右栏视图、安静模式、交付件角标、消息定位。
 * M8 扩展：设置/命令面板/上下文抽屉开关、消息内联编辑、引用插入 Composer 通道。
 * M9 扩展：Trace 抽屉（指定 Run 的全链路时间轴）。
 * M12 扩展：快捷键帮助面板（? 键 / HeaderBar 入口）。
 * M17 扩展：协作图谱（第 7 视图，React Flow 懒加载）；邀请成员对话框。
 * M21 扩展：快速组队入口（命令面板 → 建会话对话框预选）。
 * M22 扩展：连接中心（连接/操作）与浏览器面板（帧流/接管/步骤）；面板清单见 components/panels/registry。
 * M23 扩展：主区「数据库」工作台（Navicat 式）与「终端」多会话（xterm）。
 * M26 扩展：连接中心自右栏迁入左侧 rail 控制台视图（全局资源统一管理维护）。
 * M31 扩展：主区「画布」Tab（无限画布与媒体创作工作台，React Flow 懒加载）。
 * M34 扩展：主区「行情」「博弈」面板 Tab 均已撤除——K 线 / 博弈改由会话内块（kline / game
 *   围栏）与画布节点（KlineNode / GameNode）承载，不再设独立面板页签。
 * M36 扩展：主区「设置」视图（自 M8 弹窗升级为独立主区页；settingsOpen 弹窗语义移除）。
 * M49（ADR 0100）：右栏「浏览器」并入「实况」面板（browser → live），一级导航收敛为
 *   团队 / 运行 / 实况两组一单（组记忆 lastOf，持久化 v2）；主区收敛为「对话 / 画布」
 *   + 深度工作台（deepFrom / expandWorkspace / closeWorkspaceView）。
 * 右栏显隐扩展（后补）：`rightPanelOpen`（宽屏三栏布局的收起 / 展开，入口 = 页签行收起钮 / 右缘
 *   把手 / ⌘B / 命令面板，localStorage 持久化）——setRightView 默认展开（用户选视图必有可见结果）；
 *   程序性跟随（live-panel-store 自动聚焦）传 `reveal: false`，尊重用户主动收起；窄屏为团队抽屉。
 * 左栏对称（后补）：`leftPanelOpen`（入口 = 会话头部收起钮 / 左缘浮动把手 / ⌘⇧B / 命令面板；窄屏为会话抽屉）。
 * M56 扩展：设置页分组聚焦请求（`settingsFocus`，画布生成面板 → 设置·媒体生成；nonce 可重触发）。
 */
import { create } from 'zustand'
import { confirmDiscardChanges } from '../lib/unsaved-changes'

export type MainTab = 'chat' | 'artifacts' | 'canvas' | 'database' | 'terminal'

/** M54 续完善：摇卦台打开请求（AppLayout 级全局宿主 PanTossHost 消费；compare = 对照基线快照，null = 无对照） */
export interface PanTossRequest {
  compare: { title: string; yao: Array<{ yin: boolean }> } | null
  sessionId?: string
}

/** M78：抽牌台打开请求（AppLayout 级全局宿主 TarotRitualHost 消费；preset = 入口预设） */
export interface TarotDrawRequest {
  sessionId?: string
  presetSpread?: 'single' | 'three' | 'cross'
  presetQuestion?: string
}

/** M26：应用级视图（左侧 ActivityRail 切换；workspace = 现有三栏工作台） */
// M27：新增 MCP 管理（第四入口）
// M26 延伸：连接管理（自右栏「连接」面板迁入，全局资源收口 rail）
// M36：设置（自弹窗升级为主区页，覆盖全部运行期设置与资源概览）
// M57：用户管理（admin；账号邀请 / 禁用 / 重置密码）
export type AppView = 'workspace' | 'materials' | 'agents' | 'skills' | 'mcp' | 'connections' | 'settings' | 'users'

export const APP_VIEWS: AppView[] = ['workspace', 'materials', 'agents', 'skills', 'mcp', 'connections', 'settings', 'users']

/** M26：应用视图持久化（刷新保持上次所在视图；非法值回退工作台） */
const APP_VIEW_KEY = 'ma:appView'
function loadAppView(): AppView {
  try {
    const v = localStorage.getItem(APP_VIEW_KEY)
    if (v && (APP_VIEWS as string[]).includes(v)) return v as AppView
  } catch {
    // 隐私模式 / 非浏览器环境：忽略，走默认
  }
  return 'workspace'
}

export type RightView =
  | 'members'
  | 'relay'
  | 'graph'
  | 'stats'
  | 'run'
  | 'tasks'
  | 'memory'
  | 'schedules'
  | 'metrics'
  | 'live'

/** 合法右栏视图清单（M24：localStorage 持久化时的校验白名单；M49：browser → live） */
export const RIGHT_VIEWS: RightView[] = [
  'members',
  'relay',
  'graph',
  'stats',
  'run',
  'tasks',
  'memory',
  'schedules',
  'metrics',
  'live',
]

/** M49（ADR 0100）：右栏一级分组（团队 / 运行为多子面板组；实况单子项，其 face 条即二级） */
export type RightGroup = 'team' | 'ops' | 'live'

export const GROUP_LABELS: Record<RightGroup, string> = { team: '团队', ops: '运行', live: '实况' }

/** 分组归属单一事实来源（registry 的 GROUPS 由此派生，避免 components → stores 反向依赖） */
export const RIGHT_GROUPS: Record<RightGroup, RightView[]> = {
  team: ['members', 'relay', 'graph', 'stats'],
  ops: ['run', 'tasks', 'memory', 'schedules', 'metrics'],
  live: ['live'],
}

/** 一级页签展示顺序 */
export const GROUP_ORDER: RightGroup[] = ['team', 'ops', 'live']

/** 视图 → 所属一级分组 */
export function groupOf(view: RightView): RightGroup {
  if ((RIGHT_GROUPS.team as RightView[]).includes(view)) return 'team'
  if ((RIGHT_GROUPS.ops as RightView[]).includes(view)) return 'ops'
  return 'live'
}

/** 右栏显隐持久化（宽屏三栏布局；窄屏为团队抽屉，同键不影响） */
const RIGHT_PANEL_KEY = 'ma:rightPanelOpen'

function loadRightPanelOpen(): boolean {
  try {
    return localStorage.getItem(RIGHT_PANEL_KEY) !== '0'
  } catch {
    // 隐私模式 / 非浏览器环境：忽略，默认展开
    return true
  }
}

function persistRightPanelOpen(open: boolean): void {
  try {
    localStorage.setItem(RIGHT_PANEL_KEY, open ? '1' : '0')
  } catch {
    // 持久化失败不影响切换
  }
}

/** 左栏显隐持久化（宽屏；窄屏为会话抽屉，同键不影响）——与右栏对称 */
const LEFT_PANEL_KEY = 'ma:leftPanelOpen'

function loadLeftPanelOpen(): boolean {
  try {
    return localStorage.getItem(LEFT_PANEL_KEY) !== '0'
  } catch {
    // 隐私模式 / 非浏览器环境：忽略，默认展开
    return true
  }
}

function persistLeftPanelOpen(open: boolean): void {
  try {
    localStorage.setItem(LEFT_PANEL_KEY, open ? '1' : '0')
  } catch {
    // 持久化失败不影响切换
  }
}

/** M24 右栏视图持久化；M49 升级 v2：`{ current, lastOf }`（组记忆）——
 *  v1 裸 id 自动迁移（browser → live），非法值回退「成员」。 */
const RIGHT_VIEW_KEY = 'ma:rightView'

interface PersistedRightState {
  current: RightView
  lastOf: Partial<Record<RightGroup, RightView>>
}

function normalizeView(v: unknown): RightView | undefined {
  if (typeof v !== 'string') return undefined
  const migrated = v === 'browser' ? 'live' : v
  return (RIGHT_VIEWS as string[]).includes(migrated) ? (migrated as RightView) : undefined
}

function loadRightState(): PersistedRightState {
  const fallback: PersistedRightState = { current: 'members', lastOf: {} }
  try {
    const raw = localStorage.getItem(RIGHT_VIEW_KEY)
    if (!raw) return fallback
    if (!raw.startsWith('{')) {
      // v1：裸 id 字符串
      const v = normalizeView(raw)
      return v ? { current: v, lastOf: {} } : fallback
    }
    const parsed = JSON.parse(raw) as { current?: unknown; lastOf?: unknown }
    const current = normalizeView(parsed.current) ?? 'members'
    const lastOf: Partial<Record<RightGroup, RightView>> = {}
    if (parsed.lastOf && typeof parsed.lastOf === 'object') {
      for (const g of GROUP_ORDER) {
        const v = normalizeView((parsed.lastOf as Record<string, unknown>)[g])
        if (v) lastOf[g] = v
      }
    }
    return { current, lastOf }
  } catch {
    // 隐私模式 / 非浏览器环境：忽略，走默认
    return fallback
  }
}

const initialRight = loadRightState()

/** 深度工作台视图（M49：主区按需展开，带返回） */
export type WorkspaceView = 'artifacts' | 'database' | 'terminal'

interface UiState {
  /** M26：应用级视图（ActivityRail；控制台不卸载 AppLayout，仅切换主区） */
  appView: AppView
  mainTab: MainTab
  /** M49：深度工作台展开前的主 tab（'chat' | 'canvas'；closeWorkspaceView 的返回目标） */
  deepFrom?: MainTab
  rightView: RightView
  /** M49：一级分组记忆（点一级页签回到该组上次子面板；首次 = 组内首子项） */
  lastOf: Partial<Record<RightGroup, RightView>>
  /** 右栏显隐（宽屏；页签行收起钮 / 右缘把手 / ⌘B；切换右栏视图默认展开，程序性跟随不抢展开） */
  rightPanelOpen: boolean
  /** 左栏显隐（宽屏；会话头部收起钮 / 左缘把手 / ⌘⇧B；与右栏对称） */
  leftPanelOpen: boolean
  sessionDrawer: boolean
  setSessionDrawer: (open: boolean) => void
  /** M79-C：左栏页签（会话 | 联系人；联系人入口仅多用户模式渲染） */
  leftTab: 'sessions' | 'contacts'
  /** M79-F：会话列表筛选 chip（团队 / 聊天；默认选中第一个「团队」，点选过滤 / 再点取消回全部；仅多用户模式渲染） */
  sessionFilter: 'all' | 'team' | 'chat'
  /** M79-F：请求打开「新建群聊」对话框（联系人面板消费；nonce 保证重复触发） */
  groupCreateRequest?: { nonce: number }
  /** 安静模式：关闭全部趣味动画（§20.6） */
  quietMode: boolean
  /** 停留在对话页时新交付件计数（Tab 上的小角标） */
  newArtifactCount: number
  /** M31 修订：不在画布页时 agent 画布写入计数（主区「画布」页签角标；切到画布即清零） */
  newCanvasCount: number
  /** M31 修订：其他会话的画布写入标记（会话列表小点；切到该会话即清零） */
  otherCanvasWrites: Record<string, number>
  /** 最近一次更新的交付件路径（树高亮用） */
  lastArtifactPath?: string
  /** 接力目标（消息交付件 chip 点击 → 跳交付件页并选中） */
  requestedArtifactPath?: string
  /** 消息定位请求（右侧接力视图点击 → 对话区滚动 + 闪光；nonce 保证重复点击可重触发） */
  focusRequest?: { id: string; seq?: number; nonce: number }
  /** M8：⌘K 命令面板 */
  commandOpen: boolean
  /** M8：上下文抽屉（底栏电池点击 / 命令面板） */
  contextOpen: boolean
  /** M8：内联编辑中的用户消息 id（编辑重发） */
  editingMessageId?: string
  /** IM：引用回复目标（Composer 顶部引用条；发送后清除） */
  replyTarget?: { sessionId: string; messageId: string; authorName?: string; excerpt: string; deleted?: boolean }
  /** M8：向 Composer 插入文本的请求（引用 / @文件 / 命令面板；nonce 保证重复内容可重触发） */
  composerInsert?: { text: string; nonce: number }
  /** M56：设置页分组聚焦请求（画布生成面板 → 设置·媒体生成；nonce 保证重复点击可重触发） */
  settingsFocus?: { section: string; nonce: number }
  /** M9：Trace 抽屉（指定 Run 的全链路时间轴；undefined 关闭） */
  traceRunId?: string
  /** M12：快捷键帮助面板 */
  helpOpen: boolean
  /** M16：邀请成员对话框（成员视图底部 / CommandPalette 共用） */
  inviteOpen: boolean
  /** M21：请求打开建会话对话框并预选来源（快速组队 / 场景；nonce 保证重复选择可重触发） */
  pendingCreate?: { kind?: 'preset' | 'scene' | 'agent'; id?: string; draft?: string; nonce: number }
  setMainTab: (tab: MainTab) => void
  /** M26：切换应用视图（含 localStorage 持久化） */
  setAppView: (view: AppView) => boolean
  /** 切换右栏视图；默认展开右栏（`reveal: false` = 程序性切换不抢展开，用于自动跟随） */
  setRightView: (view: RightView, opts?: { reveal?: boolean }) => void
  setRightPanelOpen: (open: boolean) => void
  /** ⌘B：右栏收起 / 展开（持久化） */
  toggleRightPanel: () => void
  setLeftPanelOpen: (open: boolean) => void
  /** ⌘⇧B：左栏收起 / 展开（持久化） */
  toggleLeftPanel: () => void
  /** M79-C：切换左栏页签（会话 | 联系人） */
  setLeftTab: (tab: 'sessions' | 'contacts') => void
  /** M79-F：会话列表筛选 chip */
  setSessionFilter: (filter: 'all' | 'team' | 'chat') => void
  /** M79-F：请求打开「新建群聊」对话框（非管理员路径；联系人面板消费） */
  requestGroupCreate: () => void
  consumeGroupCreate: () => void
  /** M49：展开深度工作台（交付件 / 数据库 / 终端；deepFrom 记录返回目标） */
  expandWorkspace: (view: WorkspaceView) => void
  /** M49：关闭深度工作台，返回展开前的主 tab */
  closeWorkspaceView: () => void
  toggleQuietMode: () => void
  /** artifact:updated 通知入口（累计角标，等待实况面 / 交付件工作台「看到即清零」） */
  noteArtifact: (path?: string) => void
  /** 交付件角标清零（实况·交付件面可见 / 打开交付件工作台时调用） */
  clearArtifactCount: () => void
  /** M31 修订：agent 画布写入通知入口（非画布页时累计角标，切到画布即清零） */
  noteCanvasWrite: (count?: number) => void
  /** M31 修订：画布角标清零（进入画布 / 合流看到写入时调用） */
  clearCanvasCount: () => void
  /** M31 修订：其他会话的画布写入（会话列表小点；跨会话 agent 写入提示） */
  noteOtherCanvasWrite: (sessionId: string) => void
  /** M31 修订：清零指定会话的画布写入标记（切到该会话时） */
  clearOtherCanvasWrite: (sessionId: string) => void
  /** 交付件 chip 跳转：请求选中（右栏实况·交付件面钉住由 live-panel-store 订阅响应） */
  requestArtifact: (path: string) => void
  consumeArtifactRequest: () => void
  /** 定位消息：切回对话页并闪光指定消息 */
  focusMessage: (id: string, seq?: number) => void
  clearFocus: () => void
  setCommandOpen: (open: boolean) => void
  setContextOpen: (open: boolean) => void
  /** 开始/结束内联编辑（undefined 结束） */
  startEditMessage: (id?: string) => void
  /** 进入引用回复（target 为空 = 取消） */
  startReply: (target?: UiState['replyTarget']) => void
  /** 引用到输入框：切回对话页并排队插入 */
  insertToComposer: (text: string) => void
  consumeComposerInsert: () => void
  /** M79-AD：「在 3D 工作台打开」请求（store 通道——工作台挂载后消费，根治事件时序竞态） */
  pendingStudioOpen: string | null
  setPendingStudioOpen: (path: string | null) => void
  /** M56：请求聚焦设置页某分组（调用方通常随即 setAppView('settings')） */
  requestSettingsFocus: (section: string) => void
  consumeSettingsFocus: () => void
  /** M9：打开/关闭 Trace 抽屉 */
  openTrace: (runId: string) => void
  closeTrace: () => void
  setHelpOpen: (open: boolean) => void
  setInviteOpen: (open: boolean) => void
  /** M21：命令面板 → 建会话对话框（SessionList 消费后直接进入成员微调步）；返回 false = 用户取消离开 */
  requestCreate: (kind?: 'preset' | 'scene' | 'agent', id?: string, draft?: string) => boolean
  consumeCreate: () => void
  /** M54 续完善：摇卦台打开请求（全局宿主消费；null = 关闭）——弹窗不随消息行回收 / 面板卸载消失 */
  panToss: PanTossRequest | null
  /** M54 续完善：请求打开摇卦台（消息卡 / 面板内卡 / 面板头部入口共用同一宿主） */
  openPanToss: (req: PanTossRequest) => void
  /** M54 续完善：关闭摇卦台 */
  closePanToss: () => void
  /** M78：抽牌台打开请求（全局宿主消费；null = 关闭）——弹窗不随消息行回收 / 面板卸载消失 */
  tarotDraw: TarotDrawRequest | null
  /** M78：请求打开抽牌台（面板入口 / 消息卡 / 图鉴手记共用同一宿主） */
  openTarotDraw: (req: TarotDrawRequest) => void
  closeTarotDraw: () => void
  /** M78：78 张图鉴弹窗开关（同一宿主族） */
  tarotCodex: boolean
  openTarotCodex: () => void
  closeTarotCodex: () => void
  /** M78：抽牌手记弹窗开关（同一宿主族） */
  tarotJournal: boolean
  openTarotJournal: () => void
  closeTarotJournal: () => void
}

export const useUiStore = create<UiState>((set, get) => ({
  pendingStudioOpen: null,
  appView: loadAppView(),
  mainTab: 'chat',
  rightView: initialRight.current,
  lastOf: initialRight.lastOf,
  rightPanelOpen: loadRightPanelOpen(),
  leftPanelOpen: loadLeftPanelOpen(),
  sessionDrawer: false,
  setSessionDrawer: (open) => set({ sessionDrawer: open }),
  leftTab: 'sessions',
  sessionFilter: 'team',
  quietMode: false,
  newArtifactCount: 0,
  newCanvasCount: 0,
  otherCanvasWrites: {},
  commandOpen: false,
  contextOpen: false,
  helpOpen: false,
  inviteOpen: false,
  panToss: null,
  tarotDraw: null,
  tarotCodex: false,
  tarotJournal: false,

  setMainTab: (tab) => {
    if (tab === 'artifacts') set({ mainTab: tab, newArtifactCount: 0 })
    // 回到常态层（对话 / 画布）清除深看返回目标；进画布即清零写入角标（同交付件模式）
    else if (tab === 'chat' || tab === 'canvas') set({ mainTab: tab, deepFrom: undefined, ...(tab === 'canvas' ? { newCanvasCount: 0 } : {}) })
    else set({ mainTab: tab })
  },
  setAppView: (view) => {
    if (view !== get().appView && !confirmDiscardChanges()) return false
    try {
      localStorage.setItem(APP_VIEW_KEY, view)
    } catch {
      // 持久化失败不影响切换
    }
    set({ appView: view })
    return true
  },
  setRightView: (view, opts) => {
    const lastOf = { ...get().lastOf, [groupOf(view)]: view }
    try {
      localStorage.setItem(RIGHT_VIEW_KEY, JSON.stringify({ current: view, lastOf }))
    } catch {
      // 持久化失败不影响切换
    }
    // 用户选视图（命令面板 / 跳转入口）→ 必展开；自动跟随传 reveal:false（收起态即用户的显式意图）
    const reveal = opts?.reveal ?? true
    if (reveal) persistRightPanelOpen(true)
    set(reveal ? { rightView: view, lastOf, rightPanelOpen: true } : { rightView: view, lastOf })
  },
  setRightPanelOpen: (open) => {
    persistRightPanelOpen(open)
    set({ rightPanelOpen: open })
  },
  toggleRightPanel: () => {
    const next = !get().rightPanelOpen
    persistRightPanelOpen(next)
    set({ rightPanelOpen: next })
  },
  setLeftPanelOpen: (open) => {
    persistLeftPanelOpen(open)
    set({ leftPanelOpen: open })
  },
  toggleLeftPanel: () => {
    const next = !get().leftPanelOpen
    persistLeftPanelOpen(next)
    set({ leftPanelOpen: next })
  },
  setLeftTab: (tab) => set({ leftTab: tab }),
  setSessionFilter: (filter) => set({ sessionFilter: filter }),
  requestGroupCreate: () => set((s) => ({ groupCreateRequest: { nonce: (s.groupCreateRequest?.nonce ?? 0) + 1 } })),
  consumeGroupCreate: () => set({ groupCreateRequest: undefined }),
  expandWorkspace: (view) =>
    set((s) => ({
      // 从深度工作台再展开另一工作台（dd → 终端）时保留原返回目标
      deepFrom: s.deepFrom ?? (s.mainTab === 'chat' || s.mainTab === 'canvas' ? s.mainTab : 'chat'),
      mainTab: view,
      ...(view === 'artifacts' ? { newArtifactCount: 0 } : {}),
    })),
  closeWorkspaceView: () => set((s) => ({ mainTab: s.deepFrom ?? 'chat', deepFrom: undefined })),
  toggleQuietMode: () => {
    const next = !get().quietMode
    set({ quietMode: next })
    document.documentElement.classList.toggle('quiet-mode', next)
  },
  noteArtifact: (path) =>
    set((s) => ({
      newArtifactCount: s.newArtifactCount + 1,
      lastArtifactPath: path ?? s.lastArtifactPath,
    })),
  clearArtifactCount: () => set({ newArtifactCount: 0 }),
  noteCanvasWrite: (count = 1) => set((s) => ({ newCanvasCount: s.newCanvasCount + count })),
  clearCanvasCount: () => set({ newCanvasCount: 0 }),
  noteOtherCanvasWrite: (sessionId) =>
    set((s) => ({ otherCanvasWrites: { ...s.otherCanvasWrites, [sessionId]: (s.otherCanvasWrites[sessionId] ?? 0) + 1 } })),
  clearOtherCanvasWrite: (sessionId) =>
    set((s) => {
      if (!s.otherCanvasWrites[sessionId]) return s
      const next = { ...s.otherCanvasWrites }
      delete next[sessionId]
      return { otherCanvasWrites: next }
    }),
  requestArtifact: (path) => set({ requestedArtifactPath: path, newArtifactCount: 0 }),
  consumeArtifactRequest: () => set({ requestedArtifactPath: undefined }),
  focusMessage: (id, seq) =>
    set((s) => ({
      mainTab: 'chat',
      focusRequest: { id, ...(seq !== undefined ? { seq } : {}), nonce: (s.focusRequest?.nonce ?? 0) + 1 },
    })),
  clearFocus: () => set({ focusRequest: undefined }),
  setCommandOpen: (open) => set({ commandOpen: open }),
  setContextOpen: (open) => set({ contextOpen: open }),
  startEditMessage: (id) => set({ editingMessageId: id }),
  startReply: (target) => set({ replyTarget: target, ...(target ? { mainTab: 'chat' as const } : {}) }),
  insertToComposer: (text) =>
    set((s) => ({
      mainTab: 'chat',
      composerInsert: { text, nonce: (s.composerInsert?.nonce ?? 0) + 1 },
    })),
  consumeComposerInsert: () => set({ composerInsert: undefined }),
  setPendingStudioOpen: (path) => set({ pendingStudioOpen: path }),
  requestSettingsFocus: (section) =>
    set((s) => ({ settingsFocus: { section, nonce: (s.settingsFocus?.nonce ?? 0) + 1 } })),
  consumeSettingsFocus: () => set({ settingsFocus: undefined }),
  openTrace: (runId) => set({ traceRunId: runId }),
  closeTrace: () => set({ traceRunId: undefined }),
  setHelpOpen: (open) => set({ helpOpen: open }),
  setInviteOpen: (open) => set({ inviteOpen: open }),
  requestCreate: (kind, id, draft) => {
    // 与 setAppView 共用离开保护：用户取消放弃修改时不再切视图 / 排队创建
    if (!get().setAppView('workspace')) return false
    set((s) => ({
      pendingCreate: { kind, id, draft, nonce: (s.pendingCreate?.nonce ?? 0) + 1 },
      leftTab: 'sessions',
      leftPanelOpen: true,
      // 窄屏只有抽屉里的 SessionList 消费 pendingCreate：同时打开抽屉，否则组队台不会弹出（宽屏忽略此标记）
      sessionDrawer: true,
    }))
    return true
  },
  consumeCreate: () => set({ pendingCreate: undefined }),
  openPanToss: (req) => set({ panToss: req }),
  closePanToss: () => set({ panToss: null }),
  openTarotDraw: (req) => set({ tarotDraw: req }),
  closeTarotDraw: () => set({ tarotDraw: null }),
  openTarotCodex: () => set({ tarotCodex: true }),
  closeTarotCodex: () => set({ tarotCodex: false }),
  openTarotJournal: () => set({ tarotJournal: true }),
  closeTarotJournal: () => set({ tarotJournal: false }),
}))

/**
 * 三栏布局（§10.2 + M8；M23 主区扩展；M26 左侧 ActivityRail；M31 画布；M36 设置主区页）：
 * 会话列表 | 主区（对话 / 画布 + 深度工作台）| 团队面板。
 * - 顶栏通栏（全宽）：品牌 + 实时连接状态 / 安静模式 / 快捷键帮助（命令面板为 ⌘K 键盘直达，无按钮）；
 *   设置入口收在 rail 底部（M36 起为主区视图）；
 * - 主区：ErrorBoundary；上下文电池（ContextBar）随 Composer 底栏展示，断线提示条（ConnectionBanner）位于顶栏下方主区内；
 * - M49（ADR 0100）：主区顶栏收敛为「对话 / 画布」两页签；交付件 / 数据库 / 终端改为按需展开的
 *   深度工作台（expandWorkspace，头部替换为「← 返回 | 工作台标题」；入口在右栏实况面板展开钮 /
 *   底栏跳转 / 命令面板）；
 * - 数据库工作台与 SSH 终端按需懒加载（xterm 等独立 chunk，不进首屏）；画布（React Flow）同样懒加载；
 * - M34：主区「行情」「博弈」面板 Tab 均已撤除——K 线 / 博弈改由会话内块（kline / game 围栏）
 *   与画布节点承载（见 nodes/GameNode · KlineNode 与 md-ext/GameBlock · KlineBlock）；
 * - M26：顶栏下方为最左 ActivityRail（44px）常驻；appView !== workspace 时主区切控制台
 *   （AppLayout 不卸载，WS 生命周期与运行状态保持；HeaderBar 与 rail 保留）；
 * - 面板显隐：左钮管左栏——主区左缘垂直中部悬浮把手（LeftPanelEdgeHandle：默认不展示、悬停淡入，
 *   单个折角箭头方向随态翻转）/ 右钮管右栏——右对齐于主区头部最右端、面板样式图标（PanelToggleButton
 *   常驻双态：展开态 = 「隐藏」、收起态 =「显示」），与 ⌘B / ⌘⇧B、命令面板「左 · 右栏：显示 / 隐藏」同源；
 *   宽屏收起三栏分栏、窄屏开关对应抽屉（入口在顶栏 / 底部成员条）；收起后主区独占剩余空间，
 *   三栏比例在收起 / 展开间原位恢复；
 * - <900px 响应式：会话与团队折叠为抽屉 + 底部成员条（@ 快捷入口）；窄屏同样保留 rail。
 */
import * as React from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import {
  ArrowLeft,
  Bell,
  BellOff,
  ChevronLeft,
  ChevronRight,
  Keyboard,
  PanelLeft,
  PanelRight,
  PanelRightClose,
  PanelRightOpen,
  UserRound,
} from 'lucide-react'
import { useMediaQuery } from '../../lib/hooks'
import { memberViews } from '../../lib/members'
import { cn } from '../../lib/utils'
import { useAgentStore } from '../../stores/agent-store'
import { useAuthStore } from '../../stores/auth-store'
import { useSessionStore } from '../../stores/session-store'
import { useUiStore, type MainTab } from '../../stores/ui-store'
import { useWsStore } from '../../stores/ws-store'
import { attachActiveRunFor } from '../../stores/run-store'
import { AccountDialog } from '../account/AccountDialog'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog'
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs'
import { AgentAvatar } from '../agents/AgentAvatar'
import { SessionList } from '../sessions/SessionList'
import { ChatArea } from '../chat/ChatArea'
import { ArtifactsView } from '../artifacts/ArtifactsView'
import { TeamPanel } from '../team/TeamPanel'
import { CommandPalette } from './CommandPalette'
import { ConnectionBanner } from './ConnectionBanner'
import { ErrorBoundary } from './ErrorBoundary'
import { ShortcutHelp } from './ShortcutHelp'
import { TraceDrawer } from '../observability/TraceDrawer'
import { LiveDock } from '../live/LiveDock'
// M54 续完善：摇卦台全局宿主（自消息行内上提——弹窗不随虚拟列表行回收 / 面板卸载消失）
import { PanTossHost } from '../chat/md-ext/pan/TossHost'
// M78：塔罗抽牌台全局宿主（抽牌台 / 图鉴 / 手记同族；不放主 chunk，内部 React.lazy）
import { TarotRitualHost } from '../chat/md-ext/tarot/TarotRitualHost'
// M26：左侧图标导航栏 + 资产控制台（Agent / Skill / 连接 管理）
import { ActivityRail } from '../console/ActivityRail'
import { AgentConsole } from '../console/AgentConsole'
import { SkillConsole } from '../console/SkillConsole'
import { ConnectionsConsole } from '../console/ConnectionsConsole'
// M68：用户素材库（全员可见的个人资源视图）
import { MaterialsConsole } from '../console/MaterialsConsole'
// M27：MCP 管理台（服务器 CRUD / 生命周期 / 会话绑定 / 工具可达性）
import { McpConsole } from '../mcp/McpConsole'
// M36：设置（自弹窗升级为主区页：26 项运行期设置 + 资源概览 + 系统信息；M57：成员见个人偏好视图）
import { SettingsView } from '../settings/SettingsView'
import { PersonalSettingsView } from '../settings/PersonalSettingsView'
// M57：用户管理（admin；邀请制建号 / 禁用 / 重置密码）
import { UsersConsole } from '../console/UsersConsole'

/** 主区懒加载（M23）：数据库工作台 / SSH 终端按需分包（xterm + fit 约 300KB，不进首屏） */
const DatabaseWorkbench = React.lazy(() =>
  import('../database/DatabaseWorkbench').then((m) => ({ default: m.DatabaseWorkbench })),
)
const TerminalView = React.lazy(() => import('../terminal/TerminalView').then((m) => ({ default: m.TerminalView })))

/** 主区懒加载（M31）：画布与媒体创作（React Flow 舞台 + 生成面板，不进首屏） */
const CanvasView = React.lazy(() => import('../canvas/CanvasView').then((m) => ({ default: m.CanvasView })))

/** M49：深度工作台标题（主区深看态头部；返回目标见 ui-store.deepFrom） */
const DEEP_TITLE: Partial<Record<MainTab, string>> = {
  artifacts: '交付件',
  database: '数据库工作台',
  terminal: 'SSH 终端',
}

/** 顶栏（M26 通栏）：品牌 + 实时连接状态 / 安静模式 / 快捷键帮助。
 *  安静模式为全局 UI 偏好（ui-store.quietMode），自右栏面板头部上移于此：
 *  右栏可拖窄、页签区不挤占开关位；窄屏团队抽屉收起时开关仍全局可达。
 *  （后补）命令面板与面板显隐撤出顶栏：命令面板 = ⌘K 键盘直达；面板显隐收敛于主区
 *  （左 = 左缘悬浮把手 LeftPanelEdgeHandle / 右 = 头部最右端 PanelToggleButton），键盘路径 ⌘B（右）/ ⌘⇧B（左）。 */
export function HeaderBar({ narrow, onOpenSessions }: { narrow?: boolean; onOpenSessions?: () => void }): React.JSX.Element {
  const wsStatus = useWsStore((s) => s.status)
  const quietMode = useUiStore((s) => s.quietMode)
  const toggleQuietMode = useUiStore((s) => s.toggleQuietMode)
  // M57：账号入口（当前身份 / 修改密码 / 用户管理 / 退出登录）
  const user = useAuthStore((s) => s.user)
  const [accountOpen, setAccountOpen] = React.useState(false)

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b bg-card/80 px-3 shadow-sm shadow-slate-900/5 backdrop-blur-md sm:px-4">
      {narrow && onOpenSessions && (
        <Button variant="ghost" size="icon-sm" title="会话列表" onClick={onOpenSessions}>
          <PanelLeft className="size-4" />
        </Button>
      )}
      <div className="flex items-center gap-2">
        <img src="/favicon.svg" alt="" className="size-[18px]" />
        <span className="text-[13.5px] font-bold tracking-tight">Owli Team</span>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px]',
            wsStatus === 'open'
              ? 'border-emerald-600/20 text-emerald-700'
              : wsStatus === 'connecting'
                ? 'border-amber-500/25 text-amber-700'
                : 'border-border text-muted-foreground',
          )}
        >
          <span
            className={cn(
              'size-1.5 rounded-full',
              wsStatus === 'open' ? 'bg-emerald-500' : wsStatus === 'connecting' ? 'bg-amber-400' : 'bg-slate-300',
            )}
          />
          <span className="hidden sm:inline">
            {wsStatus === 'open' ? '通知已连接' : wsStatus === 'connecting' ? '连接中' : '降级轮询'}
          </span>
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          title={quietMode ? '退出安静模式' : '安静模式（关闭趣味动画）'}
          onClick={toggleQuietMode}
        >
          {quietMode ? <BellOff className="size-4" /> : <Bell className="size-4" />}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="hidden sm:inline-flex"
          title="快捷键帮助（?）"
          onClick={() => useUiStore.getState().setHelpOpen(true)}
        >
          <Keyboard className="size-4" />
        </Button>
        {/* M57：账号入口（修改密码 / 用户管理 / 退出登录） */}
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-[12px]"
          title="账号（修改密码 / 退出登录）"
          onClick={() => setAccountOpen(true)}
        >
          <UserRound className="size-4" />
          <span className="hidden max-w-[120px] truncate sm:inline">{user?.displayName ?? '账号'}</span>
        </Button>
      </div>
      <AccountDialog open={accountOpen} onOpenChange={setAccountOpen} />
    </header>
  )
}

/** 面板显隐钮（左 = 主区左缘悬浮把手内 / 右 = 主区头部最右端）：常驻双态——展开态 = 「隐藏 X 栏」、
 *  收起态 = 「显示 X 栏」，左钮折角箭头方向随态翻转（展开 = 向左收起 / 收起 = 向右展开）；
 *  与 ⌘B / ⌘⇧B、命令面板同源；仅宽屏渲染（窄屏抽屉入口在顶栏 / 底部成员条）。 */
export function PanelToggleButton({
  side,
  className,
}: {
  side: 'left' | 'right'
  className?: string
}): React.JSX.Element {
  const open = useUiStore((s) => (side === 'left' ? s.leftPanelOpen : s.rightPanelOpen))
  const toggle = useUiStore((s) => (side === 'left' ? s.toggleLeftPanel : s.toggleRightPanel))
  const name = side === 'left' ? '左栏' : '右栏'
  const keys = side === 'left' ? '⌘⇧B' : '⌘B'
  const Icon = side === 'left' ? (open ? ChevronLeft : ChevronRight) : open ? PanelRightClose : PanelRightOpen
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className={className}
      title={`${open ? '隐藏' : '显示'}${name}（${keys}）`}
      onClick={toggle}
    >
      <Icon className="size-4" />
    </Button>
  )
}

/** 左栏显隐·主区左缘悬浮把手（宽屏）：垂直居中于主区左缘——默认不展示，悬停左缘热区淡入、
 *  移开淡出；点击收起 / 展开左栏（单个折角箭头，方向随态翻转）。与 ⌘⇧B、命令面板同源。 */
export function LeftPanelEdgeHandle(): React.JSX.Element {
  return (
    <div className="group absolute left-0 top-1/2 z-10 -translate-y-1/2 py-3 pr-3">
      <PanelToggleButton
        side="left"
        className="-ml-px h-9 w-4 rounded-l-none rounded-r-md border border-l-0 bg-card/90 text-muted-foreground opacity-0 shadow-sm backdrop-blur [&_svg]:size-3 group-hover:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100"
      />
    </div>
  )
}

/** 底部成员条（窄屏）：横向 @ 快捷入口 + 团队抽屉开关；M77：按成员实例渲染（分身 = 名字·灵魂名） */
function BottomMemberBar({ onOpenTeam }: { onOpenTeam: () => void }): React.JSX.Element {
  const agents = useAgentStore((s) => s.agents)
  const sessions = useSessionStore((s) => s.sessions)
  const currentId = useSessionStore((s) => s.currentId)
  const session = sessions.find((s) => s.id === currentId)
  const members = React.useMemo(() => memberViews(agents, session), [agents, session])

  return (
    <div className="flex h-12 shrink-0 items-center gap-1.5 overflow-x-auto border-t bg-card/80 px-2 backdrop-blur">
      <Button variant="outline" size="xs" className="shrink-0" onClick={onOpenTeam} title="打开团队面板">
        <PanelRight className="size-3.5" />
        团队
      </Button>
      {members.map((m) => (
        <button
          key={m.key}
          type="button"
          title={`@${m.label}（插入到输入框）`}
          className="flex shrink-0 items-center gap-1.5 rounded-full border bg-card py-0.5 pl-0.5 pr-2.5 text-[11.5px] transition-colors hover:border-primary/30 hover:bg-primary/5"
          onClick={() => {
            useUiStore.getState().setMainTab('chat')
            useUiStore.getState().insertToComposer(`@${m.label} `)
          }}
        >
          <AgentAvatar agent={m.agent} size={18} animated={false} />
          {m.label}
        </button>
      ))}
      {members.length === 0 && (
        <span className="px-1 text-[11.5px] text-muted-foreground">当前会话暂无成员 · 首条消息将自动组队</span>
      )}
    </div>
  )
}

/** 目标像素宽 → 面板百分比（react-resizable-panels v2 仅支持百分比）：宽屏下按像素精确生效；
 *  仅以小屏百分比上限兜底（避免「小窗口里 280px 换算成 30%+」占掉主区）。 */
function toPanelSize(px: number, maxPct: number): number {
  const viewport = typeof window === 'undefined' ? 1440 : window.innerWidth
  return Math.min(maxPct, (px / viewport) * 100)
}

export function AppLayout(): React.JSX.Element {
  const mainTab = useUiStore((s) => s.mainTab)
  const setMainTab = useUiStore((s) => s.setMainTab)
  // M31 修订：画布页签未读角标（agent 写入计数；进画布即清零）
  const newCanvasCount = useUiStore((s) => s.newCanvasCount)
  const appView = useUiStore((s) => s.appView)
  // M57：成员不渲染管理面控制台（ActivityRail 已隐藏入口；此处兑底直接造访）
  const isAdmin = useAuthStore((s) => s.isAdmin)
  const deepFrom = useUiStore((s) => s.deepFrom)
  const closeWorkspaceView = useUiStore((s) => s.closeWorkspaceView)
  const rightPanelOpen = useUiStore((s) => s.rightPanelOpen)
  const leftPanelOpen = useUiStore((s) => s.leftPanelOpen)
  const narrow = useMediaQuery('(max-width: 900px)')
  // 左栏（会话）宽度：默认约 200px、最窄可拖到约 160px；小屏上限 17%/15%
  const sessionDefault = toPanelSize(200, 17)
  const sessionMin = toPanelSize(160, 15)
  const [sessionDrawer, setSessionDrawer] = React.useState(false)
  const [teamDrawer, setTeamDrawer] = React.useState(false)
  /** 三栏比例记忆（右栏收起 / 展开原位恢复；收起期间的拖动按比例折叠回三栏，展开无跳变） */
  const paneLayout = React.useRef<number[] | null>(null)

  const handleSelect = React.useCallback(async (id: string): Promise<void> => {
    await useSessionStore.getState().selectSession(id)
    useWsStore.getState().ensureSubscribed(id)
    useWsStore.getState().markRead(id)
    await attachActiveRunFor(id)
  }, [])

  // 启动引导：角色/技能元数据 + 会话列表 → WS 初始化 → 自动选中第一个会话
  React.useEffect(() => {
    void useAgentStore.getState().load()
    void useSessionStore
      .getState()
      .loadSessions()
      .then(() => {
        useWsStore.getState().init()
        const state = useSessionStore.getState()
        if (!state.currentId && state.sessions.length > 0) {
          void handleSelect(state.sessions[0].id)
        }
      })
      .catch(() => undefined)
  }, [handleSelect])

  // Alt+1..9 切换会话（§20.2）
  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return
      const n = Number(e.key)
      if (!Number.isInteger(n) || n < 1 || n > 9) return
      const sessions = useSessionStore.getState().sessions
      if (n <= sessions.length) {
        e.preventDefault()
        void handleSelect(sessions[n - 1].id)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handleSelect])

  // ⌘K / Ctrl+K 命令面板（M8）
  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        const ui = useUiStore.getState()
        ui.setCommandOpen(!ui.commandOpen)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  /** 右栏显隐入口（宽屏 = 分栏收起；窄屏 = 团队抽屉开关）：页签行收起钮 / 右缘把手 / ⌘B 共用 */
  const toggleRightPane = React.useCallback((): void => {
    if (narrow) setTeamDrawer((v) => !v)
    else useUiStore.getState().toggleRightPanel()
  }, [narrow])

  /** 左栏显隐入口（宽屏 = 分栏收起；窄屏 = 会话抽屉开关）：会话头部收起钮 / 左缘把手 / ⌘⇧B 共用 */
  const toggleLeftPane = React.useCallback((): void => {
    if (narrow) setSessionDrawer((v) => !v)
    else useUiStore.getState().toggleLeftPanel()
  }, [narrow])

  // ⌘B / Ctrl+B 右栏显隐；⌘⇧B / Ctrl+Shift+B 左栏显隐（与 ⌘K 同款：输入态不拦）
  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        if (e.shiftKey) toggleLeftPane()
        else toggleRightPane()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [toggleRightPane, toggleLeftPane])

  // ? 快捷键帮助（M12）：输入态不拦截（避免打不出问号）；⌘⇧/ 同效
  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== '?' && !((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === '/')) return
      const target = e.target as HTMLElement | null
      if (target?.closest('input, textarea, [contenteditable="true"]')) return
      e.preventDefault()
      const ui = useUiStore.getState()
      ui.setHelpOpen(!ui.helpOpen)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  /** M49：深看态判定（交付件 / 数据库 / 终端 = 按需展开的深度工作台） */
  const deepTitle = DEEP_TITLE[mainTab]

  const mainPane = (
    <div className="relative flex h-full min-h-0 flex-1 flex-col">
      {/* 左栏显隐：主区左缘垂直中部悬浮把手（仅宽屏；默认不展示、悬停淡入） */}
      {!narrow && <LeftPanelEdgeHandle />}
      <div className="flex h-11 shrink-0 items-center gap-1 border-b px-2">
        {/* 右栏显隐钮右对齐于头部最右端（紧邻右栏；仅宽屏，窄屏抽屉入口在底部成员条） */}
        {deepTitle ? (
          /* M49：深看态头部——「← 返回（对话/画布）｜工作台标题」（高度不变，防布局跳动） */
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Button size="xs" variant="outline" className="shrink-0" title="返回上一视图（深度工作台按需展开）" onClick={closeWorkspaceView}>
              <ArrowLeft className="mr-1 size-3.5" />
              返回{deepFrom === 'canvas' ? '画布' : '对话'}
            </Button>
            <span className="h-4 w-px shrink-0 bg-border" />
            <span className="min-w-0 truncate text-[12.5px] font-medium">{deepTitle}</span>
          </div>
        ) : (
          <Tabs value={mainTab} onValueChange={(v) => setMainTab(v as MainTab)}>
            <TabsList>
              <TabsTrigger value="chat">对话</TabsTrigger>
              <TabsTrigger value="canvas">
                画布
                {newCanvasCount > 0 && (
                  <span
                    className="ml-1 shrink-0 rounded-full bg-primary/15 px-1 text-[9.5px] font-semibold tabular-nums text-primary"
                    title="Agent 在画布上有新写入"
                  >
                    {newCanvasCount}
                  </span>
                )}
              </TabsTrigger>
            </TabsList>
          </Tabs>
        )}
        {!narrow && <PanelToggleButton side="right" className="ml-auto" />}
      </div>
      <ErrorBoundary>
        <React.Suspense
          fallback={<div className="flex min-h-0 flex-1 items-center justify-center text-[12px] text-muted-foreground">正在加载…</div>}
        >
          {mainTab === 'chat' ? (
            <ChatArea />
          ) : mainTab === 'artifacts' ? (
            <ArtifactsView />
          ) : mainTab === 'canvas' ? (
            <CanvasView />
          ) : mainTab === 'database' ? (
            <DatabaseWorkbench />
          ) : mainTab === 'terminal' ? (
            <TerminalView />
          ) : null}
        </React.Suspense>
      </ErrorBoundary>
    </div>
  )

  const overlays = (
    <>
      <Dialog open={sessionDrawer} onOpenChange={setSessionDrawer}>
        <DialogContent hideClose className="h-[72vh] max-w-xs overflow-hidden p-0">
          <DialogTitle className="sr-only">会话列表</DialogTitle>
          <SessionList
            onSelect={(id) => {
              setSessionDrawer(false)
              void handleSelect(id)
            }}
          />
        </DialogContent>
      </Dialog>
      <Dialog open={teamDrawer} onOpenChange={setTeamDrawer}>
        <DialogContent hideClose className="h-[72vh] max-w-md overflow-hidden p-0">
          <DialogTitle className="sr-only">团队面板</DialogTitle>
          <TeamPanel />
        </DialogContent>
      </Dialog>
      <CommandPalette />
      <ShortcutHelp />
      <TraceDrawer />
      <LiveDock />
      <PanTossHost />
      <TarotRitualHost />
    </>
  )

  // M26：控制台视图（appView !== 'workspace'）——主区切换，rail 与 HeaderBar 保留
  // M36：设置（appView === 'settings'）同为主区全幅视图
  // M57：管理面控制台仅 admin 渲染；成员设置页 = 个人偏好视图；用户管理（admin ）
  // M68：素材库为全员可见的个人资源视图（无 isAdmin 条件）
  const consoleView =
    appView === 'materials' ? (
      <MaterialsConsole />
    ) : appView === 'agents' && isAdmin ? (
      <AgentConsole />
    ) : appView === 'skills' && isAdmin ? (
      <SkillConsole />
    ) : appView === 'mcp' && isAdmin ? (
      <McpConsole />
    ) : appView === 'connections' && isAdmin ? (
      <ConnectionsConsole />
    ) : appView === 'users' && isAdmin ? (
      <UsersConsole />
    ) : appView === 'settings' ? (
      isAdmin ? <SettingsView /> : <PersonalSettingsView />
    ) : null

  if (narrow) {
    return (
      <div className="flex h-screen flex-col overflow-hidden">
        <HeaderBar narrow onOpenSessions={() => setSessionDrawer(true)} />
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <ActivityRail />
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <ConnectionBanner />
            {appView === 'workspace' ? (
              <>
                {mainPane}
                <BottomMemberBar onOpenTeam={() => setTeamDrawer(true)} />
              </>
            ) : (
              consoleView
            )}
            {overlays}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <HeaderBar />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <ActivityRail />
        <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          <ConnectionBanner />
          {appView === 'workspace' ? (
            <PanelGroup
              direction="horizontal"
              className="min-h-0 flex-1"
              onLayout={(layout) => {
                if (layout.length === 3) {
                  paneLayout.current = layout
                } else if (layout.length === 2) {
                  // 左右任一收起：主区兼得的合并份额按原三栏比例拆还，展开时回到原位（不跳变）；
                  // 无记忆（刷新后）以挂载默认三栏为基准——口径须与下方 Panel defaultSize 一致（S, 100−S−26, 26）
                  const prev = paneLayout.current ?? [sessionDefault, 100 - sessionDefault - 26, 26]
                  if (rightPanelOpen) {
                    // 左收右开：[main, team] → main 拆回 [sessions, main]
                    const [m0, t0] = layout
                    const rest = prev[0] + prev[1]
                    paneLayout.current = [(m0 * prev[0]) / rest, (m0 * prev[1]) / rest, t0]
                  } else {
                    // 左开右收：[sessions, main] → main 拆回 [main, team]
                    const [s0, s1] = layout
                    const rest = prev[1] + prev[2]
                    paneLayout.current = [s0, (s1 * prev[1]) / rest, (s1 * prev[2]) / rest]
                  }
                }
              }}
            >
              {/* id + order：左右栏动态挂载 / 卸载后仍按声明顺序重排（库的 dev 告警要求） */}
              {leftPanelOpen && (
                <Panel
                  id="sessions"
                  order={1}
                  defaultSize={paneLayout.current?.[0] ?? sessionDefault}
                  minSize={sessionMin}
                  maxSize={26}
                  className="min-h-0"
                >
                  <SessionList onSelect={(id) => void handleSelect(id)} />
                </Panel>
              )}
              {leftPanelOpen && (
                <PanelResizeHandle className="w-px bg-border transition-colors hover:bg-primary/50 data-[resize-handle-active]:bg-primary" />
              )}

              <Panel
                id="main"
                order={2}
                // 收起态：主区接住已收起栏的份额（无记忆的首次加载 = 100 − 各展开栏默认，其余栏不被被动挤压）
                defaultSize={
                  paneLayout.current
                    ? paneLayout.current[1] +
                      (leftPanelOpen ? 0 : (paneLayout.current[0] ?? 0)) +
                      (rightPanelOpen ? 0 : (paneLayout.current[2] ?? 0))
                    : 100 - (leftPanelOpen ? sessionDefault : 0) - (rightPanelOpen ? 26 : 0)
                }
                minSize={35}
                className="min-h-0"
              >
                {mainPane}
              </Panel>

              {rightPanelOpen && (
                <PanelResizeHandle className="w-px bg-border transition-colors hover:bg-primary/50 data-[resize-handle-active]:bg-primary" />
              )}
              {rightPanelOpen && (
                <Panel
                  id="team"
                  order={3}
                  defaultSize={paneLayout.current?.[2] ?? 26}
                  minSize={18}
                  maxSize={34}
                  className="min-h-0"
                >
                  <TeamPanel />
                </Panel>
              )}
            </PanelGroup>
          ) : (
            consoleView
          )}
          {overlays}
        </div>
      </div>
    </div>
  )
}

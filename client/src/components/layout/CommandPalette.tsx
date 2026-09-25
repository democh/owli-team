/**
 * 命令面板（M8，⌘K / Ctrl+K）：
 * - 切换会话 / 切换主视图与右栏视图 / @ 成员插入 / 停止运行 / 打开设置与上下文抽屉；
 * - 基于 cmdk（无样式，自定视觉）。
 * M21 扩展：快速组队（预设 + 场景开局）→ 建会话对话框预选。
 * M22 扩展：右栏「浏览器」入口（「连接 / 操作」已迁入控制台视图）。
 * M23 扩展：主区「数据库」工作台与「终端」入口。
 * M26 扩展：Agent 管理 / Skill 管理 / 连接管理入口（ActivityRail 同款；视图类命令自动切回工作台）。
 * M34 修订：撤「行情」入口（主区「行情」Tab 已撤除；K 线 / 博弈由会话块与画布节点承载）。
 * M49 修订（ADR 0100）：主区「交付件 / 数据库 / 终端」改为深度工作台展开（命令「展开 · X」）；
 *   右栏「浏览器」→「实况」（四面合一，setRightView('live')）。
 * 右栏显隐：新增「右栏：显示 / 隐藏」入口（与右栏页签行收起钮 / 右缘浮动把手 / ⌘B 同源，toggleRightPanel）。
 * 左栏对称（后补）：新增「左栏：显示 / 隐藏」入口（会话头部收起钮 / 左缘浮动把手 / ⌘⇧B 同源，toggleLeftPanel）。
 */
import * as React from 'react'
import { Command } from 'cmdk'
import {
  Activity,
  BookUser,
  Bot,
  BrainCircuit,
  Cable,
  CalendarClock,
  Database,
  Frame,
  Images,
  Keyboard,
  Layers,
  ListTodo,
  Maximize2,
  MessageSquare,
  MonitorPlay,
  Moon,
  PackageOpen,
  PanelLeft,
  PanelRight,
  Plug,
  Plus,
  Settings,
  Sparkles,
  Square,
  StickyNote,
  Terminal,
  Trophy,
  UserCog,
  UserPlus,
  Users,
  Waypoints,
  GitBranch,
} from 'lucide-react'
import type { AgentDefinition } from '@multi-agent/shared'
import { baseAgentId, DEFAULT_SPACE_ID } from '@multi-agent/shared'
import { toast } from 'sonner'
import { resolveIcon } from '../../lib/avatar-icons'
import { attachActiveRunFor, useRunStore } from '../../stores/run-store'
import { useAgentStore } from '../../stores/agent-store'
import { useCanvasStore, type CanvasActionKind } from '../../stores/canvas-store'
import { useSessionStore, useCurrentSession } from '../../stores/session-store'
import { useSpaceStore } from '../../stores/space-store'
import { useLiveDockStore } from '../../stores/live-dock-store'
import { useAuthStore } from '../../stores/auth-store'
import { useUiStore } from '../../stores/ui-store'
import { useWsStore } from '../../stores/ws-store'
import { AgentAvatar } from '../agents/AgentAvatar'

const ITEM_CLS =
  'flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-[12.5px] data-[selected=true]:bg-accent/80 data-[selected=true]:text-foreground'

const GROUP_CLS =
  '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[10.5px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-muted-foreground'

export function CommandPalette(): React.JSX.Element {
  const open = useUiStore((s) => s.commandOpen)
  const setOpen = useUiStore((s) => s.setCommandOpen)
  const quietMode = useUiStore((s) => s.quietMode)
  // M57：管理面命令（Agent / Skill / MCP / 连接 / 用户）仅 admin 展示
  const isAdmin = useAuthStore((s) => s.isAdmin)
  // M79-F：联系人 / 群聊命令仅多用户模式展示
  const multiUser = useAuthStore((s) => s.status.multiUser)
  const sessions = useSessionStore((s) => s.sessions)
  const currentId = useSessionStore((s) => s.currentId)
  const active = useRunStore((s) => s.active)
  const runId = useRunStore((s) => s.runId)
  const agents = useAgentStore((s) => s.agents)
  // M21：快速组队（预设）与场景开局入口（数据源 /api/agents）
  const presets = useAgentStore((s) => s.presets)
  const groups = useAgentStore((s) => s.groups)
  const session = useCurrentSession()
  // M16：当前会话未在场成员（一键邀请）；M77：在场判定按基础角色（分身在场 = 该角色已在场）
  const invitable = React.useMemo(
    () => (session ? agents.filter((a) => !session.participantIds.some((key) => baseAgentId(key) === a.id)) : []),
    [agents, session],
  )

  const openSession = (id: string): void => {
    setOpen(false)
    void (async () => {
      await useSessionStore.getState().selectSession(id)
      useWsStore.getState().ensureSubscribed(id)
      useWsStore.getState().markRead(id)
      await attachActiveRunFor(id)
    })()
  }

  const createNewSession = (): void => {
    setOpen(false)
    void (async () => {
      // M48：零选择开场——空编制创建，首条消息由平台路由自动组队并派发任务
      try {
        // 空间归属：default 之外的当前空间才随行（与 CreateSessionDialog 同口径，default 不入 body）
        const spaceId = useSpaceStore.getState().currentId
        const session = await useSessionStore
          .getState()
          .createSession([], undefined, undefined, spaceId === DEFAULT_SPACE_ID ? undefined : spaceId)
        openSession(session.id)
        toast(`会话「${session.title}」已创建，直接描述需求即可（平台将自动组队）`)
      } catch (err) {
        toast.error((err as Error).message)
      }
    })()
  }

  /** M21：快速组队 / 场景开局——关闭面板并请求 SessionList 打开建会话对话框（预选成员） */
  const requestCreate = (kind: 'preset' | 'scene', id: string): void => {
    setOpen(false)
    useUiStore.getState().requestCreate(kind, id)
  }

  const run = (fn: () => void): void => {
    setOpen(false)
    fn()
  }

  /** M26：视图类命令统一先切回工作台（控制台视图下选择主区 / 右栏 Tab 时避免「无反应」） */
  const runInWorkspace = (fn: () => void): void =>
    run(() => {
      useUiStore.getState().setAppView('workspace')
      fn()
    })

  /** M31：画布动作（切到画布 Tab 后由 CanvasView 消费执行；无会话时引导） */
  const requestCanvasAction = (kind: CanvasActionKind): void => {
    if (!useSessionStore.getState().currentId) {
      toast.error('先选择一个会话再使用画布')
      return
    }
    useUiStore.getState().setMainTab('canvas')
    useCanvasStore.getState().requestAction(kind)
  }

  /** M16：一键邀请（未在场成员直达；toast 提示开麦方式） */
  const invite = async (a: AgentDefinition): Promise<void> => {
    const sessionId = useSessionStore.getState().currentId
    if (!sessionId) return
    try {
      await useSessionStore.getState().addMembers(sessionId, [a.id])
      toast(`${a.name} 加入协作，@TA 开麦`)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      label="命令面板"
      className="fixed left-1/2 top-[16%] z-50 w-[min(560px,92vw)] -translate-x-1/2 overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-2xl shadow-slate-900/20"
    >
      <Command.Input
        autoFocus
        placeholder="搜索会话 / 切换视图 / @ 成员 / 执行操作…"
        className="h-10 w-full border-b bg-transparent px-3.5 text-[13px] outline-none placeholder:text-muted-foreground/70"
      />
      <Command.List className="max-h-[340px] overflow-y-auto p-1.5">
        <Command.Empty className="px-3 py-8 text-center text-[12px] text-muted-foreground">
          没有匹配的命令
        </Command.Empty>

        <Command.Group heading="会话" className={GROUP_CLS}>
          {sessions.map((s) => (
            <Command.Item key={s.id} value={`session ${s.title}`} className={ITEM_CLS} onSelect={() => openSession(s.id)}>
              <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{s.title}</span>
            </Command.Item>
          ))}
          {sessions.length === 0 && (
            <div className="px-3 py-2 text-[12px] text-muted-foreground">暂无会话</div>
          )}
          <Command.Item
            value="new session 新建会话 创建"
            className={ITEM_CLS}
            onSelect={createNewSession}
          >
            <Plus className="size-3.5 shrink-0 text-emerald-600" />
            新建会话
          </Command.Item>
        </Command.Group>

        {/* M79-F：社交协作命令（联系人 / 新建群聊；仅多用户模式） */}
        {multiUser && (
          <Command.Group heading="联系人" className={GROUP_CLS}>
            <Command.Item
              value="contacts 打开联系人 好友"
              className={ITEM_CLS}
              onSelect={() =>
                run(() => {
                  useUiStore.getState().setLeftPanelOpen(true)
                  useUiStore.getState().setLeftTab('contacts')
                })
              }
            >
              <Users className="size-3.5 shrink-0 text-muted-foreground" />
              打开联系人
            </Command.Item>
            <Command.Item
              value="new group 新建群聊 群聊"
              className={ITEM_CLS}
              onSelect={() =>
                run(() => {
                  useUiStore.getState().setLeftPanelOpen(true)
                  useUiStore.getState().setLeftTab('contacts')
                  useUiStore.getState().requestGroupCreate()
                })
              }
            >
              <UserPlus className="size-3.5 shrink-0 text-muted-foreground" />
              新建群聊
            </Command.Item>
          </Command.Group>
        )}

        {(presets.length > 0 || groups.length > 0) && (
          <Command.Group heading="快速组队" className={GROUP_CLS}>
            {presets.map((p) => {
              const Icon = resolveIcon(p.icon)
              return (
                <Command.Item
                  key={`preset-${p.id}`}
                  value={`new preset ${p.id} ${p.name} 快速组队 新建会话`}
                  className={ITEM_CLS}
                  onSelect={() => requestCreate('preset', p.id)}
                >
                  <Icon className="size-3.5 shrink-0" style={{ color: p.theme[0] }} />
                  <span className="min-w-0 flex-1 truncate">新建会话：{p.name}</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">{p.members.length} 人编制</span>
                </Command.Item>
              )
            })}
            {groups.map((g) => {
              const Icon = resolveIcon(g.icon)
              return (
                <Command.Item
                  key={`scene-${g.id}`}
                  value={`new scene ${g.id} ${g.name} 场景 新建会话`}
                  className={ITEM_CLS}
                  onSelect={() => requestCreate('scene', g.id)}
                >
                  <Icon className="size-3.5 shrink-0" style={{ color: g.theme[0] }} />
                  <span className="min-w-0 flex-1 truncate">新建会话：{g.name}</span>
                </Command.Item>
              )
            })}
          </Command.Group>
        )}

        {session && invitable.length > 0 && (
          <Command.Group heading="邀请成员加入会话" className={GROUP_CLS}>
            {invitable.map((a) => (
              <Command.Item key={a.id} value={`invite ${a.name}`} className={ITEM_CLS} onSelect={() => run(() => void invite(a))}>
                <AgentAvatar agent={a} size={14} animated={false} className="shrink-0" />
                {a.name}
                <span className="truncate text-[11px] text-muted-foreground">{a.role}</span>
                <UserPlus className="ml-auto size-3 shrink-0 text-muted-foreground" />
              </Command.Item>
            ))}
          </Command.Group>
        )}

        <Command.Group heading="视图" className={GROUP_CLS}>
          {isAdmin && (
            <>
              <Command.Item
                value="view agents agent management 角色管理 agent 管理 控制台 资产"
                className={ITEM_CLS}
                onSelect={() => run(() => useUiStore.getState().setAppView('agents'))}
              >
                <Bot className="size-3.5 shrink-0 text-muted-foreground" />
                Agent 管理
              </Command.Item>
              <Command.Item
                value="view skills skill management 技能管理 skill 管理 控制台 资产"
                className={ITEM_CLS}
                onSelect={() => run(() => useUiStore.getState().setAppView('skills'))}
              >
                <Sparkles className="size-3.5 shrink-0 text-muted-foreground" />
                Skill 管理
              </Command.Item>
              <Command.Item
                value="view mcp mcp 管理 servers 服务器 crud 工具接入 stdio http"
                className={ITEM_CLS}
                onSelect={() => run(() => useUiStore.getState().setAppView('mcp'))}
              >
                <Plug className="size-3.5 shrink-0 text-muted-foreground" />
                MCP 管理
              </Command.Item>
              <Command.Item
                value="view connections 连接管理 连接中心 数据库 mysql postgres sqlite ssh 操作"
                className={ITEM_CLS}
                onSelect={() => run(() => useUiStore.getState().setAppView('connections'))}
              >
                <Cable className="size-3.5 shrink-0 text-muted-foreground" />
                连接管理
              </Command.Item>
              <Command.Item
                value="view users 用户管理 账号 成员 邀请 角色 密码"
                className={ITEM_CLS}
                onSelect={() => run(() => useUiStore.getState().setAppView('users'))}
              >
                <UserCog className="size-3.5 shrink-0 text-muted-foreground" />
                用户管理
              </Command.Item>
            </>
          )}
          {/* M68：素材库——全员可见的个人资源视图（非管理面） */}
          <Command.Item
            value="view materials 素材库 library 图片 视频 上传 个人资源"
            className={ITEM_CLS}
            onSelect={() => run(() => useUiStore.getState().setAppView('materials'))}
          >
            <Images className="size-3.5 shrink-0 text-muted-foreground" />
            素材库
          </Command.Item>
          <Command.Item
            value="view settings 设置 偏好 配置 runtime 模型 记忆 金融"
            className={ITEM_CLS}
            onSelect={() => run(() => useUiStore.getState().setAppView('settings'))}
          >
            <Settings className="size-3.5 shrink-0 text-muted-foreground" />
            设置
          </Command.Item>
          <Command.Item
            value="view chat 对话 工作台 workspace"
            className={ITEM_CLS}
            onSelect={() => runInWorkspace(() => useUiStore.getState().setMainTab('chat'))}
          >
            <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
            对话
          </Command.Item>
          <Command.Item
            value="view artifacts 交付件 diff 展开 深度工作台"
            className={ITEM_CLS}
            onSelect={() => runInWorkspace(() => useUiStore.getState().expandWorkspace('artifacts'))}
          >
            <PackageOpen className="size-3.5 shrink-0 text-muted-foreground" />
            展开 · 交付件 / Diff
          </Command.Item>
          <Command.Item
            value="view database 数据库 表 数据 sql navicat 对象树 展开 深度工作台"
            className={ITEM_CLS}
            onSelect={() => runInWorkspace(() => useUiStore.getState().expandWorkspace('database'))}
          >
            <Database className="size-3.5 shrink-0 text-muted-foreground" />
            展开 · 数据库工作台
          </Command.Item>
          <Command.Item
            value="view terminal 终端 ssh 远程 xterm 展开 深度工作台"
            className={ITEM_CLS}
            onSelect={() => runInWorkspace(() => useUiStore.getState().expandWorkspace('terminal'))}
          >
            <Terminal className="size-3.5 shrink-0 text-muted-foreground" />
            展开 · SSH 终端
          </Command.Item>
          <Command.Item
            value="view members 成员"
            className={ITEM_CLS}
            onSelect={() => runInWorkspace(() => useUiStore.getState().setRightView('members'))}
          >
            <Users className="size-3.5 shrink-0 text-muted-foreground" />
            右栏 · 成员
          </Command.Item>
          <Command.Item
            value="view relay 接力"
            className={ITEM_CLS}
            onSelect={() => runInWorkspace(() => useUiStore.getState().setRightView('relay'))}
          >
            <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
            右栏 · 接力
          </Command.Item>
          <Command.Item
            value="view stats 战绩"
            className={ITEM_CLS}
            onSelect={() => runInWorkspace(() => useUiStore.getState().setRightView('stats'))}
          >
            <Trophy className="size-3.5 shrink-0 text-muted-foreground" />
            右栏 · 战绩
          </Command.Item>
          <Command.Item
            value="view tasks 任务"
            className={ITEM_CLS}
            onSelect={() => runInWorkspace(() => useUiStore.getState().setRightView('tasks'))}
          >
            <ListTodo className="size-3.5 shrink-0 text-muted-foreground" />
            右栏 · 任务
          </Command.Item>
          <Command.Item
            value="view memory 记忆"
            className={ITEM_CLS}
            onSelect={() => runInWorkspace(() => useUiStore.getState().setRightView('memory'))}
          >
            <BrainCircuit className="size-3.5 shrink-0 text-muted-foreground" />
            右栏 · 记忆
          </Command.Item>
          <Command.Item
            value="view schedules 定时 定时任务 提醒 cron"
            className={ITEM_CLS}
            onSelect={() => runInWorkspace(() => useUiStore.getState().setRightView('schedules'))}
          >
            <CalendarClock className="size-3.5 shrink-0 text-muted-foreground" />
            右栏 · 定时
          </Command.Item>
          <Command.Item
            value="view live 实况 浏览器 cdp 帧流 接管 交付件 数据库 终端 跟随"
            className={ITEM_CLS}
            onSelect={() => runInWorkspace(() => useUiStore.getState().setRightView('live'))}
          >
            <MonitorPlay className="size-3.5 shrink-0 text-muted-foreground" />
            右栏 · 实况
          </Command.Item>
          <Command.Item
            value="dock live 操作直播 悬浮窗 浮动窗 浏览器 数据库"
            className={ITEM_CLS}
            onSelect={() => runInWorkspace(() => useLiveDockStore.getState().toggle())}
          >
            <Activity className="size-3.5 shrink-0 text-muted-foreground" />
            操作直播：显示 / 折叠
          </Command.Item>
          <Command.Item
            value="toggle left panel 左栏 会话列表 显示 隐藏 收起 展开 侧栏 sidebar ⌘⇧B"
            className={ITEM_CLS}
            onSelect={() => runInWorkspace(() => useUiStore.getState().toggleLeftPanel())}
          >
            <PanelLeft className="size-3.5 shrink-0 text-muted-foreground" />
            左栏：显示 / 隐藏
          </Command.Item>
          <Command.Item
            value="toggle right panel 右栏 团队面板 显示 隐藏 收起 展开 侧栏 sidebar ⌘B"
            className={ITEM_CLS}
            onSelect={() => runInWorkspace(() => useUiStore.getState().toggleRightPanel())}
          >
            <PanelRight className="size-3.5 shrink-0 text-muted-foreground" />
            右栏：显示 / 隐藏
          </Command.Item>
        </Command.Group>

        <Command.Group heading="画布" className={GROUP_CLS}>
          <Command.Item
            value="view canvas 画布 无限画布 媒体创作 workspace"
            className={ITEM_CLS}
            onSelect={() => runInWorkspace(() => useUiStore.getState().setMainTab('canvas'))}
          >
            <Frame className="size-3.5 shrink-0 text-muted-foreground" />
            打开画布
          </Command.Item>
          <Command.Item
            value="canvas new note 画布新建便签 便签 sticky"
            className={ITEM_CLS}
            onSelect={() => runInWorkspace(() => requestCanvasAction('new-note'))}
          >
            <StickyNote className="size-3.5 shrink-0 text-muted-foreground" />
            画布 · 新建便签
          </Command.Item>
          <Command.Item
            value="canvas mind 画布生成脑图 脑图 mind map"
            className={ITEM_CLS}
            onSelect={() => runInWorkspace(() => requestCanvasAction('mind'))}
          >
            <Waypoints className="size-3.5 shrink-0 text-muted-foreground" />
            画布 · 生成脑图
          </Command.Item>
          <Command.Item
            value="canvas fit 画布适应视野 适应视野 zoom"
            className={ITEM_CLS}
            onSelect={() => runInWorkspace(() => requestCanvasAction('fit'))}
          >
            <Maximize2 className="size-3.5 shrink-0 text-muted-foreground" />
            画布 · 适应视野
          </Command.Item>
        </Command.Group>

        <Command.Group heading="@ 召唤成员" className={GROUP_CLS}>
          {agents.map((a) => (
            <Command.Item
              key={a.id}
              value={`mention ${a.name}`}
              className={ITEM_CLS}
              onSelect={() =>
                run(() => {
                  useUiStore.getState().setMainTab('chat')
                  useUiStore.getState().insertToComposer(`@${a.name} `)
                })
              }
            >
              <AgentAvatar agent={a} size={14} animated={false} className="shrink-0" />
              {a.name}
              <span className="truncate text-[11px] text-muted-foreground">{a.role}</span>
            </Command.Item>
          ))}
        </Command.Group>

        <Command.Group heading="操作" className={GROUP_CLS}>
          <Command.Item
            value="invite members 邀请成员 加入会话"
            className={ITEM_CLS}
            onSelect={() =>
              run(() => {
                if (!useSessionStore.getState().currentId) {
                  toast.error('先选择一个会话再邀请成员')
                  return
                }
                useUiStore.getState().setRightView('members')
                useUiStore.getState().setInviteOpen(true)
              })
            }
          >
            <UserPlus className="size-3.5 shrink-0 text-emerald-600" />
            邀请成员加入当前会话
          </Command.Item>
          <Command.Item
            value="browse agents directory 名录 角色展示"
            className={ITEM_CLS}
            onSelect={() =>
              run(() => {
                window.location.hash = '#/agents'
              })
            }
          >
            <BookUser className="size-3.5 shrink-0 text-muted-foreground" />
            浏览 Agent 名录
          </Command.Item>
          <Command.Item
            value="open shortcuts 快捷键 help 键盘"
            className={ITEM_CLS}
            onSelect={() => run(() => useUiStore.getState().setHelpOpen(true))}
          >
            <Keyboard className="size-3.5 shrink-0 text-muted-foreground" />
            查看快捷键帮助
          </Command.Item>
          <Command.Item
            value="open settings 设置"
            className={ITEM_CLS}
            onSelect={() => run(() => useUiStore.getState().setAppView('settings'))}
          >
            <Settings className="size-3.5 shrink-0 text-muted-foreground" />
            打开设置
          </Command.Item>
          <Command.Item
            value="open context 上下文 摘要"
            className={ITEM_CLS}
            onSelect={() => run(() => useUiStore.getState().setContextOpen(true))}
          >
            <Layers className="size-3.5 shrink-0 text-muted-foreground" />
            查看上下文分层与摘要
          </Command.Item>
          {runId && (
            <Command.Item
              value="open trace 运行轨迹 时间线"
              className={ITEM_CLS}
              onSelect={() => run(() => useUiStore.getState().openTrace(runId))}
            >
              <Activity className="size-3.5 shrink-0 text-muted-foreground" />
              查看当前运行 Trace
            </Command.Item>
          )}
          <Command.Item
            value="toggle quiet mode 安静模式 静音"
            className={ITEM_CLS}
            onSelect={() =>
              run(() => {
                useUiStore.getState().toggleQuietMode()
                toast(useUiStore.getState().quietMode ? '已开启安静模式' : '已关闭安静模式')
              })
            }
          >
            <Moon className="size-3.5 shrink-0 text-muted-foreground" />
            切换安静模式
            <span className="ml-auto text-[11px] text-muted-foreground">当前：{quietMode ? '开' : '关'}</span>
          </Command.Item>
          {active && (
            <Command.Item
              value="stop run 停止"
              className={ITEM_CLS}
              onSelect={() => run(() => void useRunStore.getState().stop())}
            >
              <Square className="size-3.5 shrink-0 text-rose-600" />
              停止当前运行
            </Command.Item>
          )}
        </Command.Group>
      </Command.List>
    </Command.Dialog>
  )
}

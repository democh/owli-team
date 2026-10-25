/**
 * 对话主区（M8）：虚拟列表消息流 + 贴底自动滚动（隔离订阅）+ 空状态（场景议程 + @ 成员）+ 底部 Composer。
 * 只有视口 + overscan 内的消息行挂载；单条消息的流式更新只重渲染该条（MessageItem 内部 O(1) 订阅），
 * 本组件不随 delta 重渲染（贴底跟随与「有无流式」均为独立订阅）。
 * M12：上滑离开底部时浮现「回到最新（N 条新消息）」浮标。
 * M16：并行协作组（同 runId + 同 turnIndex 连续 ≥2 条成员消息）成组渲染，单条波次渲染路径完全不变。
 * M37（§52）：场景空态议程 chips（资产 guide/agenda）・波次分隔行（结构键派生，ADR 0065）・
 *   悬浮阶段条（滚动位置派生，不用 CSS sticky）・消息导航条（≥20 条）・收尾仪式卡挂载。
 * M52-A（§66）：消息流区包裹场景宿主 SceneStage（四形态容器渲染；标题栏「切回纯列表」开关）。
 */
import * as React from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDown, Bot, Eye, Hand, Hourglass, LayoutList, LayoutPanelLeft, Loader2, Rocket, RotateCcw, Users } from 'lucide-react'
import { toast } from 'sonner'
import type { AgentDefinition } from '@multi-agent/shared'
import { baseAgentId, resolveRelayMode } from '@multi-agent/shared'
import { labelOfMemberKey } from '../../lib/members'
import { apiPatch, apiPost } from '../../lib/api'
import { cn } from '../../lib/utils'
import { resolveIcon } from '../../lib/avatar-icons'
import { deriveRows, type WaveInfo } from '../../lib/chat-rows'
import { useAgentStore, useGroup } from '../../stores/agent-store'
import { useRunStore } from '../../stores/run-store'
import { useSceneStore } from '../../stores/scene-store'
import { useSessionStore, useCurrentSession } from '../../stores/session-store'
import { useAuthStore } from '../../stores/auth-store'
import { useWsStore } from '../../stores/ws-store'
import { useUiStore } from '../../stores/ui-store'
import { ShareDialog } from '../sessions/ShareDialog'
import { OnlineDot } from './OnlineDot'
import { ChatMembersDialog } from '../sessions/ChatMembersDialog'
import { AgentAvatar } from '../agents/AgentAvatar'
import { SceneStage } from '../scene/SceneStage'
import { MainTabs, PanelToggleButton } from '../layout/MainTabs'
import { useMediaQuery } from '../../lib/hooks'
import { WorktreeBar } from '../sessions/WorktreeBar'
import { Button } from '../ui/button'
import { AdjournPill } from './AdjournPill'
import { CloseoutCard } from './CloseoutCard'
import { MessageItem } from './MessageItem'
import { MessageRail } from './MessageRail'
import { WaveGroup } from './WaveGroup'
import { WaveStrip } from './WaveStrip'
import { Composer } from './Composer'
import { ApprovalPanel } from './ApprovalPanel'
import { PlanReviewCard } from './PlanReviewCard'

/** 虚拟列表行高估算（measureElement 会实测修正） */
const ESTIMATED_ROW_HEIGHT = 120
/** 距底部阈值内视为「贴底」，流式输出自动跟随；用户上滑后不打断 */
const STICK_BOTTOM_THRESHOLD = 120
/** M37-7：消息导航条显示门槛（条数） */
const RAIL_MIN_MESSAGES = 20

/** M16：空会话按主场景（首位成员所属场景）差异化引导文案；缺省回退研发团队（guide 字段缺省时的兜底） */
const EMPTY_GUIDES: Record<string, { title: string }> = {
  development: { title: '开始第一次接力' },
  brainstorm: { title: '抛出一个议题' },
  research: { title: '提出研究问题' },
}

/**
 * 贴底跟随：单独订阅「消息数 / 最后一条内容长度 / 运行活跃态」，
 * 把高频流式增量挡在 ChatArea 之外（本组件只渲染 null）。
 * M52-D：贴底补正——虚拟列表实测行高 / 收尾清单异步撑高发生在滚动赋值之后，
 * 单次贴底会停在「差几行」处；先补几帧，再由内容尺寸观察（ResizeObserver）兜底，
 * 同时把实际贴底偏移记入 pinnedTopRef，供 onScroll 识别「自身滚动回声」。
 */
function BottomFollower({
  containerRef,
  atBottomRef,
  pinnedTopRef,
}: {
  containerRef: React.RefObject<HTMLDivElement>
  atBottomRef: React.MutableRefObject<boolean>
  pinnedTopRef: React.MutableRefObject<number>
}): null {
  const count = useSessionStore((s) => s.order.length)
  const lastId = useSessionStore((s) => s.order[s.order.length - 1])
  const lastLen = useSessionStore((s) => (lastId ? (s.byId.get(lastId)?.content.length ?? 0) : 0))
  const active = useRunStore((s) => !!s.active)

  React.useEffect(() => {
    const el = containerRef.current
    if (!el || !atBottomRef.current) return
    const pin = (): void => {
      const box = containerRef.current
      if (!box || !atBottomRef.current) return
      if (box.scrollHeight - box.scrollTop - box.clientHeight > 1) box.scrollTop = box.scrollHeight
      pinnedTopRef.current = box.scrollTop
    }
    pin()
    // 补正窗口：随后几帧持续复核（用户上滑使 atBottomRef 翻假后 pin 自然停手）
    let raf = 0
    let frames = 0
    const tick = (): void => {
      pin()
      if (++frames < 5) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    // 兜底：补正窗口结束后内容仍可能被异步撑高（实测行高回填 / 交付件元数据就绪）——尺寸一变即复核
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => pin())
    if (ro) for (const kid of Array.from(el.children)) ro.observe(kid)
    return () => {
      cancelAnimationFrame(raf)
      ro?.disconnect()
    }
  }, [count, lastLen, active, containerRef, atBottomRef, pinnedTopRef])

  return null
}

/** M37-2：波次分隔行——极轻量细线 + 波次号（成员头像由波次组头 / 悬浮阶段条承载，避免重复堆叠） */
function WaveSeparator({ info }: { info: WaveInfo }): React.JSX.Element {
  return (
    <div
      data-wave-sep={info.turnIndex}
      className="flex items-center gap-3 px-8 py-2"
      role="presentation"
      aria-hidden
    >
      <span className="h-px flex-1 bg-border" />
      <span className="shrink-0 text-[10.5px] font-medium tracking-wide text-muted-foreground/80">
        第 {info.turnIndex + 1} 波
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  )
}

export function ChatArea(): React.JSX.Element {
  const currentId = useSessionStore((s) => s.currentId)
  const session = useCurrentSession()
  const order = useSessionStore((s) => s.order)
  const loading = useSessionStore((s) => s.loadingMessages)
  // 消息分页：更早历史（滑近顶部自动前插 / 定位未加载消息时逐页回退）
  const hasMore = useSessionStore((s) => s.hasMore)
  const loadingEarlier = useSessionStore((s) => s.loadingEarlier)
  const loadEarlier = useSessionStore((s) => s.loadEarlier)
  const latestRun = useSessionStore((s) => s.latestRun)
  const agents = useAgentStore((s) => s.agents)
  const active = useRunStore((s) => s.active)
  const queue = useRunStore((s) => s.queue)
  // 本地挂接运行所属会话：非当前会话的运行状态不参与渲染（防跨会话残留串入消息流）
  const runSessionId = useRunStore((s) => s.sessionId)
  const attach = useRunStore((s) => s.attach)
  const setMainTab = useUiStore((s) => s.setMainTab)
  const listMode = useSceneStore((s) => s.listMode)
  const narrow = useMediaQuery('(max-width: 900px)')
  const toggleListMode = useSceneStore((s) => s.toggleListMode)
  const focusRequest = useUiStore((s) => s.focusRequest)
  const focusMessage = useUiStore((s) => s.focusMessage)
  const clearFocus = useUiStore((s) => s.clearFocus)
  const [resuming, setResuming] = React.useState(false)
  /** M57 P2：会话共享弹窗（头部入口；成员可查看 / 退出，属主可管理） */
  const [shareOpen, setShareOpen] = React.useState(false)
  /** M79-F：群 / 私聊成员弹窗（名单 + 邀请好友 + 群主移出） */
  const [membersOpen, setMembersOpen] = React.useState(false)

  const containerRef = React.useRef<HTMLDivElement>(null)
  const atBottomRef = React.useRef(true)
  /** M52-D：最近一次程序化贴底的滚动偏移（-1 = 尚未贴底过），供 onScroll 识别自身滚动回声 */
  const pinnedTopRef = React.useRef(-1)
  /** 消息分页：前插前的滚动快照（{height, top}），prepend 后按高度差补偿视口 */
  const prependAnchorRef = React.useRef<{ height: number; top: number }>()
  const insertRef = React.useRef<((text: string) => void) | null>(null)
  // M12：「回到最新」浮标：atBottom 驱动显隐，missedRef 记录离开底部那一刻的消息数基线
  const [atBottom, setAtBottom] = React.useState(true)
  const missedRef = React.useRef(0)
  // M37-3/7：视口窗口（首个/末个可见行下标）——滚动驱动，变化才落 state
  const [vp, setVp] = React.useState({ first: 0, last: 0 })

  // M57 P2：当前会话权限角色（兼容模式缺省 = owner；viewer = 只读共享）
  const myRole = session?.role ?? 'owner'
  const isViewer = myRole === 'viewer'
  // M79-AE：会话治理（触发策略等）仅属主可操作（兼容模式 / 无角色投影 → owner）
  const isOwner = !myRole || myRole === 'owner'
  // M79-E：触发策略与持球（等待徽章 / 仅点名唤起开关）
  const humanProfiles = useSessionStore((s) => s.humanProfiles)
  // M79-J（§14.4）：chat 形态头部（direct = 对端名 + 在线点 + 头衔副行；group = 群名 + 「N 人」）
  const presenceMap = useWsStore((s) => s.presenceMap)
  const myUserId = useAuthStore((s) => s.user?.id)
  const isChatKind = session?.kind === 'direct' || session?.kind === 'group'
  const peerEntry = session?.kind === 'direct' ? Object.entries(humanProfiles).find(([id]) => id !== myUserId) : undefined
  const chatMemberCount = session ? session.participantIds.length + Object.keys(humanProfiles).length : 0
  const routeMode = session?.routeMode ?? 'auto'
  const waitingOn = session?.waitingOn
  const waitingIds = React.useMemo(() => waitingOn ?? [], [waitingOn])
  const waitingLabel = React.useMemo(() => {
    const names = waitingIds.map((id) => humanProfiles[id]?.name ?? '成员')
    return names.length > 2 ? `${names[0]} 等 ${names.length} 人` : names.join('、')
  }, [waitingIds, humanProfiles])
  const toggleRouteMode = async (): Promise<void> => {
    if (!session) return
    const next = (session.routeMode ?? 'auto') === 'mention' ? 'auto' : 'mention'
    try {
      const res = await apiPatch<{ session: typeof session }>(`/api/sessions/${session.id}`, { routeMode: next })
      useSessionStore.getState().applySession(res.session)
      toast(next === 'mention' ? '已切换为仅点名唤起（AI 不响应未点名消息）' : '已恢复 AI 自动应答')
    } catch (err) {
      toast.error((err as Error).message)
    }
  }
  // M86：接力控制 —— manual = 成员不自动转交下一棒（由你点按派发）；缺省按会话形态推导
  const relayMode = session ? resolveRelayMode(session) : 'auto'
  const toggleRelay = async (): Promise<void> => {
    if (!session) return
    const next = relayMode === 'manual' ? 'auto' : 'manual'
    try {
      const res = await apiPatch<{ session: typeof session }>(`/api/sessions/${session.id}`, { relay: next })
      useSessionStore.getState().applySession(res.session)
      toast(
        next === 'manual'
          ? '已切换为手动接力：成员不再自动转交，由你派发下一棒'
          : '已切换为自动接力：成员可自行转交下一棒',
      )
    } catch (err) {
      toast.error((err as Error).message)
    }
  }
  const messageCount = order.length
  const participants = React.useMemo(
    () =>
      (session?.participantIds ?? [])
        // M77：条目为成员键（分身 = `agentId~soulId`）——M16 空态引导仅需基础角色
        .map((key) => agents.find((a) => a.id === baseAgentId(key)))
        .filter((a): a is AgentDefinition => !!a),
    [session, agents],
  )
  // M16：空态引导按主场景差异化（首位成员所属场景）；M37：优先取资产 guide，缺省回退内置文案
  // M48：空编制会话（零成员创建）→ 引导直接描述需求，平台路由自动组队
  const sceneGroup = useGroup(participants[0]?.group)
  const guideTitle =
    participants.length === 0
      ? '直接描述你的需求，平台将自动组队并派发任务'
      : sceneGroup?.guide || (sceneGroup && EMPTY_GUIDES[sceneGroup.id]?.title) || EMPTY_GUIDES.development.title
  const agenda = sceneGroup?.agenda ?? []
  const SceneIcon = resolveIcon(sceneGroup?.icon)

  // M16/M37：消息流结构键（写入时由 session-store 增量维护，流式 delta 不再触发 O(n) 拼接）→
  // 派生行（含波次分隔行 / 波次归属 / 导航条目）；结构不变 → ChatArea 不重渲染
  const structureKey = useSessionStore((s) => s.structureKey)
  const { rows, waveOf, rail } = React.useMemo(() => deriveRows(order, structureKey), [order, structureKey])

  // 虚拟列表：count 只依赖派生行数；行内容由 MessageItem 自行按 id 订阅
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: 8,
    getItemKey: React.useCallback(
      (index: number) => {
        const row = rows[index]
        if (!row) return `row-${index}`
        return row.kind === 'message' ? row.id : row.key
      },
      [rows],
    ),
    // M52-D：末端锚定——消息行实测行高回填时由库按总量差补偿（贴底态不再被「上方行重测差值」
    // 拽离末端，避免丢出带瞬时大 gap 的 scroll 事件误导离底翻转）；追加跟随让贴底时新行走
    // 库内跟随；离底阈值与上滑判定同宽（STICK_BOTTOM_THRESHOLD），用户上滑超出后两者同时停手
    anchorTo: 'end',
    followOnAppend: true,
    scrollEndThreshold: STICK_BOTTOM_THRESHOLD,
  })

  const onScroll = (): void => {
    const el = containerRef.current
    if (!el) return
    // 消息分页：滑近顶部自动加载更早一页（快照滚动锚点，前插后由 useLayoutEffect 补偿）
    if (el.scrollTop < 100 && hasMore && !loadingEarlier && order.length > 0) {
      prependAnchorRef.current = { height: el.scrollHeight, top: el.scrollTop }
      void loadEarlier().catch(() => {
        prependAnchorRef.current = undefined
      })
    }
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_BOTTOM_THRESHOLD
    // M52-D：贴底回声守卫——程序化贴底后的实测行高回填会在 scroll 事件派发前抬高 scrollHeight，
    // 浏览器补发的 scroll 事件因此算出「瞬时大 gap」。若偏移仍锚定在上次贴底位置（未被用户上拖），
    // 视为自身滚动回声：立即补正贴底，不做离底翻转（用户上拖必然使偏移小于该锚点）。
    if (!near && atBottomRef.current && pinnedTopRef.current >= 0 && el.scrollTop >= pinnedTopRef.current - 1) {
      el.scrollTop = el.scrollHeight
      pinnedTopRef.current = el.scrollTop
      return
    }
    // 基线只在「贴底 / 刚离开底部」两个时刻刷新，持续上滑期间保持不动
    if (near || atBottomRef.current) missedRef.current = order.length
    atBottomRef.current = near
    setAtBottom(near)
    // M37：视口窗口（悬浮阶段条 / 导航条共用）
    const items = virtualizer.getVirtualItems()
    if (items.length > 0) {
      const first = items[0]!.index
      const last = items[items.length - 1]!.index
      setVp((v) => (v.first === first && v.last === last ? v : { first, last }))
    }
  }

  /** M12：跳回底部（瞬时，与内部贴底跟随一致，避免平滑滚动与虚拟列表测量叠加抖动） */
  const jumpToBottom = (): void => {
    const el = containerRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    pinnedTopRef.current = el.scrollTop
    atBottomRef.current = true
    missedRef.current = order.length
    setAtBottom(true)
  }

  const missed = atBottom ? 0 : Math.max(0, order.length - missedRef.current)

  // 消息分页：前插锚点补偿——prepend 后把滚动偏移按新增高度差平移，用户视口不跳
  React.useLayoutEffect(() => {
    const anchor = prependAnchorRef.current
    const el = containerRef.current
    if (!anchor || !el) return
    if (!loadingEarlier) {
      prependAnchorRef.current = undefined
      el.scrollTop = el.scrollHeight - anchor.height + anchor.top
      pinnedTopRef.current = -1 // 历史阅读态：废除贴底回声锚点，防误判
    }
  }, [order, loadingEarlier])

  // 消息定位（右侧接力视图 / M37 悬浮条与导航条点击）：滚动到目标行并闪光，随后自动清除
  // 分页回退：目标在未加载的更早历史中时，逐页向前加载直到命中或穷尽（每个 focusRequest 至多触发一轮）
  const focusPagedRef = React.useRef<string>()
  React.useEffect(() => {
    if (!focusRequest) return
    const index = rows.findIndex((r) =>
      r.kind === 'message' ? r.id === focusRequest.id : r.kind === 'wave' ? r.ids.includes(focusRequest.id) : false,
    )
    if (index >= 0) {
      virtualizer.scrollToIndex(index, { align: 'center' })
    } else if (hasMore && !loadingEarlier && focusPagedRef.current !== focusRequest.id) {
      focusPagedRef.current = focusRequest.id
      void loadEarlier().catch(() => undefined)
    }
    const t = setTimeout(clearFocus, 1900)
    return () => clearTimeout(t)
  }, [focusRequest, rows, virtualizer, clearFocus, hasMore, loadingEarlier, loadEarlier])

  // M37-3：当前波次（首个可见行起向前扫描的首个波次）；仅上滑离开底部时展示
  const currentWave = React.useMemo(() => {
    for (let k = vp.first; k < rows.length; k++) {
      const w = waveOf[k]
      if (w) return w
    }
    return null
  }, [vp.first, rows.length, waveOf])

  // 波次总数（「共 N 波」方位读数）：与 deriveRows 的 segKey 同源——同 key 的中断续段不重复计数
  const waveTotal = React.useMemo(() => {
    const keys = new Set<string>()
    for (const w of waveOf) {
      if (w) keys.add(`${w.runId}~${w.turnIndex}`)
    }
    return keys.size
  }, [waveOf])

  // M45（R-1）：波次回放条——节点列表（≥2 波呈现）与活跃波次序号
  // （波次回放条已按产品决策移除——2026-09-25：用户确认不需要此入口）

  // 流式计数：写入时由 store 增量维护（原实现在此线性扫描全部消息，流式期每 40ms O(n)）
  const anyStreaming = useSessionStore((s) => s.streamingCount > 0)

  // M3：断点继续（进程中断遗留的 Run 快照 → 以队列 + 发言史继续，不重跑已完成回合）
  const canResume = !!session && !active && latestRun?.state === 'interrupted'
  const onResume = async (): Promise<void> => {
    if (!session) return
    setResuming(true)
    try {
      const res = await apiPost<{ runId: string }>(`/api/sessions/${session.id}/resume`, {})
      useSessionStore.getState().setLatestRun(null)
      attach(res.runId, session.id)
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setResuming(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 会话标题栏 */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-4">
        {/* M85 头部合并（2026-09-25）：主区页签（对话/画布）并入会话头行左端——顶部三层横条合为一 */}
        <MainTabs />
        <span className="truncate text-[13px] font-semibold">{session ? session.title : '未选择会话'}</span>
        {session && isChatKind && (
          <span className="flex shrink-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
            {session.kind === 'direct' && <OnlineDot online={peerEntry ? presenceMap[peerEntry[0]] : undefined} />}
            <span className="truncate">
              {session.kind === 'group' ? `${chatMemberCount} 人` : (peerEntry?.[1]?.headline ?? '私聊')}
            </span>
          </span>
        )}
        {sceneGroup?.stage ? (
          <button
            type="button"
            title={listMode ? '恢复场景工作区视图' : '切回纯列表（对话与消息不变）'}
            className="flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/30 hover:text-primary"
            onClick={toggleListMode}
          >
            {listMode ? <LayoutPanelLeft className="size-3.5" /> : <LayoutList className="size-3.5" />}
            {listMode ? '工作区' : '纯列表'}
          </button>
        ) : null}
        {/* M57 P2：共享入口（团队会话：属主管理成员，成员查看 / 退出）；M79-F：chat 形态（群/私聊）改「成员」入口 */}
        {session && (session.kind === 'direct' || session.kind === 'group') ? (
          <button
            type="button"
            title="会话成员：名单查看（群主可移出成员 / 邀请好友）"
            className="flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/30 hover:text-primary"
            onClick={() => setMembersOpen(true)}
          >
            <Users className="size-3.5" />
            成员
          </button>
        ) : session ? (
          <button
            type="button"
            title="会话共享：邀请成员 / 角色管理 / 退出"
            className={cn(
              'flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors',
              myRole === 'owner'
                ? 'text-muted-foreground hover:border-primary/30 hover:text-primary'
                : 'border-primary/30 bg-primary/[0.06] text-primary',
            )}
            onClick={() => setShareOpen(true)}
          >
            <Users className="size-3.5" />
            {myRole === 'owner' ? '共享' : myRole === 'editor' ? '已共享 · 可协作' : '已共享 · 只读'}
          </button>
        ) : null}
        {/* M79-E：持球徽章（被点名的成员待回复；任何人回复即清除） */}
        {session && waitingIds.length > 0 && (
          <span
            className="flex shrink-0 items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700"
            title="成员已被点名，等待其回复；任何人回复即清除"
          >
            <Hourglass className="size-3" />
            等待 {waitingLabel} 回复
          </span>
        )}
        {/* M79-E/AE：触发策略开关（team 会话；仅属主可切换——治理口径统一） */}
        {session && session.kind !== 'direct' && session.kind !== 'group' && isOwner && (
          <button
            type="button"
            title={
              routeMode === 'mention'
                ? '仅点名唤起：AI 不响应未点名消息——点击恢复自动应答'
                : 'AI 自动应答：未点名消息交给平台组队——点击切换为仅点名唤起'
            }
            className={cn(
              'flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors',
              routeMode === 'mention'
                ? 'border-amber-500/40 bg-amber-500/10 text-amber-700'
                : 'text-muted-foreground hover:border-primary/30 hover:text-primary',
            )}
            onClick={() => void toggleRouteMode()}
          >
            <Bot className="size-3.5" />
            {routeMode === 'mention' ? '仅点名唤起' : 'AI 自动应答'}
          </button>
        )}
        {/* M86：接力控制（有 agent 编制时才可接棒；仅属主可切换） */}
        {session && participants.length > 0 && isOwner && (
          <button
            type="button"
            title={
              relayMode === 'manual'
                ? '手动接力：成员不自动把下一棒交给别人，也不自动召集未在场角色——点按切换为自动接力'
                : '自动接力：成员可在发言后自行转交下一棒（含未在场角色自动召集）——点按切换为手动接力'
            }
            className={cn(
              'flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors',
              relayMode === 'manual'
                ? 'border-primary/40 bg-primary/[0.08] text-primary'
                : 'text-muted-foreground hover:border-primary/30 hover:text-primary',
            )}
            onClick={() => void toggleRelay()}
          >
            <Hand className="size-3.5" />
            {relayMode === 'manual' ? '手动接力' : '自动接力'}
          </button>
        )}
        {/* M52-G：标题栏头像组已移除（纯装饰且与输入条成员条 / 场景席位重复）——成员展示收口到
            输入条成员条（无席位载体时）与场景席位（arena / roundtable） */}
        {/* M85 头部合并：主区面板钮（右栏显隐）随主区头行合入本行右端（纯人聊天不渲染） */}
        {!narrow && session && !isChatKind ? <PanelToggleButton side="right" className="ml-auto -mr-2" /> : null}
      </div>

      {/* M6：worktree / 直连仓库面板（sandbox 会话不渲染） */}
      {session && <WorktreeBar sessionId={session.id} />}

      {/* M3：中断恢复横幅 */}
      {canResume && (
        <div className="flex shrink-0 items-center gap-2 border-b border-amber-200/70 bg-amber-50 px-4 py-1.5 text-[12px] text-amber-800">
          <RotateCcw className="size-3.5 shrink-0" />
          <span className="truncate">
            上一次运行被中断（已完成 {latestRun!.turnIndex} 回合，队列中还有 {latestRun!.queue.length} 位成员）
          </span>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto h-6 shrink-0 px-2 text-[11.5px]"
            disabled={resuming}
            onClick={() => void onResume()}
          >
            {resuming && <Loader2 className="size-3 animate-spin" />}
            从断点继续
          </Button>
        </div>
      )}

      {/* M52-A：场景工作区宿主（stage 未声明 / 纯列表 → stream 直通，消息流零结构变化） */}
      <SceneStage group={sceneGroup} participants={participants}>
        {/* 消息流（虚拟列表）：aria-live 播报新消息（流式由 MessageItem 层 150ms 节流）；
            min-h 保底：计划卡等底部固定区内容超高时不得把消息区压没（避免与卡头视觉挤压）。
            M52-D：overflow-anchor:none——波次分隔行中途插入 / 实测行高回填会触发浏览器滚动锚定
            （静默改写 scrollTop 并丢出瞬时大 gap 的 scroll 事件），与贴底补正互斥；滚动位交由派发层接管 */}
        <div className="relative min-h-[180px] flex-1">
        <div
          ref={containerRef}
          onScroll={onScroll}
          role="log"
          aria-live="polite"
          aria-label="消息流"
          className="h-full overflow-y-auto py-2 [overflow-anchor:none]"
        >
          {!session ? (
            <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
              <div className="flex items-end gap-3">
                {agents.slice(0, 7).map((a, i) => (
                  <AgentAvatar
                    key={a.id}
                    agent={a}
                    size={i === 3 ? 44 : 34}
                    className={i % 2 === 0 ? 'float-soft' : ''}
                  />
                ))}
              </div>
              <div className="text-base font-semibold">Owli Team</div>
              <Button variant="outline" size="sm" onClick={() => setMainTab('chat')}>
                <Users className="size-4" />
                在左侧新建会话开始
              </Button>
            </div>
          ) : loading && messageCount === 0 ? (
            <div className="flex h-full items-center justify-center gap-2 text-[13px] text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              正在加载会话…
            </div>
          ) : messageCount === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
              <div
                className="float-soft flex size-14 items-center justify-center rounded-2xl ring-1 ring-primary/10"
                style={sceneGroup ? { backgroundColor: `${sceneGroup.theme[0]}1a`, color: sceneGroup.theme[0] } : undefined}
              >
                {sceneGroup ? <SceneIcon className="size-7" /> : <Rocket className="size-7 text-primary" />}
              </div>
              <div className="text-sm font-semibold">{guideTitle}</div>
              {/* M37-1：场景议程 chips（资产 agenda；点击预填草稿，不直发） */}
              {agenda.length > 0 && (
                <div className="flex max-w-xl flex-col items-center gap-1.5">
                  <div className="text-[11px] text-muted-foreground">推荐开场</div>
                  <div className="flex flex-wrap justify-center gap-2">
                    {agenda.map((it) => (
                      <button
                        key={it.label}
                        type="button"
                        title={it.prompt}
                        className="rounded-full bg-primary/[0.07] px-3 py-1 text-[12px] text-primary ring-1 ring-primary/15 transition-all hover:bg-primary/10 hover:shadow-sm hover:ring-primary/30"
                        onClick={() => insertRef.current?.(it.prompt)}
                      >
                        {it.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className="flex flex-wrap justify-center gap-2">
                {participants.map((a) => (
                  <button
                    key={a!.id}
                    type="button"
                    className="flex items-center gap-2 rounded-full border bg-card py-1 pl-1 pr-3 text-[12.5px] shadow-sm transition-all hover:border-primary/30 hover:bg-primary/5 hover:text-primary hover:shadow-md hover:shadow-primary/10"
                    onClick={() => insertRef.current?.(`@${a!.name} `)}
                  >
                    <AgentAvatar agent={a!} size={20} animated={false} />
                    {a!.name} · {a!.role}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <>
              {/* 消息分页：顶部哨兵——还有更早历史时给出加载反馈（自动触发见 onScroll） */}
              {hasMore && (
                <div className="flex items-center justify-center gap-1.5 py-2 text-[11px] text-muted-foreground">
                  {loadingEarlier ? (
                    <>
                      <Loader2 className="size-3 animate-spin" />
                      正在加载更早的消息…
                    </>
                  ) : (
                    '上滑加载更早的消息'
                  )}
                </div>
              )}
              <div style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
                {virtualizer.getVirtualItems().map((vi) => {
                  const row = rows[vi.index]
                  if (!row) return null
                  return (
                    <div
                      key={vi.key}
                      data-index={vi.index}
                      ref={virtualizer.measureElement}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        transform: `translateY(${vi.start}px)`,
                      }}
                    >
                      {row.kind === 'wave-sep' ? (
                        <WaveSeparator info={row.info} />
                      ) : row.kind === 'wave' ? (
                        <WaveGroup ids={row.ids} />
                      ) : (
                        <MessageItem messageId={row.id} />
                      )}
                    </div>
                  )
                })}
              </div>
              {/* M11：回合间隙显示「下一棒」身份（头像 + 名 + 后续排队数），不再是我抽象的「成员」；
                  仅本地挂接运行属于当前会话时渲染（防其他会话的队列串入） */}
              {active &&
                runSessionId === currentId &&
                !anyStreaming &&
                (() => {
                  // M77：下一棒按成员实例署名（分身 = 名字·灵魂名；头像取基础角色）
                  const nextKey = queue[0]
                  const next = nextKey ? agents.find((a) => a.id === baseAgentId(nextKey)) : undefined
                  const nextLabel = nextKey ? labelOfMemberKey(agents, session, nextKey) : ''
                  return (
                    <div className="flex items-center gap-2 px-5 py-3 text-[12px] text-muted-foreground">
                      {next ? (
                        <>
                          <AgentAvatar agent={next} size={20} animated className="ring-1 ring-primary/20" />
                          <span>
                            下一棒 · <span className="font-medium text-foreground">{nextLabel}</span> 正在热身
                          </span>
                          {queue.length > 1 && (
                            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px]">其后还有 {queue.length - 1} 位</span>
                          )}
                        </>
                      ) : (
                        <span>链路即将收束…</span>
                      )}
                      <span className="flex items-end gap-[3px]">
                        {[0, 1, 2].map((i) => (
                          <span
                            key={i}
                            className="pa-dot size-1.5 rounded-full bg-primary"
                            style={{ animationDelay: `${i * 0.18}s` }}
                          />
                        ))}
                      </span>
                    </div>
                  )
                })()}
              {/* M37-6 修订：收尾交付清单（本轮有交付件时呈现完整清单 + 快捷继续 + 彩纸；无交付件不渲染） */}
              <CloseoutCard />
              {/* M42（RT-5）：散会胶囊（末条含纪要容器且运行已收束时呈现） */}
              <AdjournPill />
            </>
          )}
          <BottomFollower containerRef={containerRef} atBottomRef={atBottomRef} pinnedTopRef={pinnedTopRef} />

          {/* M85 重设计（2026-09-25）：仅「有未读新消息」时浮现纯图标钮（无文字、不再常显）——
              上滑纯浏览历史时保持界面安静；未读数以小角标承载（aria/title 保留完整语义） */}
          {!atBottom && missed > 0 && (
            <div className="pointer-events-none sticky bottom-2 z-20 -mt-10 flex justify-end pr-2">
              <button
                type="button"
                onClick={jumpToBottom}
                className="pointer-events-auto relative flex size-8 animate-fade-in items-center justify-center rounded-full border bg-card/95 shadow-lg shadow-slate-900/10 backdrop-blur transition-colors hover:border-primary/40 hover:text-primary"
                title={`回到最新（${missed} 条新消息）`}
                aria-label={`回到最新，${missed} 条新消息`}
              >
                <ArrowDown className="size-4 text-primary" />
                <span className="absolute -right-1 -top-1 flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-primary px-0.5 text-[9px] font-semibold leading-none tabular-nums text-primary-foreground">
                  {missed > 99 ? '99+' : missed}
                </span>
              </button>
            </div>
          )}
        </div>

        {/* M37-3：悬浮阶段条（滚动位置派生；上滑离开底部时给出行进方位）；续修订：顶部渐隐遮罩 + 共 N 波读数；M39：生产型场景阶段名换显示 */}
        {!atBottom && currentWave && (
          <WaveStrip info={currentWave} total={waveTotal} group={sceneGroup} onJump={() => focusMessage(currentWave.memberIds[0]!)} />
        )}

        {/* （核心交付锚定条（FocusBar）已按用户决策全链删除——2026-09-25） */}

        {/* M37-7：消息导航条（≥20 条；细轨 + 视口窗口 + hover 展开） */}
        {session && messageCount >= RAIL_MIN_MESSAGES && (
          <MessageRail items={rail} total={rows.length} vp={vp} onJump={focusMessage} />
        )}
        </div>
      </SceneStage>

      <PlanReviewCard />
      <ApprovalPanel />
      {/* M57 P2：只读共享（viewer）横幅——服务端写闸门 403 的前置提示 */}
      {isViewer && (
        <div className="flex shrink-0 items-center gap-2 border-t border-amber-200/70 bg-amber-50 px-4 py-1.5 text-[12px] text-amber-800">
          <Eye className="size-3.5 shrink-0" />
          只读共享（viewer）：可查看消息与交付件，但不能发送 / 停止 / 审批
        </div>
      )}
      {/* （波次回放条已删除——2026-09-25 产品决策：用户确认不需要此入口，输入区更简洁） */}
      <Composer onReady={(fn) => (insertRef.current = fn)} locked={isViewer} />
      <ShareDialog sessionId={session?.id} open={shareOpen} onOpenChange={setShareOpen} />
      {/* M79-F：群 / 私聊成员弹窗（名单 + 邀请好友 + 群主移出） */}
      <ChatMembersDialog session={session} open={membersOpen} onOpenChange={setMembersOpen} />
    </div>
  )
}

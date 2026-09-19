/**
 * 协作图谱 2.0（§28，M17 起步 / M21 游戏化）：聊天流回答「说了什么」，图谱回答「如何协作」。
 * M21 升级（按「作战圆桌」游戏化设计）：
 * - 可拖动节点：自由摆放 + 「整理布局」平滑归位；拖动位置在实时事件重算布局时保持
 * - 双布局：接力链（dagre，看接力往哪走）/ 圆桌（radial + 中心图腾，看谁和谁在互动），切换平滑过渡
 * - 能量边：运行中沿接力方向流动（速度 / 粗细随接手次数）；新接力触发边爆发 + 目标节点接收光环
 * - 边视觉语义：实线蓝 = 顺向接力；实线琥珀 + 光晕 = 最近一棒（与节点 recent 同源）；
 *   长虚线紫 = 回退接力（排名回退，仅接力链有排名口径）；短虚线灰 = 编制预期；能量层颜色随语义
 * - 导演镜头：可选跟随当前发言者（发言 / 排队变化时相机平滑居中）
 * - HUD 战况：成员 / 接力 / 波次 / 队列 / 最新接力；dock 操作栏（布局 · 整理 · 跟拍）
 * - 档案工作面板（GraphInspector）：点击节点查看统计 / 工作产出 / 上下游 / 最近发言并可（聚焦 · 拍一拍 · 召唤）
 * - 悬停稳定化：边标签仅随「点选成员 / 悬停边本身」出现（悬停节点不再弹出/收回），淡化过渡消除多线重叠闪烁；画布移除 MiniMap 与水印
 * - 节点引用稳定化：未变化节点复用对象引用、变化节点携带 measured——React Flow 受控重建时若丢失测量值会把节点
 *   瞬间置为 visibility: hidden（hit-test 消失 → mouseleave → 状态回摆 → enter/leave 振荡），此路径会引发悬停闪烁并阻断点击
 * M22 深化（交互手感 + 洞察 + 时间轴回放）：
 * - A1 悬停预览卡（280ms）/ A2 双击聚焦（节点开档案 · 空白适配视野）/ A3 键盘导航（方向键 / 1 2 / T 追踪 / F 跟拍）
 * - A4 点击接力边重放流光 + 固定标签 / A5 交还用户全图庆祝脉冲
 * - B1 接力链追踪（3 跳 BFS：focusSet + 链路边）/ B2 游离成员口径（虚线呼吸环）
 * - C 时间轴回放：按消息切片重建图（dock 入口 · 300ms/条 · 拖拽定格 · Esc 回实时）
 * 约束：懒加载独立 chunk 不变；quiet / reduced-motion 全量降级；数据口径零后端（lib/graph.ts 推导）。
 */
import * as React from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  ReactFlow,
  applyNodeChanges,
  type EdgeTypes,
  type NodeChange,
  type NodeTypes,
  type ReactFlowInstance,
} from '@xyflow/react'
import {
  Clapperboard,
  GitBranch,
  History,
  LayoutGrid,
  Maximize2,
  Minimize2,
  Orbit,
  Workflow,
  X,
} from 'lucide-react'
import type { AgentDefinition, Artifact, ChatMessage } from '@multi-agent/shared'
import { apiGet } from '../../lib/api'
import {
  buildGraph,
  neighborsOf,
  summarizeGraph,
  traceFrom,
  type GraphLive,
  type GraphModel,
} from '../../lib/graph'
import {
  CORE_ID,
  NODE_H,
  NODE_W,
  layoutGraph,
  nextNodeInDirection,
  pickChainPerRow,
  type LayoutMode,
  type LayoutResult,
  type NavDirection,
} from '../../lib/graph-layout'
import { timeAgo } from '../../lib/time'
import { cn } from '../../lib/utils'
import { AgentAvatar } from '../agents/AgentAvatar'
import { activeSoulOf } from '../agents/SoulPicker'
import { Button } from '../ui/button'
import { AgentNodeView, type AgentFlowNode } from './graph/AgentNode'
import { CoreNodeView, type CoreFlowNode } from './graph/CoreNode'
import { GraphInspector } from './graph/GraphInspector'
import { GraphReplay } from './graph/GraphReplay'
import { NodePreview } from './graph/NodePreview'
import { RelayEdge, EDGE_TONE, type RelayFlowEdge } from './graph/RelayEdge'
import type { RelayEdgeData } from './graph/types'
import { useAgentStore } from '../../stores/agent-store'
import { useRunStore } from '../../stores/run-store'
import { messagesOf, useSessionStore } from '../../stores/session-store'
import { useUiStore } from '../../stores/ui-store'
import '@xyflow/react/dist/style.css'

type AnyFlowNode = AgentFlowNode | CoreFlowNode

const nodeTypes = { agent: AgentNodeView, core: CoreNodeView } satisfies NodeTypes
const edgeTypes = { relay: RelayEdge } satisfies EdgeTypes

/** 布局切换 / 整理时的位置过渡（拖动中关闭，避免跟手滞后） */
const LAYOUT_TRANSITION = 'transform 380ms cubic-bezier(0.22, 1, 0.36, 1)'
/** fitView 统一留白（内容四周比例） */
const FIT_VIEW_PADDING = 0.2
/** fitView 放大上限：初始化 / 切布局 / 整理不做超原生尺寸的放大（窄栏折行单列时避免节点被撑到巨大；手动缩放不受此限） */
const FIT_MAX_ZOOM = 1
/** 回放步进间隔（ms/条）：与消息粒度对齐的稳定节奏 */
const REPLAY_STEP_MS = 300
/** 回放期间的「实时快照」：屏蔽发言 / 队列 / 待办，只看接力如何长出来 */
const REPLAY_LIVE: GraphLive = { active: false, currentWave: [], queue: [], statuses: {} }
/** 时间轴回放状态（null = 实时视图） */
type ReplayState = { index: number; playing: boolean } | null
/** 悬停预览卡出现延迟（ms）：轻扫而过不弹出 */
const PREVIEW_DELAY_MS = 280
/** 悬停预览卡宽度（与 NodePreview 的 w-[236px] 同步；用于右缘溢出翻转） */
const PREVIEW_W = 236
/** 方向键 → 导航方向（A3） */
const DIR_KEYS: Record<string, NavDirection> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
}

interface BuildNodesInput {
  model: GraphModel
  layoutResult: LayoutResult
  focusId: string | null
  /** 焦点集合（追踪链路成员或焦点邻居；非成员降透明） */
  focusSet: Set<string>
  selectedId: string | null
  smooth: boolean
  layoutMode: LayoutMode
  flashOf: ReadonlyMap<string, number>
  stageName: string
  stageColor: string | null
  memberCount: number
}

/** 画布节点组装（布局位置 + 焦点 / 选中 / 脉冲 / 过渡态） */
function buildFlowNodes(input: BuildNodesInput): AnyFlowNode[] {
  const {
    model,
    layoutResult,
    focusId,
    focusSet,
    selectedId,
    smooth,
    layoutMode,
    flashOf,
    stageName,
    stageColor,
    memberCount,
  } = input
  const style = smooth ? { transition: LAYOUT_TRANSITION } : undefined
  const nodes: AnyFlowNode[] = model.nodes.map((n) => ({
    id: n.id,
    type: 'agent',
    position: layoutResult.positions.get(n.id) ?? { x: 0, y: 0 },
    data: {
      ...n.data,
      dimmed: !!focusId && !focusSet.has(n.id),
      pinned: selectedId === n.id,
      enterDelay: layoutResult.delays.get(n.id) ?? 0,
      smooth,
      flash: flashOf.get(n.id) ?? 0,
      layout: layoutMode,
    },
    style,
    draggable: true,
    selectable: false,
    connectable: false,
  }))
  if (layoutResult.core) {
    nodes.push({
      id: CORE_ID,
      type: 'core',
      position: layoutResult.core,
      data: { name: stageName, count: memberCount, color: stageColor, enterDelay: 200 },
      style,
      draggable: false,
      selectable: false,
      connectable: false,
    })
  }
  return nodes
}

/**
 * 节点浅比较：data / 位置 / 过渡样式均未变时复用旧对象引用。
 * React Flow（受控模式）只在 userNode 引用相等或携带 measured 时保留内部节点，
 * 复用引用可完全跳过内部重建（measured / handleBounds 不丢，NodeWrapper 不重渲染）。
 */
function sameFlowNode(a: AnyFlowNode, b: AnyFlowNode): boolean {
  if (a === b) return true
  if (a.position.x !== b.position.x || a.position.y !== b.position.y) return false
  if ((a.style?.transition ?? '') !== (b.style?.transition ?? '')) return false
  if (!sameData(a.data, b.data)) return false
  return true
}

function sameData(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false
  const ra = a as Record<string, unknown>
  const rb = b as Record<string, unknown>
  const keys = Object.keys(ra)
  if (keys.length !== Object.keys(rb).length) return false
  for (const k of keys) if (ra[k] !== rb[k]) return false
  return true
}

/** 成员最近一条完成发言（实时口径；悬停预览卡 / 档案面板共用） */
function findLastMessage(agentId: string): ChatMessage | undefined {
  const { byId, order } = useSessionStore.getState()
  for (let i = order.length - 1; i >= 0; i--) {
    const m = byId.get(order[i]!)
    if (m?.role === 'agent' && m.agentId === agentId && m.status !== 'streaming') return m
  }
  return undefined
}

/** 图例（线型 × 颜色语义，口径与 RelayEdge.EDGE_TONE 一致；回退仅接力链布局有排名判定） */
function legendItems(layoutMode: LayoutMode): Array<{ swatch: React.JSX.Element; label: string }> {
  return [
    { swatch: <span className="h-0.5 w-4 rounded bg-primary" />, label: '实际接力' },
    { swatch: <span className="h-0.5 w-4 rounded bg-amber-500" />, label: '最近一棒' },
    ...(layoutMode === 'chain'
      ? [
          {
            swatch: <span className="h-0.5 w-4 border-t border-dashed border-violet-500" />,
            label: '回退接力',
          },
        ]
      : []),
    {
      swatch: <span className="h-0.5 w-4 border-t border-dashed border-muted-foreground" />,
      label: '编制预期',
    },
    {
      swatch: <span className="size-2 rounded-full bg-primary/60 ring-2 ring-primary/25" />,
      label: '发言中',
    },
    {
      swatch: (
        <span className="flex size-3.5 items-center justify-center rounded-full bg-primary text-[8px] font-semibold text-primary-foreground">
          1
        </span>
      ),
      label: '排队中',
    },
  ]
}

function ChainPreview({
  group,
  agents,
}: {
  group?: { name: string; chain: string[] }
  agents: AgentDefinition[]
}): React.JSX.Element {
  const chain = (group?.chain ?? [])
    .map((id) => agents.find((a) => a.id === id))
    .filter(Boolean) as AgentDefinition[]
  return (
    <div className="rounded-xl border border-dashed p-3">
      <div className="mb-2 text-[10.5px] uppercase tracking-wide text-muted-foreground">
        编制预览{group ? ` · ${group.name}` : ''}
      </div>
      <div className="flex items-center gap-1">
        {chain.map((a, i) => (
          <React.Fragment key={a.id}>
            {i > 0 && <span className="text-[10px] text-muted-foreground/50">›</span>}
            <AgentAvatar agent={a} size={24} animated={false} className="rounded-full" />
          </React.Fragment>
        ))}
      </div>
    </div>
  )
}

export function GraphView(): React.JSX.Element {
  const agents = useAgentStore((s) => s.agents)
  const groups = useAgentStore((s) => s.groups)
  const statuses = useAgentStore((s) => s.statuses)
  const sessions = useSessionStore((s) => s.sessions)
  const currentId = useSessionStore((s) => s.currentId)
  const active = useRunStore((s) => s.active)
  const queue = useRunStore((s) => s.queue)
  const currentWave = useRunStore((s) => s.currentWave)
  const waveIndex = useRunStore((s) => s.waveIndex)
  const quiet = useUiStore((s) => s.quietMode)

  const [hoverId, setHoverId] = React.useState<string | null>(null)
  const [hoverEdgeId, setHoverEdgeId] = React.useState<string | null>(null)
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [expanded, setExpanded] = React.useState(false)
  const [layoutMode, setLayoutMode] = React.useState<LayoutMode>('chain')
  const [follow, setFollow] = React.useState(false)
  const [entering, setEntering] = React.useState(true)
  const [tipGone, setTipGone] = React.useState(false)
  const [smoothTick, setSmoothTick] = React.useState(false)
  /** 画布容器尺寸（ResizeObserver）：驱动力链折行选档（窄容器蛇形赛道 / 宽容器单行） */
  const [canvasSize, setCanvasSize] = React.useState<{ w: number; h: number } | null>(null)
  /** B1 接力链追踪起点（null = 未追踪） */
  const [traceId, setTraceId] = React.useState<string | null>(null)
  /** A4 点击固定的边（标签保持显示；再点取消） */
  const [edgePin, setEdgePin] = React.useState<string | null>(null)
  /** A4 溯源重放 nonce（点击边一次性流光） */
  const [replayMap, setReplayMap] = React.useState<ReadonlyMap<string, number>>(new Map())
  /** C 时间轴回放（null = 实时视图） */
  const [replay, setReplay] = React.useState<ReplayState>(null)
  /** A1 悬停预览（含容器内坐标；停留 280ms 后出现） */
  const [preview, setPreview] = React.useState<{ id: string; left: number; top: number } | null>(null)
  /** A5 庆祝脉冲 nonce（awaitingUser 从无到有） */
  const [celebrateTick, setCelebrateTick] = React.useState(0)

  const wrapRef = React.useRef<HTMLDivElement | null>(null)
  const rf = React.useRef<ReactFlowInstance<AnyFlowNode, RelayFlowEdge> | null>(null)
  const offsets = React.useRef(new Map<string, { x: number; y: number }>())
  const dragging = React.useRef(new Set<string>())
  const smoothTimer = React.useRef<number>()
  const pulses = React.useRef(new Map<string, number>())
  const nodeFlash = React.useRef(new Map<string, number>())
  const prevCounts = React.useRef(new Map<string, number>())
  // 脉冲数据以 state 快照承载：新接力发生时递增 nonce → 边爆发 / 节点接收光环
  const [pulseMap, setPulseMap] = React.useState<ReadonlyMap<string, number>>(new Map())
  const [flashMap, setFlashMap] = React.useState<ReadonlyMap<string, number>>(new Map())

  React.useEffect(() => {
    const t = setTimeout(() => setEntering(false), 1500)
    const t2 = setTimeout(() => setTipGone(true), 4000)
    return () => {
      clearTimeout(t)
      clearTimeout(t2)
    }
  }, [])
  React.useEffect(() => () => window.clearTimeout(smoothTimer.current), [])
  // 容器尺寸监听（2px 阈值防抖）：折行选档依赖它
  React.useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect
      if (!cr || cr.width <= 0 || cr.height <= 0) return
      setCanvasSize((p) =>
        p && Math.abs(p.w - cr.width) < 2 && Math.abs(p.h - cr.height) < 2
          ? p
          : { w: cr.width, h: cr.height },
      )
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const session = sessions.find((s) => s.id === currentId)
  const participants = React.useMemo(() => {
    const ids = new Set(session?.participantIds ?? [])
    return agents.filter((a) => ids.has(a.id))
  }, [agents, session])

  // 结构指纹：流式 delta 不改变图结构/边权，避免 40ms 高频重建（status/mentions/createdAt 变化才重算）
  const structureKey = useSessionStore((s) =>
    s.order
      .map((id) => {
        const m = s.byId.get(id)
        return m ? `${m.role}~${m.agentId ?? ''}~${m.status}~${m.mentions.join(',')}` : '_'
      })
      .join('|'),
  )

  /** 实时全量消息（回放切片的基底；structureKey 驱动） */
  const liveMessages = React.useMemo(() => {
    const { byId, order } = useSessionStore.getState()
    return messagesOf({ byId, order })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureKey])

  /** 回放切片（null = 实时视图）：index 条消息构成的「当时图」 */
  const replayIndex = replay?.index ?? null
  const replayMessages = React.useMemo(
    () => (replayIndex === null ? null : liveMessages.slice(0, replayIndex)),
    [replayIndex, liveMessages],
  )

  const model = React.useMemo(() => {
    const live: GraphLive = { active, currentWave, queue, statuses }
    return buildGraph(
      replayMessages ?? liveMessages,
      participants,
      groups,
      replayMessages ? REPLAY_LIVE : live,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureKey, participants, groups, active, currentWave, queue, statuses, replayMessages])

  const summary = React.useMemo(() => summarizeGraph(model), [model])

  // 会话级统计：各成员完成发言条数（档案面板「发言」格）
  const talksOf = React.useMemo(() => {
    const { byId, order } = useSessionStore.getState()
    const count = new Map<string, number>()
    for (const id of order) {
      const m = byId.get(id)
      if (m?.role === 'agent' && m.agentId && m.status !== 'streaming') {
        count.set(m.agentId, (count.get(m.agentId) ?? 0) + 1)
      }
    }
    return count
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureKey])

  // 工作产出：会话交付件全量（档案面板按 authorAgentId 过滤；artifactVersion 驱动刷新）
  const artifactVersion = useSessionStore((s) => s.artifactVersion)
  const [artifacts, setArtifacts] = React.useState<Artifact[]>([])
  React.useEffect(() => {
    if (!currentId) {
      setArtifacts([])
      return
    }
    let alive = true
    apiGet<{ artifacts: Artifact[] }>(`/api/sessions/${currentId}/artifacts`)
      .then((res) => {
        if (alive) setArtifacts(res.artifacts ?? [])
      })
      .catch(() => {
        if (alive) setArtifacts([])
      })
    return () => {
      alive = false
    }
  }, [currentId, artifactVersion])

  /** B1 追踪结果（3 跳双向 BFS；null = 未追踪） */
  const trace = React.useMemo(() => (traceId ? traceFrom(model, traceId, 3) : null), [model, traceId])
  /** 焦点优先级：追踪 > 悬停 > 选中 */
  const focusId = traceId ?? hoverId ?? selectedId
  const neighborIds = React.useMemo(() => {
    const ids = new Set<string>()
    if (!focusId) return ids
    ids.add(focusId)
    for (const e of model.edges) {
      if (e.source === focusId) ids.add(e.target)
      if (e.target === focusId) ids.add(e.source)
    }
    return ids
  }, [model, focusId])
  /** 焦点集合：追踪口径（链路成员）或邻居口径（悬停 / 选中的直接相关者） */
  const focusSet = React.useMemo(
    () => (trace ? new Set(trace.hops.keys()) : neighborIds),
    [trace, neighborIds],
  )

  // 接力链折行选档：容器宽度 / 高度 + 人数 → 每行节点数（radial 不用）
  const perRow = React.useMemo(
    () => (canvasSize ? pickChainPerRow(model.nodes.length, canvasSize.w, canvasSize.h) : undefined),
    [canvasSize, model.nodes.length],
  )
  const layoutResult = React.useMemo(
    () => layoutGraph(model, layoutMode, { chainPerRow: layoutMode === 'chain' ? perRow : undefined }),
    [model, layoutMode, perRow],
  )
  const stageGroup = React.useMemo(
    () => groups.find((g) => g.id === participants[0]?.group),
    [groups, participants],
  )
  const stageName = stageGroup?.name ?? '协作圆桌'
  const stageColor = stageGroup?.theme[0] ?? null

  // ---- 接力脉冲：接力边权重增长 → 边爆发 + 目标节点接收光环；A5 交还用户 → 全图庆祝（切换 / 回放进出重置基线，不误报）----
  const sessionRef = React.useRef(currentId)
  const replayRef = React.useRef(false)
  const prevAwaiting = React.useRef<string | null | undefined>(undefined)
  React.useEffect(() => {
    const switched = sessionRef.current !== currentId
    const modeChanged = replayRef.current !== (replay !== null)
    sessionRef.current = currentId
    replayRef.current = replay !== null
    const reset = switched || modeChanged
    if (reset) {
      prevCounts.current.clear()
      pulses.current.clear()
      nodeFlash.current.clear()
      setPulseMap(new Map())
      setFlashMap(new Map())
      prevAwaiting.current = undefined
    }
    let changed = false
    for (const e of model.edges) {
      if (e.kind !== 'relay') continue
      const prev = prevCounts.current.get(e.id)
      if (!reset && prev !== undefined && e.count > prev) {
        pulses.current.set(e.id, (pulses.current.get(e.id) ?? 0) + 1)
        nodeFlash.current.set(e.target, (nodeFlash.current.get(e.target) ?? 0) + 1)
        changed = true
      }
      prevCounts.current.set(e.id, e.count)
    }
    if (changed) {
      setPulseMap(new Map(pulses.current))
      setFlashMap(new Map(nodeFlash.current))
    }
    // A5 庆祝：回放中不参与；实时视图下 awaitingUser 从无到有（或换人）→ 全图柔光脉冲
    if (!replay) {
      const awaitingId = model.nodes.find((n) => n.data.awaitingUser)?.id ?? null
      if (prevAwaiting.current !== undefined && awaitingId && awaitingId !== prevAwaiting.current) {
        setCelebrateTick((t) => t + 1)
      }
      prevAwaiting.current = awaitingId
    }
  }, [model, currentId, replay])

  const flowNodes = React.useMemo(
    () =>
      buildFlowNodes({
        model,
        layoutResult,
        focusId,
        focusSet,
        selectedId,
        smooth: smoothTick,
        layoutMode,
        flashOf: flashMap,
        stageName,
        stageColor,
        memberCount: participants.length,
      }),
    [
      model,
      layoutResult,
      focusId,
      focusSet,
      selectedId,
      smoothTick,
      layoutMode,
      stageName,
      stageColor,
      participants.length,
      flashMap,
    ],
  )

  const edges = React.useMemo<RelayFlowEdge[]>(() => {
    const ranks = layoutResult.ranks
    return model.edges.map((e) => {
      const relay = e.kind === 'relay'
      const hover = e.id === hoverEdgeId
      // 最近一棒：最近一条 agent 消息派生的交接边（琥珀高亮，与节点 recent 同源）
      const recent = relay && e.recent === true
      // 回退接力：目标排名在源之前（折行 / 拖动不改变语义；圆桌无排名口径）
      const backward = relay && !!ranks && (ranks.get(e.target) ?? 0) < (ranks.get(e.source) ?? 0)
      // 追踪口径：链路内边为焦点边；未追踪时沿焦点节点口径
      const incident = trace
        ? hover || trace.edgeIds.has(e.id)
        : hover || (!!focusId && (e.source === focusId || e.target === focusId))
      const muted = !hover && !!focusId && !incident
      // 标签稳定化：仅「点选成员 / 悬停边 / 点击固定」时显示——悬停节点不弹出/收回，消除闪烁
      const showText =
        relay &&
        (hover || e.id === edgePin || (!!selectedId && (e.source === selectedId || e.target === selectedId)))
      const data: RelayEdgeData = {
        kind: e.kind,
        count: e.count,
        layout: layoutMode,
        recent,
        backward,
        flowing: relay && active && !replay,
        pulse: relay ? (pulseMap.get(e.id) ?? 0) : 0,
        replay: relay ? (replayMap.get(e.id) ?? 0) : 0,
        incident,
        muted,
        quiet,
        text: showText ? `接手 ${e.count} 次${e.lastAt ? ` · ${timeAgo(e.lastAt)}` : ''}` : undefined,
      }
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        type: 'relay',
        data,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 14,
          height: 14,
          // 箭头颜色与边语义同源（EDGE_TONE 口径）
          color: relay
            ? recent
              ? EDGE_TONE.recent
              : backward
                ? EDGE_TONE.backward
                : EDGE_TONE.relay
            : EDGE_TONE.chain,
        },
      }
    })
  }, [
    model,
    layoutResult,
    focusId,
    trace,
    selectedId,
    hoverEdgeId,
    edgePin,
    active,
    quiet,
    layoutMode,
    pulseMap,
    replayMap,
    replay,
  ])

  // ---- 节点 state：拖动位置（offsets）在实时重算时优先，布局过渡由 smoothTick 驱动 ----
  // 悬停稳定化关键：变化节点必须携带 measured（React Flow 借此判定已初始化，
  // 缺失即置 visibility: hidden → 悬停中的节点被 hit-test 漏掉 → enter/leave 振荡）
  const [nodes, setNodes] = React.useState<AnyFlowNode[]>([])
  React.useEffect(() => {
    setNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]))
      const merge = (target: AnyFlowNode, p: AnyFlowNode | undefined): AnyFlowNode => {
        const withMeasured = p?.measured ? { ...target, measured: p.measured } : target
        return p && sameFlowNode(p, withMeasured) ? p : withMeasured
      }
      const next = flowNodes.map((n) => {
        const p = prevById.get(n.id)
        const off = offsets.current.get(n.id)
        if (off) return merge({ ...n, position: off }, p)
        if (p && dragging.current.has(n.id)) return merge({ ...n, position: p.position }, p)
        return merge(n, p)
      })
      return next.length === prev.length && next.every((n, i) => n === prev[i]) ? prev : next
    })
  }, [flowNodes])

  const onNodesChange = React.useCallback((changes: NodeChange<AnyFlowNode>[]) => {
    setNodes((nds) => applyNodeChanges(changes, nds))
  }, [])

  const startSmooth = React.useCallback(() => {
    window.clearTimeout(smoothTimer.current)
    setSmoothTick(true)
    smoothTimer.current = window.setTimeout(() => setSmoothTick(false), 460)
  }, [])

  /** 切换布局：清空手动偏移 → 平滑过渡到新布局（随后自动 fitView） */
  const switchLayout = (mode: LayoutMode): void => {
    if (mode === layoutMode) return
    offsets.current.clear()
    startSmooth()
    setLayoutMode(mode)
    window.setTimeout(() => rf.current?.fitView({ padding: FIT_VIEW_PADDING, maxZoom: FIT_MAX_ZOOM, duration: 520 }), 60)
  }

  /** 整理布局：清除拖动偏移，平滑归位到自动布局 */
  const tidyLayout = (): void => {
    if (offsets.current.size === 0) {
      rf.current?.fitView({ padding: FIT_VIEW_PADDING, maxZoom: FIT_MAX_ZOOM, duration: 420 })
      return
    }
    offsets.current.clear()
    startSmooth()
    setNodes((prev) => prev.map((n) => ({ ...n, style: { ...n.style, transition: LAYOUT_TRANSITION } })))
  }

  /** C 进入 / 退出时间轴回放（进入时收起面板 / 追踪 / 固定边 / 预览，避免与回放视图打架） */
  const toggleReplay = (): void => {
    if (replay) {
      setReplay(null)
      return
    }
    if (liveMessages.length === 0) return
    setSelectedId(null)
    setTraceId(null)
    setEdgePin(null)
    setPreview(null)
    setReplay({ index: 0, playing: true })
  }

  // 折行档位 / 容器尺寸变化 → 重排后重新适配视野（首次挂载瞬移，其余平滑；全屏切换即走此路径）
  const firstFit = React.useRef(true)
  React.useEffect(() => {
    if (layoutMode !== 'chain' || perRow === undefined) return
    const instant = firstFit.current
    firstFit.current = false
    if (!instant) startSmooth()
    const t = window.setTimeout(
      () => rf.current?.fitView({ padding: FIT_VIEW_PADDING, maxZoom: FIT_MAX_ZOOM, duration: instant ? 0 : 420 }),
      80,
    )
    return () => window.clearTimeout(t)
  }, [perRow, layoutMode, canvasSize, startSmooth])

  /** 聚焦：相机平滑居中指定成员（缩放不低于 1.05 保证可读） */
  const focusOn = (id: string): void => {
    const n = nodes.find((x) => x.id === id)
    if (!n || !rf.current) return
    const zoom = Math.max(rf.current.getZoom(), 1.05)
    rf.current.setCenter(n.position.x + NODE_W / 2, n.position.y + NODE_H / 2, { zoom, duration: 600 })
  }

  // ---- 导演镜头：跟随当前发言者（无发言者时跟随队首；回放中不参与）----
  const nodesRef = React.useRef(nodes)
  React.useEffect(() => {
    nodesRef.current = nodes
  }, [nodes])
  React.useEffect(() => {
    if (!follow || !active || replay || !rf.current) return
    const target = currentWave[0] ?? queue[0]
    const n = target ? nodesRef.current.find((x) => x.id === target) : undefined
    if (!n) return
    rf.current.setCenter(n.position.x + NODE_W / 2, n.position.y + NODE_H / 2, { duration: 650 })
  }, [follow, active, currentWave, queue, replay])

  // ---- A1 悬停预览：停留 280ms 按视口换算屏幕坐标浮现；离开 / 回放即收起 ----
  const previewTimer = React.useRef<number>()
  React.useEffect(() => () => window.clearTimeout(previewTimer.current), [])
  React.useEffect(() => {
    window.clearTimeout(previewTimer.current)
    if (!hoverId || replay) {
      setPreview(null)
      return
    }
    previewTimer.current = window.setTimeout(() => {
      const n = nodesRef.current.find((x) => x.id === hoverId)
      const vp = rf.current?.getViewport()
      const el = wrapRef.current
      if (!n || !vp || !el) return
      const z = vp.zoom
      const nodeLeft = n.position.x * z + vp.x
      const anchorX = nodeLeft + NODE_W * z + 10
      const left = anchorX + PREVIEW_W + 8 > el.clientWidth ? Math.max(8, nodeLeft - PREVIEW_W - 10) : anchorX
      const top = Math.max(8, Math.min(n.position.y * z + vp.y, el.clientHeight - 150))
      setPreview({ id: hoverId, left, top })
    }, PREVIEW_DELAY_MS)
    return () => window.clearTimeout(previewTimer.current)
  }, [hoverId, replay])

  // ---- C 回放推进：300ms/条；播放到末尾自动回到实时（暂停定格不退出）----
  React.useEffect(() => {
    if (!replay || !replay.playing) return
    if (replay.index >= liveMessages.length) {
      const t = window.setTimeout(() => setReplay(null), 600)
      return () => window.clearTimeout(t)
    }
    const t = window.setTimeout(
      () => setReplay((p) => (p && p.playing ? { ...p, index: p.index + 1 } : p)),
      REPLAY_STEP_MS,
    )
    return () => window.clearTimeout(t)
  }, [replay, liveMessages.length])

  // ---- 键盘（A3 + Esc 分层收起）：方向键移动选中；1/2 切布局；T 追踪；F 跟拍；Esc：回放 → 追踪 → 固定边 → 全屏 → 面板 ----
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      const typing = !!t?.closest('input, textarea, select, [contenteditable="true"]')
      if (e.key === 'Escape') {
        // 注：Esc 不受 typing 限制——输入区（如「@ 召唤」聚焦 Composer）后按 Esc 仍逐层收起；
        // Composer 的 Esc 处理（关弹层 / 清 slash）不拦截冒泡，两者同帧生效互不冲突
        if (replay) {
          setReplay(null)
        } else if (traceId) {
          setTraceId(null)
        } else if (edgePin) {
          setEdgePin(null)
        } else if (expanded) {
          setExpanded(false)
          setFollow(false)
          setSelectedId(null)
        } else if (selectedId) {
          setSelectedId(null)
        }
        return
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        if (!selectedId) return
        const pos = new Map(nodesRef.current.map((n) => [n.id, n.position]))
        const next = nextNodeInDirection(pos, selectedId, DIR_KEYS[e.key]!)
        if (next) {
          setSelectedId(next)
          focusOn(next)
        }
        e.preventDefault()
        return
      }
      if (e.key === '1') switchLayout('chain')
      else if (e.key === '2') switchLayout('radial')
      else if (e.key === 't' || e.key === 'T') setTraceId((p) => (p ? null : selectedId))
      else if (e.key === 'f' || e.key === 'F') setFollow((v) => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, selectedId, replay, traceId, edgePin])

  const toggleExpand = (): void => {
    const next = !expanded
    setExpanded(next)
    setFollow(next)
    if (!next) setSelectedId(null)
  }

  const selectedNode = selectedId ? model.nodes.find((n) => n.id === selectedId) : undefined
  /** 生效灵魂：会话覆盖 > 角色默认（档案面板徽标） */
  const soulOverride = useSessionStore(
    (s) => s.sessions.find((x) => x.id === s.currentId)?.memberSouls?.[selectedId ?? ''],
  )
  /** A1 预览目标节点与最近发言（悬停节点在 model 中解析） */
  const previewNode = preview ? model.nodes.find((n) => n.id === preview.id) : undefined
  const previewMessage = React.useMemo(
    () => (preview ? findLastMessage(preview.id) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [preview, structureKey],
  )
  const links = React.useMemo(
    () => (selectedId ? neighborsOf(model, selectedId) : { upstream: [], downstream: [] }),
    [model, selectedId],
  )
  /** 选中成员的工作产出（交付件按作者归集；mtime 降序） */
  const selectedArtifacts = React.useMemo(
    () =>
      selectedId
        ? artifacts.filter((a) => a.authorAgentId === selectedId).sort((a, b) => b.mtime - a.mtime)
        : [],
    [artifacts, selectedId],
  )
  const lastMessage = React.useMemo(
    () => (selectedId ? findLastMessage(selectedId) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedId, structureKey],
  )

  const nameOf = (id: string): string => agents.find((a) => a.id === id)?.name ?? id

  const canvas = (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      fitView
      fitViewOptions={{ padding: FIT_VIEW_PADDING, maxZoom: FIT_MAX_ZOOM }}
      minZoom={0.25}
      maxZoom={2.2}
      proOptions={{ hideAttribution: true }}
      nodesConnectable={false}
      elementsSelectable={false}
      onInit={(inst) => (rf.current = inst)}
      onNodesChange={onNodesChange}
      onNodeDragStart={(_, n) => {
        dragging.current.add(n.id)
        setSmoothTick(false)
      }}
      onNodeDragStop={(_, n) => {
        dragging.current.delete(n.id)
        offsets.current.set(n.id, n.position)
      }}
      onNodeMouseEnter={(_, n) => {
        if (n.type === 'agent') setHoverId(n.id)
      }}
      onNodeMouseLeave={() => setHoverId(null)}
      onNodeClick={(_, n) => {
        if (n.type === 'core') return
        setSelectedId((p) => (p === n.id ? null : n.id))
      }}
      onNodeDoubleClick={(_, n) => {
        if (n.type === 'core') return
        setSelectedId(n.id)
        focusOn(n.id)
      }}
      onEdgeMouseEnter={(_, e) => setHoverEdgeId(e.id)}
      onEdgeMouseLeave={() => setHoverEdgeId(null)}
      onEdgeClick={(_, e) => {
        if (e.data?.kind !== 'relay') return
        if (edgePin === e.id) {
          setEdgePin(null)
          return
        }
        setEdgePin(e.id)
        setReplayMap((m) => new Map(m).set(e.id, (m.get(e.id) ?? 0) + 1))
      }}
      onPaneClick={(e) => {
        // A2 空白双击：适配视野；单击：收起面板与固定边
        if (e.detail === 2) {
          rf.current?.fitView({ padding: FIT_VIEW_PADDING, maxZoom: FIT_MAX_ZOOM, duration: 520 })
          return
        }
        setSelectedId(null)
        setEdgePin(null)
      }}
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="hsl(var(--border))" />
      {/* Controls 上移避开底部 dock（窄容器下 dock 可换行成多行；适配按钮同样受放大上限约束） */}
      <Controls showInteractive={false} style={{ bottom: 76 }} fitViewOptions={{ maxZoom: FIT_MAX_ZOOM }} />
    </ReactFlow>
  )

  if (participants.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <Workflow className="float-soft size-7 text-primary/40" />
        <div className="text-[12.5px] text-muted-foreground">会话还没有成员</div>
        <ChainPreview group={groups[0]} agents={agents} />
      </div>
    )
  }

  return (
    <div
      className={cn(
        expanded ? 'fixed inset-0 z-[70] flex flex-col bg-background' : 'flex h-full min-h-0 flex-col',
      )}
    >
      <div className="relative min-h-0 flex-1">
        <div ref={wrapRef} className={cn('h-full w-full', entering && !quiet && 'graph-enter')}>
          {canvas}
        </div>

        {/* 图例（顶部左侧，沿用 M17 口径） */}
        <div className="pointer-events-none absolute inset-x-1 top-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-lg bg-card/85 px-2 py-1 backdrop-blur-[1px]">
          {legendItems(layoutMode).map((x) => (
            <span key={x.label} className="flex items-center gap-1 text-[10px] text-muted-foreground">
              {x.swatch}
              {x.label}
            </span>
          ))}
        </div>

        <Button
          variant="outline"
          size="icon-sm"
          className="absolute right-1 top-1 z-10 bg-card/90"
          title={expanded ? '退出全屏（Esc）' : '全屏查看'}
          onClick={toggleExpand}
        >
          {expanded ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
        </Button>

        {expanded && (
          <span className="pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 rounded-full border bg-card px-2.5 py-0.5 text-[11px] text-muted-foreground shadow-soft">
            协作图谱 · 拖动节点自由摆放 · 点成员开档案 · 接力实线 = 实际接手
          </span>
        )}

        {/* 入场小贴士（4s 后消失） */}
        {!tipGone && (
          <span className="graph-tip pointer-events-none absolute bottom-20 left-1/2 -translate-x-1/2 rounded-full border bg-card/90 px-2.5 py-0.5 text-[10.5px] text-muted-foreground shadow-soft">
            拖动节点自由摆放 · 点成员开档案
          </span>
        )}

        {/* A5 交还用户庆祝：全图柔光脉冲（nonce 重放） */}
        {celebrateTick > 0 && (
          <span key={celebrateTick} aria-hidden className="graph-celebrate-flash absolute inset-0 z-[5]" />
        )}

        {/* A1 悬停预览卡（280ms 浮现；pointer-events: none 不破坏 hover → click 链路） */}
        {preview && previewNode && (
          <NodePreview
            agent={previewNode.data.agent}
            speaking={previewNode.data.speaking}
            queueIndex={previewNode.data.queueIndex}
            awaitingUser={previewNode.data.awaitingUser}
            status={statuses[previewNode.id]}
            inCount={previewNode.data.inCount}
            outCount={previewNode.data.outCount}
            talks={talksOf.get(previewNode.id) ?? 0}
            isolated={previewNode.data.isolated}
            lastMessage={previewMessage}
            left={preview.left}
            top={preview.top}
          />
        )}

        {/* C 时间轴回放条 */}
        {replay && (
          <GraphReplay
            index={replay.index}
            total={liveMessages.length}
            playing={replay.playing}
            onSeek={(v) => setReplay((p) => (p ? { ...p, index: v, playing: false } : p))}
            onToggle={() => setReplay((p) => (p ? { ...p, playing: !p.playing } : p))}
            onExit={() => setReplay(null)}
          />
        )}

        {/* 档案工作面板（点击成员滑出） */}
        {selectedNode && (
          <GraphInspector
            agent={selectedNode.data.agent}
            group={selectedNode.data.group}
            upstream={links.upstream}
            downstream={links.downstream}
            talks={talksOf.get(selectedNode.id) ?? 0}
            speaking={selectedNode.data.speaking}
            queueIndex={selectedNode.data.queueIndex}
            awaitingUser={selectedNode.data.awaitingUser}
            lastMessage={lastMessage}
            artifacts={selectedArtifacts}
            soul={activeSoulOf(selectedNode.data.agent, soulOverride)}
            traceActive={traceId === selectedNode.id}
            onTrace={() => setTraceId((p) => (p === selectedNode.id ? null : selectedNode.id))}
            isolated={selectedNode.data.isolated}
            onFocus={() => focusOn(selectedNode.id)}
            onSelect={setSelectedId}
            onClose={() => setSelectedId(null)}
          />
        )}

        {/* 底部操作 dock：布局 · 整理 · 跟拍 + HUD 战况 */}
        <div className="absolute bottom-2 left-1/2 z-10 flex max-w-[calc(100%-24px)] -translate-x-1/2 flex-wrap items-center justify-center gap-x-1.5 gap-y-1 rounded-xl border bg-card/90 px-1.5 py-1 shadow-soft backdrop-blur-sm">
          <div className="flex items-center rounded-lg border bg-muted/40 p-px">
            <button
              type="button"
              title="接力链布局"
              onClick={() => switchLayout('chain')}
              className={cn(
                'flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] transition-colors',
                layoutMode === 'chain'
                  ? 'bg-card text-foreground shadow-soft'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <GitBranch className="size-3" aria-hidden />
              接力链
            </button>
            <button
              type="button"
              title="圆桌布局"
              onClick={() => switchLayout('radial')}
              className={cn(
                'flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] transition-colors',
                layoutMode === 'radial'
                  ? 'bg-card text-foreground shadow-soft'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Orbit className="size-3" aria-hidden />
              圆桌
            </button>
          </div>
          <Button variant="ghost" size="icon-sm" title="整理布局" onClick={tidyLayout}>
            <LayoutGrid className="size-3.5" />
          </Button>
          <Button
            variant={follow ? 'default' : 'ghost'}
            size="icon-sm"
            title={follow ? '导演镜头：跟随发言者（点击关闭）' : '导演镜头：跟随发言者（F）'}
            onClick={() => setFollow((v) => !v)}
          >
            <Clapperboard className="size-3.5" />
          </Button>
          <Button
            variant={replay ? 'default' : 'ghost'}
            size="icon-sm"
            title={replay ? '退出回放（Esc）' : '时间轴回放：看接力怎么长出来'}
            onClick={toggleReplay}
          >
            <History className="size-3.5" />
          </Button>

          <span className="mx-0.5 h-4 w-px bg-border" aria-hidden />

          <span className="whitespace-nowrap text-[10.5px] text-muted-foreground">
            成员 {summary.members}
            <span className="mx-1 text-border">·</span>
            接力 {summary.relayTotal}
          </span>
          {trace && (
            <span className="flex items-center gap-1 whitespace-nowrap rounded-full border border-primary/40 bg-primary/10 px-1.5 py-px text-[10.5px] text-primary">
              <GitBranch className="size-3" aria-hidden />
              追踪 {trace.hops.size} 位
              <button
                type="button"
                title="停止追踪（Esc）"
                aria-label="停止追踪"
                onClick={() => setTraceId(null)}
                className="-mr-0.5 text-primary/70 transition-colors hover:text-primary"
              >
                <X className="size-3" />
              </button>
            </span>
          )}
          {active && !replay && (
            <span className="whitespace-nowrap rounded-full bg-primary/10 px-1.5 py-px text-[10.5px] text-primary">
              第 {waveIndex + 1} 波{queue.length > 0 ? ` · 队列 ${queue.length}` : ''}
            </span>
          )}
          {summary.latest && (
            <span
              className="max-w-[150px] truncate whitespace-nowrap text-[10.5px] text-muted-foreground"
              title={`最新接力：${nameOf(summary.latest.source)} → ${nameOf(summary.latest.target)} · ${timeAgo(summary.latest.lastAt)}`}
            >
              最新接力 {nameOf(summary.latest.source)} → {nameOf(summary.latest.target)}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

export default GraphView

/**
 * 右栏面板注册表（M22）：面板 = 元数据（id / 标签 / 分组 / 是否整高）+ 渲染函数。
 *
 * 扩展方式：在 PANEL_DEFS 追加一项（含 group），并在 ui-store 的 RightView 中登记 id ——
 * TeamPanel 两级导航与命令面板「右栏 · X」入口自动生效。
 *
 * M49（ADR 0100）：PanerlDef 增 group 字段（团队 / 运行 / 实况），GROUPS 由此派生；
 * 「浏览器」并入一级「实况」面板（browser → live，LivePanel 内四面页签）。
 *
 * 说明：成员 / 接力 / 战绩 三个视图需要 TeamPanel 上下文（参与者与消息派生数据），
 * 通过 PanelSlots 插槽传入，避免组件间循环依赖；其余面板自取数据（zustand store）。
 */
import * as React from 'react'
import type { RightGroup, RightView } from '../../stores/ui-store'
import { usePlanStore } from '../../stores/plan-store'
import { useSessionStore } from '../../stores/session-store'
import { MemoryPanel } from '../team/MemoryPanel'
import { MetricsPanel } from '../team/MetricsPanel'
import { SchedulePanel } from '../team/SchedulePanel'
import { TaskView } from '../team/TaskView'
import { RunBoard } from '../run/RunBoard'

/** 图谱按需懒加载（@xyflow/react + dagre 独立 chunk，不进首屏） */
const GraphView = React.lazy(() => import('../team/GraphView'))

/** M49：实况面板懒加载（浏览器帧流 / 交付件预览器等按需分包，不进首屏） */
const LivePanel = React.lazy(() => import('../live/LivePanel').then((m) => ({ default: m.LivePanel })))

/** 由 TeamPanel 就地渲染的既有视图（插槽） */
export interface PanelSlots {
  members: React.ReactNode
  relay: React.ReactNode
  stats: React.ReactNode
}

export interface PanelDef {
  id: RightView
  label: string
  /** M49：一级分组归属（团队 / 运行 / 实况） */
  group: RightGroup
  /** 整高面板（内部自行滚动 / 铺满） */
  fill?: boolean
  /**
   * M24：Tab 徽章（返回计数；≤0 不渲染）。
   * 入参 = 实时待批准计划数（registry 统一订阅该信号源；新增徽章信号按需扩展）。
   */
  badge?: (pendingPlans: number) => number
  render: (slots: PanelSlots) => React.ReactNode
}

export const PANEL_DEFS: PanelDef[] = [
  { id: 'members', label: '成员', group: 'team', render: (slots) => slots.members },
  { id: 'relay', label: '接力', group: 'team', render: (slots) => slots.relay },
  {
    id: 'graph',
    label: '图谱',
    group: 'team',
    fill: true,
    render: () => (
      <React.Suspense
        fallback={<div className="p-4 text-center text-[11.5px] text-muted-foreground">正在加载协作图谱…</div>}
      >
        <GraphView />
      </React.Suspense>
    ),
  },
  { id: 'stats', label: '战绩', group: 'team', render: (slots) => slots.stats },
  {
    // M88：运行面板（Run Board）—— 阶段条 / 判定依据 / 计划步骤 / 决策收件箱
    id: 'run',
    label: '运行',
    group: 'ops',
    fill: true,
    badge: (pendingPlans) => pendingPlans,
    render: () => (
      <div className="h-full">
        <RunBoard />
      </div>
    ),
  },
  {
    id: 'tasks',
    label: '任务',
    group: 'ops',
    fill: true,
    badge: (pendingPlans) => pendingPlans, // M24：待批准计划数
    render: () => (
      <div className="h-full">
        <TaskView />
      </div>
    ),
  },
  {
    id: 'memory',
    label: '记忆',
    group: 'ops',
    fill: true,
    render: () => (
      <div className="h-full">
        <MemoryPanel />
      </div>
    ),
  },
  {
    // M35：定时任务（创建 / 启停 / 立即触发 / 删除；run 到点启动协作、remind 到点提醒）
    id: 'schedules',
    label: '定时',
    group: 'ops',
    fill: true,
    render: () => (
      <div className="h-full">
        <SchedulePanel />
      </div>
    ),
  },
  {
    id: 'metrics',
    label: '指标',
    group: 'ops',
    fill: true,
    render: () => (
      <div className="h-full">
        <MetricsPanel />
      </div>
    ),
  },
  {
    // M49（ADR 0100）：浏览器 / 交付件 / 数据库 / 终端 四面合一的实况面板（面内页签即二级）
    id: 'live',
    label: '实况',
    group: 'live',
    fill: true,
    render: () => (
      <React.Suspense
        fallback={<div className="p-4 text-center text-[11.5px] text-muted-foreground">正在加载实况面板…</div>}
      >
        <LivePanel />
      </React.Suspense>
    ),
  },
]

/** M49：一级分组 → 子面板（顺序 = PANEL_DEFS 声明序；分发单一事实来源 = ui-store.RIGHT_GROUPS） */
export const GROUPS: Record<RightGroup, PanelDef[]> = {
  team: PANEL_DEFS.filter((p) => p.group === 'team'),
  ops: PANEL_DEFS.filter((p) => p.group === 'ops'),
  live: PANEL_DEFS.filter((p) => p.group === 'live'),
}

/** 面板 id → 中文标签（命令面板 / 帮助文案复用） */
export const PANEL_LABELS = Object.fromEntries(PANEL_DEFS.map((panel) => [panel.id, panel.label])) as Record<
  RightView,
  string
>

/**
 * M24：面板 Tab 徽章（TeamPanel 页签内渲染）。
 * 订阅「当前会话待批准计划数」驱动实时刷新（计划提交 / 批准后立即变化）。
 */
export function PanelBadge({ def }: { def: PanelDef }): React.JSX.Element | null {
  const currentId = useSessionStore((s) => s.currentId)
  const pendingPlans = usePlanStore((s) =>
    s.sessionId && s.sessionId === currentId ? s.plans.filter((plan) => plan.status === 'submitted').length : 0,
  )
  const count = def.badge ? def.badge(pendingPlans) : 0
  if (count <= 0) return null
  return (
    <span
      className="ml-1 rounded-full bg-amber-500/15 px-1 text-[10px] font-semibold tabular-nums text-amber-700"
      title={`${count} 份计划待批准`}
    >
      {count}
    </span>
  )
}

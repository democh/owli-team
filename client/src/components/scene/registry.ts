/**
 * M52-A：场景形态注册表（§7.8）——layout → 容器组件；panel → 面板组件；parts → 元件名。
 * SceneStage 经此表解析渲染；容器不反向依赖本表（面板以 element 注入，避免循环导入）。
 */
import type * as React from 'react'
import type { StageLayout, StagePanel } from '@multi-agent/shared'
import { ArenaStage } from './ArenaStage'
import { DockStage } from './DockStage'
import { RoundtableStage } from './RoundtableStage'
import { StreamStage } from './StreamStage'
import { BoardPanel, ChartboardPanel, CoachPanel, ConsolePanel, PoolPanel, VersusPanel } from './panels'

export interface StageContainerProps {
  children: React.ReactNode
  /** 已解析的工作区面板（dock / roundtable；stream / arena 不渲染） */
  panel?: React.ReactNode
}

export const STAGE_CONTAINERS: Record<StageLayout, React.ComponentType<StageContainerProps>> = {
  stream: StreamStage,
  dock: DockStage,
  roundtable: RoundtableStage,
  arena: ArenaStage,
}

export const STAGE_PANEL_COMPONENTS: Record<StagePanel, React.ComponentType> = {
  pool: PoolPanel,
  versus: VersusPanel,
  board: BoardPanel,
  console: ConsolePanel,
  coach: CoachPanel,
  chartboard: ChartboardPanel,
}

/** 合法元件名 → 中文名（stage.parts 声明口径；空声明 = 场景默认集） */
export const PART_NAMES: Record<string, string> = {
  'round-track': '回合轴',
  scoreboard: '计分板',
  'seat-card': '席位卡',
  'seat-ring': '席位环',
  'momentum-bar': '局势条',
  'claim-tree': '论证树',
  'agenda-track': '议程推进条',
  kanban: '管道看板',
  'progress-grid': '打卡进度',
  'delivery-panel': '交付件面板',
  verdict: '裁决卡',
  panboard: '盘面板',
}

/** stage.parts 是否启用某元件（声明为空 = 场景默认集全启用） */
export function partEnabled(parts: readonly string[], name: string): boolean {
  return parts.length === 0 || parts.includes(name)
}

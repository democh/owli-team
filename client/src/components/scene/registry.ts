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
import { BoardPanel, ChartboardPanel, CoachPanel, ConsolePanel, PoolPanel, StudioPanel, VersusPanel } from './panels'

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
  studio: StudioPanel,
}

/** 合法元件名 → 中文名（stage.parts 声明口径；空声明 = 场景默认集全启用）。
 *  v68：收敛为实际受 parts 控制的 arena 五件套（其余视觉元件为容器 / 面板内部固定组成，不参与裁剪）。
 *  M63（U2）：六件套——新增 cross-fire（交锋看板，findings 配对聚合）。*/
export const PART_NAMES: Record<string, string> = {
  'round-track': '回合轴',
  scoreboard: '计分板',
  verdicts: '裁决流',
  'claim-tree': '论断树',
  offers: '报价流',
  'cross-fire': '交锋看板',
}

/** stage.parts 是否启用某元件（声明为空 = 场景默认集全启用） */
export function partEnabled(parts: readonly string[], name: string): boolean {
  return parts.length === 0 || parts.includes(name)
}

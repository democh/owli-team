/**
 * M31：画布连线 —— 三语义视觉（延续协作图谱视觉语言）：
 * - flow：实线主色（生成数据流）；任务运行中能量流动（复用 graph-energy-flow 技法，P3 接线）；
 * - mind：层级曲线（低饱和默认色，无箭头）；
 * - ref：虚线关联（无箭头）。
 * 曲线技法源自 RelayEdge（把手方向外推的三次贝塞尔，反向自动兜回）。
 */
import * as React from 'react'
import { BaseEdge, Position, type Edge, type EdgeProps } from '@xyflow/react'
import type { CanvasEdgeKind } from '@multi-agent/shared'

export interface FlowEdgeData extends Record<string, unknown> {
  kind: CanvasEdgeKind
  /** 生成任务运行中（能量流动，P3 由 media-store 注入） */
  flowing?: boolean
}

export type CanvasFlowEdge = Edge<FlowEdgeData, 'canvas'>

/** 控制点外推量（同 RelayEdge：正向半程，反向按距离开方加深，下限防退化） */
function controlOffset(distance: number): number {
  if (distance >= 0) return Math.max(28, distance * 0.5)
  return Math.max(28, 7 * Math.sqrt(-distance))
}

function controlPoint(position: Position, x1: number, y1: number, x2: number, y2: number): [number, number] {
  switch (position) {
    case Position.Left:
      return [x1 - controlOffset(x1 - x2), y1]
    case Position.Right:
      return [x1 + controlOffset(x2 - x1), y1]
    case Position.Top:
      return [x1, y1 - controlOffset(y1 - y2)]
    default:
      return [x1, y1 + controlOffset(y2 - y1)]
  }
}

function curvePath(
  sourceX: number,
  sourceY: number,
  sourcePosition: Position,
  targetX: number,
  targetY: number,
  targetPosition: Position,
): string {
  const [scx, scy] = controlPoint(sourcePosition, sourceX, sourceY, targetX, targetY)
  const [tcx, tcy] = controlPoint(targetPosition, targetX, targetY, sourceX, sourceY)
  return `M${sourceX},${sourceY} C${scx},${scy} ${tcx},${tcy} ${targetX},${targetY}`
}

function CanvasEdgeView({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  data,
  selected,
}: EdgeProps<CanvasFlowEdge>): React.JSX.Element {
  const kind = data?.kind ?? 'flow'
  const path = curvePath(sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition)
  const flow = kind === 'flow'

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={flow ? markerEnd : undefined}
        style={{
          stroke: flow ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground))',
          strokeWidth: flow ? (selected ? 2.2 : 1.6) : selected ? 1.8 : 1.2,
          strokeDasharray: kind === 'ref' ? '5 5' : undefined,
          opacity: flow ? (selected ? 1 : 0.75) : selected ? 0.8 : 0.4,
        }}
      />
      {flow && data?.flowing && (
        <path d={path} fill="none" strokeLinecap="round" className="canvas-edge-energy canvas-edge-energy-live" />
      )}
    </>
  )
}

export const FlowEdge = React.memo(CanvasEdgeView)

export const CANVAS_EDGE_TYPES = { canvas: FlowEdge }

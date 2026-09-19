/**
 * 接力能量边（§28.4，M21）：主路径（BaseEdge）+ 能量流动层 + 脉冲爆发 + 追溯重放 + 焦点标签。
 * - 视觉语义（线型 × 颜色）：实线蓝 = 顺向接力；实线琥珀 + 光晕 = 最近一棒（recent）；
 *   长虚线紫 = 回退接力（backward，目标排名在源之前）；短虚线灰 = 编制预期；能量层颜色随语义（--edge-color）
 * - 主路径为平滑贝塞尔曲线（两种布局统一）：控制点沿出 / 入把手方向外推、行程越长外推越深，
 *   反向接力（目标在源后方，如折行赛道 / 回环）自动从节点外侧兜回，不再走直角折线
 * - 能量层：运行中沿接力方向持续流动（速度 / 粗细随接手次数提升）；新接力触发一次性 burst
 * - 点击边重放（replay nonce）：一次性加速流光，可与 live / burst 叠加
 * - 编制边（chain）：虚线意象保留，仅主路径
 * - 标签经 EdgeText 渲染（保持 .react-flow__edge-textwrapper / .react-flow__edge-text 结构，
 *   既有 E2E 断言「接手 N 次」依赖该结构）
 */
import * as React from 'react'
import { BaseEdge, EdgeText, Position, type Edge, type EdgeProps } from '@xyflow/react'
import { cn } from '../../../lib/utils'
import type { RelayEdgeData } from './types'

export type RelayFlowEdge = Edge<RelayEdgeData, 'relay'>

/** 边语义色（图谱词汇表；GraphView 的 marker 箭头 / 图例同源引用） */
export const EDGE_TONE = {
  /** 顺向接力 */
  relay: 'hsl(var(--primary))',
  /** 最近一棒（与节点 recent 描边 amber-400/60 同族，取 amber-500 保证细线可读） */
  recent: 'hsl(38 92% 50%)',
  /** 回退接力（逆流回到上游；紫与主色 / 警示色都能区分） */
  backward: 'hsl(262 83% 58%)',
  /** 编制预期 */
  chain: 'hsl(var(--muted-foreground))',
} as const

/** 线型：回退 = 长划（逆流）；编制 = 短划（未发生） */
const DASH_BACKWARD = '7 5'
const DASH_CHAIN = '4 5'

const LABEL_STYLE = { fontSize: 10.5, fill: 'hsl(var(--muted-foreground))' }
const LABEL_BG_STYLE = { fill: 'hsl(var(--card))', fillOpacity: 0.92 }

/** 控制点外推量：正向（沿把手）取半程保持出线平缓；反向绕行按距离开方加深；下限兜底防退化尖角 */
function controlOffset(distance: number): number {
  if (distance >= 0) return Math.max(28, distance * 0.5)
  return Math.max(28, 7 * Math.sqrt(-distance))
}

/** 把手侧控制点（沿出线方向外推；与 React Flow bezier 同口径，反向加深并加下限） */
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

/** 平滑曲线主路径：三次贝塞尔（t=0.5 中点作标签位，与 React Flow 口径一致） */
function getFlowPath(
  sourceX: number,
  sourceY: number,
  sourcePosition: Position,
  targetX: number,
  targetY: number,
  targetPosition: Position,
): [string, number, number] {
  const [scx, scy] = controlPoint(sourcePosition, sourceX, sourceY, targetX, targetY)
  const [tcx, tcy] = controlPoint(targetPosition, targetX, targetY, sourceX, sourceY)
  return [
    `M${sourceX},${sourceY} C${scx},${scy} ${tcx},${tcy} ${targetX},${targetY}`,
    sourceX * 0.125 + scx * 0.375 + tcx * 0.375 + targetX * 0.125,
    sourceY * 0.125 + scy * 0.375 + tcy * 0.375 + targetY * 0.125,
  ]
}

function RelayEdgeView({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  data,
}: EdgeProps<RelayFlowEdge>): React.JSX.Element {
  const d = data as RelayEdgeData
  const [path, labelX, labelY] = getFlowPath(
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  )

  const relay = d.kind === 'relay'
  const color = relay
    ? d.recent
      ? EDGE_TONE.recent
      : d.backward
        ? EDGE_TONE.backward
        : EDGE_TONE.relay
    : EDGE_TONE.chain
  const width = relay ? Math.min(1 + d.count * 0.55, 3.2) : d.incident ? 1.8 : 1
  const opacity = relay ? (d.muted ? 0.15 : 0.85) : d.muted ? 0.1 : 0.4
  const energyWidth = Math.min(width + 1.4, 4)
  // 速度随权重：接手越多，能量越快
  const flowMs = Math.max(340, 900 - d.count * 90)

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        className={cn(
          'graph-edge-line',
          relay && d.flowing && !d.quiet && 'graph-edge-live',
          relay && d.recent && 'graph-edge-recent',
          relay && d.backward && 'graph-edge-backward',
        )}
        style={
          relay
            ? {
                stroke: color,
                strokeWidth: width,
                opacity,
                ...(d.backward ? { strokeDasharray: DASH_BACKWARD } : {}),
              }
            : { stroke: color, strokeDasharray: DASH_CHAIN, strokeWidth: width, opacity }
        }
      />
      {relay && (d.flowing || d.pulse > 0 || d.replay > 0) && (
        <path
          key={`${d.pulse}:${d.replay}`}
          d={path}
          fill="none"
          strokeLinecap="round"
          className={cn(
            'graph-edge-energy',
            d.flowing && !d.quiet && 'graph-edge-energy-live',
            d.pulse > 0 && 'graph-edge-energy-burst',
            d.replay > 0 && 'graph-edge-energy-replay',
          )}
          style={
            {
              strokeWidth: energyWidth,
              // 能量层颜色随边语义（缺省主色）；焦点淡化：非关联边能量层同步降透明（避免残留亮线造成闪动感）
              '--edge-color': color,
              opacity: d.muted ? 0.15 : undefined,
              '--flow-ms': `${flowMs}ms`,
            } as React.CSSProperties
          }
        />
      )}
      {d.text && (
        <EdgeText
          x={labelX}
          y={labelY}
          label={d.text}
          labelStyle={LABEL_STYLE}
          labelShowBg
          labelBgStyle={LABEL_BG_STYLE}
        />
      )}
    </>
  )
}

export const RelayEdge = React.memo(RelayEdgeView)

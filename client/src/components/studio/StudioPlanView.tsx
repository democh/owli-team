/**
 * M65-B：平面视图（俯视 SVG）——房间多边形 + 家具轮廓 + 面积标注；点击选择家具。
 * 几何由 planGeometryOf 派生（纯函数）；本组件零 three 依赖（不参与懒加载边界）。
 * 交互（轻量内联口径）：家具悬停高亮 + 尺寸提示（类型 / 宽×深 m，随 scale 折算）；
 * 点击选择行为不变（空白处点击取消选择）。
 */
import * as React from 'react'
import type { DesignScene } from '@multi-agent/shared'
import { cn } from '../../lib/utils'
import { planGeometryOf, specOf } from './design-scene-model'

export interface StudioPlanViewProps {
  scene: DesignScene
  selectedId?: string
  onSelect?: (id: string | null) => void
  /** 画布方形边长（SVG 单位） */
  size?: number
}

/** 悬停提示框宽（SVG 单位） */
const TIP_W = 122
const TIP_H = 20

export function StudioPlanView({ scene, selectedId, onSelect, size = 320 }: StudioPlanViewProps): React.JSX.Element {
  const plan = React.useMemo(() => planGeometryOf(scene, size), [scene, size])
  const [hotId, setHotId] = React.useState<string | undefined>(undefined)

  const hotRect = hotId !== undefined ? plan.furniture.find((f) => f.id === hotId) : undefined
  const hotItem = hotId !== undefined ? scene.furniture.find((f) => f.id === hotId) : undefined
  let tipText = ''
  if (hotItem) {
    const spec = specOf(hotItem.kind)
    const s = hotItem.scale ?? 1
    tipText = `${spec.label} ${((spec.width * s) / 1000).toFixed(2)} × ${((spec.depth * s) / 1000).toFixed(2)} m`
  }
  const tipPos = (() => {
    if (!hotRect) return undefined
    const tx = Math.min(Math.max(hotRect.cx - TIP_W / 2, 4), Math.max(plan.width - TIP_W - 4, 4))
    const above = hotRect.cy - hotRect.d / 2 - TIP_H - 6
    const ty = above >= 4 ? above : Math.min(hotRect.cy + hotRect.d / 2 + 6, plan.height - TIP_H - 4)
    return { tx, ty }
  })()

  return (
    <svg
      viewBox={plan.viewBox}
      className="studio-plan"
      role="img"
      aria-label="俯视平面图"
      data-studio-plan
      onClick={() => onSelect?.(null)}
    >
      {plan.rooms.map((r) => (
        <g key={r.id}>
          <path d={r.d} className="studio-plan-room" />
          <text x={plan.width / 2} y={plan.height / 2} className="studio-plan-area" textAnchor="middle">
            {r.name} · {r.areaM2}㎡
          </text>
        </g>
      ))}
      {plan.furniture.map((f) => (
        <rect
          key={f.id}
          x={-f.w / 2}
          y={-f.d / 2}
          width={f.w}
          height={f.d}
          rx={2}
          transform={`translate(${f.cx} ${f.cy}) rotate(${f.rotation})`}
          className={cn(
            'studio-plan-furniture',
            f.id === selectedId && 'studio-plan-selected',
            f.id === hotId && 'studio-plan-hot',
          )}
          onMouseEnter={() => setHotId(f.id)}
          onMouseLeave={() => setHotId((prev) => (prev === f.id ? undefined : prev))}
          onClick={(e) => {
            e.stopPropagation()
            onSelect?.(f.id)
          }}
        />
      ))}
      {hotRect && tipPos ? (
        <g className="studio-plan-tip" transform={`translate(${tipPos.tx.toFixed(1)} ${tipPos.ty.toFixed(1)})`} aria-hidden>
          <rect width={TIP_W} height={TIP_H} rx={4} />
          <text x={TIP_W / 2} y={13} textAnchor="middle">
            {tipText}
          </text>
        </g>
      ) : null}
    </svg>
  )
}

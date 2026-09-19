/**
 * M52-A 元件 9/12：进度环 + 打卡格（ProgressRing / CheckGrid）——coach 面板核心件（§7.6）。
 * 数据源：checklist 容器 + sessionStorage 勾选覆盖；勾选回调由面板注入（打卡点亮）。
 */
import * as React from 'react'
import { Check } from 'lucide-react'
import { cn } from '../../../lib/utils'

export function ProgressRing({
  value,
  size = 64,
  label,
  sublabel,
}: {
  /** 0..100 */
  value: number
  size?: number
  label?: string
  sublabel?: string
}): React.JSX.Element {
  const v = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0))
  const stroke = 6
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  return (
    <div className="scene-ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="scene-ring-track" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${(v / 100) * c} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          className="scene-ring-fill"
        />
      </svg>
      <div className="scene-ring-center">
        <span className="scene-ring-value">{Math.round(v)}%</span>
        {label ? <span className="scene-ring-label">{label}</span> : null}
      </div>
      {sublabel ? <div className="scene-ring-sub">{sublabel}</div> : null}
    </div>
  )
}

export interface CheckCell {
  id: string
  label: string
  checked: boolean
}

export function CheckGrid({
  items,
  onToggle,
}: {
  items: CheckCell[]
  onToggle?: (id: string, next: boolean) => void
}): React.JSX.Element {
  return (
    <div className="scene-check-grid" role="list" aria-label="打卡格">
      {items.map((it) => (
        <button
          type="button"
          role="listitem"
          key={it.id}
          className={cn('scene-check', it.checked && 'scene-check-on')}
          aria-pressed={it.checked}
          title={it.label}
          onClick={() => onToggle?.(it.id, !it.checked)}
        >
          <span className="scene-check-box">{it.checked ? <Check size={12} /> : null}</span>
          <span className="scene-check-label">{it.label}</span>
        </button>
      ))}
    </div>
  )
}

/**
 * M52-A 元件 11/12：裁决卡元件（VerdictPart）——arena / roundtable 终局仪式（§7.6）。
 * 视觉与 md-ext VerdictCard 同款（md-verdict 类族）；入参为已解析的容器数据（非 JSON 串）。
 */
import * as React from 'react'
import { cn } from '../../../lib/utils'
import type { SceneRow, SceneVerdictStatus } from '../derive'

const STATUS_LABEL: Record<SceneVerdictStatus, string> = {
  long: '多方',
  short: '空方',
  draw: '僵持',
  none: '',
}

export function VerdictPart({
  status = 'none',
  title,
  items,
}: {
  status?: SceneVerdictStatus
  title?: string
  items: SceneRow[]
}): React.JSX.Element {
  const active = status !== 'none' ? status : ''
  const label = STATUS_LABEL[status]
  return (
    <div className={cn('md-verdict', active && `md-verdict-${active}`)}>
      <div className="md-verdict-head">
        {label ? <span className="md-verdict-badge">{label}</span> : null}
        {title ? <span className="md-verdict-title">{title}</span> : null}
      </div>
      <div className="md-verdict-body">
        {items.map((it, i) => (
          <div className="md-verdict-row" key={i}>
            <span className="md-verdict-label">{it.label}</span>
            <span className="md-verdict-value">{it.value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

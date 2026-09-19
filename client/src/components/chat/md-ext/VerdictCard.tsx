/**
 * M34-3（P2c）：终局裁决卡（::: verdict <多方|空方|僵持> [标题]）——
 * 条目由 remark 侧转 data-items JSON（`- 项名 | 内容`，如 置信度 / 核心依据 / 翻盘条件）。
 * - 状态色：多方红（涨）/ 空方绿（跌）/ 僵持灰；未知首词降级无状态色（只显示标题）；
 * - 纯静态卡（无本地交互态）：解析失败 / 空条目 → raw 兜底渲染，其余内容照常。
 */
import * as React from 'react'
import { cn } from '../../../lib/utils'

export interface VerdictItemData {
  label: string
  value: string
}

/** data-items JSON → 条目数组（非法 JSON / 形状不符 → 空数组，走 raw / children 回退） */
export function parseVerdictItems(json: string | undefined): VerdictItemData[] {
  if (!json) return []
  try {
    const arr: unknown = JSON.parse(json)
    if (!Array.isArray(arr)) return []
    const out: VerdictItemData[] = []
    for (const v of arr) {
      if (!v || typeof v !== 'object') continue
      const o = v as { label?: unknown; value?: unknown }
      if (typeof o.label !== 'string' || o.label === '') continue
      out.push({ label: o.label, value: typeof o.value === 'string' ? o.value : '' })
    }
    return out
  } catch {
    return []
  }
}

const VERDICT_LABEL: Record<string, string> = {
  long: '多方',
  short: '空方',
  draw: '僵持',
}

export function VerdictCard({
  status,
  title,
  items: itemsRaw,
  raw,
  children,
}: {
  status?: string
  title?: string
  items?: string
  raw?: string
  children?: React.ReactNode
}): React.JSX.Element {
  const parsed = React.useMemo(() => parseVerdictItems(itemsRaw), [itemsRaw])
  const active = status && status !== 'none' ? status : ''
  const label = active ? VERDICT_LABEL[active] : undefined
  const cls = cn('md-verdict', active && `md-verdict-${active}`)

  // 无条目（解析失败 / 空容器）：raw 兜底静态渲染，其余内容照常
  if (parsed.length === 0) {
    return (
      <div className={cls}>
        {raw ? <pre className="md-verdict-static">{raw}</pre> : null}
        {children}
      </div>
    )
  }

  return (
    <div className={cls}>
      <div className="md-verdict-head">
        {label ? <span className="md-verdict-badge">{label}</span> : null}
        {title ? <span className="md-verdict-title">{title}</span> : null}
      </div>
      <div className="md-verdict-body">
        {parsed.map((it, i) => (
          <div className="md-verdict-row" key={i}>
            <span className="md-verdict-label">{it.label}</span>
            <span className="md-verdict-value">{it.value}</span>
          </div>
        ))}
      </div>
      {children}
    </div>
  )
}

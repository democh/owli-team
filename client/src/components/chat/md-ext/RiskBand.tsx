/**
 * M41（§103，FI-3）：风险色带（`::: risk 高|中|低 [标题]`）——顶部色带 + 等级标签；
 * 首词未命中 → 中性色带（fail-safe，不猜测等级）；正文 children 原样渲染在色带下方。
 */
import * as React from 'react'
import { AlertTriangle } from 'lucide-react'
import { cn } from '../../../lib/utils'
import type { RiskLevel } from './remark-ext'

const LEVEL_LABEL: Record<Exclude<RiskLevel, 'none'>, string> = {
  high: '高风险',
  mid: '中风险',
  low: '低风险',
}

export function RiskBand({
  title,
  level,
  children,
}: {
  title?: string
  /** high / mid / low / none（none → 中性不渲染等级标签） */
  level?: string
  children?: React.ReactNode
}): React.JSX.Element {
  const lv: RiskLevel = level === 'high' || level === 'mid' || level === 'low' ? level : 'none'
  return (
    <div className={cn('md-risk', lv !== 'none' && `md-risk-${lv}`)} data-risk-band={lv}>
      <div className="md-risk-band" aria-hidden />
      <div className="md-risk-head">
        <AlertTriangle className="size-3.5" aria-hidden />
        {lv !== 'none' ? <span className="md-risk-level">{LEVEL_LABEL[lv]}</span> : null}
        {title ? <span className="md-risk-title">{title}</span> : null}
      </div>
      {children}
    </div>
  )
}

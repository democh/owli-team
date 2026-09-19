/**
 * M38（§92）：阶段分隔条（`::: phase 发散期`）——研讨阶段的可视化分隔（发散=暖色 / 收敛=冷色）。
 * - 结构由 remark 侧转 data-tone（warm/cool/none，按标题词命中）+ data-title；
 * - 纯展示件（无交互）；正文 children 原样渲染在分隔条下方。
 */
import * as React from 'react'
import { cn } from '../../../lib/utils'

export function PhaseBar({
  title,
  tone,
  children,
}: {
  title?: string
  /** warm=发散 / cool=收敛 / 缺省=中性 */
  tone?: string
  children?: React.ReactNode
}): React.JSX.Element {
  const t = tone === 'warm' || tone === 'cool' ? tone : ''
  return (
    <div className={cn('md-phase', t !== '' && `md-phase-${t}`)} data-phase-bar="">
      <div className="md-phase-row" role="separator" aria-label={title || '阶段'}>
        <span className="md-phase-line" aria-hidden />
        <span className="md-phase-label">{title || '阶段'}</span>
        <span className="md-phase-line" aria-hidden />
      </div>
      {children}
    </div>
  )
}

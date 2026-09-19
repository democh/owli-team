/**
 * M63（批一 A6）：终局结论条——arena 中轴 L1 结论层（胜负 + 置信度 + 翻盘条件 + 「看裁决」）。
 * 出现条件与关闭态由宿主控制（最新非 none 裁决 + 会话级关闭记忆）；
 * 点条体 / 「看裁决」→ 定位裁决消息；关闭 → 本会话隐藏。
 */
import * as React from 'react'
import { X } from 'lucide-react'
import { cn } from '../../../lib/utils'

export function ConclusionBar({
  status,
  headline,
  confidence,
  flip,
  onSeek,
  onClose,
}: {
  status: 'long' | 'short' | 'draw'
  headline: string
  /** 置信度展示文本（如「高 / 中高 / 60%」；缺省不展示） */
  confidence?: string
  /** 翻盘条件（截断展示；缺省不展示） */
  flip?: string
  onSeek?: () => void
  onClose?: () => void
}): React.JSX.Element {
  return (
    <div className={cn('scene-conclusion', `is-${status}`)} data-conclusion="" role="status">
      <button type="button" className="scene-conclusion-main" title="查看终局裁决" onClick={onSeek}>
        <span className="scene-conclusion-tag">结论</span>
        <span className="scene-conclusion-headline">{headline}</span>
        {confidence ? <span className="scene-conclusion-conf">置信度 {confidence}</span> : null}
        {flip ? (
          <span className="scene-conclusion-flip" title={flip}>
            翻盘条件 {flip.length > 18 ? `${flip.slice(0, 18)}…` : flip}
          </span>
        ) : null}
      </button>
      <button type="button" className="scene-conclusion-close" title="关闭（本会话不再提示）" onClick={onClose}>
        <X size={12} />
      </button>
    </div>
  )
}

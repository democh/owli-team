/**
 * M63（批一 A2）：交锋看板（CrossFire）——findings 缺陷-修补配对的双泳道聚合（arena 中轴 /
 * 汇聚板红队段共用）。数据源：lib/pk.crossFireOf（提缺 → 已响应，口径同配对卡）。
 * - 条目点击 → 定位来源消息；「催回应」仅未响应条目（readOnly 模式不渲染——红队对无固定轮次纪律）。
 * - 未响应优先排序由派生层完成；每侧上限 limit 条，超出折叠计数。
 */
import * as React from 'react'
import { Swords } from 'lucide-react'
import { cn } from '../../../lib/utils'
import type { CrossFireItem } from '../../../lib/pk'

export interface CrossFireLane {
  label: string
  items: CrossFireItem[]
}

const LIMIT = 6

function lane(
  side: 'left' | 'right',
  laneData: CrossFireLane,
  opts: {
    onFocus?: (messageId: string) => void
    onChase?: (item: CrossFireItem) => void
    readOnly?: boolean
  },
): React.JSX.Element {
  const { label, items } = laneData
  const responded = items.filter((it) => it.responded).length
  const pct = items.length === 0 ? 0 : Math.round((responded / items.length) * 100)
  const shown = items.slice(0, LIMIT)
  const rest = items.length - shown.length
  return (
    <div className={cn('scene-cf-lane', `scene-cf-${side}`)} data-side={side}>
      <div className="scene-cf-cap">
        <span className="scene-cf-cap-label">{label}</span>
        <span className="scene-cf-cap-count">
          提缺 {items.length} · 已响应 {responded}
        </span>
      </div>
      <div className="scene-cf-rate" title="响应率（已响应 / 提缺）">
        <i style={{ width: `${pct}%` }} />
      </div>
      {shown.length === 0 ? (
        <div className="scene-cf-silent">暂无挑刺</div>
      ) : (
        shown.map((it) => (
          <div
            key={`${side}-${it.id}`}
            className="scene-cf-item"
            data-responded={it.responded}
            role="button"
            tabIndex={0}
            title="定位来源消息"
            onClick={() => opts.onFocus?.(it.messageId)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                opts.onFocus?.(it.messageId)
              }
            }}
          >
            <span className="scene-cf-dot" aria-hidden />
            <span className="scene-cf-id">#{it.id}</span>
            <span className="scene-cf-text">{it.text}</span>
            {!it.responded && !opts.readOnly ? (
              <button
                type="button"
                className="scene-cf-chase"
                title="催对方回应这条缺陷"
                onClick={(e) => {
                  e.stopPropagation()
                  opts.onChase?.(it)
                }}
              >
                催回应
              </button>
            ) : null}
          </div>
        ))
      )}
      {rest > 0 ? <span className="scene-cf-more">+{rest} 条未显示</span> : null}
    </div>
  )
}

export function CrossFire({
  left,
  right,
  onFocus,
  onChase,
  readOnly,
}: {
  left: CrossFireLane
  right: CrossFireLane
  onFocus?: (messageId: string) => void
  onChase?: (item: CrossFireItem) => void
  /** 只读模式（汇聚板红队段：不提供催回应） */
  readOnly?: boolean
}): React.JSX.Element {
  const opts = { onFocus, onChase, readOnly }
  return (
    <div className="scene-crossfire" role="list" aria-label="交锋看板">
      <Swords className="scene-cf-icon" size={12} aria-hidden />
      {lane('left', left, opts)}
      {lane('right', right, opts)}
    </div>
  )
}

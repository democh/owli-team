/**
 * M45（R-1，ADR 0081）：波次回放条——底部 scrubber（≥2 波时呈现）：
 * 刻度 = 波次节点（点选跳转首条成员消息，复用 focusMessage 滚动 + 闪光）；prev / next 相邻跳转；
 * 连点跳转经尾沿节流合并（wave-replay.createTrailingThrottle）；不重建历史 UI 状态（轻回放边界）。
 */
import * as React from 'react'
import { ChevronLeft, ChevronRight, History } from 'lucide-react'
import { cn } from '../../lib/utils'
import { createTrailingThrottle, type WaveNode } from '../../lib/wave-replay'

export function WaveScrubber({
  nodes,
  activeIndex,
  onJump,
}: {
  nodes: readonly WaveNode[]
  /** 当前可见波次序号（1 基；undefined → 无活跃高亮） */
  activeIndex?: number
  onJump: (messageId: string) => void
}): React.JSX.Element {
  // 节流实例随组件生命周期（连点合并；卸载取消）
  const throttle = React.useMemo(() => createTrailingThrottle(onJump, 150), [onJump])
  React.useEffect(() => () => throttle.cancel(), [throttle])

  const jumpTo = (node: WaveNode | undefined): void => {
    if (node) throttle.run(node.firstMessageId)
  }
  const prev = activeIndex !== undefined && activeIndex > 1 ? nodes[activeIndex - 2] : undefined
  const next = activeIndex !== undefined && activeIndex < nodes.length ? nodes[activeIndex] : undefined

  return (
    <div className="wave-scrubber" data-wave-scrubber="" role="toolbar" aria-label="波次回放">
      <span className="wave-scrubber-cap">
        <History className="size-3" aria-hidden />
        回放
      </span>
      <button
        type="button"
        className="wave-scrubber-nav"
        data-wave-prev=""
        title="上一波"
        disabled={!prev}
        onClick={() => jumpTo(prev)}
      >
        <ChevronLeft className="size-3.5" aria-hidden />
      </button>
      <div className="wave-scrubber-ticks" role="group" aria-label="波次刻度">
        {nodes.map((n) => (
          <button
            type="button"
            key={n.key}
            className={cn('wave-scrubber-tick', activeIndex === n.index && 'is-current')}
            data-wave-tick={n.index}
            {...(activeIndex === n.index ? { 'data-wave-current': 'true' } : {})}
            title={`第 ${n.index}/${nodes.length} 波 · ${n.count} 条`}
            onClick={() => jumpTo(n)}
          >
            {n.index}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="wave-scrubber-nav"
        data-wave-next=""
        title="下一波"
        disabled={!next}
        onClick={() => jumpTo(next)}
      >
        <ChevronRight className="size-3.5" aria-hidden />
      </button>
      <span className="wave-scrubber-count">
        {activeIndex !== undefined ? `第 ${activeIndex}/${nodes.length} 波` : `共 ${nodes.length} 波`}
      </span>
    </div>
  )
}

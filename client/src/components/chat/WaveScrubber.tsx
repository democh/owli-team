/**
 * M45（R-1，ADR 0081）：波次回放条——输入区上方的波次导航（≥2 波时呈现）：
 * 刻度 = 波次节点（点选跳转首条成员消息，复用 focusMessage 滚动 + 闪光）；prev / next 相邻跳转；
 * 连点跳转经尾沿节流合并（wave-replay.createTrailingThrottle）；不重建历史 UI 状态（轻回放边界）。
 *
 * M79-AA：默认收起——单图标胶囊（无文字）；点击展开 / 收起完整回放条（同一胶囊向左展开）。
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

  // M79-AA：默认收起——仅显示图标开关
  const [open, setOpen] = React.useState(false)

  const jumpTo = (node: WaveNode | undefined): void => {
    if (node) throttle.run(node.firstMessageId)
  }
  const prev = activeIndex !== undefined && activeIndex > 1 ? nodes[activeIndex - 2] : undefined
  const next = activeIndex !== undefined && activeIndex < nodes.length ? nodes[activeIndex] : undefined

  return (
    <div
      className={cn('wave-scrubber', open && 'is-open')}
      data-wave-scrubber=""
      role="toolbar"
      aria-label="波次回放"
    >
      {/* 收起 = 单图标胶囊；展开 = 同一胶囊向左展开（靠右对齐，与发送区同侧） */}
      <div className="wave-scrubber-bar graph-pop-in">
        <button
          type="button"
          className="wave-scrubber-cap"
          data-wave-toggle=""
          aria-expanded={open}
          title={open ? '收起波次回放' : '波次回放（点击展开）'}
          onClick={() => setOpen((v) => !v)}
        >
          <History className="size-3.5" aria-hidden />
        </button>
        {open && (
          <>
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
          </>
        )}
      </div>
    </div>
  )
}

/**
 * 彩纸（完成仪式，M9 战绩 / M37 收尾卡共用）：确定性分布的 14 片，动画类 .confetti-piece
 * 已登记在 index.css 的 quiet-mode / reduced-motion 收敛清单；quietMode 下整体不渲染。
 */
import * as React from 'react'
import { useUiStore } from '../../stores/ui-store'
import { cn } from '../../lib/utils'

const COLORS = ['#f59e0b', '#3b82f6', '#ec4899', '#10b981', '#8b5cf6']

export function ConfettiBurst({ burst, className }: { burst: number; className?: string }): React.JSX.Element | null {
  const quiet = useUiStore((s) => s.quietMode)

  const pieces = React.useMemo(
    () =>
      Array.from({ length: 14 }, (_, i) => ({
        left: `${6 + ((i * 37) % 88)}%`,
        delay: `${(i % 5) * 60}ms`,
        color: COLORS[i % 5],
        size: i % 3 === 0 ? 6 : 4,
      })),
    // 每轮触发重排一次（确定性分布，仅用于重放 key 变化）
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [burst],
  )

  if (burst <= 0 || quiet) return null
  return (
    <div key={burst} className={cn('pointer-events-none absolute inset-x-0 top-0 z-10 h-14 overflow-hidden', className)}>
      {pieces.map((p, i) => (
        <span
          key={i}
          className="confetti-piece absolute top-1 rounded-[1px]"
          style={{
            left: p.left,
            width: p.size,
            height: p.size,
            backgroundColor: p.color,
            animationDelay: p.delay,
          }}
        />
      ))}
    </div>
  )
}

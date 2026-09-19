/**
 * 演化博弈视图（M34 §6.4）：多空比例演化曲线（echarts line）——
 * 多初值曲线叠加 + 稳定固定点标线（ESS 蓝色虚线 / 不稳定点灰色点线）；中性区间警示。
 */
import * as React from 'react'
import { buildEvolveOption, mountOption } from './echarts-game'
import { fmtNum, type EvolveResult } from './types'

export function EvolveView({ result }: { result: EvolveResult }): React.JSX.Element {
  const ref = React.useRef<HTMLDivElement>(null)
  const [failed, setFailed] = React.useState(false)

  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    setFailed(false)
    try {
      const handle = mountOption(el, buildEvolveOption(result))
      return () => handle.dispose()
    } catch {
      setFailed(true)
      return
    }
  }, [result])

  return (
    <div className="md-game-evolve">
      <div className="md-game-chart-frame">
        <div ref={ref} className="md-game-chart" />
        {failed && <div className="md-chart-note is-error">演化曲线渲染失败（当前环境不支持 Canvas）</div>}
      </div>
      <div className="md-game-legend">
        {result.fixedPoints.length === 0 && <span className="md-game-legend-item">无固定点</span>}
        {result.fixedPoints.map((point) => (
          <span key={point.x} className="md-game-legend-item">
            {point.stable ? 'ESS' : '不稳定'} x={fmtNum(point.x, 3)}
          </span>
        ))}
        {result.neutral && <span className="md-game-legend-item">中性区间：任意比例均为固定点（无渐进稳定解）</span>}
      </div>
    </div>
  )
}

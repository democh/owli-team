/**
 * ABM 蒙特卡洛视图（M34 §6.4）：价格路径扇形图（P5–P95 / P25–P75 分位带 + P50 中位 + 抽样路径）
 * + 终值分布直方图 + 多空累积盈亏条形（均值 ± P5/P95 区间）+ 事件概率 chips（挤空 / 踩踏 / 僵持）。
 */
import * as React from 'react'
import { buildFanOption, buildHistogramOption, mountOption, simulateEventChips } from './echarts-game'
import { fmtPct, PLAYER_LABELS, type SimulateResult } from './types'

function ChartShell({ build }: { build: () => ReturnType<typeof buildFanOption> }): React.JSX.Element {
  const ref = React.useRef<HTMLDivElement>(null)
  const [failed, setFailed] = React.useState(false)
  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    setFailed(false)
    try {
      const handle = mountOption(el, build())
      return () => handle.dispose()
    } catch {
      setFailed(true)
      return
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [build])
  return (
    <div className="md-game-chart-frame">
      <div ref={ref} className="md-game-chart" />
      {failed && <div className="md-chart-note is-error">图表渲染失败（当前环境不支持 Canvas）</div>}
    </div>
  )
}

/** 盈亏条形：均值条形（宽度按最大值归一）+ P5/P95 文本标注 */
function PnlBar({ label, color, summary, max }: { label: string; color: string; summary: { mean: number; p5: number; p95: number }; max: number }): React.JSX.Element {
  const width = max > 0 ? Math.min(100, Math.max(4, (Math.abs(summary.mean) / max) * 100)) : 4
  return (
    <div className="md-game-pnl-row">
      <span className="md-game-pnl-label">{label}</span>
      <span className="md-game-pnl-track">
        <span className="md-game-pnl-bar" style={{ width: `${width}%`, backgroundColor: color }} />
      </span>
      <span className="md-game-pnl-value">
        均值 {fmtPct(summary.mean, 2, true)}（P5 {fmtPct(summary.p5, 1, true)} / P95 {fmtPct(summary.p95, 1, true)}）
      </span>
    </div>
  )
}

export function SimulateView({ result }: { result: SimulateResult }): React.JSX.Element {
  const maxAbs = Math.max(Math.abs(result.pnl.long.mean), Math.abs(result.pnl.short.mean), 1e-9)
  const fan = React.useCallback(() => buildFanOption(result), [result])
  const hist = React.useCallback(() => buildHistogramOption(result), [result])
  return (
    <div className="md-game-simulate">
      <div className="md-game-stack">
        <div className="md-game-stack-title">价格路径分位带（{result.paths} 条路径 · {result.rounds} 轮）</div>
        <ChartShell build={fan} />
        <div className="md-game-legend">
          <span className="md-game-legend-item">P50 中位线</span>
          <span className="md-game-legend-item">深色带 P25–P75</span>
          <span className="md-game-legend-item">浅色带 P5–P95</span>
          <span className="md-game-legend-item">细线 = 抽样路径</span>
        </div>
      </div>

      <div className="md-game-stack">
        <div className="md-game-stack-title">终值分布</div>
        <ChartShell build={hist} />
      </div>

      <div className="md-game-stack">
        <div className="md-game-stack-title">多空累积盈亏（比例口径）</div>
        <PnlBar label={PLAYER_LABELS.long} color="#2563eb" summary={result.pnl.long} max={maxAbs} />
        <PnlBar label={PLAYER_LABELS.short} color="#f97316" summary={result.pnl.short} max={maxAbs} />
        <div className="md-game-stack-note">最大回撤：P50 {fmtPct(result.maxDrawdown.p50, 1)} / P95 {fmtPct(result.maxDrawdown.p95, 1)}</div>
      </div>

      <div className="md-game-events">
        {simulateEventChips(result).map((chip) => (
          <span key={chip.label} className="md-game-event-chip">
            {chip.label} {chip.value}
          </span>
        ))}
      </div>
    </div>
  )
}

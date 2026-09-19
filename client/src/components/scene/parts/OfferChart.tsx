/**
 * M63（批一 G1 / G2）：报价折线与收敛走廊 + 让步刻度（negotiation arena 报价段）。
 * - OfferChart：SVG 自绘（零图表依赖）——双方折线（侧色区分）+ 数据点（点击 / 回车定位）+
 *   收敛走廊（两侧最新报价之间；发生交叉 → 自交叉态配色）+ 基准线（目标 / 底线 / BATNA，缺省不绘）。
 *   交互深化（轻量内联口径）：图例四层显隐（我方 / 对方 / 基准线 / 收敛走廊；button + aria-pressed）、
 *   数据点悬停 / 聚焦浮层（序号 / 席名 / 金额 / 标题 / 让步理由）与同侧折线提亮（另一侧淡化）、
 *   最新点光环（quiet 静态）+ 值标签、网格四档刻度；视图宽经 ResizeObserver 取容器宽（1:1 映射零变形；
 *   jsdom 等无 Observer 环境回落兜底宽）。
 * - OfferConcessions：让步刻度行——柱高 ∝ |Δ|；幅度递减 = 合规（绿）、扩大 = 警示（红，
 *   点击回填说明模板）；hover 展示让步理由（offer「让步」字段，缺省「未注明」）。
 * 口径：金额走 lib/pk.offerAmount 归一（formatOfferAmount 展示）；有效点 < 2 → 宿主不渲染图表。
 */
import * as React from 'react'
import { cn } from '../../../lib/utils'
import { useUiStore } from '../../../stores/ui-store'
import { formatOfferAmount, TEMPLATES, type OfferPoint, type OfferSeries } from '../../../lib/pk'

/** 兜底视图宽（无 ResizeObserver 环境：jsdom 测试等） */
const W = 320
const H = 156
const PAD_L = 42
const PAD_R = 12
const PAD_T = 14
const PAD_B = 18
/** 悬停浮层宽 */
const TIP_W = 132

type Layer = 'left' | 'right' | 'base' | 'corridor'

/** 基准线中文标签（title / 图内标注共用） */
const BASE_LABEL: Record<string, string> = { target: '目标', bottom: '底线', batna: 'BATNA' }
const BASE_TITLE: Record<string, string> = {
  target: '目标：期望成交位',
  bottom: '底线：walk-away 位（低于此转 BATNA）',
  batna: 'BATNA：最佳替代方案',
}

function clip(text: string, max: number): string {
  const t = text.trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

function scaleOf(values: number[]): { min: number; max: number; span: number } {
  let min = values[0]!
  let max = values[0]!
  for (const v of values) {
    if (v < min) min = v
    if (v > max) max = v
  }
  const span = max - min || Math.max(Math.abs(max), 1)
  return { min, max, span }
}

export function OfferChart({
  series,
  leftLabel,
  rightLabel,
  onFocus,
}: {
  series: OfferSeries
  leftLabel: string
  rightLabel: string
  onFocus?: (messageId: string) => void
}): React.JSX.Element | null {
  const { points, baselines } = series
  const quiet = useUiStore((s) => s.quietMode)
  // 图例图层显隐（即时态；隐藏 = 不渲染对应图层）
  const [hidden, setHidden] = React.useState<ReadonlySet<Layer>>(() => new Set())
  // 悬停 / 聚焦的点索引（浮层与折线提亮联动）
  const [tip, setTip] = React.useState<number>()
  const [hotSide, setHotSide] = React.useState<'left' | 'right'>()
  // 视图宽 = 容器宽（1:1 映射：字号 / 线宽恒定、无 letterbox 留白）
  const wrapRef = React.useRef<HTMLDivElement | null>(null)
  const [vw, setVw] = React.useState(W)
  React.useEffect(() => {
    const el = wrapRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width ?? 0)
      if (w > 64) setVw((prev) => (prev === w ? prev : w))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const toggle = React.useCallback((k: Layer): void => {
    setTip(undefined)
    setHotSide(undefined)
    setHidden((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }, [])

  if (points.length < 2) return null

  const baseValues = [baselines.target, baselines.bottom, baselines.batna].filter(
    (v): v is number => typeof v === 'number',
  )
  const { min, span } = scaleOf([...points.map((p) => p.amount), ...baseValues])
  const n = points.length
  const innerW = Math.max(40, vw - PAD_L - PAD_R)
  const x = (i: number): number => PAD_L + (i * innerW) / Math.max(n - 1, 1)
  const y = (v: number): number => H - PAD_B - ((v - min) / span) * (H - PAD_T - PAD_B)

  const sidePoints = (side: 'left' | 'right'): Array<{ p: OfferPoint; i: number }> =>
    points.map((p, i) => ({ p, i })).filter(({ p }) => p.side === side)

  const polyline = (side: 'left' | 'right'): string =>
    sidePoints(side)
      .map(({ p, i }) => `${x(i).toFixed(1)},${y(p.amount).toFixed(1)}`)
      .join(' ')

  const leftPts = sidePoints('left')
  const rightPts = sidePoints('right')
  const lastL = leftPts[leftPts.length - 1]
  const lastR = rightPts[rightPts.length - 1]
  const firstL = leftPts[0]
  const firstR = rightPts[0]
  let corridor: { top: number; bottom: number; crossed: boolean; gap: number } | undefined
  if (lastL && lastR) {
    const a = y(Math.max(lastL.p.amount, lastR.p.amount))
    const b = y(Math.min(lastL.p.amount, lastR.p.amount))
    const dir0 = firstL && firstR ? Math.sign(firstL.p.amount - firstR.p.amount) : 0
    const dirN = Math.sign(lastL.p.amount - lastR.p.amount)
    corridor = { top: a, bottom: b, crossed: dir0 !== 0 && dirN !== 0 && dir0 !== dirN, gap: Math.abs(lastL.p.amount - lastR.p.amount) }
  }

  const baselinesDraw: Array<{ key: string; value: number }> = [
    ...(baselines.target !== undefined ? [{ key: 'target', value: baselines.target }] : []),
    ...(baselines.bottom !== undefined ? [{ key: 'bottom', value: baselines.bottom }] : []),
    ...(baselines.batna !== undefined ? [{ key: 'batna', value: baselines.batna }] : []),
  ]

  // 四档刻度（顶 / 上三分 / 下三分 / 底）与网格
  const tickValues = [1, 2 / 3, 1 / 3, 0].map((f) => min + span * f)

  /** 每侧最新报价值标签（贴点外侧；触边自动调整锚点；浮层显示时让位） */
  const lastValueLabel = (
    pt: { p: OfferPoint; i: number } | undefined,
    side: 'left' | 'right',
  ): React.JSX.Element | null => {
    if (!pt || hidden.has(side) || tip === pt.i) return null
    const lx = x(pt.i)
    const ly = y(pt.p.amount)
    const anchor: 'start' | 'middle' | 'end' = lx > vw - 36 ? 'end' : lx < PAD_L + 16 ? 'start' : 'middle'
    const tx = anchor === 'end' ? lx - 3 : anchor === 'start' ? lx + 3 : lx
    return (
      <text
        className={cn('scene-oc-value', side === 'left' ? 'is-left' : 'is-right')}
        x={tx}
        y={ly - 8 >= PAD_T ? ly - 8 : ly + 13}
        textAnchor={anchor}
      >
        {formatOfferAmount(pt.p.amount)}
      </text>
    )
  }

  const tipPoint = tip !== undefined ? points[tip] : undefined

  return (
    <div className="scene-offer-chart" data-offer-chart="" ref={wrapRef}>
      <svg viewBox={`0 0 ${vw} ${H}`} role="img" aria-label="报价折线（双方）">
        {/* 网格与四档刻度 */}
        {tickValues.map((v, k) => (
          <g key={`tick-${k}`}>
            <line className="scene-oc-grid" x1={PAD_L} x2={vw - PAD_R} y1={y(v)} y2={y(v)} />
            <text className="scene-oc-axis" x={2} y={y(v) + 3}>
              {formatOfferAmount(v)}
            </text>
          </g>
        ))}
        {/* 收敛走廊（图例可关闭） */}
        {corridor && !hidden.has('corridor') ? (
          <rect
            className={cn('scene-oc-corridor', corridor.crossed && 'is-crossed')}
            x={PAD_L}
            y={corridor.top}
            width={innerW}
            height={Math.max(1.5, corridor.bottom - corridor.top)}
          />
        ) : null}
        {/* 基准线（目标 / 底线 / BATNA；图例可关闭） */}
        {!hidden.has('base')
          ? baselinesDraw.map((b) => (
              <g key={b.key}>
                <line
                  className="scene-oc-base"
                  data-kind={b.key}
                  x1={PAD_L}
                  x2={vw - PAD_R}
                  y1={y(b.value)}
                  y2={y(b.value)}
                >
                  <title>{`${BASE_TITLE[b.key]}：${formatOfferAmount(b.value)}`}</title>
                </line>
                <text className="scene-oc-base-label" data-kind={b.key} x={PAD_L + 3} y={y(b.value) - 3} textAnchor="start">
                  {`${BASE_LABEL[b.key]} ${formatOfferAmount(b.value)}`}
                </text>
              </g>
            ))
          : null}
        {/* 双方折线（悬停侧提亮、另一侧淡化） */}
        {!hidden.has('left') && polyline('left') !== '' ? (
          <polyline
            className={cn('scene-oc-line is-left', hotSide === 'left' && 'is-hot', hotSide === 'right' && 'is-dim')}
            points={polyline('left')}
          />
        ) : null}
        {!hidden.has('right') && polyline('right') !== '' ? (
          <polyline
            className={cn('scene-oc-line is-right', hotSide === 'right' && 'is-hot', hotSide === 'left' && 'is-dim')}
            points={polyline('right')}
          />
        ) : null}
        {/* 数据点（点击 / 回车定位；悬停显示浮层） */}
        {points.map((p, i) => {
          if (hidden.has(p.side)) return null
          const hot = tip === i
          const isLast = (p.side === 'left' ? lastL : lastR)?.i === i
          return (
            <g key={`${p.messageId}-${i}`}>
              {isLast ? (
                <circle
                  className={cn('scene-oc-halo', p.side === 'left' ? 'is-left' : 'is-right', quiet && 'is-static')}
                  cx={x(i)}
                  cy={y(p.amount)}
                  r={6.5}
                />
              ) : null}
              <circle
                className={cn('scene-oc-point', p.side === 'left' ? 'is-left' : 'is-right', hot && 'is-hot')}
                data-message-id={p.messageId}
                data-side={p.side}
                cx={x(i)}
                cy={y(p.amount)}
                r={hot ? 4.8 : 3.2}
                role="button"
                tabIndex={0}
                aria-label={`第 ${i + 1} 次报价 · ${formatOfferAmount(p.amount)} · ${p.side === 'left' ? leftLabel : rightLabel}（回车定位）`}
                onClick={() => onFocus?.(p.messageId)}
                onMouseEnter={() => {
                  setTip(i)
                  setHotSide(p.side)
                }}
                onMouseLeave={() => {
                  setTip(undefined)
                  setHotSide(undefined)
                }}
                onFocus={() => {
                  setTip(i)
                  setHotSide(p.side)
                }}
                onBlur={() => {
                  setTip(undefined)
                  setHotSide(undefined)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onFocus?.(p.messageId)
                  }
                }}
              />
            </g>
          )
        })}
        {lastValueLabel(lastL, 'left')}
        {lastValueLabel(lastR, 'right')}
        {/* 悬停浮层（顶层覆盖；序号 / 席名 / 金额 / 标题 / 让步理由） */}
        {tipPoint && !hidden.has(tipPoint.side)
          ? (() => {
              const i = tip!
              const lines: Array<{ text: string; cls: string }> = [
                { text: `第 ${i + 1} 次 · ${tipPoint.side === 'left' ? leftLabel : rightLabel}`, cls: 'is-meta' },
                { text: formatOfferAmount(tipPoint.amount), cls: 'is-amt' },
              ]
              if (tipPoint.title) lines.push({ text: clip(tipPoint.title, 14), cls: 'is-sub' })
              if (tipPoint.concession) lines.push({ text: `让步：${clip(tipPoint.concession, 12)}`, cls: 'is-sub' })
              const th = 8 + lines.length * 11
              const px = x(i)
              const py = y(tipPoint.amount)
              const tx = Math.min(Math.max(px - TIP_W / 2, 2), Math.max(vw - TIP_W - 2, 2))
              const ty = py - th - 10 >= 2 ? py - th - 10 : Math.min(py + 12, H - th - 2)
              return (
                <g className="scene-oc-tip" transform={`translate(${tx.toFixed(1)} ${ty.toFixed(1)})`} aria-hidden>
                  <rect width={TIP_W} height={th} rx={4} />
                  {lines.map((l, k) => (
                    <text key={k} className={cn('scene-oc-tip-text', l.cls)} x={7} y={12 + k * 11}>
                      {l.text}
                    </text>
                  ))}
                </g>
              )
            })()
          : null}
      </svg>
      <div className="scene-oc-legend">
        <button
          type="button"
          className={cn('scene-oc-lg is-left', hidden.has('left') && 'is-off')}
          aria-pressed={!hidden.has('left')}
          disabled={leftPts.length === 0}
          title={`显示 / 隐藏${leftLabel}折线`}
          onClick={() => toggle('left')}
        >
          {leftLabel}
        </button>
        <button
          type="button"
          className={cn('scene-oc-lg is-right', hidden.has('right') && 'is-off')}
          aria-pressed={!hidden.has('right')}
          disabled={rightPts.length === 0}
          title={`显示 / 隐藏${rightLabel}折线`}
          onClick={() => toggle('right')}
        >
          {rightLabel}
        </button>
        {baselinesDraw.length > 0 ? (
          <button
            type="button"
            className={cn('scene-oc-lg is-base', hidden.has('base') && 'is-off')}
            aria-pressed={!hidden.has('base')}
            title="显示 / 隐藏基准线（目标 / 底线 / BATNA）"
            onClick={() => toggle('base')}
          >
            基准线（目标 / 底线 / BATNA）
          </button>
        ) : null}
        {corridor ? (
          <button
            type="button"
            className={cn('scene-oc-lg is-corridor', hidden.has('corridor') && 'is-off')}
            aria-pressed={!hidden.has('corridor')}
            title="显示 / 隐藏收敛走廊（两侧最新报价之间的区间）"
            onClick={() => toggle('corridor')}
          >
            收敛走廊
          </button>
        ) : null}
        {corridor ? (
          <span className={cn('scene-oc-gap', corridor.crossed && 'is-crossed')}>
            {corridor.crossed ? '区间交叉（模拟）' : `当前差距 ${formatOfferAmount(corridor.gap)}（模拟口径）`}
          </span>
        ) : null}
      </div>
    </div>
  )
}

export function OfferConcessions({
  series,
  leftLabel,
  rightLabel,
  onFocus,
  onExplain,
}: {
  series: OfferSeries
  leftLabel: string
  rightLabel: string
  onFocus?: (messageId: string) => void
  /** 幅度扩大（纪律警示）→ 回填说明模板（文本由模板库构建） */
  onExplain?: (text: string) => void
}): React.JSX.Element | null {
  const steps = React.useMemo(() => {
    const out: Array<{ point: OfferPoint; delta: number; prevAbs?: number; warn: boolean }> = []
    for (const side of ['left', 'right'] as const) {
      let prevAbs: number | undefined
      let prevPoint: OfferPoint | undefined
      for (const p of series.points) {
        if (p.side !== side) continue
        if (prevPoint) {
          const delta = p.amount - prevPoint.amount
          const abs = Math.abs(delta)
          out.push({ point: p, delta, ...(prevAbs !== undefined ? { prevAbs } : {}), warn: prevAbs !== undefined && abs > prevAbs })
          prevAbs = abs
        }
        prevPoint = p
      }
    }
    return out
  }, [series])

  if (steps.length === 0) return null
  const maxAbs = Math.max(...steps.map((s) => Math.abs(s.delta)), 1)

  return (
    <div className="scene-concessions" aria-label="让步刻度" role="list">
      <span className="scene-conc-cap">让步刻度</span>
      {steps.map((s, i) => (
        <button
          type="button"
          role="listitem"
          key={`${s.point.messageId}-${i}`}
          className={cn('scene-conc-item', s.point.side === 'left' ? 'is-left' : 'is-right', s.warn && 'is-warn')}
          data-side={s.point.side}
          data-warn={s.warn}
          title={`让步 ${formatOfferAmount(Math.abs(s.delta))}｜理由：${s.point.concession ?? '未注明'}${s.warn ? '（幅度较上轮扩大）' : ''}`}
          onClick={() => {
            if (s.warn)
              onExplain?.(
                TEMPLATES.concessionExplain(
                  formatOfferAmount(Math.abs(s.delta)),
                  s.prevAbs !== undefined ? formatOfferAmount(s.prevAbs) : '—',
                ),
              )
            else onFocus?.(s.point.messageId)
          }}
        >
          <i style={{ height: `${Math.max(18, (Math.abs(s.delta) / maxAbs) * 100)}%` }} aria-hidden />
        </button>
      ))}
      <span className="scene-conc-legend">
        {leftLabel} / {rightLabel} · 幅度扩大标红
      </span>
    </div>
  )
}

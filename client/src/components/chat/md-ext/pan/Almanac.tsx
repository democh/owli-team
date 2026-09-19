/**
 * M54-C t4：时间轴合参（§5.4）——会话内八字 × 紫微双泳道（chartboard 面板顶部「合参」toggle）。
 *
 * - 统一年龄轴（0 → 两盘最晚终限；出生年已知时同轴双标年份 = 出生年 + 年龄）；
 *   泳道一 = 大运（干支 + 年龄区间，当前段 ●，当前大运内标流年点）；
 *   泳道二 = 大限（宫名 + 年龄区间，当前段 ●）；
 * - 出生年取自盘内「命造」公历日期；缺失 → 只显年龄（不显年份），绝不虚构；
 * - 交互：点选任一段 → 双泳道重叠段联动高亮 + 只读详情行；只呈现盘内行运数据，不推测应期。
 */
import * as React from 'react'
import { cn } from '../../../../lib/utils'
import type { BaziModel, PanRowData, ZiweiModel } from './model'

interface AlmSeg {
  key: string
  main: string
  from: number
  to: number
  current: boolean
  title: string
}

/** 出生年（盘内「命造」字段公历日期；缺 → undefined，泳道只显年龄） */
function birthYearOf(detail: PanRowData[]): number | undefined {
  const val = detail.find((r) => r.label === '命造')?.value
  const m = val ? /公历 (\d{4})-\d{2}-\d{2}/.exec(val) : null
  return m ? Number(m[1]) : undefined
}

function baziSegs(m: BaziModel): AlmSeg[] {
  return m.daYun.map((d, i) => ({
    key: `b${i}`,
    main: d.ganZhi,
    from: d.ages[0],
    to: d.ages[1],
    current: d.current,
    title: `${d.ganZhi}大运 ${d.ages[0]}-${d.ages[1]} 岁（${d.years[0]}-${d.years[1]}）`,
  }))
}

function ziweiSegs(m: ZiweiModel, birthZ?: number): AlmSeg[] {
  const out: AlmSeg[] = []
  for (const p of m.palaces) {
    if (!p.daXian) continue
    const years = birthZ !== undefined ? `（${birthZ + p.daXian.range[0]}-${birthZ + p.daXian.range[1]}）` : ''
    out.push({
      key: `z${p.zhiIndex}`,
      main: p.name,
      from: p.daXian.range[0],
      to: p.daXian.range[1],
      current: p.daXian.current,
      title: `${p.name} 大限 ${p.daXian.range[0]}-${p.daXian.range[1]} 岁${years}`,
    })
  }
  return out
}

function overlaps(a: { from: number; to: number }, b: { from: number; to: number }): boolean {
  return a.from <= b.to && b.from <= a.to
}

export function Almanac({ bazi, ziwei }: { bazi: BaziModel; ziwei: ZiweiModel }): React.JSX.Element {
  const birthB = birthYearOf(bazi.detail)
  const birthZ = birthYearOf(ziwei.detail)
  const baseYear = birthB ?? birthZ
  const bs = React.useMemo(() => baziSegs(bazi), [bazi])
  const zs = React.useMemo(() => ziweiSegs(ziwei, birthZ), [ziwei, birthZ])
  const [sel, setSel] = React.useState<{ lane: 'bazi' | 'ziwei'; index: number } | null>(null)

  const maxAge = Math.max(...bs.map((s) => s.to), ...zs.map((s) => s.to), 1)
  const pct = (age: number): string => `${(age / maxAge) * 100}%`
  const widthOf = (from: number, to: number): string => `${((to - from) / maxAge) * 100}%`

  const ticks: number[] = []
  for (let a = 10; a < maxAge; a += 10) ticks.push(a)

  const selSeg = sel ? (sel.lane === 'bazi' ? bs : zs)[sel.index] : undefined
  const hotOf = (s: AlmSeg): boolean => selSeg !== undefined && selSeg !== s && overlaps(s, selSeg)

  const segButton = (lane: 'bazi' | 'ziwei', i: number, s: AlmSeg, dots?: React.ReactNode): React.JSX.Element => {
    const on = sel?.lane === lane && sel.index === i
    return (
      <button
        key={s.key}
        type="button"
        className={cn('pn-alm-seg', s.current && 'is-current', on && 'is-on', !on && hotOf(s) && 'is-hot')}
        style={{ left: pct(s.from), width: widthOf(s.from, s.to) }}
        aria-pressed={on}
        aria-label={s.title}
        title={s.title}
        onClick={() => setSel(on ? null : { lane, index: i })}
      >
        <span className="pn-alm-seg-main">
          {s.main}
          {s.current ? (
            <span className="pn-alm-dot" aria-hidden="true">
              ●
            </span>
          ) : null}
        </span>
        <span className="pn-alm-seg-sub" aria-hidden="true">
          {s.from}-{s.to}
        </span>
        {dots}
      </button>
    )
  }

  /** 当前大运内流年点（仅有流年数据时；只读小点，title 给全称） */
  const baziDots = (s: AlmSeg): React.ReactNode =>
    s.current && bazi.liuNian.length > 0
      ? bazi.liuNian.map((ln) => (
          <span
            key={ln.year}
            className={cn('pn-alm-year-dot', ln.current && 'is-now')}
            style={{ left: `${((ln.age - s.from + 0.5) / (s.to - s.from + 1)) * 100}%` }}
            title={`流年 ${ln.year} ${ln.ganZhi}（${ln.age} 岁${ln.current ? ' · 当前' : ''}）`}
          />
        ))
      : null

  const opp = selSeg !== undefined ? (sel?.lane === 'bazi' ? zs : bs).filter((s) => overlaps(s, selSeg)) : []

  return (
    <div className="pn-alm" aria-label="八字 × 紫微 时间轴合参">
      <div className="pn-alm-cap">时间轴合参（只呈现盘内行运数据，不含推测）</div>
      <div className="pn-alm-axis" aria-hidden="true">
        {ticks.map((a) => (
          <span key={a} className="pn-alm-tick" style={{ left: pct(a) }}>
            <span className="pn-alm-tick-age">{a} 岁</span>
            {baseYear !== undefined ? <span className="pn-alm-tick-year">{baseYear + a}</span> : null}
          </span>
        ))}
      </div>
      <div className="pn-alm-lane">
        <div className="pn-alm-lane-cap">八字 · 大运</div>
        <div className="pn-alm-track">
          {bs.map((s, i) => segButton('bazi', i, s, baziDots(s)))}
        </div>
      </div>
      <div className="pn-alm-lane">
        <div className="pn-alm-lane-cap">紫微 · 大限</div>
        <div className="pn-alm-track">{zs.map((s, i) => segButton('ziwei', i, s))}</div>
      </div>
      <div className={selSeg ? 'pn-alm-detail' : 'pn-alm-hint'} role="status">
        {selSeg
          ? `${selSeg.title} ↔ ${opp.length > 0 ? opp.map((s) => s.title).join('、') : '另一泳道无重叠段'}`
          : '点选任一段：双泳道重叠段联动高亮'}
      </div>
    </div>
  )
}

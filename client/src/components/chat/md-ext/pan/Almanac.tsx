/**
 * M54-C t4：时间轴合参（§5.4）——会话内八字 × 紫微双泳道（chartboard 面板顶部「合参」toggle）。
 *
 * - 统一年龄轴（0 → 两盘最晚终限；出生年已知时同轴双标年份 = 出生年 + 年龄）；
 *   泳道一 = 大运（干支 + 年龄区间，当前段 ●，当前大运内标流年点）；
 *   泳道二 = 大限（宫名 + 年龄区间，当前段 ●）；
 * - M63-F：泳道三 = 行运时点（会话内存在可派生 transit 卡且含扫描时点时——hits → 年龄轴节点；
 *   虚岁 = 年份 − 出生年 + 1（与卡内流年岁数口径一致）；缺出生年 / 无扫描 → 零渲染不虚构）；
 * - 出生年取自盘内「命造」公历日期；缺失 → 只显年龄（不显年份），绝不虚构；
 * - 交互：点选任一段 → 双泳道重叠段联动高亮 + 只读详情行；点行运◆ → 时点详情（与段选互斥）；
 *   只呈现盘内行运数据，不推测应期（时点 title 含「参考时点，非事件断言」）。
 */
import * as React from 'react'
import { cn } from '../../../../lib/utils'
import type { BaziModel, PanRowData, TransitModel, ZiweiModel } from './model'

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

/** M63-F 行运时点（transit 卡扫描 hits → 年龄轴节点） */
interface AlmMark {
  key: string
  age: number
  title: string
}

function transitMarks(t: TransitModel, birth?: number): AlmMark[] {
  if (!t.scan || birth === undefined) return []
  const out: AlmMark[] = []
  t.scan.hits.forEach((h, i) => {
    const year = Number(h.exact.slice(0, 4))
    if (!Number.isFinite(year)) return
    const age = year - birth + 1 // 虚岁口径（与卡内流年岁数一致）
    const label = `行运${h.transitPlanet}-本命${h.natalPoint} ${h.type}`
    out.push({ key: `t${i}`, age, title: `${label} · 精确 ${h.exact}（${age} 岁 · 参考时点，非事件断言）` })
  })
  return out.sort((a, b) => a.age - b.age)
}

export function Almanac({
  bazi,
  ziwei,
  transit,
}: {
  bazi: BaziModel
  ziwei: ZiweiModel
  /** M63-F：行运盘（有扫描时点时出第三泳道） */
  transit?: TransitModel
}): React.JSX.Element {
  const birthB = birthYearOf(bazi.detail)
  const birthZ = birthYearOf(ziwei.detail)
  const baseYear = birthB ?? birthZ
  const bs = React.useMemo(() => baziSegs(bazi), [bazi])
  const zs = React.useMemo(() => ziweiSegs(ziwei, birthZ), [ziwei, birthZ])
  const marks = React.useMemo(() => (transit ? transitMarks(transit, baseYear) : []), [transit, baseYear])
  /** 同年龄（年）多时点 → 水平错开 22px/序（完全可点；否则同年节点重叠互相遮挡） */
  const marksLayout = React.useMemo(() => {
    const groups = new Map<number, AlmMark[]>()
    for (const m of marks) {
      const g = groups.get(m.age) ?? []
      g.push(m)
      groups.set(m.age, g)
    }
    const out: Array<AlmMark & { dx: number }> = []
    for (const g of groups.values()) {
      g.forEach((m, i) => out.push({ ...m, dx: (i - (g.length - 1) / 2) * 22 }))
    }
    return out
  }, [marks])
  const [sel, setSel] = React.useState<{ lane: 'bazi' | 'ziwei'; index: number } | null>(null)
  const [selMark, setSelMark] = React.useState<string | null>(null)

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
        onClick={() => {
          setSel(on ? null : { lane, index: i })
          setSelMark(null)
        }}
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
  const selMarkObj = selMark ? marks.find((m) => m.key === selMark) : undefined
  const clampAge = (a: number): number => Math.min(a, maxAge)
  const detailText = selMarkObj
    ? selMarkObj.title
    : selSeg
      ? `${selSeg.title} ↔ ${opp.length > 0 ? opp.map((s) => s.title).join('、') : '另一泳道无重叠段'}`
      : marks.length > 0
        ? '点选任一段：双泳道重叠段联动高亮；点行运 ◆ 看时点详情（参考时点，非事件断言）'
        : '点选任一段：双泳道重叠段联动高亮'

  return (
    <div className="pn-alm" aria-label={marks.length > 0 ? '八字 × 紫微 × 行运 时间轴合参' : '八字 × 紫微 时间轴合参'}>
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
      {marks.length > 0 ? (
        <div className="pn-alm-lane">
          <div className="pn-alm-lane-cap">行运 · 时点</div>
          <div className="pn-alm-track pn-alm-track-node">
            {marksLayout.map((mk) => {
              const on = selMark === mk.key
              return (
                <button
                  key={mk.key}
                  type="button"
                  className={cn('pn-alm-node', on && 'is-on')}
                  style={{ left: `calc(${pct(clampAge(mk.age))} + ${mk.dx}px)` }}
                  aria-pressed={on}
                  aria-label={mk.title}
                  title={mk.title}
                  onClick={() => {
                    setSelMark(on ? null : mk.key)
                    setSel(null)
                  }}
                >
                  <span className="pn-alm-node-dot" aria-hidden="true">
                    ◆
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      ) : null}
      <div className={selSeg || selMarkObj ? 'pn-alm-detail' : 'pn-alm-hint'} role="status">
        {detailText}
      </div>
    </div>
  )
}

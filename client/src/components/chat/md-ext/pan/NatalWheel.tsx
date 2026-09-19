/**
 * M54-B t2：星盘 · 黄道轮盘（§4.4）——轮盘 / 相位筛选 / 矩阵互跳。
 *
 * 几何：θ(lon) = 180° + (lon − asc)（ASC 置左水平；缺 ASC 用 0° 白羊置左，
 * 且不画 ASC/DSC 轴标记以防误导），黄经增大逆时针；viewBox 320×320 静态 SVG，无动画依赖。
 * 口径纪律：度数 / 落宫 / 元素 / 模式一律取自卡内派生（deriveNatal），不重算、不预测。
 * 弦型颜色 + 线型双编码（合实线 / 六合点线 / 刑长划 / 拱双点 / 对分加粗，§4.4）。
 */
import * as React from 'react'
import type { NatalAspect, NatalModel, NatalPlanet } from './model'
import { AskBar, Legend } from './parts'

const CX = 160
const CY = 160
const R_OUT = 146
const R_ZOD = 126
const R_HOUSE = 103
const R_ASP = 94
/** 行星点三档半径错位（3° 内错档，§4.4） */
const TIERS = [96, 86, 76] as const

const SIGNS = ['白羊', '金牛', '双子', '巨蟹', '狮子', '处女', '天秤', '天蝎', '射手', '摩羯', '水瓶', '双鱼'] as const
const ASP_TYPES = ['合相', '六合', '刑相', '拱相', '对分'] as const
type AspType = (typeof ASP_TYPES)[number]
const ASP_SHORT: Record<AspType, string> = { 合相: '合', 六合: '六', 刑相: '刑', 拱相: '拱', 对分: '对' }
const PLANET_SHORT: Record<string, string> = {
  太阳: '日',
  月亮: '月',
  水星: '水',
  金星: '金',
  火星: '火',
  木星: '木',
  土星: '土',
  天王星: '天',
  海王星: '海',
  冥王星: '冥',
}

const shortOf = (name: string): string => PLANET_SHORT[name] ?? name.slice(0, 1)

const f = (n: number): number => Math.round(n * 100) / 100

function signIndexOf(name: string): number {
  return (SIGNS as readonly string[]).indexOf(name)
}

/** 黄经 → 「星座 度.度°」（展示口径，与卡内同一黄经） */
function signLabel(lon: number): string {
  const si = Math.floor(lon / 30) % 12
  return `${SIGNS[si]}${(Math.round((lon - si * 30) * 10) / 10).toFixed(1)}°`
}

/** θ(lon) = 180° + (lon − asc)：ASC 置左水平、黄经增大逆时针（屏幕 y = cy − r·sinθ） */
function ptOf(lon: number, r: number, asc: number): { x: number; y: number } {
  const t = ((180 + (lon - asc)) * Math.PI) / 180
  return { x: f(CX + r * Math.cos(t)), y: f(CY - r * Math.sin(t)) }
}

/** 环带扇区路径（黄经 a→b；外弧逆时针 sweep=0，内弧回程 sweep=1） */
function ringSector(a: number, b: number, rOut: number, rIn: number, asc: number): string {
  const o1 = ptOf(a, rOut, asc)
  const o2 = ptOf(b, rOut, asc)
  const i1 = ptOf(a, rIn, asc)
  const i2 = ptOf(b, rIn, asc)
  return `M ${o1.x} ${o1.y} A ${rOut} ${rOut} 0 0 0 ${o2.x} ${o2.y} L ${i2.x} ${i2.y} A ${rIn} ${rIn} 0 0 1 ${i1.x} ${i1.y} Z`
}

/** 多条径向短线合并为单 path（控节点量，§7.11） */
function spokesPath(lons: number[], r1: number, r2: number, asc: number): string {
  return lons
    .map((lon) => {
      const p1 = ptOf(lon, r1, asc)
      const p2 = ptOf(lon, r2, asc)
      return `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}`
    })
    .join(' ')
}

const aspKey = (a: NatalAspect): string => `${a.a}|${a.b}|${a.type}|${a.orb}`

const isKinOf = (a: NatalPlanet, b: NatalPlanet): boolean =>
  (a.house !== undefined && a.house === b.house) || a.sign === b.sign

/** 模板 8 参数段：星座度数 / 落宫 / 逆行 */
function planetSegs(p: NatalPlanet): string[] {
  const segs = [`${p.sign}${p.deg}°`]
  if (p.house !== undefined) segs.push(`${p.house} 宫`)
  if (p.retro) segs.push('逆行')
  return segs
}

export function NatalWheel({ model, onAsk }: { model: NatalModel; onAsk?: (text: string) => void }): React.JSX.Element {
  const hasAsc = model.asc !== undefined
  const asc = model.asc ?? 0
  const cusps = model.cusps

  const detailVal = (label: string): string => model.detail.find((d) => d.label === label)?.value ?? ''
  const elems = detailVal('元素')
    .split('｜')
    .map((s) => s.trim())
    .filter(Boolean)

  // MC 取自「宫制」字段原文（缺失 → 不画 MC/IC）
  const mc = (() => {
    const m = /MC (\S+) (\d+(?:\.\d+)?)°/.exec(detailVal('宫制'))
    if (!m) return null
    const si = signIndexOf(m[1]!)
    return si >= 0 ? si * 30 + Number(m[2]) : null
  })()

  const [selPlanet, setSelPlanet] = React.useState<string | null>(null)
  const [hoverPlanet, setHoverPlanet] = React.useState<string | null>(null)
  const [selAsp, setSelAsp] = React.useState<NatalAspect | null>(null)
  const [hoverAsp, setHoverAsp] = React.useState<NatalAspect | null>(null)
  const [active, setActive] = React.useState<ReadonlySet<AspType>>(() => new Set(ASP_TYPES))
  const [view, setView] = React.useState<'wheel' | 'matrix'>('wheel')
  const [focusCell, setFocusCell] = React.useState<[number, number] | null>(null)
  const gridRef = React.useRef<HTMLDivElement | null>(null)

  const tierOf = (() => {
    const map = new Map<string, number>()
    const sorted = [...model.planets].sort((a, b) => a.lon - b.lon)
    let last = Number.NEGATIVE_INFINITY
    let tier = 0
    for (const p of sorted) {
      if (p.lon - last < 3) tier = (tier + 1) % TIERS.length
      map.set(p.name, tier)
      last = p.lon
    }
    return map
  })()

  const lonOf = (name: string): number | null => model.planets.find((p) => p.name === name)?.lon ?? null
  const aspMap = (() => {
    const map = new Map<string, NatalAspect>()
    for (const a of model.aspects) {
      map.set(`${a.a}|${a.b}`, a)
      map.set(`${a.b}|${a.a}`, a)
    }
    return map
  })()

  const isSelAsp = (a: NatalAspect): boolean => selAsp !== null && aspKey(selAsp) === aspKey(a)
  const visAspects = model.aspects.filter((a) => active.has(a.type) && lonOf(a.a) !== null && lonOf(a.b) !== null)
  const selPlanetData = selPlanet !== null ? model.planets.find((p) => p.name === selPlanet) ?? null : null
  const hoverP = hoverPlanet !== null ? model.planets.find((p) => p.name === hoverPlanet) ?? null : null

  const partnerOf = (a: NatalAspect, name: string): string => (a.a === name ? a.b : a.a)
  const aspOfPlanet = (name: string): NatalAspect[] => model.aspects.filter((a) => a.a === name || a.b === name)

  const toggleType = (t: AspType): void => {
    setActive((prev) => {
      const next = new Set(prev)
      if (next.has(t)) next.delete(t)
      else next.add(t)
      return next
    })
  }

  const togglePlanet = (name: string): void => {
    setSelPlanet(selPlanet === name ? null : name)
    setSelAsp(null)
  }

  const wheelLabel = `星盘轮盘（${hasAsc ? `上升 ${signLabel(asc)}` : '上升未提供'}，行星 ${model.planets.length} 颗，相位 ${model.aspects.length} 条，ASC 置左、黄经逆时针）`

  const tipPos = (a: NatalAspect): { left: string; top: string } | null => {
    const la = lonOf(a.a)
    const lb = lonOf(a.b)
    if (la === null || lb === null) return null
    const pa = ptOf(la, R_ASP, asc)
    const pb = ptOf(lb, R_ASP, asc)
    return {
      left: `${(((pa.x + pb.x) / 2 / 320) * 100).toFixed(2)}%`,
      top: `${(((pa.y + pb.y) / 2 / 320) * 100).toFixed(2)}%`,
    }
  }

  // 行星浮标锚点：底边（translate −100%）落在圆点（r=8）与逆行 ℞ 标（y−9 起）之上，
  // 取 y−15 留出净距；横向收拢到 [72,248]，防轮盘边缘行星的浮标越出滚动容器被裁切。
  const planetTipPos = (p: NatalPlanet): { left: string; top: string } => {
    const pos = ptOf(p.lon, TIERS[tierOf.get(p.name) ?? 0]!, asc)
    const lx = Math.min(Math.max(pos.x, 72), 248)
    return { left: `${((lx / 320) * 100).toFixed(2)}%`, top: `${(((pos.y - 15) / 320) * 100).toFixed(2)}%` }
  }

  const firstFocus = (() => {
    for (let i = 0; i < model.planets.length; i++) {
      for (let j = i + 1; j < model.planets.length; j++) {
        if (aspMap.get(`${model.planets[i]!.name}|${model.planets[j]!.name}`)) return [i, j] as [number, number]
      }
    }
    return null
  })()

  const onCellKey = (e: React.KeyboardEvent<HTMLButtonElement>, i: number, j: number): void => {
    const deltas: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    }
    const d = deltas[e.key]
    if (!d) return
    e.preventDefault()
    const cells = gridRef.current?.querySelectorAll<HTMLElement>('.pn-mcell-btn')
    if (!cells) return
    let best: HTMLElement | null = null
    let bestScore = Number.POSITIVE_INFINITY
    for (const c of Array.from(cells)) {
      if (c === e.currentTarget) continue
      const ci = Number(c.dataset.i)
      const cj = Number(c.dataset.j)
      const di = ci - i
      const dj = cj - j
      const ok = d[0] !== 0 ? dj === 0 && Math.sign(di) === d[0] : di === 0 && Math.sign(dj) === d[1]
      const score = Math.abs(di) + Math.abs(dj)
      if (ok && score < bestScore) {
        bestScore = score
        best = c
      }
    }
    if (best) best.focus()
  }

  const askItems: Array<{ text: string; onPick?: () => void }> = []
  if (selPlanetData) {
    askItems.push({
      text: `请教${selPlanetData.name}`,
      onPick: () => onAsk?.(`请解读本命盘中${selPlanetData.name}（${planetSegs(selPlanetData).join('，')}）的落点含义与依据。`),
    })
  }
  if (selAsp) {
    askItems.push({
      text: '请教此相位',
      onPick: () => onAsk?.(`请解读${selAsp.a}-${selAsp.b} ${selAsp.type} ${selAsp.orb}° 相位的课题与成长点表述（含依据）。`),
    })
  }

  const retroNames = model.planets.filter((p) => p.retro).map((p) => shortOf(p.name))
  const legendItems: React.ReactNode[] = [
    '弦型：合实线 · 六合点线 · 刑长划 · 拱双点 · 对分加粗',
    hasAsc ? `ASC 置左（${signLabel(asc)}）· 黄经逆时针` : 'ASC 未提供（按 0° 白羊置左）',
  ]
  if (retroNames.length > 0) legendItems.push(`℞ 逆行（${retroNames.join('/')}）`)

  const axes: Array<{ key: string; lon: number }> = [
    ...(hasAsc
      ? [
          { key: 'ASC', lon: asc },
          { key: 'DSC', lon: (asc + 180) % 360 },
        ]
      : []),
    ...(mc !== null
      ? [
          { key: 'MC', lon: mc },
          { key: 'IC', lon: (mc + 180) % 360 },
        ]
      : []),
  ]

  // 水平轴（ASC/DSC）标签与同方向星座名（r=136）避让：两者横坐标几乎同列，唯有纵向可让位。
  // 星座名中心距轴线 < 12（轴标半高 + 星座名半高 + 呼吸）时才下沉到其下方——
  // 距离够远的名字本就分离，盲目下沉反而会撞上「轴下方稍远」的名字（固定偏移的失效区）。
  // 两轴取最大需求，保持 ASC/DSC 标签齐平。
  let horizontalAxisDy = 0
  for (const ax of axes) {
    if (ax.key !== 'ASC' && ax.key !== 'DSC') continue
    const nameY = ptOf((Math.floor(ax.lon / 30) % 12) * 30 + 15, 136, asc).y
    if (Math.abs(nameY - CY) < 12) horizontalAxisDy = Math.max(horizontalAxisDy, nameY + 12 - CY)
  }

  return (
    <div className="pn-board pn-natal">
      {view === 'wheel' ? (
        <div className="pn-natal-top">
          <div className="pn-scroll">
            <div className="pn-wheel-wrap">
              <svg className="pn-wheel" viewBox="0 0 320 320" role="img" aria-label={wheelLabel}>
                <g className="pn-zodiac">
                  {SIGNS.map((s, i) => (
                    <path key={s} data-sign={s} className="pn-zodiac-seg" d={ringSector(i * 30, (i + 1) * 30, R_OUT, R_ZOD, asc)} />
                  ))}
                  <path
                    className="pn-tick"
                    d={spokesPath(
                      Array.from({ length: 72 }, (_, i) => i * 5).filter((d) => d % 30 !== 0),
                      R_ZOD,
                      R_ZOD + 5,
                      asc,
                    )}
                  />
                  <path className="pn-zodiac-line" d={spokesPath(SIGNS.map((_, i) => i * 30), R_ZOD, R_OUT, asc)} />
                  {SIGNS.map((s, i) => {
                    const c = ptOf(i * 30 + 15, 136, asc)
                    return (
                      <text key={s} className="pn-zodiac-name" x={c.x} y={c.y} textAnchor="middle" dominantBaseline="central">
                        {s}
                      </text>
                    )
                  })}
                </g>

                {cusps ? (
                  <g className="pn-houses">
                    <path className="pn-house-line" d={spokesPath(cusps, R_HOUSE, R_ZOD, asc)} />
                    {cusps.map((c, i) => {
                      const b = cusps[(i + 1) % 12]!
                      const mid = (c + (((b - c) + 360) % 360) / 2) % 360
                      const p = ptOf(mid, 114.5, asc)
                      return (
                        <text key={i} className="pn-house-num" x={p.x} y={p.y} textAnchor="middle" dominantBaseline="central">
                          {i + 1}
                        </text>
                      )
                    })}
                  </g>
                ) : (
                  <circle className="pn-house-lite" cx={CX} cy={CY} r={114.5} />
                )}

                <g className="pn-axes">
                  {axes.map((ax) => {
                    // 垂直轴（MC/IC）轴点置于环外缘（r=R_OUT）：其标签在正上方、径向外已贴视口，
                    // 原 +4 会压字底 2px；水平轴保持环外 4px（再外会碰星座名）
                    const dotR = ax.key === 'MC' || ax.key === 'IC' ? R_OUT : R_OUT + 4
                    const dot = ptOf(ax.lon, dotR, asc)
                    const t = ((180 + (ax.lon - asc)) * Math.PI) / 180
                    const cos = Math.cos(t)
                    const anchor = cos < -0.5 ? 'start' : cos > 0.5 ? 'end' : 'middle'
                    // 水平轴（ASC/DSC）标签纵向避让同列星座名（见 horizontalAxisDy 计算）
                    const dy = ax.key === 'ASC' || ax.key === 'DSC' ? horizontalAxisDy : 0
                    const lb = ptOf(ax.lon, R_OUT + 9, asc)
                    // 水平轴：标签锚端与轴点（r=R_OUT+4）保持 7px 间隔——避让量≈0 时圆点会压在字头
                    const lx = ax.key === 'ASC' ? dot.x + 7 : ax.key === 'DSC' ? dot.x - 7 : lb.x
                    return (
                      <g key={ax.key} className={`pn-axis is-${ax.key.toLowerCase()}`}>
                        <circle className="pn-axis-dot" cx={dot.x} cy={dot.y} r={2.5} />
                        <text className="pn-axis-label" x={lx} y={lb.y + dy} textAnchor={anchor} dominantBaseline="central">
                          {ax.key}
                        </text>
                      </g>
                    )
                  })}
                </g>

                <g className="pn-aspects">
                  {visAspects.map((a) => {
                    const pa = ptOf(lonOf(a.a)!, R_ASP, asc)
                    const pb = ptOf(lonOf(a.b)!, R_ASP, asc)
                    const rel = hoverPlanet !== null && (a.a === hoverPlanet || a.b === hoverPlanet)
                    const hot = rel || isSelAsp(a)
                    const faded = hoverPlanet !== null && !rel
                    return (
                      <React.Fragment key={aspKey(a)}>
                        {/* 透明命中层：虚线 / 细线命中不可靠，交互一律挂命中层（视觉层 pointer-events: none） */}
                        <line
                          className="pn-aspect-hit"
                          data-type={a.type}
                          data-a={a.a}
                          data-b={a.b}
                          x1={pa.x}
                          y1={pa.y}
                          x2={pb.x}
                          y2={pb.y}
                          aria-hidden="true"
                          onMouseEnter={() => setHoverAsp(a)}
                          onMouseLeave={() => setHoverAsp(null)}
                          onClick={() => {
                            setSelAsp(isSelAsp(a) ? null : a)
                            setSelPlanet(null)
                          }}
                        />
                        <line
                          className={`pn-aspect${hot ? ' is-hot' : ''}${faded ? ' is-faded' : ''}`}
                          data-type={a.type}
                          data-a={a.a}
                          data-b={a.b}
                          x1={pa.x}
                          y1={pa.y}
                          x2={pb.x}
                          y2={pb.y}
                          aria-hidden="true"
                        />
                      </React.Fragment>
                    )
                  })}
                </g>

                <g className="pn-planets">
                  {model.planets.map((p) => {
                    const r = TIERS[tierOf.get(p.name) ?? 0]!
                    const pos = ptOf(p.lon, r, asc)
                    const hot = hoverPlanet === p.name
                    const kin = hoverP !== null && p.name !== hoverP.name && isKinOf(hoverP, p)
                    const cls = `pn-planet${p.retro ? ' is-retro' : ''}${hot ? ' is-hot' : ''}${kin ? ' is-kin' : ''}${
                      selPlanet === p.name ? ' is-on' : ''
                    }`
                    return (
                      <g
                        key={p.name}
                        className={cls}
                        data-name={p.name}
                        role="button"
                        tabIndex={0}
                        aria-label={`${p.name} ${p.sign}${p.deg}°，${p.house !== undefined ? `${p.house} 宫` : '落宫未标'}${
                          p.retro ? '，逆行' : ''
                        }`}
                        onMouseEnter={() => setHoverPlanet(p.name)}
                        onMouseLeave={() => setHoverPlanet(null)}
                        onFocus={() => setHoverPlanet(p.name)}
                        onBlur={() => setHoverPlanet(null)}
                        onClick={() => togglePlanet(p.name)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            togglePlanet(p.name)
                          }
                        }}
                      >
                        <circle className="pn-planet-dot" cx={pos.x} cy={pos.y} r={8} />
                        <text className="pn-planet-glyph" x={pos.x} y={pos.y} textAnchor="middle" dominantBaseline="central">
                          {shortOf(p.name)}
                        </text>
                        {p.retro ? (
                          <text className="pn-planet-retro" x={pos.x} y={pos.y - 9} textAnchor="middle" aria-hidden="true">
                            ℞
                          </text>
                        ) : null}
                      </g>
                    )
                  })}
                </g>
              </svg>
              {hoverAsp && tipPos(hoverAsp) ? (
                <div className="pn-aspect-tip" style={tipPos(hoverAsp)!} aria-hidden="true">
                  {hoverAsp.a}-{hoverAsp.b} {hoverAsp.type} {hoverAsp.orb}°
                </div>
              ) : null}
              {/* 行星浮标：悬停 / 键盘聚焦（hoverPlanet）即出——名称 + 星座度数 / 落宫 / 逆行 */}
              {hoverP ? (
                <div className="pn-planet-tip" style={planetTipPos(hoverP)} aria-hidden="true">
                  {hoverP.name} {planetSegs(hoverP).join(' · ')}
                </div>
              ) : null}
            </div>
          </div>

          <div className="pn-natal-side">
            {selPlanetData ? (
              <div className="pn-detail pn-planet-detail" role="region" aria-label={`${selPlanetData.name}详情`}>
                <span className="pn-detail-strong">
                  {selPlanetData.name}
                  {selPlanetData.retro ? ' · 逆行' : ''}
                </span>
                <span>
                  {selPlanetData.sign} {selPlanetData.deg}°（黄经 {selPlanetData.lon}°）
                </span>
                {selPlanetData.house !== undefined ? <span>第 {selPlanetData.house} 宫</span> : null}
                <div className="pn-asp-list">
                  {aspOfPlanet(selPlanetData.name).length === 0 ? (
                    <span className="pn-asp-none">无相位记录</span>
                  ) : (
                    aspOfPlanet(selPlanetData.name).map((a) => (
                      <button
                        key={aspKey(a)}
                        type="button"
                        className={`pn-asp-item${isSelAsp(a) ? ' is-on' : ''}`}
                        data-type={a.type}
                        aria-pressed={isSelAsp(a)}
                        onClick={() => setSelAsp(isSelAsp(a) ? null : a)}
                      >
                        {partnerOf(a, selPlanetData.name)} {a.type} {a.orb}°
                      </button>
                    ))
                  )}
                </div>
              </div>
            ) : (
              <div className="pn-detail pn-natal-hint">点击行星查看度数 / 落宫 / 相位清单</div>
            )}
          </div>
        </div>
      ) : (
        <div className="pn-mtable" role="grid" aria-label={`相位矩阵（${model.planets.length}×${model.planets.length} 半角对照）`} ref={gridRef}>
          <div className="pn-mrow" role="row">
            <span className="pn-mcorner" role="columnheader" aria-label="行 / 列行星" />
            {model.planets.map((p) => (
              <span key={p.name} className="pn-mhead" role="columnheader" title={p.name}>
                {shortOf(p.name)}
              </span>
            ))}
          </div>
          {model.planets.map((rowP, i) => (
            <div className="pn-mrow" role="row" key={rowP.name}>
              <span className="pn-mhead" role="rowheader" title={rowP.name}>
                {shortOf(rowP.name)}
              </span>
              {model.planets.map((colP, j) => {
                if (i === j) return <span key={colP.name} className="pn-mcell is-diag" role="gridcell" aria-hidden="true" />
                const asp = i < j ? aspMap.get(`${rowP.name}|${colP.name}`) : undefined
                if (!asp) {
                  return <span key={colP.name} className="pn-mcell" role="gridcell" aria-label={`${rowP.name}-${colP.name} 无相位`} />
                }
                const tabbable =
                  focusCell !== null ? focusCell[0] === i && focusCell[1] === j : firstFocus !== null && firstFocus[0] === i && firstFocus[1] === j
                return (
                  <button
                    key={colP.name}
                    type="button"
                    role="gridcell"
                    className={`pn-mcell-btn${isSelAsp(asp) ? ' is-hot' : ''}`}
                    data-type={asp.type}
                    data-a={asp.a}
                    data-b={asp.b}
                    data-i={i}
                    data-j={j}
                    tabIndex={tabbable ? 0 : -1}
                    aria-label={`${asp.a}-${asp.b} ${asp.type} ${asp.orb}°`}
                    onFocus={() => setFocusCell([i, j])}
                    onKeyDown={(e) => onCellKey(e, i, j)}
                    onClick={() => {
                      setSelAsp(asp)
                      setView('wheel')
                    }}
                  >
                    {ASP_SHORT[asp.type]}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      )}

      {elems.length > 0 ? (
        <div className="pn-natal-meta">
          {elems.map((s, i) => (
            <span key={i} className="pn-natal-meta-item">
              {i === 0 ? `元素 ${s}` : s}
            </span>
          ))}
        </div>
      ) : null}

      <div className="pn-foot">
        <AskBar items={askItems} />
        <div className="pn-asp-filter" role="group" aria-label="相位筛选">
          {ASP_TYPES.map((t) => (
            <button
              key={t}
              type="button"
              className="pn-asp-chip"
              data-type={t}
              aria-pressed={active.has(t)}
              onClick={() => toggleType(t)}
            >
              {t}
            </button>
          ))}
        </div>
        <div className="pn-viewseg" role="group" aria-label="轮盘与矩阵切换">
          <button type="button" className="pn-viewseg-btn" aria-pressed={view === 'wheel'} onClick={() => setView('wheel')}>
            轮盘
          </button>
          <button type="button" className="pn-viewseg-btn" aria-pressed={view === 'matrix'} onClick={() => setView('matrix')}>
            矩阵
          </button>
        </div>
        <Legend items={legendItems} ariaLabel="星盘图例" />
      </div>
    </div>
  )
}

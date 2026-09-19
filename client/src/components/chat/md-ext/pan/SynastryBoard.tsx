/**
 * M63-B：合盘 · 对照视图（§5.2）——交角矩阵（A 十星 × B 十星）+ 轴相位清单 + 组合盘 + 知情脚注。
 * M63 续完善（v2）：双环同心图——外环 A / 内环 B（0° 白羊置左，与轮盘同约定）；
 *   点格 / 悬停格 → 双环对应点高亮 + 连线（色随相位类型）。
 *
 * 口径纪律：矩阵 / 清单 / 组合盘 / 双环一律取自卡内派生（deriveSynastry），不重算不预测；
 * 知情声明为卡内字段原文（合规）。
 */
import * as React from 'react'
import type { SynastryModel, SynastryAspect } from './model'
import { AskBar, Legend } from './parts'

const ASP_TYPES = ['合相', '六合', '刑相', '拱相', '对分'] as const
type AspType = (typeof ASP_TYPES)[number]
const ASP_CLASS: Record<string, string> = {
  合相: 'pn-asp-he',
  六合: 'pn-asp-liu',
  刑相: 'pn-asp-xing',
  拱相: 'pn-asp-gong',
  对分: 'pn-asp-dui',
}
const ASTRO_POINTS = ['太阳', '月亮', '水星', '金星', '火星', '木星', '土星', '天王星', '海王星', '冥王星']
const shortOf = (name: string): string => name.slice(0, 1)

/** 解析带侧前缀点名（'A金星' → {side:'A', point:'金星'}；轴为 'AASC'） */
function parsePoint(p: string): { side: 'A' | 'B' | '?'; point: string } {
  if (p.startsWith('A')) return { side: 'A', point: p.slice(1) }
  if (p.startsWith('B')) return { side: 'B', point: p.slice(1) }
  return { side: '?', point: p }
}

const isAxisPoint = (n: string): boolean => ['ASC', 'MC', 'DSC', 'IC'].includes(n)

// 双环几何（0° 白羊置左，黄经增大逆时针；与 TransitWheel/NatalWheel 同约定）
const WX = 120
const WY = 120
const R_OUT = 96
const R_IN = 66
const f2 = (n: number): number => Math.round(n * 100) / 100
function ptOf(lon: number, r: number): { x: number; y: number } {
  const t = ((180 + lon) * Math.PI) / 180
  return { x: f2(WX + r * Math.cos(t)), y: f2(WY - r * Math.sin(t)) }
}

export function SynastryBoard({ model, onAsk }: { model: SynastryModel; onAsk?: (text: string) => void }): React.JSX.Element {
  const [focus, setFocus] = React.useState<SynastryAspect | null>(null)
  const [hover, setHover] = React.useState<SynastryAspect | null>(null)
  const [showComposite, setShowComposite] = React.useState(false)

  const aspects = model.aspects
  // 矩阵：A 星 × B 星（点对点）；轴向单独成清单
  const cellOf = new Map<string, SynastryAspect>()
  const axisAspects: SynastryAspect[] = []
  for (const a of aspects) {
    const pa = parsePoint(a.a)
    const pb = parsePoint(a.b)
    const isAxis = (n: string): boolean => ['ASC', 'MC', 'DSC', 'IC'].includes(n)
    if (isAxis(pa.point) || isAxis(pb.point)) {
      axisAspects.push(a)
    } else {
      cellOf.set(`${pa.point}|${pb.point}`, a)
    }
  }

  const askItems: Array<{ text: string; onPick?: () => void }> = []
  if (focus) {
    askItems.push({
      text: `请教相位 ${focus.a}-${focus.b}`,
      onPick: () =>
        onAsk?.(`请解读 ${focus.a}-${focus.b} ${focus.type} ${focus.orb.toFixed(1)}° 的课题与成长点表述（含依据）。`),
    })
  }
  askItems.push({
    text: '请教重点',
    onPick: () => onAsk?.('请按 orb 从紧到松解读本合盘的几个重点交角（并列呈现吸引与摩擦点，含依据）。'),
  })

  const elementText = model.detail.find((d) => d.label === '元素')?.value ?? ''

  // 双环联动目标（focus 优先、hover 其次；仅点对点——轴相位不进双环）
  const active = focus ?? hover
  const activePair = (() => {
    if (!active) return null
    const pa = parsePoint(active.a)
    const pb = parsePoint(active.b)
    if (pa.side !== 'A' || pb.side !== 'B' || isAxisPoint(pa.point) || isAxisPoint(pb.point)) return null
    return { aName: pa.point, bName: pb.point, type: active.type }
  })()

  return (
    <div className="pn-board pn-synastry">
      <div className="pn-sy-top">
        <div className="pn-sy-wheel" role="img" aria-label="双环对照（外环 A · 内环 B；0° 白羊置左）">
          <svg viewBox="0 0 240 240">
            <circle className="pn-sy-ring" cx={WX} cy={WY} r={R_OUT} />
            <circle className="pn-sy-ring" cx={WX} cy={WY} r={R_IN} />
            {model.a.map((p) => {
              const pt = ptOf(p.lon, R_OUT)
              const on = activePair?.aName === p.name
              return (
                <g key={`a-${p.name}`} className={`pn-sy-dot is-a${on ? ' is-on' : ''}`}>
                  <circle cx={pt.x} cy={pt.y} r={on ? 8.5 : 6.5} />
                  <text x={pt.x} y={pt.y} textAnchor="middle" dominantBaseline="middle">
                    {shortOf(p.name)}
                  </text>
                </g>
              )
            })}
            {model.b.map((p) => {
              const pt = ptOf(p.lon, R_IN)
              const on = activePair?.bName === p.name
              return (
                <g key={`b-${p.name}`} className={`pn-sy-dot is-b${on ? ' is-on' : ''}`}>
                  <circle cx={pt.x} cy={pt.y} r={on ? 8.5 : 6.5} />
                  <text x={pt.x} y={pt.y} textAnchor="middle" dominantBaseline="middle">
                    {shortOf(p.name)}
                  </text>
                </g>
              )
            })}
            {(() => {
              if (!activePair) return null
              const pa = model.a.find((p) => p.name === activePair.aName)
              const pb = model.b.find((p) => p.name === activePair.bName)
              if (!pa || !pb) return null
              const p1 = ptOf(pa.lon, R_OUT)
              const p2 = ptOf(pb.lon, R_IN)
              return <line className={`pn-sy-link ${ASP_CLASS[activePair.type] ?? ''}`} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} />
            })()}
          </svg>
        </div>
      <div className="pn-sy-matrix" role="group" aria-label="交角矩阵（A 行星 × B 行星）">
        <div className="pn-sy-grid" style={{ gridTemplateColumns: `28px repeat(${ASTRO_POINTS.length}, minmax(26px, 1fr))` }}>
          <span className="pn-sy-corner" aria-hidden>
            A×B
          </span>
          {ASTRO_POINTS.map((n) => (
            <span key={`h${n}`} className="pn-sy-colhead" title={`B ${n}`}>
              {shortOf(n)}
            </span>
          ))}
          {ASTRO_POINTS.map((aName) => (
            <React.Fragment key={`r${aName}`}>
              <span className="pn-sy-rowhead" title={`A ${aName}`}>
                {shortOf(aName)}
              </span>
              {ASTRO_POINTS.map((bName) => {
                const hit = cellOf.get(`${aName}|${bName}`)
                return (
                  <button
                    type="button"
                    key={`${aName}-${bName}`}
                    className={`pn-sy-cell${hit ? ` has-asp ${ASP_CLASS[hit.type] ?? ''}` : ''}${focus === hit && hit ? ' is-on' : ''}`}
                    onMouseEnter={() => setHover(hit ?? null)}
                    onMouseLeave={() => setHover(null)}
                    data-a={aName}
                    data-b={bName}
                    data-type={hit?.type ?? ''}
                    disabled={!hit}
                    title={hit ? `A${aName}-B${bName} ${hit.type} ${hit.orb.toFixed(1)}°` : `A${aName}-B${bName}（无主相位）`}
                    aria-pressed={focus === hit && hit !== undefined}
                    onClick={() => setFocus(focus === hit ? null : hit ?? null)}
                  >
                    {hit ? <span className="pn-sy-cellt">{hit.type.slice(0, 1)}</span> : ''}
                  </button>
                )
              })}
            </React.Fragment>
          ))}
        </div>
        <div className="pn-sy-legend">
          {ASP_TYPES.map((t) => (
            <span key={t} className="pn-sy-legitem">
              <span className={`pn-sy-legdot ${ASP_CLASS[t]}`} aria-hidden />
              {t}
            </span>
          ))}
        </div>
      </div>
      </div>

      {axisAspects.length > 0 ? (
        <div className="pn-sy-axes" role="group" aria-label="四轴相位">
          <div className="pn-ln-head">四轴相位（{axisAspects.length} 条）</div>
          <div className="pn-tw-asp-row">
            {axisAspects.map((a) => (
              <button
                type="button"
                key={`${a.a}${a.b}${a.type}${a.orb}`}
                className={`pn-tw-achip${focus === a ? ' is-on' : ''}`}
                aria-pressed={focus === a}
                onClick={() => setFocus(focus === a ? null : a)}
              >
                <span className="pn-tw-aname">
                  {a.a}-{a.b}
                </span>
                <span className="pn-tw-atype">{a.type}</span>
                <span className="pn-tw-aorb">{a.orb.toFixed(1)}°</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="pn-sy-list" role="group" aria-label="相位清单（orb 升序）">
        <div className="pn-ln-head">相位清单（orb ≤ 8° · {aspects.length} 条 · 对称去重）</div>
        <div className="pn-tw-asp-row">
          {aspects.map((a) => (
            <button
              type="button"
              key={`${a.a}-${a.b}-${a.type}-${a.orb}`}
              className={`pn-tw-achip${focus === a ? ' is-on' : ''}`}
              aria-pressed={focus === a}
              onClick={() => setFocus(focus === a ? null : a)}
            >
              <span className="pn-tw-aname">
                {a.a}-{a.b}
              </span>
              <span className="pn-tw-atype">{a.type}</span>
              <span className="pn-tw-aorb">{a.orb.toFixed(1)}°</span>
            </button>
          ))}
        </div>
      </div>

      <div className="pn-sy-meta">
        {elementText ? <span className="pn-sy-elem">{elementText}</span> : null}
        {model.composite.length > 0 ? (
          <button
            type="button"
            className="pn-act pn-sy-compbtn"
            aria-pressed={showComposite}
            onClick={() => setShowComposite((v) => !v)}
          >
            组合盘（中点）
          </button>
        ) : null}
      </div>
      {showComposite && model.composite.length > 0 ? (
        <div className="pn-pop pn-sy-composite" role="region" aria-label="组合盘中点盘">
          <div className="pn-pop-title">组合盘（行星中点；组合宫位 v1 不提供）</div>
          <div className="pn-sy-comprow">
            {model.composite.map((p) => (
              <span key={p.name} className="pn-sy-compitem">
                {p.name} {p.sign} {p.deg.toFixed(1)}°
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <div className="pn-foot">
        <AskBar items={askItems} />
        <Legend
          ariaLabel="合盘图例"
          items={['矩阵：A 行 × B 列（点格看相位）', '色 + 字双编码', '知情：仅基于双方出生数据的关系模式参考']}
        />
      </div>
    </div>
  )
}

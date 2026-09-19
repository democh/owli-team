/**
 * M63-B：行运 · 行运盘视图（§5.1 v1）——星座环 + 行运十星 + cross 相位清单 + 扫描时点 ribbon。
 *
 * 口径纪律：卡内无本命行星黄经（卡格式 B.1 决定）——内环不画（不推测数据）；
 * 基准 0° 白羊置左（本命 ASC 黄经不在卡内，不画轴标误导）；度数 / 相位 / 时点一律取自卡内派生。
 * cross 清单与环上行星双向联动（清单 → 高亮星点；星点 → 过滤其清单项）。
 */
import * as React from 'react'
import type { TransitModel } from './model'
import { AskBar, Legend } from './parts'

const CX = 160
const CY = 160
const R_OUT = 146
const R_ZOD = 128
const TIERS = [100, 90, 80] as const
/** M63 续完善（v2 双环）：内环（本命十星）三档（与外环同档位垂直对应） */
const TIERS_INNER = [58, 50, 42] as const

const SIGNS = ['白羊', '金牛', '双子', '巨蟹', '狮子', '处女', '天秤', '天蝎', '射手', '摩羯', '水瓶', '双鱼'] as const
const PLANET_SHORT: Record<string, string> = {
  太阳: '日', 月亮: '月', 水星: '水', 金星: '金', 火星: '火', 木星: '木', 土星: '土', 天王星: '天', 海王星: '海', 冥王星: '冥',
}
const shortOf = (name: string): string => PLANET_SHORT[name] ?? name.slice(0, 1)
const f = (n: number): number => Math.round(n * 100) / 100

/** θ(lon) = 180° + lon（0° 白羊置左、黄经增大逆时针） */
function ptOf(lon: number, r: number): { x: number; y: number } {
  const t = ((180 + lon) * Math.PI) / 180
  return { x: f(CX + r * Math.cos(t)), y: f(CY - r * Math.sin(t)) }
}

function ringSector(a: number, b: number, rOut: number, rIn: number): string {
  const o1 = ptOf(a, rOut)
  const o2 = ptOf(b, rOut)
  const i1 = ptOf(a, rIn)
  const i2 = ptOf(b, rIn)
  return `M ${o1.x} ${o1.y} A ${rOut} ${rOut} 0 0 0 ${o2.x} ${o2.y} L ${i2.x} ${i2.y} A ${rIn} ${rIn} 0 0 1 ${i1.x} ${i1.y} Z`
}

function minSpokePath(): string {
  return Array.from({ length: 12 }, (_, i) => {
    const lon = i * 30
    const p1 = ptOf(lon, R_ZOD)
    const p2 = ptOf(lon, R_ZOD - 8)
    return `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}`
  }).join(' ')
}

/** 'YYYY-MM-DD HH:mm' → 分钟数（ribbon 定位用；纯字符串解析不涉时区） */
function minutesOf(text: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(text)
  if (!m) return 0
  return Math.floor(new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00Z`).getTime() / 60000)
}

export function TransitWheel({ model, onAsk }: { model: TransitModel; onAsk?: (text: string) => void }): React.JSX.Element {
  const [selPlanet, setSelPlanet] = React.useState<string | null>(null)
  const [selAspect, setSelAspect] = React.useState<number | null>(null)
  const [selHit, setSelHit] = React.useState<number | null>(null)

  const aspects = model.aspects
  const aspect = selAspect !== null ? aspects[selAspect] ?? null : null
  const hit = selHit !== null && model.scan ? model.scan.hits[selHit] ?? null : null

  const tierOf = ((): Map<string, number> => {
    const map = new Map<string, number>()
    model.planets.forEach((p, i) => map.set(p.name, i % 3))
    return map
  })()

  const askItems: Array<{ text: string; onPick?: () => void }> = []
  if (aspect) {
    askItems.push({
      text: `请教相位 ${aspect.transitPlanet}-${aspect.natalPoint}`,
      onPick: () =>
        onAsk?.(
          `请解读行运相位「行运${aspect.transitPlanet}-本命${aspect.natalPoint} ${aspect.type} ${aspect.orb.toFixed(1)}°」的含义与自我安排参考（含依据）。`,
        ),
    })
  }
  if (hit) {
    askItems.push({
      text: `关注时点 ${hit.exact}`,
      onPick: () =>
        onAsk?.(
          `请解读行运相位「行运${hit.transitPlanet}-本命${hit.natalPoint} ${hit.type}」的精确时点 ${hit.exact}（窗口 ±${hit.windowDays} 天）的含义与自我安排参考。`,
        ),
    })
  } else if (model.scan) {
    askItems.push({
      text: '请教扫描重点',
      onPick: () => onAsk?.('请按时间顺序解读本次行运扫描的各关键时点（参考区间）与依据。'),
    })
  }

  // 扫描 ribbon：时间范围 → 百分比
  let ribbon: React.JSX.Element | null = null
  if (model.scan) {
    const fromMin = minutesOf(`${model.scan.from} 00:00`)
    const toMin = minutesOf(`${model.scan.to} 00:00`)
    const span = Math.max(1, toMin - fromMin)
    ribbon = (
      <div className="pn-tw-ribbon" role="group" aria-label="扫描时点">
        <div className="pn-tw-ribbon-head">
          扫描 {model.scan.from} ~ {model.scan.to}（{model.scan.hits.length} 时点 · 参考区间）
        </div>
        <div className="pn-tw-track">
          {model.scan.hits.map((h, i) => (
            <button
              type="button"
              key={`${h.transitPlanet}${h.natalPoint}${h.type}${h.exact}`}
              className={`pn-tw-node${selHit === i ? ' is-on' : ''}`}
              style={{ left: `${Math.min(100, Math.max(0, ((minutesOf(h.exact) - fromMin) / span) * 100))}%` }}
              title={`${h.transitPlanet}-${h.natalPoint} ${h.type} · ${h.exact}`}
              aria-pressed={selHit === i}
              onClick={() => setSelHit(selHit === i ? null : i)}
            />
          ))}
        </div>
        {hit ? (
          <div className="pn-tw-hit" role="status">
            {hit.transitPlanet}-{hit.natalPoint} · {hit.type} ｜ 精确 {hit.exact} ｜ 影响窗 ±{hit.windowDays} 天
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div className="pn-board pn-transit">
      <div className="pn-tw-top">
        <div className="pn-tw-wheel">
          <svg viewBox="0 0 320 320" role="img" aria-label="行运星环（星座环 + 行运十星；0° 白羊置左）">
            {/* 星座环扇区（交错底纹按元素分色） */}
            {SIGNS.map((sign, i) => (
              <path key={sign} className={`pn-tw-zod pn-tw-z${i % 4}`} d={ringSector(i * 30, (i + 1) * 30, R_OUT, R_ZOD)} />
            ))}
            <path className="pn-tw-spokes" d={minSpokePath()} />
            <circle className="pn-tw-ring" cx={CX} cy={CY} r={R_ZOD} />
            {/* 星座名 */}
            {SIGNS.map((sign, i) => {
              const p = ptOf(i * 30 + 15, (R_OUT + R_ZOD) / 2)
              return (
                <text key={`t${sign}`} className="pn-tw-zlabel" x={p.x} y={p.y} textAnchor="middle" dominantBaseline="middle">
                  {sign}
                </text>
              )
            })}
            {/* 行运十星 */}
            {model.planets.map((p) => {
              const r = TIERS[tierOf.get(p.name) ?? 0]!
              const pos = ptOf(p.lon, r)
              const on = selPlanet === p.name || (aspect !== null && aspect.transitPlanet === p.name) || (hit !== null && hit.transitPlanet === p.name)
              return (
                <g key={p.name}>
                  <circle className={`pn-tw-dot${on ? ' is-on' : ''}${p.retro ? ' is-retro' : ''}`} cx={pos.x} cy={pos.y} r={9} />
                  <text className={`pn-tw-plabel${on ? ' is-on' : ''}`} x={pos.x} y={pos.y} textAnchor="middle" dominantBaseline="middle">
                    {shortOf(p.name)}
                  </text>
                  {p.retro ? (
                    <text className="pn-tw-retro" x={pos.x} y={pos.y + 17} textAnchor="middle">
                      R
                    </text>
                  ) : null}
                </g>
              )
            })}
            {/* M63 续完善（v2 双环）：本命十星内环（旧卡无「本命」行 → 不渲染，单环零回归） */}
            {model.natalPlanets
              ? model.natalPlanets.map((p) => {
                  const r = TIERS_INNER[tierOf.get(p.name) ?? 0]!
                  const pos = ptOf(p.lon, r)
                  const on = aspect !== null && aspect.natalPoint === p.name
                  return (
                    <g key={`n-${p.name}`}>
                      <circle className={`pn-tw-ndot${on ? ' is-on' : ''}`} cx={pos.x} cy={pos.y} r={7} />
                      <text className={`pn-tw-nlabel${on ? ' is-on' : ''}`} x={pos.x} y={pos.y} textAnchor="middle" dominantBaseline="middle">
                        {shortOf(p.name)}
                      </text>
                    </g>
                  )
                })
              : null}
            {/* 连线（选中 cross → 外环行运点 ↔ 内环本命点；轴相位不入环） */}
            {(() => {
              if (!aspect || !model.natalPlanets) return null
              const tp = model.planets.find((p) => p.name === aspect.transitPlanet)
              const np = model.natalPlanets.find((p) => p.name === aspect.natalPoint)
              if (!tp || !np) return null
              const p1 = ptOf(tp.lon, TIERS[tierOf.get(tp.name) ?? 0]!)
              const p2 = ptOf(np.lon, TIERS_INNER[tierOf.get(np.name) ?? 0]!)
              return <line className="pn-tw-link" x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} />
            })()}
            <text className="pn-tw-center" x={CX} y={CY - 6} textAnchor="middle">
              行运
            </text>
            <text className="pn-tw-center2" x={CX} y={CY + 12} textAnchor="middle">
              0° 白羊置左
            </text>
          </svg>
        </div>

        <div className="pn-tw-side">
          <div className="pn-tw-planets" role="group" aria-label="行运十星">
            {model.planets.map((p) => (
              <button
                type="button"
                key={p.name}
                className={`pn-tw-pchip${selPlanet === p.name ? ' is-on' : ''}`}
                aria-pressed={selPlanet === p.name}
                onClick={() => setSelPlanet(selPlanet === p.name ? null : p.name)}
              >
                <span className="pn-tw-pname">{p.name}</span>
                <span className="pn-tw-pdeg">
                  {p.sign} {p.deg.toFixed(1)}°
                </span>
                {p.house !== undefined ? <span className="pn-tw-phouse">{p.house} 宫</span> : null}
                {p.retro ? <span className="pn-tw-pretro">逆</span> : null}
              </button>
            ))}
          </div>
        </div>
      </div>

      {aspects.length > 0 ? (
        <div className="pn-tw-asp" role="group" aria-label="行运 cross 相位（按 orb 升序）">
          <div className="pn-ln-head">行运相位（cross，orb ≤ 6° · {aspects.length} 条）</div>
          <div className="pn-tw-asp-row">
            {aspects.map((a, i) => {
              const dim = selPlanet !== null && a.transitPlanet !== selPlanet
              return (
                <button
                  type="button"
                  key={`${a.transitPlanet}${a.natalPoint}${a.type}${a.orb}`}
                  className={`pn-tw-achip${selAspect === i ? ' is-on' : ''}${dim ? ' is-dim' : ''}`}
                  aria-pressed={selAspect === i}
                  onClick={() => setSelAspect(selAspect === i ? null : i)}
                >
                  <span className="pn-tw-aname">
                    {a.transitPlanet}-{a.natalPoint}
                  </span>
                  <span className="pn-tw-atype">{a.type}</span>
                  <span className="pn-tw-aorb">{a.orb.toFixed(1)}°</span>
                </button>
              )
            })}
          </div>
        </div>
      ) : null}

      {ribbon}

      <div className="pn-foot">
        <AskBar items={askItems} />
        <Legend
          ariaLabel="行运图例"
          items={[
            '环 = 行运十星（0° 白羊置左）',
            'R = 逆行',
            '相位于卡内直读（上表）',
            ...(model.natalPlanets ? ['内环 = 本命十星（与外环同档位垂直对应）'] : []),
            ...(model.scan ? ['ribbon = 扫描时点（参考区间）'] : []),
          ]}
        />
      </div>
    </div>
  )
}

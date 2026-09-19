/**
 * M63-E：七政四余 · 宫位视图（§5.7）——十二宫圆盘（宫名 / 宫支 / 宫主）+ 政余表 + 庙旺。
 *
 * 口径纪律：七政四余 / 十二宫 / 命宫一律取自卡内派生（deriveQizheng），不重算、不预测；
 * 四余近似等级如实呈现（近似角标不隐藏）；v1 不列二十八宿度（卡面口径声明）。
 * 方位：午上子下（与六壬天地盘同盘式）。
 */
import * as React from 'react'
import type { QizhengModel } from './model'
import { AskBar, Legend } from './parts'

const CX = 150
const CY = 150
const R_GONG = 132
const R_BRANCH = 96
const R_LORD = 62

const ZHI = '子丑寅卯辰巳午未申酉戌亥'
const f = (n: number): number => Math.round(n * 100) / 100

function ptOf(zhi: string, r: number): { x: number; y: number } {
  const idx = ZHI.indexOf(zhi)
  const deg = (idx - 6) * 30
  const rad = (deg * Math.PI) / 180
  return { x: f(CX + r * Math.sin(rad)), y: f(CY - r * Math.cos(rad)) }
}

export function QizhengBoard({ model, onAsk }: { model: QizhengModel; onAsk?: (text: string) => void }): React.JSX.Element {
  const [selGong, setSelGong] = React.useState<string | null>(null)
  const [selBody, setSelBody] = React.useState<string | null>(null)

  const palaceOf = new Map(model.palaces.map((p) => [p.gong, p]))
  const bodyOf = new Map(model.bodies.map((b) => [b.name, b]))
  const selPalace = selGong ? palaceOf.get(selGong) ?? null : null
  const selBodyRow = selBody ? bodyOf.get(selBody) ?? null : null
  const detailVal = (label: string): string => model.detail.find((d) => d.label === label)?.value ?? ''

  const askItems: Array<{ text: string; onPick?: () => void }> = []
  if (selPalace) {
    askItems.push({
      text: `请教${selPalace.name}`,
      onPick: () =>
        onAsk?.(
          `请解读${selPalace.name}宫（${selPalace.gong}宫·${selPalace.sign}·宫主 ${selPalace.lord}${selPalace.bodies.length > 0 ? `·落 ${selPalace.bodies.join('、')}` : ''}）的含义与依据（参考区间）。`,
        ),
    })
  }
  if (selBodyRow) {
    askItems.push({
      text: `请教${selBodyRow.name}`,
      onPick: () =>
        onAsk?.(
          `请解读${selBodyRow.name}（${selBodyRow.gong}宫 ${selBodyRow.deg.toFixed(1)}°${selBodyRow.retro ? '·逆行' : ''}${selBodyRow.note ? `·${selBodyRow.note}` : ''}）的落宫含义与依据。`,
        ),
    })
  }
  if (askItems.length === 0) {
    askItems.push({
      text: '请教此盘',
      onPick: () => onAsk?.('请按七政四余结构解读此盘（命宫 / 十二宫 / 星曜落宫；四余为近似口径）——给参考区间与依据。'),
    })
  }

  return (
    <div className="pn-board pn-qizheng">
      <div className="pn-qz-top">
        <div className="pn-qz-wheel">
          <svg viewBox="0 0 300 300" role="img" aria-label="十二宫圆盘（午上子下；外圈宫名、中圈宫支、内圈宫主）">
            <circle className="pn-qz-ring" cx={CX} cy={CY} r={R_GONG} />
            <circle className="pn-qz-ring" cx={CX} cy={CY} r={R_BRANCH - 20} />
            <circle className="pn-qz-ring-in" cx={CX} cy={CY} r={R_LORD - 16} />
            {model.palaces.map((p) => {
              const pName = ptOf(p.gong, R_GONG - 14)
              const pBranch = ptOf(p.gong, R_BRANCH - 12)
              const pLord = ptOf(p.gong, R_LORD - 10)
              const on = selGong === p.gong
              const has = p.bodies.length > 0
              return (
                <g key={p.gong} className={`pn-qz-cell${on ? ' is-on' : ''}${has ? ' has-bodies' : ''}`} onClick={() => setSelGong(on ? null : p.gong)}>
                  <text className="pn-qz-name" x={pName.x} y={pName.y} textAnchor="middle" dominantBaseline="middle">
                    {p.name}
                  </text>
                  <text className="pn-qz-branch" x={pBranch.x} y={pBranch.y} textAnchor="middle" dominantBaseline="middle">
                    {p.gong}
                  </text>
                  <text className="pn-qz-lord" x={pLord.x} y={pLord.y} textAnchor="middle" dominantBaseline="middle">
                    {p.lord.slice(0, 2)}
                  </text>
                </g>
              )
            })}
            <text className="pn-qz-center" x={CX} y={CY - 6} textAnchor="middle">
              命宫 {model.palaces[0]?.gong ?? ''}
            </text>
            <text className="pn-qz-center2" x={CX} y={CY + 12} textAnchor="middle">
              七政四余
            </text>
          </svg>
          {selPalace ? (
            <div className="pn-qz-selinfo" role="status">
              {selPalace.name} {selPalace.gong}宫（{selPalace.sign}）· 宫主 {selPalace.lord}
              {selPalace.bodies.length > 0 ? ` · 落 ${selPalace.bodies.join(' ')}` : ''}
            </div>
          ) : null}
        </div>

        <div className="pn-qz-side">
          <div className="pn-qz-bodies" role="group" aria-label="七政四余">
            {model.bodies.map((b) => (
              <button
                type="button"
                key={b.name}
                className={`pn-qz-bchip${selBody === b.name ? ' is-on' : ''}${b.note ? ' is-approx' : ''}`}
                aria-pressed={selBody === b.name}
                title={b.note ?? undefined}
                onClick={() => setSelBody(selBody === b.name ? null : b.name)}
              >
                <span className="pn-qz-bname">{b.name}</span>
                <span className="pn-qz-bpos">
                  {b.gong}宫 {b.deg.toFixed(1)}°
                </span>
                {b.retro ? <span className="pn-qz-bretro">逆</span> : null}
                {b.note ? (
                  <span className="pn-qz-bapprox" aria-hidden>
                    近
                  </span>
                ) : null}
              </button>
            ))}
          </div>
          <div className="pn-qz-meta">
            <span>{detailVal('出生')}</span>
            {model.miaoWangText ? <span className="pn-qz-miao">{model.miaoWangText}</span> : null}
          </div>
        </div>
      </div>

      <div className="pn-foot">
        <AskBar items={askItems} />
        <Legend
          ariaLabel="七政四余图例"
          items={['外圈宫名 · 中圈宫支 · 内圈宫主', '近 = 四余近似口径（悬停看等级）', 'v1 不列二十八宿度', '命宫：太阳过宫·生时推移']}
        />
      </div>
    </div>
  )
}

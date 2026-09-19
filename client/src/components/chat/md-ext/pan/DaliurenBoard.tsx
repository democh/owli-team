/**
 * M63-C：大六壬 · 天地盘与课传视图（§5.5）——天地盘圆盘（地盘 / 天盘 / 天将三层）+ 四课板书 + 三传。
 *
 * 口径纪律：天地盘 / 四课 / 三传 / 天将一律取自卡内派生（deriveDaliuren），不重算、不预测；
 * 方位：午上子下（传统天盘式）；月将加时关系由「地盘宫 → 其上所临天盘神」直接呈现。
 */
import * as React from 'react'
import type { DaliurenModel } from './model'
import { AskBar, Legend } from './parts'

const CX = 150
const CY = 150
const R_DI = 136
const R_TIAN = 96
const R_JIANG = 58

const ZHI = '子丑寅卯辰巳午未申酉戌亥'
const f = (n: number): number => Math.round(n * 100) / 100

/** 传统方位：午上子下（顶=午），顺时针 */
function ptOf(zhi: string, r: number): { x: number; y: number } {
  const idx = ZHI.indexOf(zhi)
  const deg = (idx - 6) * 30
  const rad = (deg * Math.PI) / 180
  return { x: f(CX + r * Math.sin(rad)), y: f(CY - r * Math.cos(rad)) }
}

export function DaliurenBoard({ model, onAsk }: { model: DaliurenModel; onAsk?: (text: string) => void }): React.JSX.Element {
  const [selDi, setSelDi] = React.useState<string | null>(null)
  const [selKe, setSelKe] = React.useState<number | null>(null)
  const [selChuan, setSelChuan] = React.useState<number | null>(null)
  const [showJiang, setShowJiang] = React.useState(true)

  const tianOfDi = new Map(model.pan.map((x) => [x.di, x.tian]))
  const detailVal = (label: string): string => model.detail.find((d) => d.label === label)?.value ?? ''
  const guiRen = detailVal('贵人')

  const selInfo = selDi
    ? `地盘 ${selDi} 上临 天盘 ${tianOfDi.get(selDi) ?? ''}${showJiang ? `（乘 ${model.jiangOf[tianOfDi.get(selDi) ?? ''] ?? ''}）` : ''}`
    : ''

  const chuan = selChuan !== null ? model.chuan[selChuan] ?? null : null
  const keRow = selKe !== null ? model.ke[selKe] ?? null : null

  const askItems: Array<{ text: string; onPick?: () => void }> = []
  if (chuan) {
    askItems.push({
      text: `请教${chuan.name}`,
      onPick: () =>
        onAsk?.(
          `请解读${chuan.name}（${chuan.zhi}·遁干 ${chuan.dunGan ?? '—'}·天将 ${chuan.jiang}${chuan.kong ? '·旬空' : ''}）的课传含义与依据。`,
        ),
    })
  }
  if (keRow) {
    askItems.push({
      text: `请教${keRow.label}`,
      onPick: () => onAsk?.(`请解读${keRow.label}（上 ${keRow.upper} / 下 ${keRow.lower}）在四课中的关系与依据。`),
    })
  }
  if (askItems.length === 0) {
    askItems.push({
      text: '请教此课',
      onPick: () =>
        onAsk?.(
          `请按四课与三传结构解读此课（${model.keti ?? ''}）：${model.chuan.map((c) => `${c.name}${c.zhi}`).join('、')} 的课题与依据（参考区间）。`,
        ),
    })
  }

  return (
    <div className="pn-board pn-daliuren">
      <div className="pn-dl-top">
        <div className="pn-dl-pan">
          <svg viewBox="0 0 300 300" role="img" aria-label="天地盘（午上子下；外圈地盘、中圈天盘、内圈天将）">
            <circle className="pn-dl-ring" cx={CX} cy={CY} r={R_DI} />
            <circle className="pn-dl-ring" cx={CX} cy={CY} r={R_TIAN - 22} />
            <circle className="pn-dl-ring-in" cx={CX} cy={CY} r={R_JIANG - 20} />
            {model.pan.map(({ di, tian }) => {
              const pDi = ptOf(di, R_DI - 12)
              const pTianT = ptOf(di, R_TIAN - 12)
              const pJiang = ptOf(di, R_JIANG - 12)
              const deg = (ZHI.indexOf(di) - 6) * 30
              const rad = (deg * Math.PI) / 180
              const l1 = { x: f(CX + (R_TIAN - 10) * Math.sin(rad)), y: f(CY - (R_TIAN - 10) * Math.cos(rad)) }
              const l2 = { x: f(CX + (R_JIANG - 8) * Math.sin(rad)), y: f(CY - (R_JIANG - 8) * Math.cos(rad)) }
              const on = selDi === di
              return (
                <g key={di} className={`pn-dl-cell${on ? ' is-on' : ''}`} onClick={() => setSelDi(on ? null : di)}>
                  <line className="pn-dl-spoke" x1={l1.x} y1={l1.y} x2={l2.x} y2={l2.y} />
                  <text className="pn-dl-di" x={pDi.x} y={pDi.y} textAnchor="middle" dominantBaseline="middle">
                    {di}
                  </text>
                  <text className="pn-dl-tian" x={pTianT.x} y={pTianT.y} textAnchor="middle" dominantBaseline="middle">
                    {tian}
                  </text>
                  {showJiang ? (
                    <text className="pn-dl-jiang" x={pJiang.x} y={pJiang.y} textAnchor="middle" dominantBaseline="middle">
                      {(model.jiangOf[tian] ?? '').slice(0, 2)}
                    </text>
                  ) : null}
                </g>
              )
            })}
            <text className="pn-dl-center" x={CX} y={CY - 8} textAnchor="middle">
              {model.keti ?? '课'}
            </text>
            <text className="pn-dl-center2" x={CX} y={CY + 10} textAnchor="middle">
              {model.jiangText ?? ''}
            </text>
          </svg>
          {selInfo ? (
            <div className="pn-dl-selinfo" role="status">
              {selInfo}
            </div>
          ) : null}
        </div>

        <div className="pn-dl-side">
          <div className="pn-ke-board" role="group" aria-label="四课（右起：一课在最右）">
            {[model.ke[3]!, model.ke[2]!, model.ke[1]!, model.ke[0]!].map((k) => (
              <button
                type="button"
                key={k.idx}
                className={`pn-ke-col${selKe === k.idx - 1 ? ' is-on' : ''}`}
                aria-pressed={selKe === k.idx - 1}
                onClick={() => setSelKe(selKe === k.idx - 1 ? null : k.idx - 1)}
              >
                <span className="pn-ke-name">{k.label}</span>
                <span className="pn-ke-upper">{k.upper}</span>
                <span className="pn-ke-lower">{k.lower}</span>
              </button>
            ))}
          </div>
          <div className="pn-chuan-col" role="group" aria-label="三传">
            {model.chuan.map((c, i) => (
              <button
                type="button"
                key={c.name}
                className={`pn-chuan-card${selChuan === i ? ' is-on' : ''}${c.kong ? ' is-kong' : ''}`}
                aria-pressed={selChuan === i}
                onClick={() => setSelChuan(selChuan === i ? null : i)}
              >
                <span className="pn-chuan-name">{c.name}</span>
                <span className="pn-chuan-zhi">{c.zhi}</span>
                <span className="pn-chuan-meta">
                  遁{c.dunGan ?? '—'} · {c.jiang}
                  {c.kong ? ' · 旬空' : ''}
                </span>
              </button>
            ))}
          </div>
          <div className="pn-dl-meta">
            <span>{detailVal('起课')}</span>
            <span>{guiRen}</span>
          </div>
          <button type="button" className="pn-act pn-dl-jiangbtn" aria-pressed={showJiang} onClick={() => setShowJiang((v) => !v)}>
            天将层
          </button>
        </div>
      </div>

      <div className="pn-foot">
        <AskBar items={askItems} />
        <Legend
          ariaLabel="大六壬图例"
          items={[
            '外圈地盘 · 中圈天盘（其上所临之神）· 内圈天将',
            '方位：午上子下',
            model.keti ? `课体：${model.keti}` : '课体见卡',
            '旬空 = 虚线框',
          ]}
        />
      </div>
    </div>
  )
}

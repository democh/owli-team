/**
 * M54-A t4：八字 · 人生时间轴（§4.2）——四柱 / 五行能量 / 大运轨道 / 流年条 / 时间轴。
 *
 * 口径纪律：五行能量条直接显示卡内计数，不重算、不引入藏干加权（同一张盘永远同一个数）；
 * 流年仅随当前大运计算（非当前大运 → 空态 + 补算草稿，绝不虚构行运数据）。
 */
import * as React from 'react'
import type { BaziModel } from './model'
import { AskBar, HeatBar, Legend, segments } from './parts'

const WX_KEYS = ['木', '火', '土', '金', '水'] as const
type WxKey = (typeof WX_KEYS)[number]

/** 干支 → 五行（仅用于「点五行 → 高亮含该五行的柱」的标注，不参与任何统计） */
const GAN_WX: Record<string, WxKey> = { 甲: '木', 乙: '木', 丙: '火', 丁: '火', 戊: '土', 己: '土', 庚: '金', 辛: '金', 壬: '水', 癸: '水' }
const ZHI_WX: Record<string, WxKey> = { 寅: '木', 卯: '木', 巳: '火', 午: '火', 辰: '土', 戌: '土', 丑: '土', 未: '土', 申: '金', 酉: '金', 亥: '水', 子: '水' }

const PILLAR_LABEL = ['年柱', '月柱', '日柱', '时柱'] as const

export function BaziBoard({ model, onAsk }: { model: BaziModel; onAsk?: (text: string) => void }): React.JSX.Element {
  const detailVal = (label: string): string => model.detail.find((d) => d.label === label)?.value ?? ''
  const cangGan = detailVal('藏干').split(/\s+/u).filter(Boolean)
  const naYin = segments(detailVal('纳音'))
  const kongWang = detailVal('空亡').split(/\s+/u).filter(Boolean).map((t) => t.replace(/^[年月日时]/u, ''))
  const diShi = detailVal('地势').split(/\s+/u).filter(Boolean).map((t) => t.replace(/^[年月日时]/u, ''))

  const currentDy = Math.max(0, model.daYun.findIndex((d) => d.current))
  const [pillar, setPillar] = React.useState<number | null>(null)
  const [hoverPillar, setHoverPillar] = React.useState<number | null>(null)
  const [dy, setDy] = React.useState(currentDy)
  const [year, setYear] = React.useState<number | null>(null)
  const [wx, setWx] = React.useState<WxKey | null>(null)

  const dyItem = model.daYun[dy]!
  const isCurrentDy = dy === currentDy
  const maxWx = Math.max(...WX_KEYS.map((k) => model.wuxing[k]), 1)

  // 时间轴：起点 = 出生年（命造公历），终点 = 末步大运结束年
  const birthYear = (() => {
    for (const d of model.detail) {
      const m = /(\d{4})-\d{2}-\d{2}/u.exec(d.value)
      if (m) return Number(m[1])
    }
    return null
  })()
  const axisStart = birthYear ?? model.daYun[0]!.years[0]
  const axisEnd = model.daYun[model.daYun.length - 1]!.years[1]
  const today = new Date().getFullYear()
  const pct = (y: number): number => {
    const span = Math.max(1, axisEnd - axisStart)
    return Math.min(100, Math.max(0, ((y - axisStart) / span) * 100))
  }
  const winLeft = pct(dyItem.years[0])
  const winWidth = Math.max(3, pct(dyItem.years[1] + 1) - winLeft)
  const selectedYear = year !== null ? model.liuNian.find((v) => v.year === year) ?? null : null

  const onRailKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      setDy((v) => Math.max(0, v - 1))
      setYear(null)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      setDy((v) => Math.min(model.daYun.length - 1, v + 1))
      setYear(null)
    }
  }

  const askPillar = pillar !== null ? model.pillars[pillar]! : null
  const askItems: Array<{ text: string; onPick?: () => void }> = []
  if (askPillar && pillar !== null) {
    askItems.push({
      text: `请教${PILLAR_LABEL[pillar]}`,
      onPick: () =>
        onAsk?.(`请解读此柱（${PILLAR_LABEL[pillar]} ${askPillar.gan}${askPillar.zhi}）在四柱中的十神与藏干背景，及参考区间。`),
    })
  }
  askItems.push({
    text: `请教大运 ${dyItem.ganZhi}`,
    onPick: () =>
      onAsk?.(
        `请重点解读${dyItem.ganZhi}大运（${dyItem.ages[0]}-${dyItem.ages[1]} 岁，${dyItem.years[0]}-${dyItem.years[1]}）的五行十神背景与课题。`,
      ),
  })
  if (selectedYear) {
    askItems.push({
      text: `请教流年 ${selectedYear.year}`,
      onPick: () =>
        onAsk?.(
          `请解读流年 ${selectedYear.year} ${selectedYear.ganZhi}（${selectedYear.age} 岁，${model.daYun[currentDy]!.ganZhi} 大运中）的参考区间与依据。`,
        ),
    })
  }

  const pillarHit = (i: number): boolean => wx !== null && (GAN_WX[model.pillars[i]!.gan] === wx || ZHI_WX[model.pillars[i]!.zhi] === wx)

  return (
    <div className="pn-board pn-bazi">
      <div className="pn-bazi-top">
        <div className="pn-pillars" role="group" aria-label="四柱">
          {model.pillars.map((p, i) => (
            <button
              type="button"
              key={p.name}
              className={`pn-pillar${pillar === i ? ' is-on' : ''}${pillarHit(i) ? ' is-hit' : ''}`}
              aria-pressed={pillar === i}
              onClick={() => setPillar(pillar === i ? null : i)}
              onMouseEnter={() => setHoverPillar(i)}
              onMouseLeave={() => setHoverPillar(null)}
              onFocus={() => setHoverPillar(i)}
              onBlur={() => setHoverPillar(null)}
            >
              <span className="pn-pillar-gz">
                <span className="pn-pillar-gan">{p.gan}</span>
                <span className="pn-pillar-zhi">{p.zhi}</span>
              </span>
              {p.shiShen ? <span className="pn-pillar-shi">{p.shiShen}</span> : null}
              <span className="pn-pillar-name">{PILLAR_LABEL[i]}</span>
            </button>
          ))}
        </div>
        <div className="pn-wx" role="group" aria-label="五行能量">
          {WX_KEYS.map((k) => {
            const hp = hoverPillar !== null ? model.pillars[hoverPillar]! : null
            const hot = hp !== null && (GAN_WX[hp.gan] === k || ZHI_WX[hp.zhi] === k)
            return (
              <button
                type="button"
                key={k}
                className={`pn-wx-row${wx === k ? ' is-on' : ''}${hot ? ' is-hot' : ''}`}
                aria-pressed={wx === k}
                onClick={() => setWx(wx === k ? null : k)}
              >
                <HeatBar label={k} value={model.wuxing[k]} max={maxWx} />
              </button>
            )
          })}
          {model.dayMaster ? (
            <div className="pn-dm">
              日主 {model.dayMaster.gan} · {model.dayMaster.yinYang}
            </div>
          ) : null}
        </div>
      </div>

      {pillar !== null ? (
        <div className="pn-detail" role="region" aria-label={`${PILLAR_LABEL[pillar]}详情`}>
          <span className="pn-detail-strong">
            {PILLAR_LABEL[pillar]} {model.pillars[pillar]!.gan}
            {model.pillars[pillar]!.zhi}
          </span>
          <span>十神 {model.pillars[pillar]!.shiShen ?? '—'}</span>
          <span>藏干 {cangGan[pillar] ?? '—'}</span>
          <span>纳音 {naYin[pillar] ?? '—'}</span>
          <span>空亡 {kongWang[pillar] ?? '—'}</span>
          <span>地势 {diShi[pillar] ?? '—'}</span>
        </div>
      ) : null}

      <div className="pn-dy-rail" role="group" aria-label="大运轨道（← → 切换）" onKeyDown={onRailKey}>
        {model.daYun.map((d, i) => (
          <button
            type="button"
            key={d.ganZhi}
            data-idx={i}
            className={`pn-dyseg${i === dy ? ' is-on' : ''}${d.current ? ' is-current' : ''}`}
            aria-pressed={i === dy}
            onClick={() => {
              setDy(i)
              setYear(null)
            }}
          >
            <span className="pn-dy-gz">{d.ganZhi}</span>
            <span className="pn-dy-age">
              {d.ages[0]}-{d.ages[1]}
            </span>
          </button>
        ))}
        {!isCurrentDy ? (
          <button
            type="button"
            className="pn-dy-back"
            onClick={() => {
              setDy(currentDy)
              setYear(null)
            }}
          >
            回当前
          </button>
        ) : null}
      </div>

      {isCurrentDy ? (
        <div className="pn-ln" role="group" aria-label="流年">
          <div className="pn-ln-head">
            流年（{dyItem.ganZhi} 大运内 · {model.liuNian.length} 条）
          </div>
          <div className="pn-ln-row">
            {model.liuNian.map((v) => (
              <button
                type="button"
                key={v.year}
                className={`pn-lnchip${year === v.year ? ' is-on' : ''}${v.current ? ' is-current' : ''}`}
                aria-pressed={year === v.year}
                onClick={() => setYear(year === v.year ? null : v.year)}
              >
                {v.year} {v.ganZhi}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="pn-ln-empty">
          <span>该步流年未随盘计算</span>
          <button
            type="button"
            className="pn-ask-btn"
            onClick={() =>
              onAsk?.(
                `请补算${dyItem.ganZhi}大运（${dyItem.ages[0]}-${dyItem.ages[1]} 岁）内的十个流年（干支与岁数），并标注当前流年。`,
              )
            }
          >
            请研习师补算该步流年
          </button>
        </div>
      )}

      <div className="pn-axis">
        <div className="pn-axis-track">
          <div className="pn-axis-win" style={{ left: `${winLeft}%`, width: `${winWidth}%` }} />
          {today >= axisStart && today <= axisEnd ? <div className="pn-axis-now" style={{ left: `${pct(today)}%` }} /> : null}
        </div>
        <div className="pn-axis-labels">
          <span>{axisStart}</span>
          <span>
            {dyItem.years[0]}-{dyItem.years[1]}
          </span>
          <span>{axisEnd}</span>
        </div>
      </div>

      <div className="pn-foot">
        <AskBar items={askItems} />
        <Legend
          ariaLabel="八字图例"
          items={[
            '▮ 五行计数（卡内原值）',
            <>
              <span className="pn-dot-on" /> 当前大运
            </>,
          ]}
        />
      </div>
    </div>
  )
}

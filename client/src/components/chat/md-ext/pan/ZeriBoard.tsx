/**
 * M66 续完善：择日盘 · 候选日表（§10 续完善）——推荐高亮 / 星级 / 冲煞 / 点击行回填草稿。
 * 口径：日期 / 建除 / 评分 / 冲煞一律取自卡内派生（deriveZeri），不重算、不预测；
 * 合规：星级为传统宜忌参考（金色高亮不等于吉凶断言）；行点击 → 回填深入询问。
 */
import * as React from 'react'
import type { ZeriCardDay, ZeriModel } from './model'
import { AskBar, Legend } from './parts'

const starOf = (score: number): string => '★'.repeat(Math.max(0, Math.min(5, score))) + '☆'.repeat(Math.max(0, 5 - score))

export function ZeriBoard({ model, onAsk }: { model: ZeriModel; onAsk?: (t: string) => void }): React.JSX.Element {
  const recommended = React.useMemo(() => new Set(model.recommended), [model.recommended])

  const askDay = (d: ZeriCardDay): void =>
    onAsk?.(`@司南 关于 ${d.date}（${d.ganzhi} · ${d.jianchu}日，${d.score}/5，${d.chongSha}）想进一步了解：<补述问题>；`)

  const askItems = React.useMemo(() => {
    const items: Array<{ text: string; onPick?: () => void }> = []
    if (!onAsk) return items
    const first = model.days.find((d) => recommended.has(d.date))
    if (first) {
      items.push({ text: `推荐日细节（${first.date}）`, onPick: () => askDay(first) })
    }
    items.push({
      text: '放宽区间再排',
      onPick: () =>
        onAsk(
          `@司南 请把择日区间放宽到「${model.to}」之后的两周再排一次（事项：${model.purpose}），列出评分前 3：`,
        ),
    })
    return items
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onAsk, model.days, model.recommended])

  return (
    <div className="pn-zeri" data-zeri>
      <div className="pn-zr-head">
        <span className="pn-zr-title">{model.purpose || '择日'}</span>
        {model.from ? (
          <span className="pn-zr-chip">
            {model.from} 至 {model.to}
          </span>
        ) : null}
        {model.caliber ? <span className="pn-zr-chip pn-zr-chip-dim">{model.caliber}</span> : null}
      </div>

      {model.recommended.length > 0 ? (
        <div className="pn-zr-rec" data-zr-rec>
          <span className="pn-zr-rec-label">推荐</span>
          {model.recommended.map((d) => (
            <span key={d} className="pn-zr-rec-item">
              {d}
            </span>
          ))}
        </div>
      ) : null}

      <ul className="pn-zr-days">
        {model.days.map((d) => (
          <li key={d.date} className={recommended.has(d.date) ? 'pn-zr-day pn-zr-day-rec' : 'pn-zr-day'}>
            <button type="button" className="pn-zr-day-btn" onClick={() => askDay(d)} data-zr-day={d.date}>
              <span className="pn-zr-date">
                {d.date} <span className="pn-zr-week">{d.weekday}</span>
              </span>
              <span className="pn-zr-meta">
                {d.ganzhi} · {d.jianchu}
              </span>
              <span
                className={d.score >= 4 ? 'pn-zr-star pn-zr-star-hi' : d.score <= 2 ? 'pn-zr-star pn-zr-star-lo' : 'pn-zr-star'}
                aria-label={`参考评分 ${d.score} / 5`}
              >
                {starOf(d.score)}
              </span>
              <span className="pn-zr-cs">{d.chongSha}</span>
              <span className="pn-zr-note">{d.note}</span>
            </button>
          </li>
        ))}
      </ul>

      {model.notes.length > 0 ? (
        <div className="pn-zr-notes">
          {model.notes.map((n, i) => (
            <div key={i} className="pn-zr-note-item">
              {n.label}：{n.value}
            </div>
          ))}
        </div>
      ) : null}

      <Legend
        items={[
          <span key="hi" className="pn-zr-lg-hi">
            评分 ≥ 4（传统参考）
          </span>,
          <span key="lo" className="pn-zr-lg-lo">
            评分 ≤ 2（传统慎用参考）
          </span>,
        ]}
        ariaLabel="择日图例"
      />
      <AskBar items={askItems} />
    </div>
  )
}

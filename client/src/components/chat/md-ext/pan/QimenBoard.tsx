/**
 * M63-D：奇门遁甲 · 九宫局盘（§5.6）——3×3 洛书格（五层堆叠：八神 / 九星 / 八门 / 天盘干 / 地盘干）。
 *
 * 口径纪律：九宫 / 八门 / 八神 / 值符值使一律取自卡内派生（deriveQimen），不重算不预测；
 * 宫格布局为洛书固定位（巽离坤 / 震中兑 / 艮坎乾）——禁止按条目序摆放；拆补口径随卡面声明。
 */
import * as React from 'react'
import type { QimenModel } from './model'
import { AskBar, Legend } from './parts'

/** 洛书布局（grid 渲染序） */
const LAYOUT = [4, 9, 2, 3, 5, 7, 8, 1, 6] as const

export function QimenBoard({ model, onAsk }: { model: QimenModel; onAsk?: (text: string) => void }): React.JSX.Element {
  const [sel, setSel] = React.useState<number | null>(null)

  const byNum = new Map(model.gongs.map((g) => [g.num, g]))
  const selGong = sel !== null ? byNum.get(sel) ?? null : null
  const zhiShiMen = model.zhiFuText ? /值使：(\S+)/.exec(model.zhiFuText)?.[1] : undefined
  const zhiFuStar = model.zhiFuText ? /^([^｜]+?) ｜/u.exec(model.zhiFuText)?.[1]?.trim() : undefined

  const askItems: Array<{ text: string; onPick?: () => void }> = []
  if (selGong) {
    askItems.push({
      text: `请教${selGong.name}${selGong.num}宫`,
      onPick: () =>
        onAsk?.(
          `请解读${selGong.name}${selGong.num}宫（${[selGong.shen, selGong.star, selGong.men].filter(Boolean).join('·') || '中宫'}；天盘 ${selGong.tianGan || '——'} / 地盘 ${selGong.diGan}${selGong.kong ? '·旬空' : ''}）的用神与方位时段参考（含拆补口径说明）。`,
        ),
    })
  }
  if (askItems.length === 0) {
    askItems.push({
      text: '请教此局',
      onPick: () => onAsk?.('请按九宫局盘结构解读此局（定局 / 值符值使 / 用神落宫与方位时段参考；拆补口径随盘）。'),
    })
  }

  return (
    <div className="pn-board pn-qimen">
      <div className="pn-qm-meta">
        {model.dingText ? <span className="pn-qm-ding">{model.dingText}</span> : null}
        {model.zhiFuText ? <span className="pn-qm-fu">{model.zhiFuText}</span> : null}
        {model.kongText ? <span className="pn-qm-kong">{model.kongText}</span> : null}
        {model.duiZhaoText ? <span className="pn-qm-kong">{model.duiZhaoText}</span> : null}
      </div>

      <div className="pn-qm-grid" role="grid" aria-label="九宫局盘（洛书布局：巽离坤 / 震中兑 / 艮坎乾）">
        {LAYOUT.map((num) => {
          const g = byNum.get(num)!
          const isZhiFu = g.shen === '值符'
          const isZhiShi = zhiShiMen !== undefined && g.men === zhiShiMen
          const on = sel === g.num
          return (
            <button
              type="button"
              key={g.num}
              className={`pn-qm-cell${on ? ' is-on' : ''}${g.kong ? ' is-kong' : ''}${num === 5 ? ' is-center' : ''}`}
              data-gong={num}
              aria-pressed={on}
              aria-label={`${g.name}${g.num}宫 ${g.star} ${g.men}${g.kong ? ' 旬空' : ''}`}
              onClick={() => setSel(on ? null : g.num)}
            >
              <span className="pn-qm-tags">
                {isZhiFu ? <span className="pn-qm-tag">值符</span> : null}
                {isZhiShi ? <span className="pn-qm-tag is-shi">值使</span> : null}
                {g.kong ? <span className="pn-qm-tag is-kong">空</span> : null}
              </span>
              <span className="pn-qm-shen">{g.shen || (num === 5 ? '——' : '')}</span>
              <span className="pn-qm-star">
                {g.star}
                {zhiFuStar && g.star.includes(zhiFuStar) && num !== 5 ? <em className="pn-qm-fustar">（值符）</em> : null}
              </span>
              <span className="pn-qm-men">{g.men || (num === 5 ? '——' : '')}</span>
              <span className="pn-qm-gan">
                {g.tianGan ? <b className="pn-qm-tiangan">{g.tianGan}</b> : <b className="pn-qm-tiangan is-none">——</b>}
                <em className="pn-qm-digan">/{g.diGan}</em>
              </span>
              <span className="pn-qm-name">
                {g.name}
                {g.num}
              </span>
            </button>
          )
        })}
      </div>

      {selGong ? (
        <div className="pn-qm-detail" role="status">
          <span className="pn-detail-strong">
            {selGong.name}
            {selGong.num}宫
          </span>
          <span>神 {selGong.shen || '——'}</span>
          <span>星 {selGong.star}</span>
          <span>门 {selGong.men || '——'}</span>
          <span>天盘 {selGong.tianGan || '——'}</span>
          <span>地盘 {selGong.diGan}</span>
          {selGong.kong ? <span>旬空</span> : null}
        </div>
      ) : null}

      <div className="pn-foot">
        <AskBar items={askItems} />
        <Legend
          ariaLabel="奇门图例"
          items={['洛书布局：巽离坤 / 震中兑 / 艮坎乾', '天盘干 / 地盘干', '值符 = 值符星宫 · 值使 = 值使门宫', '空 = 旬空（虚线）']}
        />
      </div>
    </div>
  )
}

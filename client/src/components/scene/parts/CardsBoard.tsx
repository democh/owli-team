/**
 * M78 修订：牌面改用真实卡片效果（TarotCardFace：公版韦特位图 + 正逆位倒置 + 牌位标）——
 * 原文字牌（牌位 / 牌名 / 正逆位白板）仅作降级兜底（由 TarotCardFace 内部处理）；
 * 类名与交互不变（.scene-card-tile / .is-active / .scene-cards-keys 均为测试锤点）。 */
import * as React from 'react'
import { Moon } from 'lucide-react'
import type { TarotCardRow } from '../../chat/md-ext/CardsCard'
import { cardSlugOf } from '../../chat/md-ext/tarot/deck'
import { TarotCardFace } from '../../chat/md-ext/tarot/TarotCardFace'

export function CardsBoard({
  title,
  cards,
  onInsert,
}: {
  title?: string
  cards: TarotCardRow[]
  onInsert?: (text: string) => void
}): React.JSX.Element {
  const [active, setActive] = React.useState(-1)
  const current = active >= 0 ? cards[active] : undefined
  const count = cards.length
  const layout = count === 1 || count === 3 || count === 5 ? `is-${count}` : 'is-grid'
  const deckText = `@观照 深入解读这组牌（${title || '本牌阵'}）：逐牌展开 + 关系编织 + 参考区间，并注明复现种子。`
  const redrawText = `@观照 换一组牌重抽（同问题，新种子）：${title || '本牌阵'}。`

  return (
    <div className="scene-cards-board" data-cards-board={layout}>
      <div className="scene-cards-board-head">
        <Moon className="size-3.5" aria-hidden />
        <span className="scene-cards-board-title">{title || '牌阵'}</span>
        <span className="scene-cards-board-count">{count} 张</span>
      </div>
      <div className={`scene-cards-spread ${layout}`}>
        {cards.map((c, i) => (
          <button
            key={i}
            type="button"
            className={`scene-card-tile${i === active ? ' is-active' : ''}`}
            aria-pressed={i === active}
            title="点击查看关键词"
            onClick={() => setActive((v) => (v === i ? -1 : i))}
          >
            <TarotCardFace
              card={{
                name: c.name,
                orientation: c.orientation.includes('逆') ? '逆位' : '正位',
                slug: cardSlugOf(c.name),
                position: c.position,
              }}
              variant="reveal"
              showPosition
              className="is-board"
            />
          </button>
        ))}
      </div>
      {current ? (
        <div className="scene-cards-keys" data-cards-keys="">
          <span className="scene-cards-keys-name">
            {current.name} · {current.orientation}
          </span>
          <span className="scene-cards-keys-list">{current.keywords.join(' · ')}</span>
        </div>
      ) : null}
      <div className="scene-cards-board-foot">
        <button type="button" className="md-cards-redraw" onClick={() => onInsert?.(redrawText)}>
          <Moon className="size-3" />
          重抽一组
        </button>
        <button type="button" className="md-cards-enter" onClick={() => onInsert?.(deckText)}>
          <Moon className="size-3" />
          深入解读这组牌
        </button>
      </div>
    </div>
  )
}

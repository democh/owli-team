/**
 * M78：牌面（见 docs/tarot-ritual-design.md §3.4–3.6）——揭示态 / 成阵态 / 图鉴共用。
 *
 * 降级链：位图（公版韦特，/tarot/rws/<slug>.jpg）→ 程序化文字牌（DOM：花色符号 × 点数阵列，
 * 大小牌各有版式）→ 纯文本（由父组件以 `.tc-face-plain` 兜底，通常不触达）。
 * 逆位口径（中性）：牌面图 180° 倒置（真实塔罗语义）+ 虚线框 + 「逆位」角标（不加任何凶兆色）。
 */
import * as React from 'react'
import { DECK, cardImageUrl, type RitualCard } from './deck'

export type FaceVariant = 'grid' | 'slot' | 'reveal' | 'codex' | 'thumb'

/** 罗马数字（大阿卡纳 0-21；0 = 愚者传统标 0） */
const ROMAN = ['0', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX', 'XXI']

/** 花色符号（炼金四元素：权杖=火/圣杯=水/宝剑=风/星币=土——体系正确性承载） */
const SUIT_GLYPH: Record<string, string> = { 权杖: '🜂', 圣杯: '🜄', 宝剑: '🜁', 星币: '🜃' }

/** 程序化牌面（L2）：主题底 + 描金边框 + 大牌罗马序号 / 小牌花色符号 × 点数阵列 + 牌名 */
function ProceduralFace({ name }: { name: string }): React.JSX.Element {
  const card = DECK.find((c) => c.name === name)
  const isMajor = card?.majorIndex !== undefined
  const rankIdx = card && card.suit !== undefined ? ['首牌', '二', '三', '四', '五', '六', '七', '八', '九', '十'].indexOf(card.rank ?? '') : -1
  const pips = rankIdx >= 0 ? rankIdx + 1 : 0
  const glyph = card?.suit ? SUIT_GLYPH[card.suit] : ''
  return (
    <span className="tc-face-proc" data-proc-face="">
      <span className="tc-face-proc-frame" />
      {isMajor ? <span className="tc-face-proc-roman">{ROMAN[card!.majorIndex!]}</span> : null}
      {pips > 0 ? (
        <span className="tc-face-proc-pips" aria-hidden="true">
          {Array.from({ length: pips }, (_, i) => (
            <span key={i} className="tc-face-proc-pip">
              {glyph}
            </span>
          ))}
        </span>
      ) : card?.suit ? (
        <span className="tc-face-proc-glyph" aria-hidden="true">
          {glyph}
        </span>
      ) : null}
      <span className="tc-face-proc-name">{name}</span>
    </span>
  )
}

export interface TarotCardFaceProps {
  card: Pick<RitualCard, 'name' | 'orientation' | 'slug'> & { position?: string; keywords?: string[] }
  variant?: FaceVariant
  /** 牌位标（揭示/成阵态显示） */
  showPosition?: boolean
  /** 关键词行（成阵/图鉴态显示） */
  showKeywords?: boolean
  /** 交互态（选牌高亮等由父级控制） */
  active?: boolean
  className?: string
  onClick?: () => void
  /** 元素语义：button（可点）| div（静态） */
  as?: 'button' | 'div'
}

export function TarotCardFace({
  card,
  variant = 'reveal',
  showPosition = false,
  showKeywords = false,
  active = false,
  className,
  onClick,
  as = 'div',
}: TarotCardFaceProps): React.JSX.Element {
  const [imgOk, setImgOk] = React.useState(true)
  const url = cardImageUrl(card.slug)
  const rev = card.orientation === '逆位'
  const label = `${showPosition && card.position ? `${card.position}位：` : ''}${card.name}，${card.orientation}${card.keywords && card.keywords.length > 0 ? `，关键词 ${card.keywords.join(' ')}` : ''}`
  const cls = [
    'tc-face',
    `is-${variant}`,
    rev ? 'is-rev' : 'is-upright',
    active ? 'is-active' : '',
    as === 'button' ? 'is-button' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')

  const inner = (
    <>
      {showPosition && card.position ? <span className="tc-face-pos">{card.position}</span> : null}
      <span className="tc-face-art">
        {imgOk && url !== '' ? (
          <img
            className="tc-face-img"
            src={url}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={() => setImgOk(false)}
            style={rev ? { transform: 'rotate(180deg)' } : undefined}
          />
        ) : (
          <ProceduralFace name={card.name} />
        )}
      </span>
      <span className="tc-face-meta">
        <span className="tc-face-name">{card.name}</span>
        <span className={`tc-face-orient${rev ? ' is-rev' : ''}`}>
          <span className="tc-face-orient-dot" aria-hidden="true" />
          {card.orientation}
        </span>
      </span>
      {showKeywords && card.keywords && card.keywords.length > 0 ? (
        <span className="tc-face-keys">{card.keywords.join(' · ')}</span>
      ) : null}
    </>
  )

  if (as === 'button') {
    return (
      <button type="button" className={cls} onClick={onClick} aria-pressed={active} aria-label={label}>
        {inner}
      </button>
    )
  }
  return (
    <div className={cls} role="img" aria-label={label} onClick={onClick}>
      {inner}
    </div>
  )
}

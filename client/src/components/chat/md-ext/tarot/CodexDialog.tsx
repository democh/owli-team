/**
 * M78：78 张图鉴弹窗（见 docs/tarot-ritual-design.md §8.2）——研习工具，非收集玩法。
 *
 * 分组导航（大阿卡纳 / 四花色）+ 全表网格；每张：位图（缺图回退程序化）+ 名称 + 关键词；
 * 「遇见」计数由手记派生（只读小字，无进度条 / 成就 / 解锁）；点卡展详情 + 「问这张」回填草稿。
 */
import * as React from 'react'
import { createPortal } from 'react-dom'
import { useUiStore } from '../../../../stores/ui-store'
import { DECK, SUITS, type DeckCard } from './deck'
import { entryCards, readJournal } from './journal'
import { TarotCardFace } from './TarotCardFace'

type GroupId = 'major' | 'wands' | 'cups' | 'swords' | 'pents'

const GROUPS: Array<{ id: GroupId; label: string }> = [
  { id: 'major', label: '大阿卡纳' },
  ...SUITS.map((s) => ({ id: s.slug as GroupId, label: s.name })),
]

const ROMAN = ['0', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX', 'XXI']

/** 手记派生：每张牌遇见次数（去重口径 = 出现即计） */
function seenCounts(sessionId: string): Map<string, number> {
  const m = new Map<string, number>()
  for (const e of readJournal(sessionId)) {
    for (const c of entryCards(e)) m.set(c.name, (m.get(c.name) ?? 0) + 1)
  }
  return m
}

export function CodexDialog({ open, onClose, sessionId }: { open: boolean; onClose: () => void; sessionId?: string }): React.JSX.Element | null {
  const insertToComposer = useUiStore((s) => s.insertToComposer)
  const [group, setGroup] = React.useState<GroupId>('major')
  const [sel, setSel] = React.useState('')

  React.useEffect(() => {
    if (open) setSel('')
  }, [open])

  const sid = sessionId ?? ''
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const counts = React.useMemo(() => seenCounts(sid), [sid, open])
  const seenNames = counts.size

  if (!open) return null

  const cards: DeckCard[] = group === 'major' ? DECK.slice(0, 22) : DECK.filter((c) => c.suit === SUITS.find((s) => s.slug === group)?.name)
  const selCard = DECK.find((c) => c.name === sel)

  const ask = (name: string): void => {
    insertToComposer(`@观照 讲讲「${name}」这张牌的牌义、意象与常见误读。`)
    onClose()
  }

  return createPortal(
    <div className="tc-mask" role="presentation" onClick={onClose}>
      <div className="tc-dialog is-codex" role="dialog" aria-modal="true" aria-label="塔罗图鉴" onClick={(e) => e.stopPropagation()}>
        <div className="tc-ritual-head">
          <span className="tc-ritual-title">塔罗图鉴 · 78 张</span>
          <span className="tc-ritual-sub">{seenNames > 0 ? `遇见 ${seenNames}/78 张（本地记录）` : '78 张全表 · 点卡看牌义'}</span>
          <button type="button" className="tc-ritual-close" aria-label="关闭图鉴" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="tc-codex-tabs" role="tablist" aria-label="牌组分组">
          {GROUPS.map((g) => (
            <button
              key={g.id}
              type="button"
              role="tab"
              aria-selected={group === g.id}
              className={`tc-codex-tab${group === g.id ? ' is-on' : ''}`}
              onClick={() => setGroup(g.id)}
            >
              {g.label}
            </button>
          ))}
        </div>
        <div className="tc-codex-scroll">
          <div className="tc-codex-grid">
            {cards.map((c) => {
              const cnt = counts.get(c.name) ?? 0
              return (
                <button
                  key={c.name}
                  type="button"
                  className={`tc-codex-cell${sel === c.name ? ' is-on' : ''}`}
                  onClick={() => setSel((v) => (v === c.name ? '' : c.name))}
                >
                  <TarotCardFace card={{ name: c.name, orientation: '正位', slug: c.slug }} variant="codex" />
                  <span className="tc-codex-cap">
                    {c.majorIndex !== undefined ? `${ROMAN[c.majorIndex]} · ` : ''}
                    {c.name}
                    {cnt > 0 ? <span className="tc-codex-cnt">×{cnt}</span> : null}
                  </span>
                </button>
              )
            })}
          </div>
          {selCard ? (
            <div className="tc-codex-detail">
              <div className="tc-codex-detail-card">
                <TarotCardFace card={{ name: selCard.name, orientation: '正位', slug: selCard.slug }} variant="reveal" />
              </div>
              <div className="tc-codex-detail-info">
                <div className="tc-codex-detail-name">
                  {selCard.majorIndex !== undefined ? `大阿卡纳 ${ROMAN[selCard.majorIndex]} · ` : `${selCard.suit} · `}
                  {selCard.name}
                </div>
                <div className="tc-codex-detail-keys">{selCard.keywords.join(' · ')}</div>
                <button type="button" className="tc-ghost" onClick={() => ask(selCard.name)}>
                  问这张
                </button>
              </div>
            </div>
          ) : null}
        </div>
        <div className="tc-foot">
          <span className="tc-declare">文化研习参考，不构成决策依据 · 牌面：Rider-Waite-Smith（1909，公有领域）</span>
        </div>
      </div>
    </div>,
    document.body,
  )
}

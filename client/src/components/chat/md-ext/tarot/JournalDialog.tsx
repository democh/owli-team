/**
 * M78：抽牌手记弹窗（见 docs/tarot-ritual-design.md §8.1）——本地私密（`ma:tc:journal:<sid>`）。
 *
 * 条目只存复现参数（牌面现推）；时间倒序；当天首个单张条目标「今日一牌」（无连续天数 / 无提醒）；
 * 操作：展开（成阵态牌面 + 参数）/ 再请解（回填草稿，不自动发送）/ 删除（二次确认）；
 * 页脚研习足迹（只读小字，无奖励机制）。
 */
import * as React from 'react'
import { createPortal } from 'react-dom'
import { useUiStore } from '../../../../stores/ui-store'
import { SPREADS } from './deck'
import { entryCards, formatStats, journalStats, readJournal, recordAsk, removeEntry, type JournalEntry } from './journal'
import { buildAskDraft } from './TarotRitual'
import { TarotCardFace } from './TarotCardFace'

function timeText(at: number): string {
  if (at <= 0) return ''
  const d = new Date(at)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return sameDay ? `今天 ${hm}` : `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

/** 当天首个单张条目 id（「今日一牌」小标；无则为空串） */
function todayFirstSingle(list: JournalEntry[]): string {
  const today = new Date().toDateString()
  const todays = list.filter((e) => new Date(e.at).toDateString() === today).sort((a, b) => a.at - b.at)
  return todays.find((e) => e.spread === 'single')?.id ?? ''
}

export function JournalDialog({ open, onClose, sessionId }: { open: boolean; onClose: () => void; sessionId?: string }): React.JSX.Element | null {
  const insertToComposer = useUiStore((s) => s.insertToComposer)
  const [ver, setVer] = React.useState(0)
  const [expanded, setExpanded] = React.useState('')
  const [confirmDel, setConfirmDel] = React.useState('')

  React.useEffect(() => {
    if (open) {
      setVer((v) => v + 1)
      setExpanded('')
      setConfirmDel('')
    }
  }, [open])

  const sid = sessionId ?? ''
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const list = React.useMemo(() => [...readJournal(sid)].sort((a, b) => b.at - a.at), [sid, ver, open])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stats = React.useMemo(() => journalStats(sid), [sid, ver, open])
  const todayId = React.useMemo(() => todayFirstSingle(list), [list])

  if (!open) return null

  const ask = (e: JournalEntry): void => {
    recordAsk(sid, e.id)
    insertToComposer(buildAskDraft(e.spread, e.seed, e.cut, e.picks, e.question))
    onClose()
  }

  const del = (e: JournalEntry): void => {
    if (confirmDel !== e.id) {
      setConfirmDel(e.id)
      return
    }
    removeEntry(sid, e.id)
    setConfirmDel('')
    setVer((v) => v + 1)
  }

  const trail = formatStats(stats)

  return createPortal(
    <div className="tc-mask" role="presentation" onClick={onClose}>
      <div className="tc-dialog" role="dialog" aria-modal="true" aria-label="抽牌手记" onClick={(e) => e.stopPropagation()}>
        <div className="tc-ritual-head">
          <span className="tc-ritual-title">抽牌手记</span>
          <span className="tc-ritual-sub">{trail === '' ? '本地私密 · 不落库' : `研习足迹：${trail}`}</span>
          <button type="button" className="tc-ritual-close" aria-label="关闭手记" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="tc-journal-scroll">
          {list.length === 0 ? (
            <p className="tc-empty">还没有记录——去右栏「亲手抽牌」抽一组吧。</p>
          ) : (
            <ul className="tc-journal" role="list">
              {list.map((e) => {
                const cards = entryCards(e)
                const isOpen = expanded === e.id
                return (
                  <li key={e.id} className="tc-journal-item">
                    <button
                      type="button"
                      className="tc-journal-head"
                      aria-expanded={isOpen}
                      onClick={() => setExpanded((v) => (v === e.id ? '' : e.id))}
                    >
                      <span className="tc-journal-time">{timeText(e.at)}</span>
                      <span className="tc-journal-name">{SPREADS[e.spread].name}</span>
                      {e.id === todayId ? <span className="tc-journal-today">今日一牌</span> : null}
                      <span className="tc-journal-q">{e.question === '' ? '（未注明所问）' : e.question}</span>
                      <span className="tc-journal-thumbs" aria-hidden="true">
                        {cards.map((c) => (
                          <TarotCardFace key={c.position} card={c} variant="thumb" />
                        ))}
                      </span>
                    </button>
                    {isOpen ? (
                      <div className="tc-journal-detail">
                        <div className={`tc-spread is-${cards.length}`}>
                          {cards.map((c, i) => (
                            <div key={c.position} className="tc-spread-slot">
                              <TarotCardFace card={c} variant="reveal" showPosition showKeywords />
                              <span className="tc-slot-hint">{SPREADS[e.spread].hints[i]}</span>
                            </div>
                          ))}
                        </div>
                        <div className="tc-info">
                          <span className="tc-info-params">复现参数：种子 {e.seed} · 切牌 {e.cut} · 选牌 [{e.picks.join(', ')}]</span>
                          {e.asked > 0 ? <span className="tc-info-comp">已请解 {e.asked} 次</span> : null}
                        </div>
                      </div>
                    ) : null}
                    <div className="tc-journal-ops">
                      <button type="button" className="tc-ghost" onClick={() => ask(e)}>
                        再请解
                      </button>
                      <button type="button" className={`tc-ghost${confirmDel === e.id ? ' is-danger' : ''}`} onClick={() => del(e)}>
                        {confirmDel === e.id ? '确认删除' : '删除'}
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
        <div className="tc-foot">
          <span className="tc-declare">文化研习参考，不构成决策依据 · 记录仅存本机会话</span>
        </div>
      </div>
    </div>,
    document.body,
  )
}

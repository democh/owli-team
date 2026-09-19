/**
 * M78：抽牌台 TarotRitual（见 docs/tarot-ritual-design.md §4）——亲手抽牌六阶段状态机：
 * idle（静心提问）→ shuffle（洗牌）→ cut（切牌）→ draw（亲手选牌）→ reveal（逐张翻牌）→ complete（成阵）。
 *
 * 诚实参与：点选位置即结果（picks 进复现参数）；种子全程公开；牌面恒由 seed/cut/picks 经
 * deck.ritualDraw 现推（与工具逐位同源）；产物一律为草稿（回填 Composer 不自动发送，ADR 0064）；
 * 进度存 `ma:tc:ritual`（只存参数与进度，关闭 / 刷新可续）。仪式克制：动效 ≤700ms；
 * quiet / reduced-motion 直出；键盘（空格 / 回车 / 方向键 / 撤销 / Escape）；aria-live 播报。
 */
import * as React from 'react'
import { createPortal } from 'react-dom'
import { useUiStore } from '../../../../stores/ui-store'
import {
  DECK,
  DECK_SIZE,
  SPREADS,
  SPREAD_LIST,
  freshSeed,
  readRitual,
  ritualDraw,
  writeRitual,
  type RitualSaved,
  type SpreadId,
} from './deck'
import { recordAsk, recordDraw } from './journal'
import { CardBack } from './CardBack'
import { TarotCardFace } from './TarotCardFace'

const GRID_COLS = 13

/** 请解草稿（附录 A 文案 1/2 同构）——只回填，不自动发送 */
export function buildAskDraft(spread: SpreadId, seed: number, cut: number, picks: number[], question: string): string {
  const sp = SPREADS[spread]
  const q = question.trim() === '' ? '（未注明）' : question.trim()
  const verb = picks.length === 1 ? '我亲手抽了一张牌' : '我亲手抽了一组牌'
  return (
    `${verb}（${sp.name}，种子 ${seed}，切牌 ${cut}，选牌 [${picks.join(', ')}]，所问：「${q}」）。\n` +
    `请用 tarot_draw（spread=${spread}，seed=${seed}，cut=${cut}，picks=[${picks.join(',')}]）复算牌面，逐位核对后按四步解读；\n` +
    `若复算牌面与我所见不一致，请指出并说明。`
  )
}

/** 牌组构成（事实行：大阿卡纳数 / 元素分布——只列事实，不给解读判断） */
function compositionOf(cards: ReturnType<typeof ritualDraw>): string {
  const elemOf: Record<string, string> = { 权杖: '火', 圣杯: '水', 宝剑: '风', 星币: '土' }
  const major = cards.filter((c) => DECK_MAJOR.has(c.name)).length
  const elems: Record<string, number> = {}
  for (const c of cards) {
    const suit = DECK_SUIT.get(c.name)
    if (suit) elems[elemOf[suit]!] = (elems[elemOf[suit]!] ?? 0) + 1
  }
  const parts = [`大阿卡纳 ${major}/${cards.length}`]
  const el = Object.entries(elems).map(([k, v]) => `${k} ${v}`)
  if (el.length > 0) parts.push(`元素 ${el.join(' ')}`)
  return parts.join(' · ')
}

// 静态映射（一次性构建，避免每次渲染扫表）
const DECK_MAJOR = new Set<string>()
const DECK_SUIT = new Map<string, string>()
for (const c of DECK) {
  if (c.majorIndex !== undefined) DECK_MAJOR.add(c.name)
  if (c.suit) DECK_SUIT.set(c.name, c.suit)
}

function prefersReduced(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

export interface TarotRitualProps {
  open: boolean
  onClose: () => void
  /** 请解草稿（回填 Composer，不自动发送） */
  onDone: (draft: string) => void
  sessionId?: string
  /** 入口预设：牌阵 / 所问 */
  presetSpread?: SpreadId
  presetQuestion?: string
}

export function TarotRitual({ open, onClose, onDone, sessionId, presetSpread, presetQuestion }: TarotRitualProps): React.JSX.Element | null {
  const quiet = useUiStore((s) => s.quietMode)
  const [stage, setStage] = React.useState<RitualSaved['stage']>('idle')
  const [spread, setSpread] = React.useState<SpreadId>('three')
  const [question, setQuestion] = React.useState('')
  const [seed, setSeed] = React.useState<number | null>(null)
  const [shuffleCount, setShuffleCount] = React.useState(0)
  const [cut, setCut] = React.useState(0)
  const [picks, setPicks] = React.useState<number[]>([])
  const [revealed, setRevealed] = React.useState(0)
  const [flipping, setFlipping] = React.useState(false)
  const [shuffling, setShuffling] = React.useState(false)
  const [live, setLive] = React.useState('')
  const [focusIdx, setFocusIdx] = React.useState(0)
  const flipTimer = React.useRef<number | null>(null)
  const shuffleTimer = React.useRef<number | null>(null)
  const panelRef = React.useRef<HTMLDivElement | null>(null)
  const gridRef = React.useRef<HTMLDivElement | null>(null)

  const n = SPREADS[spread].positions.length
  const cards = React.useMemo(
    () => (seed !== null && picks.length === n ? ritualDraw(spread, seed, cut, picks) : []),
    [spread, seed, cut, picks, n],
  )
  const reduced = quiet || prefersReduced()

  const save = React.useCallback(
    (patch: Partial<RitualSaved>) => {
      writeRitual({
        stage,
        spread,
        question,
        seed,
        shuffleCount,
        cut,
        picks,
        revealed,
        ...patch,
      })
    },
    [stage, spread, question, seed, shuffleCount, cut, picks, revealed],
  )

  // 打开：按进度恢复（关闭 / 刷新保留；仅 idle 时应用入口预设）
  React.useEffect(() => {
    if (!open) return
    const s = readRitual()
    if (s.stage === 'idle') {
      const sp = presetSpread ?? s.spread
      const q = presetQuestion ?? s.question
      setStage('idle')
      setSpread(sp)
      setQuestion(q)
      setSeed(null)
      setShuffleCount(0)
      setCut(0)
      setPicks([])
      setRevealed(0)
      writeRitual({ ...s, stage: 'idle', spread: sp, question: q, seed: null, shuffleCount: 0, cut: 0, picks: [], revealed: 0 })
    } else {
      setStage(s.stage)
      setSpread(s.spread)
      setQuestion(s.question)
      setSeed(s.seed)
      setShuffleCount(s.shuffleCount)
      setCut(s.cut)
      setPicks(s.picks)
      setRevealed(s.revealed)
    }
    setLive('')
    panelRef.current?.focus({ preventScroll: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // 卸载清理定时器
  React.useEffect(
    () => () => {
      if (flipTimer.current !== null) window.clearTimeout(flipTimer.current)
      if (shuffleTimer.current !== null) window.clearTimeout(shuffleTimer.current)
    },
    [],
  )

  // 焦点约束（模态性，照摇卦台规格：Tab 环回 + 逃逸拉回）
  React.useEffect(() => {
    if (!open) return
    const focusables = (): HTMLElement[] => {
      const panel = panelRef.current
      if (!panel) return []
      return Array.from(
        panel.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex]'),
      ).filter((el) => el.getAttribute('tabindex') !== '-1')
    }
    const onFocusIn = (e: FocusEvent): void => {
      const panel = panelRef.current
      if (!panel || !(e.target instanceof Node)) return
      if (!panel.contains(e.target)) panel.focus({ preventScroll: true })
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return
      const items = focusables()
      if (items.length === 0) return
      const first = items[0]!
      const last = items[items.length - 1]!
      const active = document.activeElement
      if (!(active instanceof Node) || !panelRef.current?.contains(active)) {
        e.preventDefault()
        ;(e.shiftKey ? last : first).focus()
        return
      }
      if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      } else if (e.shiftKey && active === first) {
        e.preventDefault()
        last.focus()
      }
    }
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open])

  // 成阵自动入记（幂等：同参数只记一次）
  React.useEffect(() => {
    if (stage !== 'complete' || seed === null || picks.length !== n) return
    if (!sessionId) return
    recordDraw(sessionId, { question: question.trim(), spread, seed, cut, picks })
  }, [stage, sessionId, question, spread, seed, cut, picks, n])

  // ---------- 动作 ----------

  const start = (sp: SpreadId = spread): void => {
    const s = freshSeed()
    setSpread(sp)
    setSeed(s)
    setShuffleCount(0)
    setCut(0)
    setPicks([])
    setRevealed(0)
    setStage('shuffle')
    setLive('已生成仪式种子，开始洗牌')
    save({ spread: sp, seed: s, stage: 'shuffle', shuffleCount: 0, cut: 0, picks: [], revealed: 0 })
  }

  const doShuffle = (): void => {
    if (seed === null) return
    const next = shuffleCount + 1
    if (reduced) {
      setShuffleCount(next)
      setLive(`已洗牌第 ${next} 次`)
      save({ shuffleCount: next })
      return
    }
    setShuffling(true)
    shuffleTimer.current = window.setTimeout(() => {
      shuffleTimer.current = null
      setShuffling(false)
      setShuffleCount(next)
      setLive(`已洗牌第 ${next} 次`)
      save({ shuffleCount: next })
    }, 700)
  }

  const toCut = (): void => {
    setStage('cut')
    setLive('请把一堆牌放到最上面')
    save({ stage: 'cut' })
  }

  const doCut = (pile: number): void => {
    setCut(pile)
    setStage('draw')
    setLive('已切牌；请凭直觉点选牌张')
    save({ cut: pile, stage: 'draw' })
  }

  const pick = (k: number): void => {
    if (picks.includes(k) || picks.length >= n) return
    const next = [...picks, k]
    setPicks(next)
    const pos = SPREADS[spread].positions[next.length - 1]
    const need = n - next.length
    setLive(need > 0 ? `已选第 ${next.length} 张（${pos}位），还需 ${need} 张` : `${pos}位已选——可以揭示牌面了`)
    save({ picks: next })
  }

  const undoPick = (): void => {
    if (picks.length === 0) return
    const next = picks.slice(0, -1)
    setPicks(next)
    setLive(`已撤销，当前已选 ${next.length} 张`)
    save({ picks: next })
  }

  const toReveal = (): void => {
    if (picks.length !== n) return
    setStage('reveal')
    setRevealed(0)
    setLive('请逐张翻开牌面')
    save({ stage: 'reveal', revealed: 0 })
  }

  const flipNext = (): void => {
    if (revealed >= n || cards.length !== n) return
    const k = revealed
    const card = cards[k]!
    const next = k + 1
    if (reduced) {
      setRevealed(next)
      setLive(`${card.position}位已揭晓：${card.name}，${card.orientation}`)
      if (next >= n) {
        setStage('complete')
        save({ revealed: next, stage: 'complete' })
      } else {
        save({ revealed: next })
      }
      return
    }
    setFlipping(true)
    flipTimer.current = window.setTimeout(() => {
      flipTimer.current = null
      setFlipping(false)
      setRevealed(next)
      setLive(`${card.position}位已揭晓：${card.name}，${card.orientation}`)
      if (next >= n) {
        setStage('complete')
        save({ revealed: next, stage: 'complete' })
      } else {
        save({ revealed: next })
      }
    }, 600)
  }

  const flipAll = (): void => {
    if (revealed >= n || cards.length !== n) return
    setRevealed(n)
    setStage('complete')
    setLive(`全部翻开：${cards.map((c) => `${c.position} ${c.name}${c.orientation === '正位' ? '' : '·逆'}`).join('；')}`)
    save({ revealed: n, stage: 'complete' })
  }

  const ask = (): void => {
    if (seed === null || picks.length !== n) return
    if (sessionId) {
      const e = recordDraw(sessionId, { question: question.trim(), spread, seed, cut, picks })
      recordAsk(sessionId, e.id)
    }
    onDone(buildAskDraft(spread, seed, cut, picks, question))
    onClose()
  }

  /** 同参数重放（复现自检：与本地现推逐位比对——理论恒一致） */
  const replay = (): void => {
    if (seed === null || picks.length !== n) return
    const again = ritualDraw(spread, seed, cut, picks)
    const same = again.every((c, i) => c.name === cards[i]?.name && c.orientation === cards[i]?.orientation)
    setLive(same ? `同参数重放：本组牌与 seed+cut+picks 复算逐位一致` : '重放不一致——请反馈（不应发生）')
  }

  const redraw = (): void => {
    setStage('idle')
    setSeed(null)
    setShuffleCount(0)
    setCut(0)
    setPicks([])
    setRevealed(0)
    setLive('')
    save({ stage: 'idle', seed: null, shuffleCount: 0, cut: 0, picks: [], revealed: 0 })
  }

  // ---------- 键盘 ----------

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key !== ' ' && e.key !== 'Enter') return
    const t = e.target as HTMLElement | null
    if (t && t.closest('button, input, textarea, select, a')) return
    if (stage === 'idle') {
      e.preventDefault()
      start()
    } else if (stage === 'shuffle' && !shuffling) {
      e.preventDefault()
      if (shuffleCount === 0) doShuffle()
      else toCut()
    } else if (stage === 'reveal' && !flipping) {
      e.preventDefault()
      flipNext()
    } else if (stage === 'complete') {
      e.preventDefault()
      ask()
    }
  }

  /** 选牌网格：roving tabindex（方向键移动 + Enter 选牌） */
  const onGridKeyDown = (e: React.KeyboardEvent): void => {
    const cur = focusIdx
    const move = (to: number): void => {
      e.preventDefault()
      setFocusIdx(to)
      const el = gridRef.current?.querySelector<HTMLElement>(`[data-cell="${to}"]`)
      el?.focus()
    }
    if (e.key === 'ArrowRight') {
      if (cur % GRID_COLS !== GRID_COLS - 1 && cur + 1 < DECK_SIZE) move(cur + 1)
    } else if (e.key === 'ArrowLeft') {
      if (cur % GRID_COLS !== 0) move(cur - 1)
    } else if (e.key === 'ArrowDown') {
      if (cur + GRID_COLS < DECK_SIZE) move(cur + GRID_COLS)
    } else if (e.key === 'ArrowUp') {
      if (cur - GRID_COLS >= 0) move(cur - GRID_COLS)
    } else if (e.key === 'Backspace') {
      e.preventDefault()
      undoPick()
    }
  }

  if (!open) return null

  const pickedSlots = SPREADS[spread].positions
  const hints = SPREADS[spread].hints

  // Portal 到 body：避免被虚拟列表行的 transform 封层（摇卦台同规格）
  return createPortal(
    <div className="tc-mask" role="presentation" onClick={onClose}>
      <div
        ref={panelRef}
        className="tc-ritual"
        role="dialog"
        aria-modal="true"
        aria-label="抽牌台"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="tc-ritual-head">
          <span className="tc-ritual-title">抽牌台</span>
          <span className="tc-ritual-sub">种子公开 · 与研习师工具逐位同源</span>
          <button type="button" className="tc-ritual-close" aria-label="关闭抽牌台" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="tc-steps" role="list" aria-label="抽牌进度">
          {(['idle', 'shuffle', 'cut', 'draw', 'reveal'] as const).map((s, i) => {
            const order = ['idle', 'shuffle', 'cut', 'draw', 'reveal', 'complete']
            const cur = order.indexOf(stage)
            const at = order.indexOf(s)
            return (
              <span key={s} className={`tc-step${cur === at ? ' is-on' : ''}${cur > at ? ' is-done' : ''}`} role="listitem">
                {['静心', '洗牌', '切牌', '选牌', '揭示'][i]}
              </span>
            )
          })}
        </div>

        <div className="tc-body">
          {stage === 'idle' ? (
            <div className="tc-pane" role="region" aria-label="静心提问">
              <div className="tc-spreads" role="radiogroup" aria-label="牌阵">
                {SPREAD_LIST.map((sp) => (
                  <button
                    key={sp.id}
                    type="button"
                    role="radio"
                    aria-checked={spread === sp.id}
                    className={`tc-spread-card${spread === sp.id ? ' is-on' : ''}`}
                    onClick={() => {
                      setSpread(sp.id)
                      save({ spread: sp.id })
                    }}
                  >
                    <span className="tc-spread-name">{sp.name}</span>
                    <span className="tc-spread-count">{sp.count} 张</span>
                    <span className="tc-spread-pos">{sp.positions.join(' → ')}</span>
                  </button>
                ))}
              </div>
              <label className="tc-q">
                <span>所问（可选）</span>
                <input
                  value={question}
                  maxLength={80}
                  placeholder="例：最近这段时间该把注意力放在哪里"
                  onChange={(e) => {
                    setQuestion(e.target.value)
                    save({ question: e.target.value })
                  }}
                />
              </label>
              <p className="tc-hint">一次一个清晰的问题；涉及健康 / 法律 / 财产请咨询专业人士。</p>
              <div className="tc-actions">
                <button type="button" className="tc-btn" onClick={() => start()}>
                  开始洗牌
                </button>
                <button type="button" className="tc-ghost" onClick={() => start('single')}>
                  今日一牌
                </button>
              </div>
              <p className="tc-hint is-quiet">重抽不改写结果；对牌面不满时，换问法更有用。</p>
            </div>
          ) : null}

          {stage === 'shuffle' || stage === 'cut' ? (
            <div className="tc-pane" role="region" aria-label="洗牌与切牌">
              {stage === 'shuffle' ? (
                <>
                  <div className={`tc-deck${shuffling ? ' is-shuffling' : ''}`} aria-hidden="true">
                    <CardBack className="tc-deck-pile is-a" />
                    <CardBack className="tc-deck-pile is-b" />
                    <CardBack className="tc-deck-pile is-c" />
                  </div>
                  {question.trim() !== '' ? <div className="tc-qline">所问：{question.trim()}</div> : null}
                  <div className="tc-actions">
                    <button type="button" className="tc-btn" disabled={shuffling} onClick={() => (shuffleCount === 0 ? doShuffle() : toCut())}>
                      {shuffling ? '洗牌中…' : shuffleCount === 0 ? '洗牌' : '切牌'}
                    </button>
                    {shuffleCount > 0 ? (
                      <button type="button" className="tc-ghost" disabled={shuffling} onClick={doShuffle}>
                        再洗一次
                      </button>
                    ) : null}
                  </div>
                  <p className="tc-hint">洗牌是仪式；牌序与正逆位由种子定妥，可复现。</p>
                </>
              ) : (
                <>
                  <p className="tc-cut-cap">凭直觉把一堆放到最上面</p>
                  <div className="tc-cut" role="group" aria-label="切牌三堆">
                    {[0, 1, 2].map((pile) => (
                      <button key={pile} type="button" className="tc-cut-pile" onClick={() => doCut(pile)} aria-label={`第 ${pile + 1} 堆放最上`}>
                        <CardBack />
                        <span className="tc-cut-no">{pile + 1}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          ) : null}

          {stage === 'draw' ? (
            <div className="tc-pane" role="region" aria-label="亲手选牌">
              <div className="tc-slots" role="list" aria-label="牌位">
                {pickedSlots.map((pos, i) => (
                  <span key={pos} className={`tc-slot${i < picks.length ? ' is-filled' : ''}`} role="listitem">
                    <span className="tc-slot-pos">{pos}</span>
                    {i < picks.length ? <CardBack className="tc-slot-back" /> : <span className="tc-slot-empty" aria-hidden="true" />}
                  </span>
                ))}
              </div>
              <div className="tc-draw-cap">
                凭直觉点选 {n} 张 · 已选 {picks.length}/{n}
                {picks.length < n ? <span className="tc-draw-hint">第 {picks.length + 1} 张 = {pickedSlots[picks.length]}</span> : null}
              </div>
              <div
                ref={gridRef}
                className="tc-grid"
                role="group"
                aria-label={`牌堆（共 ${DECK_SIZE} 张背面朝上）`}
                onKeyDown={onGridKeyDown}
              >
                {Array.from({ length: DECK_SIZE }, (_, k) => {
                  const pickedAt = picks.indexOf(k)
                  return (
                    <button
                      key={k}
                      type="button"
                      data-cell={k}
                      tabIndex={k === focusIdx ? 0 : -1}
                      className={`tc-cell${pickedAt >= 0 ? ' is-picked' : ''}`}
                      aria-label={`第 ${k + 1} 张，${pickedAt >= 0 ? `已选（第 ${pickedAt + 1} 支）` : '未选'}`}
                      aria-pressed={pickedAt >= 0}
                      onClick={() => pick(k)}
                      onFocus={() => setFocusIdx(k)}
                    >
                      <CardBack />
                      {pickedAt >= 0 ? <span className="tc-cell-mark">{pickedAt + 1}</span> : null}
                    </button>
                  )
                })}
              </div>
              <div className="tc-actions">
                <button type="button" className="tc-btn" disabled={picks.length !== n} onClick={toReveal}>
                  揭示牌面
                </button>
                <button type="button" className="tc-ghost" disabled={picks.length === 0} onClick={undoPick}>
                  撤销上一张
                </button>
              </div>
            </div>
          ) : null}

          {stage === 'reveal' || stage === 'complete' ? (
            <div className="tc-pane" role="region" aria-label={stage === 'complete' ? '牌阵已成' : '逐张翻牌'}>
              <div className={`tc-spread is-${n}${stage === 'reveal' && flipping ? ' is-flipping' : ''}`}>
                {cards.map((c, i) => {
                  const shown = stage === 'complete' || i < revealed
                  const isNext = stage === 'reveal' && i === revealed
                  return (
                    <div key={c.position} className={`tc-spread-slot${n === 5 ? ` tc-at-${i}` : ''}`}>
                      {shown ? (
                        <TarotCardFace card={c} variant="reveal" showPosition showKeywords={stage === 'complete'} />
                      ) : (
                        <button
                          type="button"
                          className={`tc-spread-back${isNext ? ' is-next' : ''}`}
                          onClick={flipNext}
                          aria-label={`翻开${c.position}位`}
                          disabled={!isNext || flipping}
                        >
                          <CardBack />
                        </button>
                      )}
                      {shown ? <span className="tc-slot-hint">{hints[i]}</span> : null}
                    </div>
                  )
                })}
              </div>

              {stage === 'reveal' ? (
                <div className="tc-actions">
                  <button type="button" className="tc-btn" disabled={flipping} onClick={flipNext}>
                    {flipping ? '翻牌中…' : `翻开第 ${Math.min(revealed + 1, n)} 张`}
                  </button>
                  <button type="button" className="tc-ghost" disabled={flipping} onClick={flipAll}>
                    全部翻开
                  </button>
                </div>
              ) : (
                <>
                  <div className="tc-info">
                    {question.trim() !== '' ? <span className="tc-info-q">所问：{question.trim()}</span> : null}
                    <span className="tc-info-sp">牌阵：{SPREADS[spread].name}</span>
                    <span className="tc-info-params">种子 {seed} · 切牌 {cut} · 选牌 [{picks.join(', ')}]</span>
                    <span className="tc-info-comp">构成：{compositionOf(cards)}</span>
                  </div>
                  <div className="tc-actions">
                    <button type="button" className="tc-btn" onClick={ask}>
                      请观照解读
                    </button>
                    <button type="button" className="tc-ghost" onClick={replay}>
                      同参数重放
                    </button>
                    <button type="button" className="tc-ghost" onClick={redraw}>
                      重新洗牌（新种子）
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : null}
        </div>

        <span className="tc-live" aria-live="polite">
          {live}
        </span>
        <div className="tc-foot">
          {seed !== null ? <span className="tc-seed">种子 {seed}</span> : null}
          <span className="tc-declare">文化研习参考，不构成决策依据 · 牌面：Rider-Waite-Smith（1909，公有领域）</span>
        </div>
      </div>
    </div>,
    document.body,
  )
}

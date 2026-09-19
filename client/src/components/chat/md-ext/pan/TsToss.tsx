/**
 * M54-C t1/t2：摇卦台 TsToss（§5.1 / 5.2 / 5.7）——亲手摇卦（三枚铜钱 × 六爻，逐次点击成卦）
 * 与报数起卦页签。产出一律为草稿（模板 1/2）交外壳回填 Composer，不自动发送；报数不本地
 * 预测卦名（数字映射规则不在卡格式内，交工具复算——诚实边界）；摇卦的本卦 / 变卦名取本地
 * 64 卦表映射（与工具同源表）。
 *
 * 状态机（§5.7）：idle --开始（新种子）--> tossing(i=0..5) --第 6 爻定--> complete --重摇全卦--> idle；
 * 存储 `ma:pn:toss`（session）只存种子与进度（结果恒由 mulberry32(seed) 现推，与工具逐位一致）；
 * 刷新 / 关闭重开按进度恢复；动效 600ms 翻转（80ms 错峰），reduced-motion / quiet-mode 直出终态；
 * 空格 / 回车 = 摇下一爻（idle 时为开始）；aria-live 逐爻播报，对照模式追加一致 / 不一致。
 */
import * as React from 'react'
import { createPortal } from 'react-dom'
import { useUiStore } from '../../../../stores/ui-store'
import { readStored, writeStored } from '../../../scene/persist'
import { newSeed, tossGua, type TossYao } from './coin'
import { guaNameOf } from './hex'
import { MiniGua, PN_POS_LABEL, yaoTitle } from './parts'

export const TOSS_KEY = 'ma:pn:toss'

const YAO_SUM_NAME: Record<number, string> = { 6: '老阴', 7: '少阳', 8: '少阴', 9: '老阳' }

/** 摇卦进行态（session）：只存种子与进度，不存逐爻结果（§5.7） */
export interface TossSaved {
  seed: number | null
  question: string
  done: number
  startedAt: number
}

function readSaved(): TossSaved | null {
  const v = readStored<TossSaved | null>('session', TOSS_KEY, null)
  if (!v || typeof v !== 'object') return null
  if (v.seed !== null && typeof v.seed !== 'number') return null
  return {
    seed: v.seed === null ? null : v.seed >>> 0,
    question: typeof v.question === 'string' ? v.question : '',
    done: typeof v.done === 'number' && v.done >= 0 && v.done <= 6 ? Math.floor(v.done) : 0,
    startedAt: typeof v.startedAt === 'number' ? v.startedAt : 0,
  }
}

function save(next: TossSaved): void {
  writeStored('session', TOSS_KEY, next)
}

/** 仪式种子（§5.1）：crypto 优先；环境缺失回退 newSeed（仍为 32 位正整数） */
function freshSeed(): number {
  try {
    const a = new Uint32Array(1)
    crypto.getRandomValues(a)
    return a[0]! >>> 0
  } catch {
    return newSeed()
  }
}

function prefersReduced(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/** 铭牌行 / 播报文本：`三爻 少阴 ▬ ▬`（动爻追加 · 动） */
function yaoLine(y: TossYao): string {
  return `${PN_POS_LABEL[y.pos - 1]}爻 ${YAO_SUM_NAME[y.sum] ?? ''} ${y.yin ? '▬ ▬' : '▬▬▬'}${y.dong ? ' · 动' : ''}`
}

/** 对照基线（外壳从已有卦盘派生：GuaBoard / chartboard 面板内卦盘） */
export interface TsTossCompare {
  /** 基线标题（本卦名） */
  title: string
  /** 盘面卡六爻（初 → 上；缺段不标点） */
  yao: Array<{ yin: boolean }>
}

export interface TsTossProps {
  open: boolean
  onClose: () => void
  /** 请解草稿（模板 1 / 2）——外壳回填 Composer，不自动发送 */
  onDone: (draft: string) => void
  /** 第 6 爻定（成卦）时通知；恢复 / 重摇路径不触发（外壳记研习足迹用） */
  onThrow?: () => void
  /** 对照基线；缺省不显示对照 */
  compare?: TsTossCompare | null
}

export function TsToss({ open, onClose, onDone, onThrow, compare }: TsTossProps): React.JSX.Element | null {
  const quiet = useUiStore((s) => s.quietMode)
  const [seed, setSeed] = React.useState<number | null>(null)
  const [done, setDone] = React.useState(0)
  const [question, setQuestion] = React.useState('')
  const [startedAt, setStartedAt] = React.useState(0)
  const [tab, setTab] = React.useState<'coin' | 'number'>('coin')
  const [flipping, setFlipping] = React.useState(false)
  const [live, setLive] = React.useState('')
  const [numA, setNumA] = React.useState('')
  const [numB, setNumB] = React.useState('')
  const [numErr, setNumErr] = React.useState('')
  const flipTimer = React.useRef<number | null>(null)
  const panelRef = React.useRef<HTMLDivElement | null>(null)

  const result = seed !== null ? tossGua(seed) : null
  const lastYao = result && done > 0 ? result.yao[done - 1]! : null
  const tossing = seed !== null && done < 6
  const complete = seed !== null && done >= 6

  // 打开：按进度恢复（关闭 / 刷新保留进度，可续）；焦点入台（键盘：空格 / 回车摇卦）
  React.useEffect(() => {
    if (!open) return
    const s = readSaved()
    if (s) {
      if (s.seed !== null) {
        setSeed(s.seed)
        setDone(s.done)
        setStartedAt(s.startedAt)
      }
      setQuestion(s.question)
    }
    panelRef.current?.focus({ preventScroll: true })
  }, [open])

  // 焦点约束（模态性，M54 续完善）：Tab 在首尾环回弹（尾→首 / 首→尾，含焦点在台外时拉入）；
  // 焦点逃逸弹窗外（focusin）拉回——轻量 trap（配合遮罩点击 / Escape 关闭）
  React.useEffect(() => {
    if (!open) return
    /** 台内可聚焦元素（按 DOM 序；动态计算——面板为 portal 末尾元素，浏览器无自然环回） */
    const focusables = (): HTMLElement[] => {
      const panel = panelRef.current
      if (!panel) return []
      return Array.from(
        panel.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]'),
      ).filter((el) => el.getAttribute('tabindex') !== '-1')
    }
    const onFocusIn = (e: FocusEvent): void => {
      const panel = panelRef.current
      if (!panel || !(e.target instanceof Node)) return
      if (!panel.contains(e.target)) panel.focus({ preventScroll: true })
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return
      const panel = panelRef.current
      if (!panel) return
      const items = focusables()
      if (items.length === 0) return
      const first = items[0]!
      const last = items[items.length - 1]!
      const active = document.activeElement
      if (!(active instanceof Node) || !panel.contains(active)) {
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

  // 卸载清理翻转定时器
  React.useEffect(
    () => () => {
      if (flipTimer.current !== null) window.clearTimeout(flipTimer.current)
    },
    [],
  )

  const start = (): void => {
    const s = freshSeed()
    const t = Date.now()
    setSeed(s)
    setDone(0)
    setStartedAt(t)
    setLive('')
    save({ seed: s, question, done: 0, startedAt: t })
  }

  const land = (next: number): void => {
    if (seed === null) return
    setDone(next)
    const y = tossGua(seed).yao[next - 1]!
    let text = yaoLine(y)
    const base = compare?.yao[next - 1]
    if (base) text += base.yin === y.yin ? ' · 与盘面一致' : ' · 与盘面不一致'
    setLive(text)
    save({ seed, question, done: next, startedAt })
    if (next >= 6) onThrow?.()
  }

  const tossNext = (): void => {
    if (seed === null || flipping || done >= 6) return
    if (quiet || prefersReduced()) {
      land(done + 1)
      return
    }
    setFlipping(true)
    flipTimer.current = window.setTimeout(() => {
      flipTimer.current = null
      setFlipping(false)
      land(done + 1)
    }, 600)
  }

  /** 重摇全卦（仅新种子，无单爻撤销——保仪式一致性，§5.7） */
  const reset = (): void => {
    if (flipTimer.current !== null) {
      window.clearTimeout(flipTimer.current)
      flipTimer.current = null
    }
    setFlipping(false)
    setSeed(null)
    setDone(0)
    setLive('')
    save({ seed: null, question, done: 0, startedAt: 0 })
  }

  const askCoin = (): void => {
    if (seed === null || done < 6) return
    const q = question.trim() || '（未注明）'
    onDone(`我亲手摇了六爻（种子 ${seed}，所问：「${q}」）。请用 gua_pan（method=coin，seed=${seed}）起卦，逐爻核对后解读。`)
    onClose()
  }

  const okNum = (n: number): boolean => Number.isInteger(n) && n >= 1 && n <= 99
  const askNumber = (): void => {
    const a = Number(numA)
    const b = Number(numB)
    if (numA.trim() === '' || numB.trim() === '' || !okNum(a) || !okNum(b)) {
      setNumErr('两数均须为 1-99 的整数')
      return
    }
    setNumErr('')
    onDone(`报数起卦：${a}、${b}。请用 gua_pan（method=number，numbers=[${a},${b}]）起卦并解读。`)
    onClose()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
      return
    }
    if (tab !== 'coin' || (e.key !== ' ' && e.key !== 'Enter')) return
    const t = e.target as HTMLElement | null
    if (t && t.closest('button, input, textarea, select, a')) return
    if (seed === null) {
      e.preventDefault()
      start()
    } else if (done < 6) {
      e.preventDefault()
      tossNext()
    }
  }

  if (!open) return null

  const coinFace = (i: number): string => {
    if (flipping) return '?'
    if (!lastYao) return ''
    return lastYao.coins[i] === 2 ? '字' : '背'
  }

  // Portal 到 body：避免被虚拟列表行的 transform 封层（stacking context），确保遮罩盖过波次条 / 回到最新
  return createPortal(
    <div className="pn-toss-mask" role="presentation" onClick={onClose}>
      <div
        ref={panelRef}
        className="pn-toss"
        role="dialog"
        aria-modal="true"
        aria-label="摇卦台"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="pn-toss-head">
          <span className="pn-toss-title">摇卦台</span>
          <span className="pn-toss-sub">种子公开 · 与研习师工具逐位同源</span>
          <button type="button" className="pn-toss-close" aria-label="关闭摇卦台" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="pn-toss-tabs" role="tablist" aria-label="起卦方式">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'coin'}
            className={`pn-toss-tab${tab === 'coin' ? ' is-on' : ''}`}
            onClick={() => setTab('coin')}
          >
            亲手摇卦
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'number'}
            className={`pn-toss-tab${tab === 'number' ? ' is-on' : ''}`}
            onClick={() => setTab('number')}
          >
            报数起卦
          </button>
        </div>

        {tab === 'coin' ? (
          <div className="pn-toss-pane" role="tabpanel" aria-label="亲手摇卦">
            {seed === null ? (
              <div className="pn-toss-idle">
                <label className="pn-toss-q">
                  <span>所问（可选）</span>
                  <input
                    value={question}
                    maxLength={80}
                    placeholder="例：此事推进当注意什么"
                    onChange={(e) => {
                      setQuestion(e.target.value)
                      save({ seed, question: e.target.value, done, startedAt })
                    }}
                  />
                </label>
                <button type="button" className="pn-toss-btn" onClick={start}>
                  开始（生成种子）
                </button>
                <p className="pn-toss-hint">三枚铜钱 × 六爻，逐爻亲手摇；空格 / 回车同样可摇。</p>
              </div>
            ) : (
              <>
                <div className={`pn-coins${flipping ? ' is-flipping' : ''}`} aria-hidden="true">
                  {[0, 1, 2].map((i) => (
                    <span key={i} className="pn-coin" style={{ animationDelay: `${i * 80}ms` }}>
                      {coinFace(i)}
                    </span>
                  ))}
                </div>

                {question.trim() !== '' ? <div className="pn-toss-qline">所问：{question.trim()}</div> : null}

                {tossing ? (
                  <button type="button" className="pn-toss-btn" disabled={flipping} onClick={tossNext}>
                    {flipping ? '摇卦中…' : `摇${PN_POS_LABEL[done]}爻`}
                  </button>
                ) : null}

                {done > 0 ? (
                  <div className="pn-toss-list" role="list" aria-label="已定爻">
                    {result!.yao.slice(0, done).map((y) => (
                      <div key={y.pos} role="listitem" className={`pn-toss-yao${y.dong ? ' is-dong' : ''}`}>
                        <span className="pn-toss-yao-pos">{PN_POS_LABEL[y.pos - 1]}爻</span>
                        <span className="pn-toss-yao-name">{YAO_SUM_NAME[y.sum]}</span>
                        <span className="pn-toss-yao-line" aria-hidden="true">
                          {y.yin ? '▬ ▬' : '▬▬▬'}
                        </span>
                        {y.dong ? <span className="pn-toss-yao-dong">动</span> : null}
                      </div>
                    ))}
                  </div>
                ) : null}

                {complete && result ? (
                  <div className="pn-toss-done-pane">
                    <div className="pn-toss-reveal">
                      <span className="pn-toss-ben">本卦 {guaNameOf(result.bits)}</span>
                      {result.dongYao.length > 0 ? (
                        <>
                          <span className="pn-toss-sep">｜</span>
                          <span className="pn-toss-bian">变卦 {guaNameOf(result.bianBits)}</span>
                        </>
                      ) : (
                        <span className="pn-toss-nodong">无动爻</span>
                      )}
                    </div>
                    <div className="pn-toss-mini">
                      <MiniGua yao={result.yao} />
                    </div>
                    {result.dongYao.length > 0 ? (
                      <div className="pn-toss-donglist">
                        动爻 {result.yao.filter((y) => y.dong).map((y) => yaoTitle(y)).join('、')}
                      </div>
                    ) : null}

                    {compare ? (
                      <div className="pn-toss-cmp" role="region" aria-label={`与「${compare.title}」对照`}>
                        <div className="pn-toss-cmp-cap">对照：{compare.title}（逐爻标点）</div>
                        <div className="pn-toss-cmp-list">
                          {[...result.yao].reverse().map((y) => {
                            const base = compare.yao[y.pos - 1]
                            const same = base ? base.yin === y.yin : null
                            return (
                              <div
                                key={y.pos}
                                className={`pn-toss-cmp-row${same === null ? '' : same ? ' is-match' : ' is-diff'}`}
                              >
                                <span className="pn-toss-cmp-pos">{yaoTitle(y)}</span>
                                <span className="pn-toss-cmp-mine">我 {y.yin ? '阴 ▬ ▬' : '阳 ▬▬▬'}</span>
                                <span className="pn-toss-cmp-base">{base ? `盘 ${base.yin ? '阴 ▬ ▬' : '阳 ▬▬▬'}` : '盘 —'}</span>
                                <span className="pn-toss-cmp-mark">{same === null ? '' : same ? '一致' : '不一致'}</span>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    ) : null}

                    <div className="pn-toss-actions">
                      <button type="button" className="pn-toss-btn pn-toss-done" onClick={askCoin}>
                        以此卦请解
                      </button>
                      <button type="button" className="pn-toss-ghost" onClick={reset}>
                        重摇全卦
                      </button>
                    </div>
                  </div>
                ) : null}
              </>
            )}

            <span className="pn-toss-live" aria-live="polite">
              {live}
            </span>
            {seed !== null ? <div className="pn-toss-seed">种子 {seed}</div> : null}
          </div>
        ) : (
          <div className="pn-toss-pane" role="tabpanel" aria-label="报数起卦">
            <div className="pn-toss-nums">
              <label className="pn-toss-num">
                <span>第一数</span>
                <input
                  inputMode="numeric"
                  value={numA}
                  placeholder="1-99"
                  onChange={(e) => setNumA(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      askNumber()
                    }
                  }}
                />
              </label>
              <label className="pn-toss-num">
                <span>第二数</span>
                <input
                  inputMode="numeric"
                  value={numB}
                  placeholder="1-99"
                  onChange={(e) => setNumB(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      askNumber()
                    }
                  }}
                />
              </label>
            </div>
            {numErr ? (
              <p className="pn-toss-err" role="alert">
                {numErr}
              </p>
            ) : null}
            <button type="button" className="pn-toss-btn" onClick={askNumber}>
              以此两数起卦
            </button>
            <p className="pn-toss-hint">不本地预测卦名——数字映射规则不在卡格式内，交研习师工具复算（诚实边界）。</p>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

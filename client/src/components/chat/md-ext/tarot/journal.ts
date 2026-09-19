/**
 * M78：抽牌手记（session 作用域，本地私密，不落库）——见 docs/tarot-ritual-design.md §8.1。
 *
 * 条目只存复现参数（spread/seed/cut/picks）不存牌面（牌面恒由参数现推）；
 * 成阵自动记录（同参数幂等去重）；足迹（抽过 / 遇见 / 请解）从条目派生（只读小字，无奖励机制）。
 */
import { readStored, writeStored } from '../../../scene/persist'
import { ritualDraw, DECK, type SpreadId } from './deck'

export interface JournalEntry {
  id: string
  at: number
  question: string
  spread: SpreadId
  seed: number
  cut: number
  picks: number[]
  /** 已请解（回填草稿）次数 */
  asked: number
}

export function journalKey(sessionId: string): string {
  return `ma:tc:journal:${sessionId || '-'}`
}

const EMPTY: JournalEntry[] = []

/** 幂等键（同参数同问题视为同一次抽牌） */
function dedupKey(e: Pick<JournalEntry, 'spread' | 'seed' | 'cut' | 'picks'>): string {
  return `${e.spread}|${e.seed}|${e.cut}|${e.picks.join(',')}`
}

function normalize(raw: unknown): JournalEntry[] {
  if (!Array.isArray(raw)) return [...EMPTY]
  const out: JournalEntry[] = []
  for (const v of raw) {
    if (!v || typeof v !== 'object') continue
    const o = v as Partial<JournalEntry>
    if (typeof o.id !== 'string' || typeof o.seed !== 'number' || !Array.isArray(o.picks)) continue
    out.push({
      id: o.id,
      at: typeof o.at === 'number' ? o.at : 0,
      question: typeof o.question === 'string' ? o.question : '',
      spread: (['single', 'three', 'cross'] as string[]).includes(o.spread as string) ? (o.spread as SpreadId) : 'three',
      seed: o.seed >>> 0,
      cut: typeof o.cut === 'number' && o.cut >= 0 && o.cut <= 2 ? Math.floor(o.cut) : 0,
      picks: o.picks.filter((p) => Number.isInteger(p) && p >= 0 && p < DECK.length),
      asked: typeof o.asked === 'number' && o.asked > 0 ? Math.floor(o.asked) : 0,
    })
  }
  return out
}

export function readJournal(sessionId: string): JournalEntry[] {
  return normalize(readStored<unknown>('session', journalKey(sessionId), null))
}

export function writeJournal(sessionId: string, list: JournalEntry[]): void {
  writeStored('session', journalKey(sessionId), list)
}

/** 成阵记录（幂等：同参数已存在则返回既有条目） */
export function recordDraw(
  sessionId: string,
  e: Omit<JournalEntry, 'id' | 'at' | 'asked'>,
): JournalEntry {
  const list = readJournal(sessionId)
  const key = dedupKey(e)
  const found = list.find((x) => dedupKey(x) === key)
  if (found) return found
  const entry: JournalEntry = { ...e, id: `d${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`, at: Date.now(), asked: 0 }
  writeJournal(sessionId, [...list, entry])
  return entry
}

/** 请解一次（回填草稿时调用） */
export function recordAsk(sessionId: string, id: string): void {
  const list = readJournal(sessionId)
  writeJournal(
    sessionId,
    list.map((x) => (x.id === id ? { ...x, asked: x.asked + 1 } : x)),
  )
}

export function removeEntry(sessionId: string, id: string): void {
  writeJournal(
    sessionId,
    readJournal(sessionId).filter((x) => x.id !== id),
  )
}

/** 条目牌面（由参数现推——与工具逐位一致） */
export function entryCards(e: JournalEntry): ReturnType<typeof ritualDraw> {
  return ritualDraw(e.spread, e.seed, e.cut, e.picks)
}

/** 研习足迹（只读小字：抽过 / 遇见 / 请解；无奖励、无提醒） */
export function journalStats(sessionId: string): { draws: number; seen: number; asked: number } {
  const list = readJournal(sessionId)
  const names = new Set<string>()
  for (const e of list) {
    for (const c of ritualDraw(e.spread, e.seed, e.cut, e.picks)) names.add(c.name)
  }
  return { draws: list.length, seen: names.size, asked: list.reduce((n, e) => n + e.asked, 0) }
}

/** 足迹文案（空足迹 → ''） */
export function formatStats(s: { draws: number; seen: number; asked: number }): string {
  const parts: string[] = []
  if (s.draws > 0) parts.push(`抽过 ${s.draws} 阵`)
  if (s.seen > 0) parts.push(`遇见 ${s.seen}/${DECK.length} 张`)
  if (s.asked > 0) parts.push(`请解 ${s.asked} 次`)
  return parts.join(' · ')
}

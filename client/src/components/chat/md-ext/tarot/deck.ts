/**
 * M78：塔罗复现层（deck.ts）——见 docs/tarot-ritual-design.md §6。
 *
 * 与 server/src/tools/tarot.ts 逐字同源（78 张表 / Fisher-Yates / 正逆位序列 / cut 旋转 / picks 取牌），
 * 跨端一致性由交叉测试向量锁定（client/tests/m78-deck.test.ts ↔ server/tests/m78-tarot-ritual.test.ts，期望值字面相同）。
 * 纪律：本文件的表与算法任何变更必须同步 server 侧并更新向量；mulberry32 常数勿改。
 */
import { readStored, writeStored } from '../../../scene/persist'

/** 确定性 PRNG（与 server/src/tools/tarot.ts / pan/coin.ts 逐字一致；常数勿改） */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------- 牌表（与 server 一致）

/** 大阿卡纳 22 张（名称 + 三关键词） */
const MAJOR: Array<{ name: string; keywords: [string, string, string] }> = [
  { name: '愚者', keywords: ['起点', '冒险', '纯真'] },
  { name: '魔术师', keywords: ['创造', '意志', '行动'] },
  { name: '女祭司', keywords: ['直觉', '静观', '潜意识'] },
  { name: '皇后', keywords: ['丰饶', '滋养', '感性'] },
  { name: '皇帝', keywords: ['秩序', '权威', '结构'] },
  { name: '教皇', keywords: ['传统', '指引', '信念'] },
  { name: '恋人', keywords: ['联结', '选择', '价值'] },
  { name: '战车', keywords: ['前进', '掌控', '意志'] },
  { name: '力量', keywords: ['勇气', '柔韧', '克制'] },
  { name: '隐士', keywords: ['内省', '独处', '求索'] },
  { name: '命运之轮', keywords: ['转机', '周期', '时机'] },
  { name: '正义', keywords: ['公正', '权衡', '责任'] },
  { name: '倒吊人', keywords: ['暂停', '换位', '舍弃'] },
  { name: '死神', keywords: ['结束', '转化', '重生'] },
  { name: '节制', keywords: ['平衡', '调和', '耐心'] },
  { name: '恶魔', keywords: ['束缚', '执念', '欲望'] },
  { name: '塔', keywords: ['突变', '瓦解', '觉醒'] },
  { name: '星星', keywords: ['希望', '疗愈', '指引'] },
  { name: '月亮', keywords: ['迷惘', '幻象', '直觉'] },
  { name: '太阳', keywords: ['生机', '成就', '明朗'] },
  { name: '审判', keywords: ['召唤', '清算', '觉醒'] },
  { name: '世界', keywords: ['完成', '整合', '圆满'] },
]

/** 小阿卡纳：四花色 × 十四阶（阶义 2 词 + 花色域词 = 每牌 3 关键词） */
const SUITS: Array<{ name: string; domain: string; slug: string }> = [
  { name: '权杖', domain: '行动', slug: 'wands' },
  { name: '圣杯', domain: '情感', slug: 'cups' },
  { name: '宝剑', domain: '思维', slug: 'swords' },
  { name: '星币', domain: '物质', slug: 'pents' },
]
const RANKS: Array<{ name: string; words: [string, string] }> = [
  { name: '首牌', words: ['起点', '潜能'] },
  { name: '二', words: ['平衡', '抉择'] },
  { name: '三', words: ['成长', '协作'] },
  { name: '四', words: ['稳定', '根基'] },
  { name: '五', words: ['冲突', '变动'] },
  { name: '六', words: ['和谐', '修复'] },
  { name: '七', words: ['评估', '坚持'] },
  { name: '八', words: ['推进', '精进'] },
  { name: '九', words: ['接近', '丰盈'] },
  { name: '十', words: ['完成', '循环'] },
  { name: '侍从', words: ['学习', '消息'] },
  { name: '骑士', words: ['行动', '追逐'] },
  { name: '王后', words: ['内化', '滋养'] },
  { name: '国王', words: ['掌控', '成熟'] },
]

/** 牌（含位图 slug：`major-00` / `wands-01` …，见 docs 附录 B） */
export interface DeckCard {
  /** 0-77（与 server DECK 顺序一致） */
  index: number
  name: string
  keywords: string[]
  /** 大阿卡纳序号（0-21）；小阿卡纳 undefined */
  majorIndex?: number
  suit?: string
  rank?: string
  /** 位图文件名（不含扩展名） */
  slug: string
}

function buildDeck(): DeckCard[] {
  const deck: DeckCard[] = MAJOR.map((c, i) => ({
    index: i,
    name: c.name,
    keywords: [...c.keywords],
    majorIndex: i,
    slug: `major-${String(i).padStart(2, '0')}`,
  }))
  SUITS.forEach((suit, si) => {
    RANKS.forEach((rank, ri) => {
      deck.push({
        index: 22 + si * 14 + ri,
        name: `${suit.name}${rank.name}`,
        keywords: [rank.words[0], rank.words[1], suit.domain],
        suit: suit.name,
        rank: rank.name,
        slug: `${suit.slug}-${String(ri + 1).padStart(2, '0')}`,
      })
    })
  })
  return deck
}

export const DECK: DeckCard[] = buildDeck()
export const DECK_SIZE = 78
export const MAJOR_COUNT = 22
export { SUITS, RANKS }

// ---------------------------------------------------------------- 牌阵

export type SpreadId = 'single' | 'three' | 'cross'

/** 牌阵与牌位语义（hints 为仪式提示语——专业承载，只讲位置含义不给判断） */
export const SPREADS: Record<SpreadId, { name: string; positions: string[]; hints: string[] }> = {
  single: {
    name: '单张牌阵',
    positions: ['当下'],
    hints: ['当下：此刻最值得留意的处境关键词'],
  },
  three: {
    name: '三张牌阵',
    positions: ['过去', '现在', '未来'],
    hints: ['过去：事情的来处与因由', '现在：当前的张力与处境', '未来：趋势的参考方向（非定数）'],
  },
  cross: {
    name: '五张十字阵',
    positions: ['核心', '横越', '根基', '过去', '未来'],
    hints: ['核心：问题的心脏', '横越：横在面前的阻力或助力', '根基：局面的底层基础', '过去：正在退场的旧力量', '未来：正在成形的走向'],
  },
}

export const SPREAD_LIST: Array<{ id: SpreadId; name: string; count: number; positions: string[] }> = (
  Object.keys(SPREADS) as SpreadId[]
).map((id) => ({ id, name: SPREADS[id].name, count: SPREADS[id].positions.length, positions: SPREADS[id].positions }))

// ---------------------------------------------------------------- 复现推导（与工具逐位同源）

export interface RitualCard {
  position: string
  name: string
  orientation: '正位' | '逆位'
  keywords: string[]
  slug: string
}

/** 切牌旋转（点第 c 堆放最上；每堆 26 张；c = 0 → 原序）——与 server cutDeck 一致 */
function cutDeck<T>(deck: T[], cut: number): T[] {
  const pile = DECK_SIZE / 3
  if (cut === 0) return deck
  if (cut === 1) return [...deck.slice(pile, pile * 2), ...deck.slice(pile * 2), ...deck.slice(0, pile)]
  return [...deck.slice(pile * 2), ...deck.slice(0, pile), ...deck.slice(pile, pile * 2)]
}

/**
 * 同源推导：洗牌（Fisher-Yates）→ 78 张逐张定正逆位（「牌带正逆位」）→ cut 旋转 → picks 取牌。
 * 与 server drawTarot(spread, seed, cut, picks) 逐位一致（交叉测试向量锁定）。
 */
export function ritualDraw(spread: SpreadId, seed: number, cut: number, picks: number[]): RitualCard[] {
  const def = SPREADS[spread]
  const rand = mulberry32(seed)
  const deck = DECK.map((c) => ({ ...c }))
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const tmp = deck[i]!
    deck[i] = deck[j]!
    deck[j] = tmp
  }
  const oriented = deck.map((c) => ({ ...c, orientation: (rand() < 0.5 ? '正位' : '逆位') as '正位' | '逆位' }))
  const rotated = cutDeck(oriented, cut)
  return def.positions.map((position, i) => {
    const card = rotated[picks[i]!]!
    return { position, name: card.name, orientation: card.orientation, keywords: card.keywords, slug: card.slug }
  })
}

/** 仪式种子（crypto 优先；环境缺失回退——与摇卦台 freshSeed 同口径，32 位正整数） */
export function freshSeed(): number {
  try {
    const a = new Uint32Array(1)
    crypto.getRandomValues(a)
    return a[0]! >>> 0
  } catch {
    return (Date.now() ^ Math.floor(Math.random() * 0x100000000)) >>> 0
  }
}

/** 牌名 → 位图 slug（未知牌名回退空串 = 程序化牌面） */
export function cardSlugOf(name: string): string {
  return DECK.find((c) => c.name === name)?.slug ?? ''
}

/** 位图 URL（开发与生产同路径；缺图由 TarotCardFace 降级链兜底） */
export function cardImageUrl(slug: string): string {
  return slug === '' ? '' : `/tarot/rws/${slug}.jpg`
}

// ---------------------------------------------------------------- 进行中快照（session 作用域）

/** 抽牌台进行态（只存参数与进度；牌面恒由 seed/cut/picks 现推——与摇卦台同口径） */
export interface RitualSaved {
  stage: 'idle' | 'shuffle' | 'cut' | 'draw' | 'reveal' | 'complete'
  spread: SpreadId
  question: string
  seed: number | null
  shuffleCount: number
  cut: number
  picks: number[]
  revealed: number
}

export const RITUAL_KEY = 'ma:tc:ritual'

const EMPTY_RITUAL: RitualSaved = {
  stage: 'idle',
  spread: 'three',
  question: '',
  seed: null,
  shuffleCount: 0,
  cut: 0,
  picks: [],
  revealed: 0,
}

/** 读取进行态（容错：非法数据回退空态——与 trail.ts 同纪律） */
export function readRitual(): RitualSaved {
  const raw = readStored<unknown>('session', RITUAL_KEY, null)
  if (!raw || typeof raw !== 'object') return { ...EMPTY_RITUAL }
  const o = raw as Partial<RitualSaved>
  const stage = (['idle', 'shuffle', 'cut', 'draw', 'reveal', 'complete'] as const).includes(o.stage as never)
    ? (o.stage as RitualSaved['stage'])
    : 'idle'
  const spread = (Object.keys(SPREADS) as string[]).includes(o.spread as string) ? (o.spread as SpreadId) : 'three'
  const picks = Array.isArray(o.picks) ? o.picks.filter((p) => Number.isInteger(p) && (p as number) >= 0 && (p as number) < DECK_SIZE) : []
  return {
    stage,
    spread,
    question: typeof o.question === 'string' ? o.question : '',
    seed: typeof o.seed === 'number' ? o.seed >>> 0 : null,
    shuffleCount: typeof o.shuffleCount === 'number' && o.shuffleCount >= 0 ? Math.floor(o.shuffleCount) : 0,
    cut: typeof o.cut === 'number' && o.cut >= 0 && o.cut <= 2 ? Math.floor(o.cut) : 0,
    picks: picks as number[],
    revealed: typeof o.revealed === 'number' && o.revealed >= 0 ? Math.floor(o.revealed) : 0,
  }
}

export function writeRitual(next: RitualSaved): void {
  writeStored('session', RITUAL_KEY, next)
}

export { EMPTY_RITUAL }

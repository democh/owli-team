/**
 * M69-B2：塔罗抽牌工具（tarot 塔罗研习 · tarot_draw）——见 docs/scene-expansion-v2-design.md §4.2。
 * M78：复现三元组扩展（seed + cut + picks）——见 docs/tarot-ritual-design.md §5：
 * 亲手抽牌台交出「洗牌种子 + 切牌 + 选牌格位」，本工具按同一算法逐位复算；
 * cut / picks 缺省（0 / [0..N-1]）时与旧版逐位一致（既有 golden 不动）。
 *
 * - 纯计算只读（无 IO / 无网络 / 无副作用）；tier=deferred，经 tool_search（「塔罗 / 抽牌 / 牌阵」）激活；
 * - 78 张全表（22 大阿卡纳 + 56 小阿卡纳 = 4 花色 × 14 阶）；正逆位各 50%；
 * - 随机策略：mulberry32 确定性 PRNG——种子缺省随机生成并回显，同种子牌序与正逆位逐位复现；
 * - 表述纪律（与 gua_pan 同口径）：结果为文化研习参考，不承诺预测；禁止模型心算造牌；
 * - 输出含可直接整卡复制的「::: cards」牌阵卡模板（M69 容器渲染）。
 */
import { randomInt } from 'node:crypto'
import { z } from 'zod'
import type { AgentTool, ToolResult } from './registry.js'

/** mulberry32：确定性 PRNG（与 dice_roll 同实现，同种子 → 同序列） */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------- 牌表

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
const SUITS: Array<{ name: string; domain: string }> = [
  { name: '权杖', domain: '行动' },
  { name: '圣杯', domain: '情感' },
  { name: '宝剑', domain: '思维' },
  { name: '星币', domain: '物质' },
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

/** 78 张全牌（大阿卡纳 + 小阿卡纳生成） */
function buildDeck(): Array<{ name: string; keywords: string[] }> {
  const deck: Array<{ name: string; keywords: string[] }> = MAJOR.map((c) => ({ name: c.name, keywords: [...c.keywords] }))
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ name: `${suit.name}${rank.name}`, keywords: [rank.words[0], rank.words[1], suit.domain] })
    }
  }
  return deck
}

const DECK = buildDeck()

/** 牌阵定义（v1 三阵：单张 / 三张 / 五张十字阵） */
const SPREADS: Record<string, { name: string; positions: string[] }> = {
  single: { name: '单张牌阵', positions: ['当下'] },
  three: { name: '三张牌阵', positions: ['过去', '现在', '未来'] },
  cross: { name: '五张十字阵', positions: ['核心', '横越', '根基', '过去', '未来'] },
}

// ---------------------------------------------------------------- 抽牌

export interface TarotCard {
  position: string
  name: string
  orientation: '正位' | '逆位'
  keywords: string[]
}

export interface TarotResult {
  spread: string
  spreadName: string
  cards: TarotCard[]
  seed: number
  /** M78：切牌（0 = 原序；1 / 2 = 第 c 堆置顶——牌堆旋转，每堆 26 张） */
  cut: number
  /** M78：亲手选牌格位（洗牌后牌堆索引序列；牌位序 = picks 顺序；缺省 [0..N-1]） */
  picks: number[]
}

const DECK_SIZE = 78
/** 切牌三堆：每堆 26 张 */
const CUT_PILE = DECK_SIZE / 3

/** M78：选牌参数规范化与校验（缺省 = 洗好后依次取前 N 张，与旧版一致） */
function normPicks(picksInput: number[] | undefined, n: number): number[] {
  if (picksInput === undefined) return Array.from({ length: n }, (_, i) => i)
  const bad = picksInput.length !== n || new Set(picksInput).size !== n || picksInput.some((p) => !Number.isInteger(p) || p < 0 || p >= DECK_SIZE)
  if (bad) throw new Error(`选牌参数无效：须为不重复的 0-${DECK_SIZE - 1} 整数，且数量等于牌阵张数（${n}）`)
  return [...picksInput]
}

/** M78：切牌旋转（点第 c 堆放最上；c = 0 → 原序） */
function cutDeck<T>(deck: T[], cut: number): T[] {
  if (cut === 0) return deck
  if (cut === 1) return [...deck.slice(CUT_PILE, CUT_PILE * 2), ...deck.slice(CUT_PILE * 2), ...deck.slice(0, CUT_PILE)]
  return [...deck.slice(CUT_PILE * 2), ...deck.slice(0, CUT_PILE), ...deck.slice(CUT_PILE, CUT_PILE * 2)]
}

/** 洗牌抽牌（Fisher-Yates；同种子牌序与正逆位逐位复现）。
 * M78：复现三元组 seed + cut + picks——缺省（cut=0 / picks=[0..N-1]）与旧版逐位一致；
 * 正逆位在洗牌后一次性为 78 张定妥（「牌带正逆位」），切牌旋转与选牌只搬运不重置。 */
export function drawTarot(spread: string, seedInput?: number, cutInput?: number, picksInput?: number[]): TarotResult {
  const def = SPREADS[spread]
  if (!def) throw new Error(`牌阵无法识别：「${spread}」（可选：single / three / cross）`)
  const n = def.positions.length
  const cut = cutInput ?? 0
  if (!Number.isInteger(cut) || cut < 0 || cut > 2) throw new Error('切牌参数须为 0 / 1 / 2（第 c 堆放最上）')
  const picks = normPicks(picksInput, n)
  const seed = seedInput !== undefined ? Math.abs(Math.trunc(seedInput)) : randomInt(1, 0x7fffffff)
  const rand = mulberry32(seed)
  const deck = DECK.map((c) => ({ ...c }))
  // Fisher-Yates 洗牌（77 次 rand——常数序列勿改）
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const tmp = deck[i]!
    deck[i] = deck[j]!
    deck[j] = tmp
  }
  // 78 张逐张定正逆位（第 78..155 次 rand；与旧版「前 N 张逐张定」对位置 k 同为第 78+k 次）
  const oriented = deck.map((c) => ({ ...c, orientation: (rand() < 0.5 ? '正位' : '逆位') as TarotCard['orientation'] }))
  const rotated = cutDeck(oriented, cut)
  const cards: TarotCard[] = def.positions.map((position, i) => {
    const card = rotated[picks[i]!]!
    return { position, name: card.name, orientation: card.orientation, keywords: card.keywords }
  })
  return { spread, spreadName: def.name, cards, seed, cut, picks }
}

/** 容器行：`- 牌位 | 牌名 | 正逆位 | 关键词` */
const cardLine = (c: TarotCard): string => `- ${c.position} | ${c.name} | ${c.orientation} | ${c.keywords.join(' · ')}`

/** 工具输出：明细 + 可直接整卡复制的「::: cards」牌阵卡模板 */
export function tarotDetail(r: TarotResult, question?: string): string {
  const L: string[] = []
  L.push(`塔罗抽牌（${r.spreadName}；种子 ${r.seed}）`)
  if (question) L.push(`所问：${question}`)
  L.push(`牌序：${r.cards.map((c) => c.position).join(' → ')}`)
  for (const c of r.cards) L.push(cardLine(c))
  L.push(`种子：${r.seed}——携带 seed=${r.seed} 重抽牌序与正逆位逐位复现`)
  L.push(`复现三元组：seed=${r.seed} · cut=${r.cut} · picks=[${r.picks.join(',')}]（亲手抽牌的牌面交接口径）`)
  L.push('')
  L.push('牌面卡（复制到回复渲染，整卡原样保留、勿增删字段）：')
  L.push(`::: cards ${r.spreadName}`)
  for (const c of r.cards) L.push(cardLine(c))
  L.push(':::')
  return L.join('\n')
}

const tarotArgs = z.object({
  spread: z.enum(['single', 'three', 'cross']),
  seed: z.number().int().optional(),
  cut: z.number().int().optional(),
  picks: z.array(z.number().int()).optional(),
  question: z.string().optional(),
})

const tarotDrawTool: AgentTool = {
  name: 'tarot_draw',
  tier: 'deferred',
  readOnly: true,
  description:
    '塔罗抽牌（唯一口径；牌序与正逆位必须出自本工具，禁止心算造牌）：输入牌阵（single 单张 / three 三张·过去现在未来 / cross 五张十字阵），可带 seed 复现（同种子牌序与正逆位逐位相同）；用户亲手抽牌时按其给出的复现三元组复算——cut（切牌 0/1/2）与 picks（选牌格位索引序列，长度等于牌阵张数）必须原样传入，逐位核对后解读；question 记录所问。输出各牌位、牌名（78 张全表：22 大阿卡纳 + 4 花色 × 14 阶）、正逆位、关键词与可直接整卡复制的「::: cards」牌阵卡模板。凡是「塔罗 / 抽牌 / 牌阵 / 翻牌」都先用本工具；结果定位为文化研习参考（不承诺预测）。',
  parameters: {
    type: 'object',
    properties: {
      spread: { type: 'string', enum: ['single', 'three', 'cross'], description: '牌阵（single 单张 / three 三张 / cross 五张十字阵）' },
      seed: { type: 'number', description: '随机种子（整数；同种子逐位复现，重抽 / 回放用）' },
      cut: { type: 'number', enum: [0, 1, 2], description: '切牌（0/1/2：第 c 堆放最上；用户亲手抽牌时原样传入，缺省 0）' },
      picks: {
        type: 'array',
        items: { type: 'number' },
        description: '亲手选牌格位（不重复的 0-77 整数，数量等于牌阵张数，按点选顺序对应牌位；缺省依次取前 N 张）',
      },
      question: { type: 'string', description: '所问之事（回显存档）' },
    },
    required: ['spread'],
  },
  schema: tarotArgs,
  async execute(args: z.infer<typeof tarotArgs>): Promise<ToolResult> {
    try {
      const r = drawTarot(args.spread, args.seed, args.cut, args.picks)
      return {
        ok: true,
        summary: `抽牌完成：${r.spreadName}（${r.cards.map((c) => `${c.name}${c.orientation === '正位' ? '' : '·逆'}`).join(' / ')}；种子 ${r.seed} · 切牌 ${r.cut} · 选牌 [${r.picks.join(',')}]）`,
        detail: tarotDetail(r, args.question),
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        ok: false,
        summary: `抽牌失败：${msg}`,
        detail: `抽牌失败：${msg}\n建议：牌阵可选 single / three / cross；种子为整数可复现；cut 为 0/1/2；picks 为不重复 0-77 整数且数量等于牌阵张数`,
      }
    }
  },
}

/** M69：场景玩法工具组（tarot 抽牌）——纯计算只读，tier=deferred 经 tool_search 激活 */
export function createTarotTools(): AgentTool[] {
  return [tarotDrawTool]
}

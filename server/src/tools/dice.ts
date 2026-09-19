/**
 * M69-B2：掷骰工具（trpg 跑团工坊 · dice_roll）——见 docs/scene-expansion-v2-design.md §4.1。
 *
 * - 纯计算只读（无 IO / 无网络 / 无副作用）；tier=deferred，经 tool_search（「掷骰 / 骰子」）激活；
 * - 随机策略（储备方向前置项）：mulberry32 确定性 PRNG——种子缺省随机生成并回显，
 *   同种子逐位可复现（战报存档 / 回放）；禁止模型心算造数；
 * - 防护：骰数 1–100、单骰面 2–1000、修正 ±10000；
 * - 输出含可直接整卡复制的「::: roll」骰卡模板（M69 容器渲染）。
 */
import { randomInt } from 'node:crypto'
import { z } from 'zod'
import type { AgentTool, ToolResult } from './registry.js'

const MAX_COUNT = 100
const MAX_SIDES = 1000
const MAX_MODIFIER = 10000

/** mulberry32：确定性 PRNG（同种子 → 同序列；零依赖） */
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

export interface DiceResult {
  /** 规范化骰式（如 3d6+2） */
  formula: string
  count: number
  sides: number
  modifier: number
  rolls: number[]
  total: number
  seed: number
}

const signed = (n: number): string => (n >= 0 ? `+${n}` : `${n}`)

/** 解析骰式（`d20` / `3d6+2` / `2d10-1`；大小写与空格容错）并掷骰（同种子逐位复现） */
export function rollDice(formula: string, seedInput?: number): DiceResult {
  const m = /^\s*(\d{0,3})\s*[dD]\s*(\d{1,4})\s*([+-]\s*\d{1,6})?\s*$/.exec(formula)
  if (!m) throw new Error(`骰式无法解析：「${formula}」（示例：d20 / 3d6+2 / 2d10-1）`)
  const count = m[1] ? Number(m[1]) : 1
  const sides = Number(m[2])
  const modifier = m[3] ? Number(m[3].replace(/\s/g, '')) : 0
  if (count < 1 || count > MAX_COUNT) throw new Error(`骰数超出范围（1–${MAX_COUNT}）`)
  if (sides < 2 || sides > MAX_SIDES) throw new Error(`骰面超出范围（2–${MAX_SIDES}）`)
  if (Math.abs(modifier) > MAX_MODIFIER) throw new Error(`修正值超出范围（±${MAX_MODIFIER}）`)
  const seed = seedInput !== undefined ? Math.abs(Math.trunc(seedInput)) : randomInt(1, 0x7fffffff)
  const rand = mulberry32(seed)
  const rolls: number[] = []
  for (let i = 0; i < count; i++) rolls.push(1 + Math.floor(rand() * sides))
  const total = rolls.reduce((s, v) => s + v, 0) + modifier
  const norm = `${count === 1 ? '' : count}d${sides}${modifier === 0 ? '' : signed(modifier)}`
  return { formula: norm, count, sides, modifier, rolls, total, seed }
}

/** 工具输出：明细 + 可直接整卡复制的「::: roll」骰卡模板 */
export function diceDetail(r: DiceResult, label?: string): string {
  const title = label || r.formula
  const modText = r.modifier === 0 ? '' : ` ${signed(r.modifier)} 修正`
  const L: string[] = []
  L.push(`掷骰（${title}）：${r.formula} = ${r.total}（骰面 ${r.rolls.join(' + ')}${modText}）`)
  L.push(`种子：${r.seed}——携带 seed=${r.seed} 重掷逐位复现（战报存档 / 回放用）`)
  L.push('')
  L.push('骰卡（复制到回复渲染，整卡原样保留、勿增删字段）：')
  L.push(`::: roll ${title}`)
  L.push(`骰式：${r.formula} | 种子：${r.seed}`)
  L.push(`明细：${r.rolls.join(' + ')} | 修正：${signed(r.modifier)} | 总值：${r.total}`)
  L.push(':::')
  return L.join('\n')
}

const diceArgs = z.object({
  formula: z.string().min(1),
  seed: z.number().int().optional(),
  label: z.string().optional(),
})

const diceRollTool: AgentTool = {
  name: 'dice_roll',
  tier: 'deferred',
  readOnly: true,
  description:
    '掷骰（唯一口径；trpg 跑团 / 剧本杀的一切随机判定必须出自本工具，禁止心算造数）：输入骰式（d20 / 3d6+2 / 2d10-1；骰数 1–100、面数 2–1000），可带 seed 复现（同种子逐位相同，重掷 / 回放用）与 label 标注用途；输出各骰面值、修正、总值、种子与可直接整卡复制的「::: roll」骰卡模板。凡是「掷骰 / 骰子 / 判定 / 检定 / 摇点 / 随机」都先用本工具。',
  parameters: {
    type: 'object',
    properties: {
      formula: { type: 'string', description: "骰式（如 'd20'、'3d6+2'、'2d10-1'；省略骰数默认 1）" },
      seed: { type: 'number', description: '随机种子（整数；同种子逐位复现，重掷 / 回放用）' },
      label: { type: 'string', description: '用途标注（如「攀爬检定」「伤害掷骰」；缺省用骰式作标题）' },
    },
    required: ['formula'],
  },
  schema: diceArgs,
  async execute(args: z.infer<typeof diceArgs>): Promise<ToolResult> {
    try {
      const r = rollDice(args.formula, args.seed)
      const modText = r.modifier === 0 ? '' : signed(r.modifier)
      return {
        ok: true,
        summary: `掷骰：${r.formula} = ${r.total}（${r.rolls.join('+')}${modText}；种子 ${r.seed}）`,
        detail: diceDetail(r, args.label),
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        ok: false,
        summary: `掷骰失败：${msg}`,
        detail: `掷骰失败：${msg}\n建议：骰式示例 d20 / 3d6+2 / 2d10-1；骰数 1–${MAX_COUNT}、面数 2–${MAX_SIDES}、修正 ±${MAX_MODIFIER}`,
      }
    }
  },
}

/** M69：场景玩法工具组（trpg 掷骰）——纯计算只读，tier=deferred 经 tool_search 激活 */
export function createDiceTools(): AgentTool[] {
  return [diceRollTool]
}

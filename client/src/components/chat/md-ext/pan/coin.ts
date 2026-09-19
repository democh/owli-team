/**
 * M54-A：摇卦复现（设计 §3.6）——`mulberry32` 与 server/src/pan/gua.ts 逐字一致，
 * 同种子在客户端复算必须与工具输出完全相同（已验向量：seed 12345 → 初7 二8 三8 四8 五9 上6）。
 *
 * 约定：bits 从初爻（索引 0）到上爻（索引 5），'1' = 阳、'0' = 阴；
 * 三枚铜钱背 = 3 / 字 = 2，和为 6（老阴，动）/ 7（少阳）/ 8（少阴）/ 9（老阳，动）。
 */

/** 确定性 PRNG（与 server 端逐字一致；种子可复现，勿改常数） */
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

export interface TossYao {
  /** 1..6（初 → 上） */
  pos: number
  /** 三枚铜钱（2 = 字、3 = 背） */
  coins: number[]
  /** 6 / 7 / 8 / 9 */
  sum: number
  yin: boolean
  dong: boolean
}

export interface TossResult {
  /** 六爻数（初 → 上） */
  digits: number[]
  /** 本卦 bits（初 → 上） */
  bits: string
  /** 变卦 bits（动爻取反） */
  bianBits: string
  /** 动爻位置（1..6，升序） */
  dongYao: number[]
  yao: TossYao[]
}

/** 三枚铜钱 × 六爻（自初爻起）；同种子逐位可复现 */
export function tossGua(seed: number): TossResult {
  const rand = mulberry32(seed)
  const yao: TossYao[] = []
  const digits: number[] = []
  const chars: string[] = []
  const dongYao: number[] = []
  for (let i = 0; i < 6; i++) {
    const coins = [0, 0, 0].map(() => (rand() < 0.5 ? 2 : 3))
    const sum = coins[0]! + coins[1]! + coins[2]!
    const dong = sum === 6 || sum === 9
    const yin = sum === 6 || sum === 8
    digits.push(sum)
    chars.push(yin ? '0' : '1')
    if (dong) dongYao.push(i + 1)
    yao.push({ pos: i + 1, coins, sum, yin, dong })
  }
  const bits = chars.join('')
  const bianChars = [...bits]
  for (const pos of dongYao) bianChars[pos - 1] = bianChars[pos - 1] === '1' ? '0' : '1'
  return { digits, bits, bianBits: bianChars.join(''), dongYao, yao }
}

/** 新种子（按钮「开始」用；32 位正整数） */
export function newSeed(): number {
  return (Date.now() ^ Math.floor(Math.random() * 0x100000000)) >>> 0
}

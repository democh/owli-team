/**
 * 确定性伪随机数（M34 §5.4）：mulberry32 PRNG。
 *
 * 目标：相同 `seed + params` 的输出逐位一致（工具结果与快照可复现的前提）。
 * - 所有随机数只从本模块取，禁止在博弈引擎中使用 Math.random（不可复现）；
 * - Box-Muller 生成标准正态（缓存备用样本），保证序列消费的确定性。
 */

export interface Prng {
  /** [0, 1) 均匀分布 */
  next(): number
  /** 标准正态（Box-Muller） */
  normal(): number
  /** [min, max) 均匀分布 */
  uniform(min: number, max: number): number
}

/** mulberry32：轻量确定性 PRNG（32 位状态，序列稳定跨平台） */
export function mulberry32(seed: number): Prng {
  let state = seed >>> 0
  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  let spare: number | null = null
  const normal = (): number => {
    if (spare !== null) {
      const value = spare
      spare = null
      return value
    }
    let u = 0
    let v = 0
    while (u === 0) u = next()
    while (v === 0) v = next()
    const r = Math.sqrt(-2 * Math.log(u))
    spare = r * Math.sin(2 * Math.PI * v)
    return r * Math.cos(2 * Math.PI * v)
  }
  return {
    next,
    normal,
    uniform: (min: number, max: number) => min + (max - min) * next(),
  }
}

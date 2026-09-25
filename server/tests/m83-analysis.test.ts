/**
 * M83 批 A：分析引擎测试（合成形态数据，确定性断言）。
 *
 * 覆盖：阶段判定（吸筹 / 恐慌 / 主升）/ 平滑不变式（转移邻接）/ 关键位（支撑 / 箱体量度）/
 * 情绪档界 / 特征标签 / 落图有效性 / 样本不足降级 / 确定性。
 */
import { describe, expect, it } from 'vitest'
import { DRAWING_KINDS, KLINE_PHASES, type KlinePhase } from '@multi-agent/shared'
import type { KlineBar } from '../src/finance/types.js'
import { ANALYSIS_PARAMS, analyzeKline, isAdjacent, PHASE_NEIGHBORS, sentimentStageOf } from '../src/finance/analysis/index.js'

const BASE_TS = Date.parse('2025-01-06T00:00:00+08:00')

/** 由收盘价序列构建 bars（open=前收；high/low 各 ±0.5% 包络） */
function barsFromCloses(closes: number[], volumes?: number[]): KlineBar[] {
  return closes.map((c, i) => {
    const open = i === 0 ? c : closes[i - 1]
    return {
      timestamp: BASE_TS + i * 86_400_000,
      open,
      high: Math.max(open, c) * 1.005,
      low: Math.min(open, c) * 0.995,
      close: c,
      volume: volumes?.[i] ?? 10_000,
    }
  })
}

function analysisOf(bars: KlineBar[]) {
  return analyzeKline(bars, { period: 'day', adjust: 'qfq', now: new Date('2026-09-25T00:00:00Z') })
}

/** 场景：长下跌（100→70）后低位温和上行（66→70）缩量 → 吸筹 */
function accumulationBars(): KlineBar[] {
  const closes: number[] = []
  for (let i = 0; i < 100; i++) closes.push(100 - (30 * i) / 99)
  for (let i = 0; i < 20; i++) closes.push(66 + (4 * i) / 19)
  const volumes = [...new Array(100).fill(20_000), ...new Array(20).fill(3_000)]
  return barsFromCloses(closes, volumes)
}

/** 场景：平台 100 附近震荡后 10 根暴跌 -25% 放量 4 倍 → 恐慌 */
function panicBars(): KlineBar[] {
  const closes: number[] = []
  for (let i = 0; i < 110; i++) closes.push(100 + (i % 2 === 0 ? 1 : -1))
  for (let i = 0; i < 10; i++) closes.push(100 * (1 - 0.25 * ((i + 1) / 10)))
  const volumes = [...new Array(110).fill(10_000), ...new Array(10).fill(40_000)]
  return barsFromCloses(closes, volumes)
}

/** 场景：平台震荡后 10 根拉升 +30% 放量 2 倍 → 主升 */
function climaxBars(): KlineBar[] {
  const closes: number[] = []
  for (let i = 0; i < 110; i++) closes.push(100 + (i % 2 === 0 ? 1 : -1))
  for (let i = 0; i < 10; i++) closes.push(100 * (1 + 0.3 * ((i + 1) / 10)))
  const volumes = [...new Array(110).fill(10_000), ...new Array(10).fill(20_000)]
  return barsFromCloses(closes, volumes)
}

/** 场景：80–100 箱体震荡 120 根（末收 95） */
function boxBars(): KlineBar[] {
  const closes: number[] = []
  for (let i = 0; i < 120; i++) {
    const phase = (i % 40) / 40
    closes.push(phase < 0.5 ? 80 + (20 * phase) / 0.5 : 100 - (20 * (phase - 0.5)) / 0.5)
  }
  return barsFromCloses(closes)
}

describe('M83 分析引擎：阶段判定', () => {
  it('低位缩量温和上行 → 吸筹（且置信度在 45–100）', () => {
    const r = analysisOf(accumulationBars())
    expect(r.phases.current).toBe('accumulation')
    expect(r.phases.confidence).toBeGreaterThanOrEqual(45)
    expect(r.phases.confidence).toBeLessThanOrEqual(100)
    expect(r.phases.description).toContain('吸筹')
    expect(r.phases.bands).toHaveLength(120)
    expect(r.phases.since).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('暴跌放量 → 恐慌', () => {
    const r = analysisOf(panicBars())
    expect(r.phases.current).toBe('panic')
  })

  it('加速放量上攻 → 主升', () => {
    const r = analysisOf(climaxBars())
    expect(r.phases.current).toBe('climax')
  })

  it('平滑不变式：相邻段相位满足转移邻接约束', () => {
    for (const bars of [accumulationBars(), panicBars(), climaxBars()]) {
      const { bands } = analysisOf(bars).phases
      const phases: KlinePhase[] = []
      for (const b of bands) {
        if (phases[phases.length - 1] !== b.phase) phases.push(b.phase)
      }
      for (let i = 1; i < phases.length; i++) {
        expect(isAdjacent(phases[i - 1], phases[i])).toBe(true)
      }
      // 全部相位合法
      for (const b of bands) expect(KLINE_PHASES).toContain(b.phase)
    }
  })

  it('恐慌相位不允许直接跳主升（邻接表口径）', () => {
    expect(PHASE_NEIGHBORS.panic).not.toContain('climax')
    expect(isAdjacent('panic', 'climax')).toBe(false)
    expect(isAdjacent('panic', 'rebound')).toBe(true)
  })

  it('确定性：同输入两次分析结果一致（含 now 注入）', () => {
    const bars = accumulationBars()
    expect(JSON.stringify(analysisOf(bars))).toBe(JSON.stringify(analysisOf(bars)))
  })

  it('样本不足（<60 根）：notes 声明且置信度降档', () => {
    const bars = accumulationBars().slice(-40)
    const r = analysisOf(bars)
    expect(r.notes.some((n) => n.includes('样本不足'))).toBe(true)
    expect(r.phases.confidence).toBeLessThanOrEqual(70)
  })
})

describe('M83 分析引擎：关键位与落图', () => {
  it('下跌末段：支撑为近端摆动低点（带出处与触碰数）', () => {
    const r = analysisOf(accumulationBars())
    expect(r.levels.support).not.toBeNull()
    const s = r.levels.support!
    expect(s.price).toBeGreaterThan(63)
    expect(s.price).toBeLessThan(68)
    expect(['前低', '密集区']).toContain(s.basis)
    expect(s.touches).toBeGreaterThanOrEqual(1)
    expect(r.levels.resistance === null || r.levels.resistance.price > r.levels.support!.price).toBe(true)
  })

  it('箱体震荡：识别箱体并给出量度目标（箱高量度）', () => {
    const r = analysisOf(boxBars())
    expect(r.levels.target).not.toBeNull()
    expect(r.levels.target!.basis).toContain('箱体量度')
    expect(r.levels.target!.price).toBeGreaterThan(118)
    expect(r.drawings.some((d) => d.id === 'an-box' && d.kind === 'zone')).toBe(true)
  })

  it('落图有效性：kind 白名单 / 价格有限 / id 唯一', () => {
    const r = analysisOf(boxBars())
    const ids = new Set<string>()
    for (const d of r.drawings) {
      expect(DRAWING_KINDS).toContain(d.kind)
      expect(ids.has(d.id)).toBe(false)
      ids.add(d.id)
      for (const p of d.points) {
        expect(Number.isFinite(p.ts)).toBe(true)
        expect(Number.isFinite(p.price)).toBe(true)
      }
    }
    expect(r.drawings.some((d) => d.kind === 'hline')).toBe(true)
  })
})

describe('M83 分析引擎：情绪与特征', () => {
  it('情绪分数域与档位一致性；暴跌 vs 拉升单调', () => {
    const down = analysisOf(panicBars()).sentiment
    const up = analysisOf(climaxBars()).sentiment
    for (const s of [down, up]) {
      expect(s.score).toBeGreaterThanOrEqual(0)
      expect(s.score).toBeLessThanOrEqual(100)
      expect(s.stage).toBe(sentimentStageOf(s.score))
      expect(s.pathLabel).toContain('当前')
    }
    expect(up.score).toBeGreaterThan(down.score)
    expect(down.score).toBeLessThan(45)
    expect(up.score).toBeGreaterThan(65)
  })

  it('低位缩量 → 命中「地量地价」「平台整理」', () => {
    const r = analysisOf(accumulationBars())
    const keys = r.features.map((f) => f.key)
    expect(keys).toContain('dry-volume-price')
    expect(keys).toContain('platform')
    for (const f of r.features) expect(f.label.length).toBeGreaterThan(0)
  })

  it('区间收敛 → 命中「三角形整理」（近似口径标签为 confirmed=false 仅限筹码集中）', () => {
    const closes: number[] = []
    for (let i = 0; i < 20; i++) closes.push(90 + (i % 2 === 0 ? 10 : 0))
    for (let i = 0; i < 20; i++) closes.push(95 + (i % 2 === 0 ? 5 : 0))
    for (let i = 0; i < 20; i++) closes.push(98 + (i % 2 === 0 ? 2 : 0))
    const r = analysisOf(barsFromCloses(closes))
    expect(r.features.map((f) => f.key)).toContain('triangle')
  })
})

describe('M83 分析引擎：契约完整性', () => {
  it('notes 固定含口径声明；参数常量可引用', () => {
    const r = analysisOf(accumulationBars())
    expect(r.notes[0]).toContain('规则化统计口径')
    expect(ANALYSIS_PARAMS.minBars).toBe(60)
    expect(r.bars).toBe(120)
    expect(r.period).toBe('day')
    expect(r.adjust).toBe('qfq')
  })

  it('空 bars 抛错', () => {
    expect(() => analysisOf([])).toThrow('无 K 线数据')
  })
})

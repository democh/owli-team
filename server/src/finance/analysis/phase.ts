/**
 * 阶段判定（M83 §4.2）：确定性规则 + 逐根回放两段式（静态判定 → 平滑）。
 *
 * - 严格回看窗口（无未来函数），全序列指标由 buildContext 预计算，逐根判定 O(1) 查表；
 * - 平滑两段：① 最短段长合并（minSegment）② 转移邻接约束回填（禁止 panic→climax 类跳变）；
 * - 置信度 = 规则命中强度加权（0–100），单弱条件不给高分；range 兜底给中低分。
 */
import type { KlineAnalysisPhaseInfo, KlinePhase, KlinePhaseBand } from '@multi-agent/shared'
import { formatCnDate } from '../period.js'
import { ANALYSIS_PARAMS, clamp, percentileRank, rangePosition, scale01, windowExtreme, type AnalysisContext } from './types.js'

/** 阶段中文名（描述模板与图表标注共用） */
export const PHASE_CN: Record<KlinePhase, string> = {
  accumulation: '吸筹',
  bottoming: '筑底',
  wash: '洗盘',
  markup: '拉升',
  climax: '主升',
  distribution: '派发',
  markdown: '下跌',
  panic: '恐慌',
  rebound: '反弹',
  range: '震荡',
}

/** 阶段描述模板（引擎确定性文案；深度解读留给 Agent 在 facts 之上撰写） */
export const PHASE_DESCRIPTIONS: Record<KlinePhase, string> = {
  accumulation: '低位缩量横盘、筹码集中，主力吸筹特征',
  bottoming: '低位反复探底、波动收敛，筑底特征',
  wash: '拉升途中缩量回撤，洗盘特征',
  markup: '均线多头排列、重心上移，拉升特征',
  climax: '加速放量上攻，主升特征',
  distribution: '高位滞涨放量，派发特征',
  markdown: '均线空头排列、重心下移，下跌特征',
  panic: '急速放量杀跌，恐慌特征',
  rebound: '下跌后修复反弹，结构未反转',
  range: '区间震荡，方向未明',
}

/** 转移邻接表（平滑用；对称判定 isAdjacent 双向检查） */
export const PHASE_NEIGHBORS: Record<KlinePhase, KlinePhase[]> = {
  accumulation: ['bottoming', 'wash', 'range', 'markup', 'rebound'],
  bottoming: ['accumulation', 'range', 'rebound', 'panic', 'wash'],
  wash: ['markup', 'accumulation', 'range'],
  markup: ['wash', 'climax', 'distribution', 'range', 'accumulation'],
  climax: ['markup', 'distribution', 'panic'],
  distribution: ['climax', 'markdown', 'range', 'markup'],
  markdown: ['distribution', 'rebound', 'panic', 'range'],
  panic: ['markdown', 'rebound', 'bottoming'],
  rebound: ['panic', 'markdown', 'bottoming', 'accumulation', 'range'],
  range: ['accumulation', 'bottoming', 'wash', 'markup', 'distribution', 'markdown', 'rebound'],
}

/** 方向性邻接判定：a → b 是否允许（同相恒真；表按「from → to」语义，双向不对称是特性） */
export function isAdjacent(from: KlinePhase, to: KlinePhase): boolean {
  if (from === to) return true
  return PHASE_NEIGHBORS[from].includes(to)
}

export interface PhasePoint {
  phase: KlinePhase
  confidence: number
}

/** 单根判定入参（全部为「截至该根」的回看量） */
interface BarFeatures {
  pos: number | null
  close: number
  ma20: number | null
  ma60: number | null
  /** MA20 10 根斜率（相对） */
  slope20: number | null
  volRatio: number | null
  /** ATR% 在近 rangeWindow 的分位 */
  volQuantile: number
  /** 近 10 根涨跌幅 */
  ret10: number
  /** 近 8 根涨跌幅 */
  ret8: number
  /** 近 20 根振幅（(maxH-minL)/minL） */
  amp20: number | null
  /** 自近 20 根高点回撤 */
  drawdown20: number | null
  /** 近 60 根探底次数（局部低点 ≤ 区间低点 ×1.03） */
  probeCount: number
}

/** 逐根特征（全部回看，无未来函数） */
function featuresAt(ctx: AnalysisContext, i: number): BarFeatures {
  const p = ANALYSIS_PARAMS
  const close = ctx.closes[i]
  const ma20 = ctx.ma20[i]
  const ma60 = ctx.ma60[i]
  const back = Math.max(0, i - 10)
  const slope20 = ma20 !== null && ctx.ma20[back] !== null && ctx.ma20[back]! > 0 ? ma20 / ctx.ma20[back]! - 1 : null
  const vqFrom = Math.max(0, i - p.rangeWindow + 1)
  const volQuantile = percentileRank(ctx.atrPct.slice(vqFrom, i + 1), ctx.atrPct[i])
  const ret10 = i >= 10 && ctx.closes[i - 10] > 0 ? close / ctx.closes[i - 10] - 1 : 0
  const ret8 = i >= 8 && ctx.closes[i - 8] > 0 ? close / ctx.closes[i - 8] - 1 : 0
  const ampFrom = Math.max(0, i - p.platformWindow + 1)
  const high20 = windowExtreme(ctx.highs, ampFrom, i, 'max')
  const low20 = windowExtreme(ctx.lows, ampFrom, i, 'min')
  const amp20 = high20 && low20 && low20.value > 0 ? (high20.value - low20.value) / low20.value : null
  const drawdown20 = high20 && high20.value > 0 ? (high20.value - close) / high20.value : null
  // 探底次数：近 60 根内「局部低点且 ≤ 区间低点 ×1.03」
  const probeFrom = Math.max(0, i - 60 + 1)
  const low60 = windowExtreme(ctx.lows, probeFrom, i, 'min')
  let probeCount = 0
  if (low60) {
    for (let j = Math.max(1, probeFrom + 1); j < i; j++) {
      if (ctx.lows[j] <= low60.value * 1.03) {
        const left = ctx.lows[j - 1]
        const right = ctx.lows[j + 1]
        if (ctx.lows[j] <= left && ctx.lows[j] <= right) probeCount++
      }
    }
  }
  return {
    pos: rangePosition(ctx, i),
    close,
    ma20,
    ma60,
    slope20,
    volRatio: ctx.volRatio[i],
    volQuantile,
    ret10,
    ret8,
    amp20,
    drawdown20,
    probeCount,
  }
}

/** 命中强度 → 置信度（45–100；强度为各条件「超出阈值的比例」） */
function confidenceOf(strengths: number[]): number {
  if (strengths.length === 0) return 45
  const avg = strengths.reduce((acc, s) => acc + clamp(s, 0, 1), 0) / strengths.length
  return Math.round(clamp(45 + 55 * avg, 45, 100))
}

/** 单根静态判定（规则优先级短路，强特征先行） */
export function detectPhaseAt(ctx: AnalysisContext, i: number): PhasePoint {
  const f = featuresAt(ctx, i)
  const { pos, close, ma20, ma60, slope20, volRatio, volQuantile, ret10, ret8, amp20, drawdown20, probeCount } = f
  const vr = volRatio ?? 1

  // ① 恐慌：急速放量杀跌
  if (ret10 <= -0.15 && vr >= 1.6 && volQuantile >= 0.85) {
    return {
      phase: 'panic',
      confidence: confidenceOf([scale01(-ret10, 0.15, 0.3), scale01(vr, 1.6, 3), scale01(volQuantile, 0.85, 1)]),
    }
  }
  // ② 主升：加速放量上攻
  if (ret10 >= 0.25 && vr >= 1.3) {
    return { phase: 'climax', confidence: confidenceOf([scale01(ret10, 0.25, 0.5), scale01(vr, 1.3, 2.5)]) }
  }
  // ③ 下跌：空头排列 + MA20 下行
  if (ma20 !== null && ma60 !== null && close < ma20 && ma20 < ma60 && slope20 !== null && slope20 < 0) {
    return {
      phase: 'markdown',
      confidence: confidenceOf([
        scale01((ma20 - close) / close, 0, 0.05),
        scale01((ma60 - ma20) / ma60, 0, 0.05),
        scale01(-slope20, 0, 0.06),
      ]),
    }
  }
  // ④ 拉升：多头排列 + MA20 上行（未达主升强度）
  if (ma20 !== null && ma60 !== null && close > ma20 && ma20 > ma60 && slope20 !== null && slope20 > 0) {
    return {
      phase: 'markup',
      confidence: confidenceOf([
        scale01((close - ma20) / close, 0, 0.05),
        scale01((ma20 - ma60) / ma60, 0, 0.05),
        scale01(slope20, 0, 0.06),
      ]),
    }
  }
  // ⑤ 反弹：下跌结构中的修复（仍未收复 MA60）
  if (ma60 !== null && close < ma60 && ret8 >= 0.08) {
    return { phase: 'rebound', confidence: confidenceOf([scale01(ret8, 0.08, 0.2), scale01((ma60 - close) / ma60, 0, 0.15)]) }
  }
  // ⑥ 洗盘：拉升结构内缩量回撤且守住 MA20
  if (
    ma20 !== null &&
    ma60 !== null &&
    close > ma60 &&
    drawdown20 !== null &&
    drawdown20 >= 0.05 &&
    drawdown20 <= 0.12 &&
    vr < 0.8 &&
    close >= ma20
  ) {
    return {
      phase: 'wash',
      confidence: confidenceOf([scale01(drawdown20, 0.05, 0.12), scale01(0.8 - vr, 0, 0.4)]),
    }
  }
  // ⑦ 吸筹：低位 + 窄幅 + 缩量/温和量
  if (pos !== null && pos < 0.35 && amp20 !== null && amp20 < 0.12 && vr <= 1.1) {
    return {
      phase: 'accumulation',
      confidence: confidenceOf([scale01(0.35 - pos, 0, 0.3), scale01(0.12 - amp20, 0, 0.08)]),
    }
  }
  // ⑧ 筑底：低位 + 多次探底 + 低波动
  if (pos !== null && pos < 0.35 && probeCount >= 2 && volQuantile < 0.4) {
    return {
      phase: 'bottoming',
      confidence: confidenceOf([scale01(0.35 - pos, 0, 0.3), scale01(probeCount, 2, 5), scale01(0.4 - volQuantile, 0, 0.3)]),
    }
  }
  // ⑨ 派发：高位滞涨放量
  if (pos !== null && pos > 0.7 && ret10 < 0.05 && vr >= 1.2) {
    return {
      phase: 'distribution',
      confidence: confidenceOf([scale01(pos, 0.7, 1), scale01(vr, 1.2, 2.5), scale01(0.05 - ret10, 0, 0.08)]),
    }
  }
  // ⑩ 震荡兜底（中低分）
  const posBase = pos ?? 0.5
  return { phase: 'range', confidence: Math.round(40 + 20 * (1 - Math.abs(posBase - 0.5) * 2)) }
}

interface Segment {
  phase: KlinePhase
  from: number
  to: number
  conf: number[]
}

/** 压缩为段 */
function toSegments(points: PhasePoint[]): Segment[] {
  const segs: Segment[] = []
  for (let i = 0; i < points.length; i++) {
    const last = segs[segs.length - 1]
    if (last && last.phase === points[i].phase) {
      last.to = i
      last.conf.push(points[i].confidence)
    } else {
      segs.push({ phase: points[i].phase, from: i, to: i, conf: [points[i].confidence] })
    }
  }
  return segs
}

const segLen = (s: Segment): number => s.to - s.from + 1

/** 合并相邻同相段 + 短段并入较长邻居（循环至无短段；合并时必须同步扩展段范围，否则出现空洞） */
function squashAndMergeShort(segs: Segment[]): Segment[] {
  const { minSegment } = ANALYSIS_PARAMS
  let list = squash(segs)
  for (;;) {
    const idx = list.findIndex((s) => segLen(s) < minSegment)
    if (idx < 0 || list.length <= 1) break
    const prev = list[idx - 1]
    const next = list[idx + 1]
    const prevLen = prev ? segLen(prev) : -1
    const nextLen = next ? segLen(next) : -1
    const target = prevLen >= nextLen ? prev : next
    if (!target) break
    const victim = list[idx]
    target.conf.push(...victim.conf)
    if (target === prev) prev.to = victim.to
    else next.from = victim.from
    list = squash(list.filter((_, j) => j !== idx))
  }
  return list
}

/** 相邻同相段合并 */
function squash(segs: Segment[]): Segment[] {
  const out: Segment[] = []
  for (const s of segs) {
    const last = out[out.length - 1]
    if (last && last.phase === s.phase) {
      last.to = s.to
      last.conf.push(...s.conf)
    } else {
      out.push({ ...s, conf: [...s.conf] })
    }
  }
  return out
}

/**
 * 平滑（两段式）：短段合并 → 转移邻接约束回填（≤5 轮，每轮减少一个段，必然收敛）。
 * 非法跳变（如 panic→climax）时短者让位并入长者。
 */
export function smoothPhasePoints(points: PhasePoint[]): PhasePoint[] {
  if (points.length === 0) return points
  let segs = squashAndMergeShort(toSegments(points))
  for (let pass = 0; pass < 5 && segs.length > 1; pass++) {
    let illegal = -1
    for (let i = 0; i < segs.length - 1; i++) {
      if (!isAdjacent(segs[i].phase, segs[i + 1].phase)) {
        illegal = i
        break
      }
    }
    if (illegal < 0) break
    const a = segs[illegal]
    const b = segs[illegal + 1]
    // 短者让位：并入长者（同相后由 squash 合并，覆盖范围不变）
    if (segLen(a) >= segLen(b)) b.phase = a.phase
    else a.phase = b.phase
    segs = squashAndMergeShort(segs)
  }
  // 展开为逐根
  const out: PhasePoint[] = new Array(points.length)
  for (const s of segs) {
    const level = Math.round(s.conf.reduce((acc, v) => acc + v, 0) / Math.max(1, s.conf.length))
    for (let i = s.from; i <= s.to; i++) out[i] = { phase: s.phase, confidence: level }
  }
  return out
}

/** 阶段判定主入口（逐根回放两段式） */
export function detectPhases(ctx: AnalysisContext): KlineAnalysisPhaseInfo {
  const points: PhasePoint[] = new Array(ctx.n)
  for (let i = 0; i < ctx.n; i++) points[i] = detectPhaseAt(ctx, i)
  const smoothed = smoothPhasePoints(points)
  const bands: KlinePhaseBand[] = smoothed.map((p, i) => ({ ts: ctx.bars[i].timestamp, phase: p.phase }))
  const last = smoothed[smoothed.length - 1] ?? { phase: 'range' as KlinePhase, confidence: 40 }
  // 当前段起点（since）
  let start = smoothed.length - 1
  while (start > 0 && smoothed[start - 1].phase === last.phase) start--
  return {
    current: last.phase,
    confidence: last.confidence,
    since: formatCnDate(ctx.bars[start].timestamp),
    description: PHASE_DESCRIPTIONS[last.phase],
    bands,
  }
}

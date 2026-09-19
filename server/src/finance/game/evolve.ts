/**
 * 模型 3 · 演化博弈（M34 §5.4）：复制动态 + RK4 数值积分 + 固定点 / ESS 判定。
 *
 * 群体：多头比例 x 与空头比例 1 − x；适应度由价格反馈给出——
 *   价格映射 dp(x) = priceImpact × f(2x − 1)（linear 线性 / logistic 饱和）；
 *   方向收益 U_L = dp − carryCost × x；U_S = −dp − carryCost × (1 − x)；
 * 动力学 dx/dt = x(1−x)(U_L − U_S)（复制动态，x ∈ [0,1]）；
 * 固定点：数值扫描（符号变化）+ 二分精化；稳定性：g'(x*) < 0 → 稳定（ESS）。
 */
import { clamp01, GameError, ParamReader, round, type ModelOutcome } from './types.js'

export type EvolveFeedback = 'linear' | 'logistic'

export interface EvolveParams {
  feedback: EvolveFeedback
  priceImpact: number
  carryCost: number
  logisticK: number
  duration: number
  dt: number
  initialValues: number[]
  samples: number
}

export const EVOLVE_KNOWN_PARAMS = [
  'feedback',
  'priceImpact',
  'carryCost',
  'logisticK',
  'duration',
  'dt',
  'initialValues',
  'samples',
] as const

export interface EvolveFixedPoint {
  x: number
  stable: boolean
  kind: 'boundary' | 'interior'
}

export interface EvolveCurve {
  x0: number
  points: Array<{ t: number; x: number }>
}

export interface EvolveResult {
  feedback: EvolveFeedback
  fixedPoints: EvolveFixedPoint[]
  /** 演化稳定策略（稳定固定点，含边界） */
  ess: number[]
  curves: EvolveCurve[]
  /** 退化：中性区间（任意比例均为固定点，无渐进稳定解） */
  neutral: boolean
}

export function parseEvolveParams(reader: ParamReader): EvolveParams {
  const duration = reader.num('duration', 100, { min: 0.1, max: 200 })
  const dt = reader.num('dt', 0.05, { min: 0.001, max: 1 })
  const steps = Math.round(duration / dt)
  if (steps > 20000) throw new GameError('演化积分步数过大（duration / dt 不得超过 20000）')
  return {
    feedback: reader.choice<EvolveFeedback>('feedback', 'linear', ['linear', 'logistic'] as const),
    priceImpact: reader.num('priceImpact', 0.03, { min: 0, max: 1 }),
    carryCost: reader.num('carryCost', 0.12, { min: 0, max: 1 }),
    logisticK: reader.num('logisticK', 2, { min: 0.1, max: 20 }),
    duration,
    dt,
    initialValues: reader.numArray('initialValues', [0.05, 0.25, 0.5, 0.75, 0.95], { min: 0, max: 1, maxLen: 9 }),
    samples: reader.num('samples', 1000, { min: 64, max: 20000, int: true }),
  }
}

/** 构造复制动态漂移函数 g(x) = dx/dt */
export function driftFunction(params: EvolveParams): (x: number) => number {
  const { feedback, priceImpact, carryCost, logisticK } = params
  return (x: number): number => {
    const u = 2 * x - 1
    const priceMove = feedback === 'logistic' ? priceImpact * Math.tanh(logisticK * u) : priceImpact * u
    const payoffLong = priceMove - carryCost * x
    const payoffShort = -priceMove - carryCost * (1 - x)
    return x * (1 - x) * (payoffLong - payoffShort)
  }
}

function refineFixedPoint(g: (x: number) => number, low: number, high: number): number {
  let lo = low
  let gl = g(lo)
  for (let i = 0; i < 60; i++) {
    const mid = (lo + high) / 2
    const gm = g(mid)
    if (gm === 0) return mid
    if (gl * gm <= 0) {
      high = mid
    } else {
      lo = mid
      gl = gm
    }
  }
  return (lo + high) / 2
}

/** 固定点扫描：内部（符号变化 + 二分精化）+ 边界稳定性（g(ε) 符号） */
export function findFixedPoints(g: (x: number) => number, samples: number): EvolveFixedPoint[] {
  const out: EvolveFixedPoint[] = []
  const epsilon = 1e-6
  const h = 1e-7

  // 边界：x → 0⁺ 时 g < 0 则吸引（趋向 0）；x → 1⁻ 时 g > 0 则吸引（趋向 1）
  out.push({ x: 0, stable: g(epsilon) < 0, kind: 'boundary' })

  // 内部：等分网格上的符号变化
  let prevX = epsilon
  let prevG = g(prevX)
  for (let i = 1; i <= samples; i++) {
    const x = i / (samples + 1)
    const gx = g(x)
    if (prevG === 0 || prevG * gx < 0) {
      const root = refineFixedPoint(g, prevX, x)
      const derivative = (g(root + h) - g(root - h)) / (2 * h)
      out.push({ x: root, stable: derivative < -1e-9, kind: 'interior' })
    }
    prevX = x
    prevG = gx
  }

  out.push({ x: 1, stable: g(1 - epsilon) > 0, kind: 'boundary' })
  return out
}

function integrate(
  g: (x: number) => number,
  x0: number,
  params: EvolveParams,
  steps: number,
  sampleEvery: number,
): EvolveCurve {
  const points: Array<{ t: number; x: number }> = [{ t: 0, x: round(x0) }]
  let x = x0
  let t = 0
  for (let step = 1; step <= steps; step++) {
    const k1 = g(x)
    const k2 = g(clamp01(x + (params.dt / 2) * k1))
    const k3 = g(clamp01(x + (params.dt / 2) * k2))
    const k4 = g(clamp01(x + params.dt * k3))
    x = clamp01(x + (params.dt / 6) * (k1 + 2 * k2 + 2 * k3 + k4))
    t += params.dt
    if (step % sampleEvery === 0 || step === steps) points.push({ t: round(t), x: round(x) })
  }
  return { x0, points }
}

export function runEvolve(params: Record<string, unknown> | undefined): ModelOutcome<EvolveResult> {
  const reader = new ParamReader(params, EVOLVE_KNOWN_PARAMS)
  const parsed = parseEvolveParams(reader)
  const warnings = reader.warnings

  const g = driftFunction(parsed)
  // 中性退化：线性反馈下 2 × priceImpact = carryCost → g ≡ 0（任意比例为固定点）
  const neutral = parsed.feedback === 'linear' && Math.abs(2 * parsed.priceImpact - parsed.carryCost) < 1e-9

  let fixedPoints: EvolveFixedPoint[]
  if (neutral) {
    warnings.push('参数处于中性退化区间（2 × priceImpact = carryCost）：任意多头比例均为固定点，无渐进稳定解')
    fixedPoints = [
      { x: 0, stable: false, kind: 'boundary' },
      { x: 0.5, stable: false, kind: 'interior' },
      { x: 1, stable: false, kind: 'boundary' },
    ]
  } else {
    fixedPoints = findFixedPoints(g, parsed.samples).map((point) => ({ ...point, x: round(point.x) }))
  }

  const steps = Math.round(parsed.duration / parsed.dt)
  const sampleEvery = Math.max(1, Math.floor(steps / 200))
  const curves = parsed.initialValues.map((x0) => integrate(g, x0, parsed, steps, sampleEvery))

  const ess = fixedPoints.filter((point) => point.stable).map((point) => point.x)
  const finalValues = curves.map((curve) => curve.points[curve.points.length - 1].x)

  const feedbackLabel = parsed.feedback === 'logistic' ? 'logistic 饱和反馈' : '线性反馈'
  const fixedText = fixedPoints
    .map((point) => `${point.x.toFixed(2)}（${point.stable ? '稳定' : '不稳定'}）`)
    .join(' / ')
  const parts: string[] = [
    `演化博弈（${feedbackLabel}）：多头比例 x 的复制动态 dx/dt = x(1−x)(U_L − U_S)，` +
      `固定点：${fixedText}。`,
  ]
  if (neutral) {
    parts.push('系统处于中性区间：多空比例漂移无稳定归宿，历史路径决定终态。')
  } else if (ess.length === 1 && ess[0] > 0 && ess[0] < 1) {
    parts.push(
      `演化稳定策略 ESS = ${ess[0].toFixed(2)}（多空均衡比例）：市场力量自我修复、渐近收敛于该僵持点（初值越接近收敛越快）。`,
    )
  } else if (ess.includes(0) && ess.includes(1)) {
    parts.push('两极分化（赢家通吃）：初值决定终局——多头占优则趋向全多（0 侧为全空、1 侧为全多）。')
  } else if (ess.length > 0) {
    parts.push(`稳定态：${ess.map((v) => v.toFixed(2)).join('、')}（边界稳定，方向单一化收敛）。`)
  } else {
    parts.push('无渐进稳定点。')
  }
  const curveText = curves
    .map((curve, idx) => `x₀ = ${curve.x0.toFixed(2)} → ${finalValues[idx].toFixed(2)}`)
    .join('；')
  parts.push(`初值敏感性：${curveText}。`)

  return {
    result: { feedback: parsed.feedback, fixedPoints, ess, curves, neutral },
    stats: {
      feedback: parsed.feedback,
      fixedPointCount: fixedPoints.length,
      stableCount: ess.length,
      ess,
      finalValues,
      neutral,
    },
    narrative: parts.join(''),
    params: {
      feedback: parsed.feedback,
      priceImpact: parsed.priceImpact,
      carryCost: parsed.carryCost,
      logisticK: parsed.logisticK,
      duration: parsed.duration,
      dt: parsed.dt,
      initialValues: parsed.initialValues,
      samples: parsed.samples,
    },
    warnings,
  }
}

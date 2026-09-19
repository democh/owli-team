/**
 * 博弈场景预设与参数基线（M34 §6.4）：
 * - GAME_PRESETS：一键装载的场景模板（模型 / 主题 / 参数集）；
 * - MODEL_PARAM_DEFAULTS：与服务端各模型默认值同口径的参数基线（UI 初值与预设装载共用）；
 * - MODEL_FIELDS：配置态参数控件定义（画布博弈节点与实验室共用；数组型参数不设控件走基线值）；
 * - 参数键对齐 server 各模型 KNOWN_PARAMS 白名单：未知键会被忽略并记 warning（ParamReader 严格口径）、
 *   越界值会被夹取；数组型参数（capital / initialValues）首期不做控件，走基线值。
 */
import type { GameModelName } from '../../../lib/game-spec'

export interface GamePreset {
  id: string
  name: string
  model: GameModelName
  topic: string
  desc: string
  params: Record<string, unknown>
}

/** 与服务端默认值对齐（matrix.ts / sequence.ts / evolve.ts / simulate.ts 的 reader 缺省） */
export const MODEL_PARAM_DEFAULTS: Record<GameModelName, Record<string, unknown>> = {
  matrix: {
    capital: [1e8, 1e8],
    priceImpact: 0.06,
    carryCost: 0.03,
    conflictCost: 0.05,
    retreatLoss: 0.03,
  },
  sequence: {
    leader: 'long',
    capital: [1e8, 1e8],
    priceImpact: 0.06,
    carryCost: 0.03,
    conflictCost: 0.05,
    retreatLoss: 0.03,
  },
  evolve: {
    feedback: 'linear',
    priceImpact: 0.03,
    carryCost: 0.12,
    logisticK: 2,
    duration: 100,
    dt: 0.05,
    initialValues: [0.05, 0.25, 0.5, 0.75, 0.95],
    samples: 1000,
  },
  simulate: {
    initialPrice: 100,
    lambda: 0.01,
    sigma: 0.004,
    rounds: 120,
    paths: 500,
    longWeight: 1,
    shortWeight: 1,
    arbWeight: 0.4,
    mmLiquidity: 0.5,
    retailNoise: 0.3,
    cascadeThreshold: 0.08,
    cascadeFlow: 0.6,
    momentumWindow: 10,
    momentumScale: 0.005,
    stalemateBand: 0.02,
  },
}

/** 参数控件描述（数字 / 下拉两类；首期精选核心项） */
export type ParamField =
  | { kind: 'number'; key: string; label: string; min?: number; max?: number; step?: number }
  | { kind: 'select'; key: string; label: string; options: Array<{ value: string; label: string }> }

/** 参数控件（首期精选核心项；数组型参数走基线默认值，不设控件） */
export const MODEL_FIELDS: Record<GameModelName, ParamField[]> = {
  matrix: [
    { kind: 'number', key: 'priceImpact', label: '价格冲击', min: 0, max: 1, step: 0.01 },
    { kind: 'number', key: 'carryCost', label: '持仓成本', min: 0, max: 1, step: 0.01 },
    { kind: 'number', key: 'conflictCost', label: '争夺消耗', min: 0, max: 1, step: 0.01 },
    { kind: 'number', key: 'retreatLoss', label: '撤退损失', min: 0, max: 1, step: 0.01 },
  ],
  sequence: [
    {
      kind: 'select',
      key: 'leader',
      label: '先动方',
      options: [
        { value: 'long', label: '多头' },
        { value: 'short', label: '空头' },
      ],
    },
    { kind: 'number', key: 'priceImpact', label: '价格冲击', min: 0, max: 1, step: 0.01 },
    { kind: 'number', key: 'carryCost', label: '持仓成本', min: 0, max: 1, step: 0.01 },
    { kind: 'number', key: 'conflictCost', label: '争夺消耗', min: 0, max: 1, step: 0.01 },
    { kind: 'number', key: 'retreatLoss', label: '撤退损失', min: 0, max: 1, step: 0.01 },
  ],
  evolve: [
    {
      kind: 'select',
      key: 'feedback',
      label: '反馈机制',
      options: [
        { value: 'linear', label: '线性' },
        { value: 'logistic', label: '逻辑斯蒂' },
      ],
    },
    { kind: 'number', key: 'priceImpact', label: '价格冲击', min: 0, max: 1, step: 0.01 },
    { kind: 'number', key: 'carryCost', label: '持仓成本', min: 0, max: 1, step: 0.01 },
    { kind: 'number', key: 'logisticK', label: '饱和系数 K', min: 0.1, max: 20, step: 0.1 },
    { kind: 'number', key: 'duration', label: '时长', min: 0.1, max: 200, step: 1 },
    { kind: 'number', key: 'dt', label: '步长', min: 0.001, max: 1, step: 0.005 },
    { kind: 'number', key: 'samples', label: '采样点', min: 64, max: 20000, step: 1 },
  ],
  simulate: [
    { kind: 'number', key: 'initialPrice', label: '初始价', min: 0.01, step: 1 },
    { kind: 'number', key: 'lambda', label: '漂移 λ', min: 0, max: 1, step: 0.001 },
    { kind: 'number', key: 'sigma', label: '波动 σ', min: 0, max: 1, step: 0.001 },
    { kind: 'number', key: 'rounds', label: '轮次', min: 1, max: 240, step: 1 },
    { kind: 'number', key: 'paths', label: '路径数', min: 1, max: 2000, step: 1 },
    { kind: 'number', key: 'longWeight', label: '多头权重', min: 0, max: 10, step: 0.1 },
    { kind: 'number', key: 'shortWeight', label: '空头权重', min: 0, max: 10, step: 0.1 },
    { kind: 'number', key: 'arbWeight', label: '套利权重', min: 0, max: 10, step: 0.05 },
    { kind: 'number', key: 'mmLiquidity', label: '做市流动性', min: 0, max: 1, step: 0.05 },
    { kind: 'number', key: 'retailNoise', label: '散户噪声', min: 0, max: 10, step: 0.05 },
    { kind: 'number', key: 'cascadeThreshold', label: '级联阈值', min: 0.001, max: 1, step: 0.005 },
    { kind: 'number', key: 'cascadeFlow', label: '级联流量', min: 0, max: 10, step: 0.05 },
  ],
}

export const GAME_PRESETS: GamePreset[] = [
  {
    id: 'standoff',
    name: '多空对峙',
    model: 'matrix',
    topic: '多空双方在关键价位的攻守取舍',
    desc: '静态矩阵：观察纳什均衡与占优策略',
    params: { capital: [1e8, 1e8], priceImpact: 0.06, carryCost: 0.03, conflictCost: 0.05, retreatLoss: 0.03 },
  },
  {
    id: 'squeeze',
    name: '逼空挤压',
    model: 'simulate',
    topic: '资金逼空引发空头级联平仓',
    desc: 'ABM 蒙特卡洛：观察挤空概率与尾部回撤',
    params: {
      initialPrice: 100,
      lambda: 0.02,
      sigma: 0.006,
      rounds: 120,
      paths: 500,
      longWeight: 1.4,
      shortWeight: 1.4,
      arbWeight: 0.3,
      mmLiquidity: 0.4,
      retailNoise: 0.35,
      cascadeThreshold: 0.05,
      cascadeFlow: 0.75,
      momentumWindow: 10,
      momentumScale: 0.008,
      stalemateBand: 0.02,
    },
  },
  {
    id: 'signal',
    name: '信号跟随',
    model: 'evolve',
    topic: '趋势信号在多空群体中的扩散',
    desc: '演化博弈：观察 ESS 与多初值收敛路径',
    params: {
      feedback: 'logistic',
      priceImpact: 0.03,
      carryCost: 0.12,
      logisticK: 2,
      duration: 120,
      dt: 0.05,
      initialValues: [0.05, 0.25, 0.5, 0.75, 0.95],
      samples: 1000,
    },
  },
  {
    id: 'policy',
    name: '政策冲击',
    model: 'sequence',
    topic: '政策消息落地后的先后手应对',
    desc: '序贯博弈：观察先动优势与均衡路径',
    params: { leader: 'long', capital: [1e8, 1e8], priceImpact: 0.08, carryCost: 0.03, conflictCost: 0.06, retreatLoss: 0.05 },
  },
]

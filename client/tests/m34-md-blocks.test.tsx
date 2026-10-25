/**
 * M34 批 C2：```kline / ```game 块渲染内测试。
 * - Markdown 路由：lang 分派到 KlineBlock / GameBlock（懒加载内核，测试 mock 边界）；
 * - KlineBlock：内联 data 直用、流式纯文本、错误卡回退、src 无会话报错、周期切换实拉、源码开关、全屏；
 * - GameBlock：内联 matrix 渲染（chips/矩阵/narrative/免责）、src 快照通道、模拟数据缺失、
 *   simulate 分派（echarts mock 挂载）、gameStatsChips 各模型要点。
 * 说明：chart/entry（klinecharts）与 echarts/core 在此文件 mock——jsdom 无 Canvas；
 * 内核组件本身的行为由上游库保证，这里验证块级装配与数据装配。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Markdown } from '../src/components/chat/Markdown'
import { gameStatsChips } from '../src/components/game/GameResultView'
import { createKlineChart } from '../src/components/finance/chart/entry'
import { clearMarkdownCaches } from '../src/lib/md-cache'
import { useCanvasStore } from '../src/stores/canvas-store'
import { useSessionStore } from '../src/stores/session-store'

vi.mock('../src/components/finance/chart/entry', () => ({
  createKlineChart: vi.fn(() => ({
    update: vi.fn(),
    beginDraw: vi.fn(),
    cancelDraw: vi.fn(),
    setManualEvents: vi.fn(),
    exportPng: vi.fn(),
    resize: vi.fn(),
    dispose: vi.fn(),
  })),
}))
vi.mock('echarts/core', () => ({
  use: vi.fn(),
  init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })),
}))

// ---------- fixtures ----------

const KLINE_BARS = [
  { timestamp: 1757952000000, open: 1450, high: 1468, low: 1442, close: 1461, volume: 28300 },
  { timestamp: 1758038400000, open: 1461, high: 1475, low: 1450, close: 1456, volume: 22100 },
  { timestamp: 1758124800000, open: 1456, high: 1462, low: 1438, close: 1444, volume: 19700 },
]
const KLINE_DATA = {
  kind: 'kline',
  symbol: 'sh600519',
  name: '贵州茅台',
  period: 'day',
  adjust: 'qfq',
  bars: KLINE_BARS,
}
const KLINE_JSON = JSON.stringify({
  data: KLINE_DATA,
  indicators: ['MA', 'VOL', 'MACD'],
  annotations: [{ type: 'priceLine', price: 1475, label: '压力位' }],
})

/** M83：带分析结论 / 落图的块（分析面板 + 阶段色带 + 落图入参） */
const KLINE_ANALYSIS = {
  asOf: '2026-09-25T00:00:00.000Z',
  bars: 3,
  period: 'day',
  adjust: 'qfq',
  phases: {
    current: 'accumulation',
    confidence: 62,
    since: '2026-09-20',
    description: '低位缩量横盘、筹码集中',
    bands: [
      { ts: 1757952000000, phase: 'accumulation' },
      { ts: 1758038400000, phase: 'accumulation' },
      { ts: 1758124800000, phase: 'accumulation' },
    ],
  },
  sentiment: { score: 42, stage: 'hesitate', pathLabel: '恐慌→犹豫→修复→乐观→狂热（当前：犹豫）' },
  levels: { support: { price: 1442, basis: '前低', touches: 2 }, resistance: null, target: null },
  features: [{ key: 'platform', label: '平台整理', confirmed: true }],
  drawings: [{ id: 'an-support', kind: 'hline', points: [{ ts: 1758038400000, price: 1442 }], label: '支撑 1442' }],
  notes: ['阶段判定为规则化统计口径，仅供复盘研究'],
}
const KLINE_ANALYSIS_JSON = JSON.stringify({
  data: KLINE_DATA,
  indicators: ['MA', 'VOL'],
  drawings: [{ id: 'an-support', kind: 'hline', points: [{ ts: 1758038400000, price: 1442 }], label: '支撑 1442' }],
  analysis: KLINE_ANALYSIS,
})

const MATRIX_RESULT = {
  actions: ['aggressive', 'hold', 'retreat'],
  payoffs: [
    [{ long: -1.2, short: 0.8 }, { long: 0.6, short: -0.3 }, { long: 1.1, short: -0.7 }],
    [{ long: -0.4, short: 0.5 }, { long: 0.2, short: 0.1 }, { long: 0.7, short: -0.5 }],
    [{ long: -0.9, short: 0.9 }, { long: -0.2, short: 0.4 }, { long: 0.3, short: 0.2 }],
  ],
  pureNash: [{ long: 'hold', short: 'hold' }],
  mixedNash: [
    { long: { aggressive: 0.2, hold: 0.5, retreat: 0.3 }, short: { aggressive: 0.3, hold: 0.4, retreat: 0.3 }, degenerate: false },
  ],
  dominant: {},
  gameType: 'chicken',
  gameTypeLabel: '懦夫博弈',
}
const MATRIX_STATS = { gameType: 'chicken', gameTypeLabel: '懦夫博弈', pureNashCount: 1, mixedNashCount: 1 }
const GAME_MATRIX_JSON = JSON.stringify({
  model: 'matrix',
  data: {
    kind: 'game',
    model: 'matrix',
    topic: '茅台多空对峙推演',
    symbol: 'sh600519',
    seed: 20260918,
    meta: { params: { rounds: 5 }, asOf: '2026-09-18T10:30:00+08:00' },
    stats: MATRIX_STATS,
    narrative: '懦夫博弈：先退让方损失最小',
    result: MATRIX_RESULT,
  },
})

const GAME_SNAPSHOT = {
  kind: 'game',
  model: 'matrix',
  topic: '茅台多空对峙推演',
  symbol: 'sh600519',
  seed: 20260918,
  meta: { params: { rounds: 5 }, asOf: '2026-09-18T10:30:00+08:00' },
  stats: MATRIX_STATS,
  narrative: '懦夫博弈：先退让方损失最小',
  result: MATRIX_RESULT,
}

const SIMULATE_RESULT = {
  initialPrice: 1700,
  rounds: 5,
  paths: 200,
  bands: {
    rounds: [0, 1, 2, 3, 4],
    p5: [1700, 1650, 1610, 1580, 1550],
    p25: [1700, 1680, 1660, 1640, 1620],
    p50: [1700, 1700, 1710, 1715, 1720],
    p75: [1700, 1720, 1740, 1760, 1780],
    p95: [1700, 1750, 1800, 1840, 1880],
  },
  samplePaths: [[1700, 1690, 1705, 1712, 1708]],
  finalHistogram: [
    { binStart: 1500, count: 12 },
    { binStart: 1700, count: 60 },
    { binStart: 1900, count: 20 },
  ],
  pnl: {
    long: { mean: 0.032, p5: -0.11, p50: 0.02, p95: 0.21 },
    short: { mean: -0.028, p5: -0.2, p50: -0.02, p95: 0.09 },
  },
  maxDrawdown: { mean: 0.05, p5: 0.012, p50: 0.044, p95: 0.118 },
  events: { squeeze: 0.2, crash: 0.15, stalemate: 0.4, other: 0.25 },
}
const GAME_SIMULATE_JSON = JSON.stringify({
  model: 'simulate',
  data: {
    kind: 'game',
    model: 'simulate',
    topic: '茅台多空对峙推演',
    seed: 20260918,
    stats: { squeezeProb: 0.2, crashProb: 0.15, stalemateProb: 0.4, medianReturn: 0.02, maxDrawdownP95: 0.118 },
    result: SIMULATE_RESULT,
  },
})

const fetchMock = vi.fn()
function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response
}

beforeEach(() => {
  clearMarkdownCaches()
  vi.mocked(createKlineChart).mockClear()
  fetchMock.mockReset()
  fetchMock.mockImplementation(async () => jsonResponse({}))
  vi.stubGlobal('fetch', fetchMock)
  useSessionStore.setState({ currentId: undefined, sessions: [], byId: new Map(), order: [] })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------- KlineBlock ----------

describe('```kline 块（Markdown 路由 + 内核装配）', () => {
  it('内联 data：解析后交给 klinecharts 内核（懒加载 chunk）创建画布', async () => {
    const { container } = render(<Markdown content={'```kline\n' + KLINE_JSON + '\n```'} />)
    await waitFor(() => expect(container.querySelector('.md-kline-canvas[data-state="ready"]')).not.toBeNull())
    expect(vi.mocked(createKlineChart)).toHaveBeenCalledTimes(1)
    const input = vi.mocked(createKlineChart).mock.calls[0][1]
    expect(input.dataset.name).toBe('贵州茅台')
    expect(input.dataset.bars).toHaveLength(3)
    // M83：indicators 旧字段在宿主层推导为主/副图（MA → 主图；VOL → 副图）
    expect(input.mainIndicator).toBe('MA')
    expect(input.subIndicator).toBe('VOL')
    expect(input.annotations).toHaveLength(1)
    expect(input.label).toBe('贵州茅台 日K（前复权）')
    expect(container.querySelector('.md-block-lang')?.textContent).toBe('kline')
    expect(container.querySelector('.md-klineblock .md-block-title')?.textContent).toBe('贵州茅台 日K（前复权）')
  })

  it('M83：携带 analysis / drawings → 分析面板渲染 + 入参携带落图与阶段（智能分析按钮隐藏）', async () => {
    const { container } = render(<Markdown content={'```kline\n' + KLINE_ANALYSIS_JSON + '\n```'} />)
    await waitFor(() => expect(container.querySelector('.md-kline-canvas[data-state="ready"]')).not.toBeNull())
    expect(container.querySelector('.md-kline-analysis')).not.toBeNull()
    expect(container.textContent).toContain('阶段分析')
    expect(container.textContent).toContain('吸筹')
    const input = vi.mocked(createKlineChart).mock.calls.at(-1)![1]
    expect(input.drawings).toHaveLength(1)
    expect(input.phases).toHaveLength(3)
    expect(input.showPhases).toBe(true)
    // 已有分析：不再展示「智能分析」按钮
    expect(screen.queryByTitle(/智能分析/)).toBeNull()
  })

  it('流式期间：仅纯文本源码，不触发内核', () => {
    const { container } = render(<Markdown content={'```kline\n' + KLINE_JSON + '\n```'} streaming />)
    expect(container.querySelector('.md-klineblock')).toBeNull()
    expect(container.textContent).toContain('sh600519')
    expect(vi.mocked(createKlineChart)).not.toHaveBeenCalled()
  })

  it('非法 JSON：错误卡 + 源码回退，不加载内核', () => {
    const { container } = render(<Markdown content={'```kline\n{ not json }\n```'} />)
    expect(container.querySelector('.md-chart-error')).not.toBeNull()
    expect(container.textContent).toContain('K 线配置无效')
    expect(container.querySelector('.md-code-plain')).not.toBeNull()
    expect(vi.mocked(createKlineChart)).not.toHaveBeenCalled()
  })

  it('未知指标：错误卡给出可选清单', () => {
    const { container } = render(
      <Markdown content={'```kline\n{"data":' + JSON.stringify(KLINE_DATA) + ',"indicators":["BOLL2"]}\n```'} />,
    )
    expect(container.querySelector('.md-chart-error')!.textContent).toContain('不支持的指标 "BOLL2"')
    expect(vi.mocked(createKlineChart)).not.toHaveBeenCalled()
  })

  it('src 且无会话上下文：错误卡提示无法读取快照', async () => {
    const { container } = render(<Markdown content={'```kline\n{"src":"charts/sh600519-day-202609181030.json"}\n```'} />)
    await waitFor(() =>
      expect(container.querySelector('.md-chart-error')?.textContent).toContain('当前无会话上下文，无法读取K 线快照文件'),
    )
    expect(vi.mocked(createKlineChart)).not.toHaveBeenCalled()
  })

  it('周期切换：直连 /api/finance/kline 实拉并重绘（仅本地展示）', async () => {
    const user = userEvent.setup()
    const { container } = render(<Markdown content={'```kline\n' + KLINE_JSON + '\n```'} />)
    await waitFor(() => expect(container.querySelector('.md-kline-canvas[data-state="ready"]')).not.toBeNull())
    expect(screen.getByRole('button', { name: '日K' }).className).toContain('is-active')

    fetchMock.mockImplementation(async () => jsonResponse({ kline: { ...KLINE_DATA, period: 'week' } }))
    await user.click(screen.getByRole('button', { name: '周K' }))
    await waitFor(() => expect(vi.mocked(createKlineChart)).toHaveBeenCalledTimes(2))
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/finance/kline?symbol=sh600519&period=week&adjust=qfq&indicators=VOL&limit=250'),
    )
    const second = vi.mocked(createKlineChart).mock.calls[1][1]
    expect(second.dataset.period).toBe('week')
    expect(container.textContent).toContain('实拉视图')
    // 实拉视图下芯片高亮跟随展示周期（而非快照周期）
    expect(screen.getByRole('button', { name: '周K' }).className).toContain('is-active')
    expect(screen.getByRole('button', { name: '日K' }).className).not.toContain('is-active')

    // 切换失败：错误提示 + 保持原视图
    fetchMock.mockImplementation(async () => ({
      ok: false,
      status: 502,
      json: async () => ({ error: '网关不可用' }),
    }))
    await user.click(screen.getByRole('button', { name: '月K' }))
    await waitFor(() => expect(container.querySelector('.md-kline-switch-error')?.textContent).toContain('网关不可用'))
    expect(vi.mocked(createKlineChart)).toHaveBeenCalledTimes(2)
  })

  it('源码开关与全屏：Overlay 内二次挂载内核 + Esc 关闭', async () => {
    const user = userEvent.setup()
    const { container } = render(<Markdown content={'```kline\n' + KLINE_JSON + '\n```'} />)
    await waitFor(() => expect(vi.mocked(createKlineChart)).toHaveBeenCalledTimes(1))

    await user.click(screen.getByTitle('查看源码'))
    expect(container.querySelector('.md-klineblock .md-code-plain')).not.toBeNull()
    await user.click(screen.getByTitle('收起源码'))
    expect(container.querySelector('.md-klineblock .md-code-plain')).toBeNull()

    await user.click(screen.getByTitle('全屏查看'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await waitFor(() => expect(vi.mocked(createKlineChart)).toHaveBeenCalledTimes(2))
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('送上画布：sendKline 携带 bars 与元信息（标的 / 名称 / 周期 / 复权 / 指标）', async () => {
    const user = userEvent.setup()
    const sendKline = vi.fn(async (_data: unknown) => 'nd_k1')
    const original = useCanvasStore.getState().sendKline
    useCanvasStore.setState({ sendKline })
    try {
      render(<Markdown content={'```kline\n' + KLINE_JSON + '\n```'} />)
      await waitFor(() => expect(vi.mocked(createKlineChart)).toHaveBeenCalledTimes(1))
      await user.click(screen.getByTitle('送上画布（落为 K 线节点，可切换周期 / 复权）'))
      expect(sendKline).toHaveBeenCalledTimes(1)
      expect(sendKline.mock.calls[0]?.[0]).toMatchObject({
        symbol: 'sh600519',
        name: '贵州茅台',
        period: 'day',
        adjust: 'qfq',
        indicators: ['MA', 'VOL', 'MACD'],
      })
      expect((sendKline.mock.calls[0]?.[0] as { bars?: unknown[] }).bars).toHaveLength(3)
    } finally {
      useCanvasStore.setState({ sendKline: original })
    }
  })
})

// ---------- GameBlock ----------

describe('```game 块（Markdown 路由 + 结果视图）', () => {
  it('内联 matrix：懒加载结果视图，chips / 矩阵 / 叙事 / 免责齐全', async () => {
    const { container } = render(<Markdown content={'```game\n' + GAME_MATRIX_JSON + '\n```'} />)
    await screen.findByText('茅台多空对峙推演 · 静态矩阵博弈')
    await waitFor(() => expect(container.querySelector('.md-game-svg')).not.toBeNull())
    expect(container.querySelector('.md-block-lang')?.textContent).toBe('game')

    // 结论 chips 与矩阵 SVG
    expect(container.querySelector('.md-game-chips')?.textContent).toContain('懦夫博弈')
    expect(container.querySelector('.md-game-chips')?.textContent).toContain('纯 1 / 混合 1')
    expect(container.querySelector('.md-game-svg-nash')?.textContent).toBe('均衡')

    // 叙事与免责（模型推演非预测 + 种子复现口径）
    expect(container.querySelector('.md-game-narrative')?.textContent).toContain('先退让方损失最小')
    expect(container.querySelector('.md-game-footnote')?.textContent).toContain('模型推演，非预测')
    expect(container.querySelector('.md-game-footnote')?.textContent).toContain('种子 20260918')
  })

  it('流式期间：仅纯文本源码', () => {
    const { container } = render(<Markdown content={'```game\n' + GAME_MATRIX_JSON + '\n```'} streaming />)
    expect(container.querySelector('.md-gameblock')).toBeNull()
    expect(container.textContent).toContain('"model":"matrix"')
  })

  it('未知模型：错误卡 + 源码回退', () => {
    const { container } = render(<Markdown content={'```game\n{"src":"charts/game-a.json","model":"auction"}\n```'} />)
    expect(container.querySelector('.md-chart-error')!.textContent).toContain('不支持的博弈模型 "auction"')
    expect(container.querySelector('.md-code-plain')).not.toBeNull()
  })

  it('内联 data 缺 result：结果缺失提示（不崩）', async () => {
    const noResult = JSON.stringify({ model: 'matrix', data: { kind: 'game', model: 'matrix', topic: '缺结果的推演' } })
    const { container } = render(<Markdown content={'```game\n' + noResult + '\n```'} />)
    await screen.findByText('缺结果的推演 · 静态矩阵博弈')
    expect(container.querySelector('.md-game-missing')?.textContent).toContain('结果数据缺失')
  })

  it('src 快照：经交付件通道取数并复用解析器校验（会话上下文）', async () => {
    useSessionStore.setState({ currentId: 's1', sessions: [], byId: new Map(), order: [] })
    fetchMock.mockImplementation(async () => jsonResponse(GAME_SNAPSHOT))
    const { container } = render(
      <Markdown content={'```game\n{"src":"charts/game-maotai-duikang-202609181030.json","model":"matrix"}\n```'} />,
    )
    await waitFor(() => expect(container.querySelector('.md-game-svg')).not.toBeNull())
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/sessions/s1/artifacts/content?path=charts%2Fgame-maotai-duikang-202609181030.json&raw=1'),
    )
    expect(container.querySelector('.md-game-chips')?.textContent).toContain('懦夫博弈')
  })

  it('src 快照内容无效：错误卡提示快照无效', async () => {
    useSessionStore.setState({ currentId: 's1', sessions: [], byId: new Map(), order: [] })
    fetchMock.mockImplementation(async () => jsonResponse([1, 2]))
    const { container } = render(
      <Markdown content={'```game\n{"src":"charts/game-bad-202609181030.json","model":"matrix"}\n```'} />,
    )
    await waitFor(() => expect(container.querySelector('.md-chart-error')).not.toBeNull())
    expect(container.querySelector('.md-chart-error')!.textContent).toContain('博弈快照内容无效')
  })

  it('simulate 模型：分派到蒙特卡洛视图（分位带 / 直方图 / 盈亏 / 事件 chips）', async () => {
    const { container } = render(<Markdown content={'```game\n' + GAME_SIMULATE_JSON + '\n```'} />)
    await waitFor(() => expect(container.querySelector('.md-game-simulate')).not.toBeNull())
    expect(container.textContent).toContain('价格路径分位带（200 条路径 · 5 轮）')
    expect(container.textContent).toContain('终值分布')
    expect(container.textContent).toContain('多空累积盈亏')
    expect(container.querySelector('.md-game-events')?.textContent).toContain('挤空 20.0%')
    expect(container.querySelector('.md-game-events')?.textContent).toContain('僵持 40.0%')
    const chips = container.querySelector('.md-game-chips')
    expect(chips?.textContent).toContain('回撤 P95')
    expect(chips?.textContent).toContain('11.8%')
    // 免责与种子
    expect(container.querySelector('.md-game-footnote')?.textContent).toContain('模型推演，非预测')
  })

  it('全屏：Overlay 承载结果视图 + Esc 关闭', async () => {
    const user = userEvent.setup()
    render(<Markdown content={'```game\n' + GAME_MATRIX_JSON + '\n```'} />)
    await screen.findByText('茅台多空对峙推演 · 静态矩阵博弈')
    await user.click(screen.getByTitle('全屏查看'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('源码开关：显示与收起', async () => {
    const user = userEvent.setup()
    const { container } = render(<Markdown content={'```game\n' + GAME_MATRIX_JSON + '\n```'} />)
    await screen.findByText('茅台多空对峙推演 · 静态矩阵博弈')
    expect(container.querySelector('.md-gameblock .md-code-plain')).toBeNull()
    await user.click(screen.getByTitle('查看源码'))
    expect(container.querySelector('.md-gameblock .md-code-plain')).not.toBeNull()
    await user.click(screen.getByTitle('收起源码'))
    expect(container.querySelector('.md-gameblock .md-code-plain')).toBeNull()
  })

  it('送上画布：sendGame 携带数据集全量字段（topic / symbol / seed / params / 结果态直出）', async () => {
    const user = userEvent.setup()
    const sendGame = vi.fn(async (_data: unknown) => 'nd_game1')
    const original = useCanvasStore.getState().sendGame
    useCanvasStore.setState({ sendGame })
    try {
      render(<Markdown content={'```game\n' + GAME_MATRIX_JSON + '\n```'} />)
      await screen.findByText('茅台多空对峙推演 · 静态矩阵博弈')
      await user.click(screen.getByTitle('送上画布（落为博弈节点，可继续调参推演）'))
      expect(sendGame).toHaveBeenCalledTimes(1)
      expect(sendGame.mock.calls[0]?.[0]).toMatchObject({
        model: 'matrix',
        topic: '茅台多空对峙推演',
        symbol: 'sh600519',
        seed: 20260918,
        params: { rounds: 5 },
      })
      expect((sendGame.mock.calls[0]?.[0] as { result?: unknown }).result).toEqual(MATRIX_RESULT)
    } finally {
      useCanvasStore.setState({ sendGame: original })
    }
  })
})

// ---------- gameStatsChips（服务端 stats → 结论要点） ----------

describe('gameStatsChips：各模型要点映射', () => {
  it('matrix：结构 / 均衡数量 / 占优策略', () => {
    expect(gameStatsChips('matrix', MATRIX_STATS)).toEqual([
      { label: '博弈结构', value: '懦夫博弈' },
      { label: '均衡', value: '纯 1 / 混合 1' },
    ])
    expect(gameStatsChips('matrix', { ...MATRIX_STATS, dominantLong: '进攻' })).toContainEqual({ label: '占优（多头）', value: '进攻' })
  })

  it('sequence：先动方 / 均衡路径 / 收益与先动优势', () => {
    const stats = {
      leader: 'long',
      equilibriumPath: '进攻 → 观望',
      leaderPayoff: 1.5,
      followerPayoff: -0.5,
      firstMoverAdvantage: 0.8,
    }
    expect(gameStatsChips('sequence', stats)).toEqual([
      { label: '先动方', value: 'long' },
      { label: '均衡路径', value: '进攻 → 观望' },
      { label: '均衡收益', value: '多头 +1.5 / 空头 -0.5' },
      { label: '先动优势', value: '+0.8' },
    ])
  })

  it('evolve：固定点 / ESS / 中性区间', () => {
    expect(gameStatsChips('evolve', { fixedPointCount: 2, stableCount: 1, ess: [0.75], neutral: true })).toEqual([
      { label: '固定点', value: '2 个（稳定 1）' },
      { label: 'ESS', value: '0.75' },
      { label: '中性区间', value: '无渐进稳定解' },
    ])
  })

  it('simulate：事件概率 / 中位收益 / 回撤分位', () => {
    const stats = { squeezeProb: 0.2, crashProb: 0.15, stalemateProb: 0.4, medianReturn: 0.02, maxDrawdownP95: 0.118 }
    expect(gameStatsChips('simulate', stats)).toEqual([
      { label: '挤空', value: '20.0%' },
      { label: '踩踏', value: '15.0%' },
      { label: '僵持', value: '40.0%' },
      { label: '中位收益', value: '+2.00%' },
      { label: '回撤 P95', value: '11.8%' },
    ])
  })

  it('缺项自动跳过、非有限数忽略', () => {
    expect(gameStatsChips('matrix', {})).toEqual([])
    expect(gameStatsChips('simulate', { squeezeProb: Number.NaN, crashProb: 0.1 })).toEqual([{ label: '踩踏', value: '10.0%' }])
    expect(gameStatsChips('matrix', undefined)).toEqual([])
  })
})

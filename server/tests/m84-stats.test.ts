/**
 * M84 H2：统计引擎测试 —— 事件检测器（6 类）/ Node 兜底统计 / fin_stats 工具（桥通道 + 降级矩阵 + 快照）/
 * 真脚本冒烟（按本机能力守卫：pandas / scipy 可用性）。
 *
 * 依赖注入：真实网关（runPy 回放；零网络零 spawn）+ 临时会话工作区；真脚本冒烟直调 runBridge。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Fetcher } from '../src/finance/fetcher.js'
import { createFinanceGateway, type PyAvailability } from '../src/finance/gateway.js'
import { runBridge } from '../src/finance/bridge/runner.js'
import { detectEvents, nodeSummary, type PySignificanceResult, type PyStatsResult } from '../src/finance/stats.js'
import { FinanceStore } from '../src/store/finance.js'
import type { ToolRuntime, ToolResult } from '../src/tools/registry.js'
import { makeEnv } from './helpers.js'
import type { KlineBar } from '../src/finance/types.js'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'finance')
const CLOCK = new Date('2026-09-18T02:00:00.000Z')
const BASE_TS = Date.parse('2025-01-06T00:00:00+08:00')

/** 合成 K 线（正弦 + 趋势；有涨有跌保证金叉与事件触发存在） */
function syntheticBars(n = 160, closesOverride?: number[], volumesOverride?: number[]): KlineBar[] {
  const closes: number[] = []
  for (let i = 0; i < n; i++) closes.push(closesOverride?.[i] ?? 100 + 12 * Math.sin(i / 5) + i * 0.05)
  return closes.map((c, i) => {
    const open = i === 0 ? c : closes[i - 1]
    return {
      timestamp: BASE_TS + i * 86_400_000,
      open,
      high: Math.max(open, c) * 1.005,
      low: Math.min(open, c) * 0.995,
      close: c,
      volume: volumesOverride?.[i] ?? 15_000 + 3_000 * Math.sin(i / 4),
    }
  })
}

function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8')
}

function makeFetcher(): Fetcher {
  return async (req) => {
    const url = req.url
    let text: string | undefined
    if (url.includes('clist/get')) {
      const isEtf = /MK002[1-4]/.test(url)
      text = fixture(isEtf ? 'eastmoney-clist-screen-etf.json' : 'eastmoney-clist-screen.json')
    } else if (url.includes('kline/get')) text = fixture('eastmoney-kline-long.json')
    if (text === undefined) throw new Error(`无匹配 fixture：${url}`)
    return { status: 200, ok: true, statusText: 'OK', finalUrl: url, headers: new Headers(), text, setCookies: [] }
  }
}

// ---------------------------------------------------------------- 桥结果夹具

const PY_STATS_RESULT: PyStatsResult = {
  names: ['A（sh600000）', 'B（sz000001）'],
  engine: 'python',
  items: {
    summary: [
      { name: 'A（sh600000）', points: 160, first: 100, last: 120, changePct: 20, annualReturnPct: 47.2, annualVolPct: 17.8, maxDrawdownPct: 16.3, percentile: 1, skew: -0.08, kurtosis: -1.5 },
      { name: 'B（sz000001）', points: 160, first: 50, last: 52, changePct: 4, annualReturnPct: 8.1, annualVolPct: 9.2, maxDrawdownPct: 7.7, percentile: 0.9, skew: 0.1, kurtosis: -0.9 },
    ],
    correlation: { names: ['A（sh600000）', 'B（sz000001）'], pearson: [[1, 0.62], [0.62, 1]], spearman: [[1, 0.58], [0.58, 1]], rollingWindow: 60, rollingLast: { 'A（sh600000）|B（sz000001）': 0.71 }, points: 159 },
    stationarity: [{ name: 'A（sh600000）', priceP: 0.42, returnP: 0.01 }],
  },
  notes: [],
}

const PY_SIG_RESULT: PySignificanceResult = {
  events: 12,
  bars: 160,
  alpha: 0.05,
  bonferroniAlpha: 0.025,
  bootstrap: 2000,
  seed: 42,
  horizons: [
    { horizon: 1, samples: 12, meanPct: 1.2, medianPct: 0.9, winRate: 0.5833, profitFactor: 1.8, tStat: 2.1, pValue: 0.03, significant: false, ciLowPct: -0.3, ciHighPct: 2.4, baselineMeanPct: 0.1, excessPct: 1.1 },
    { horizon: 5, samples: 11, meanPct: 3.4, medianPct: 2.8, winRate: 0.6364, profitFactor: 2.4, tStat: 3.3, pValue: 0.008, significant: true, ciLowPct: 1.1, ciHighPct: 5.9, baselineMeanPct: 0.6, excessPct: 2.8 },
  ],
  notes: ['多重检验校正：Bonferroni α\' = α / 窗口数'],
}

function setup(opts: { bars?: KlineBar[]; pyStatus?: PyAvailability; pyHandlers?: Record<string, (params: Record<string, unknown>) => unknown>; pyThrow?: string } = {}) {
  const bars = opts.bars ?? syntheticBars()
  const env = makeEnv({ financeEnabled: true, financeKlineSnapshotDir: 'charts', financeGameMaxPaths: 50 })
  const pyCalls: Array<{ task: string; params: Record<string, unknown> }> = []
  const gateway = createFinanceGateway({
    db: env.db,
    fetcher: makeFetcher(),
    pyStatus: async () => opts.pyStatus ?? 'ready',
    runPy: async (task, params) => {
      pyCalls.push({ task, params })
      if (task === 'kline') return { bars }
      if (opts.pyThrow) throw new Error(opts.pyThrow)
      const handler = opts.pyHandlers?.[task]
      if (handler) return handler(params)
      throw new Error(`fake bridge 未定义任务：${task}`)
    },
    now: () => new Date(CLOCK),
  })
  const store = new FinanceStore(env.db)
  const session = env.sessions.create(['pm'], 'M84 统计测试')
  const workspace = env.artifacts.ensureSessionDir(session.id)
  const runtime: ToolRuntime = {
    sessionId: session.id,
    runId: 'r1',
    agentId: 'pm',
    workspace,
    artifacts: env.artifacts,
    skills: env.skills,
    memory: env.memory,
    tasks: env.tasks,
    participants: [{ id: 'pm', name: '费利' }],
    todos: [],
    allowRunCommand: false,
    allowedCommands: [],
    allowSensitive: false,
    webSearch: { apiKey: '', apiUrl: '', htmlUrl: '' },
    httpUserAgent: '',
    httpMinIntervalMs: 0,
    httpTimeoutMs: 15_000,
    loadSkill: () => ({ ok: false, error: 'n/a' }),
    finance: gateway,
    financeStore: store,
  }
  return { env, gateway, runtime, workspace, registry: env.tools, pyCalls }
}

// ---------------------------------------------------------------- 事件检测器

describe('M84 事件检测器', () => {
  it('ma_cross_up：与手工 sma 交叉序列一致', () => {
    const bars = syntheticBars()
    const r = detectEvents(bars, { kind: 'ma_cross_up', fast: 5, slow: 20 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.events.length).toBeGreaterThan(0)
    expect(r.label).toContain('上穿')
    // 逐点复核：事件点必须满足前根未穿 / 当根穿越
    const closes = bars.map((b) => b.close)
    for (const i of r.events) {
      const f0 = closes.slice(0, i).slice(-5).reduce((a, b) => a + b, 0) / 5
      const s0 = closes.slice(0, i).slice(-20).reduce((a, b) => a + b, 0) / 20
      const f1 = closes.slice(0, i + 1).slice(-5).reduce((a, b) => a + b, 0) / 5
      const s1 = closes.slice(0, i + 1).slice(-20).reduce((a, b) => a + b, 0) / 20
      expect(f0 <= s0 && f1 > s1).toBe(true)
    }
  })

  it('drop_pct / rise_pct：构造单点跌幅命中', () => {
    const closes = [...new Array(40).fill(100), 92]
    for (let i = 0; i < 20; i++) closes.push(92 + i * 0.5)
    const bars = syntheticBars(closes.length, closes)
    const drop = detectEvents(bars, { kind: 'drop_pct', window: 1, pct: 5 })
    expect(drop.ok).toBe(true)
    if (drop.ok) expect(drop.events).toContain(40)

    const closes2 = [...new Array(40).fill(100), 110]
    for (let i = 0; i < 20; i++) closes2.push(110 - i * 0.5)
    const rise = detectEvents(syntheticBars(closes2.length, closes2), { kind: 'rise_pct', window: 1, pct: 5 })
    expect(rise.ok).toBe(true)
    if (rise.ok) expect(rise.events).toContain(40)
  })

  it('volume_spike：构造放量单点命中', () => {
    const volumes = [...new Array(30).fill(10_000)]
    volumes[25] = 35_000
    const bars = syntheticBars(40, undefined, volumes)
    const r = detectEvents(bars, { kind: 'volume_spike', ratio: 2, window: 20 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.events).toContain(25)
  })

  it('touch_level：bar 区间覆盖关键位；容差模式放宽', () => {
    const closes = [...new Array(30).fill(101)]
    closes[20] = 99
    const bars = syntheticBars(closes.length, closes)
    const strict = detectEvents(bars, { kind: 'touch_level', price: 100 })
    expect(strict.ok).toBe(true)
    // bar20 自身覆盖 100；bar21 的 open=bar20 收盘（99）致区间下探至 100 以下，同样覆盖
    if (strict.ok) expect(strict.events).toEqual([20, 21])
    const tolerance = detectEvents(bars, { kind: 'touch_level', price: 100, tolerancePct: 1 })
    expect(tolerance.ok).toBe(true)
    if (tolerance.ok) expect(tolerance.events.length).toBeGreaterThan(20)
  })

  it('参数错误与样本不足', () => {
    const bars = syntheticBars()
    const bad = detectEvents(bars, { kind: 'ma_cross_up', fast: 20, slow: 5 })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toContain('fast < slow')
    const noPrice = detectEvents(bars, { kind: 'touch_level' })
    expect(noPrice.ok).toBe(false)
    const small = detectEvents(syntheticBars(20), { kind: 'drop_pct', pct: 5 })
    expect(small.ok).toBe(false)
  })
})

describe('M84 Node 兜底统计', () => {
  it('nodeSummary：区间涨跌 / 最大回撤 / 完美相关矩阵 / 缺失项注明', () => {
    const closesA = Array.from({ length: 60 }, (_, i) => 100 + i)
    const closesB = closesA.map((c) => c * 2)
    const ts = closesA.map((_, i) => BASE_TS + i * 86_400_000)
    const out = nodeSummary([
      { name: 'A', timestamps: ts, closes: closesA },
      { name: 'B', timestamps: ts, closes: closesB },
    ])
    expect(out.engine).toBe('node')
    expect(out.summaries[0].changePct).toBeCloseTo((closesA[closesA.length - 1] / closesA[0] - 1) * 100, 6)
    expect(out.summaries[0].maxDrawdownPct).toBe(0)
    expect(out.correlation).not.toBeNull()
    expect(out.correlation!.pearson[0][1]).toBeCloseTo(1, 6)
    expect(out.missing.length).toBeGreaterThan(0)

    const declining = nodeSummary([{ name: 'D', timestamps: ts.slice(0, 5), closes: [100, 80, 90, 85, 95] }])
    expect(declining.summaries[0].maxDrawdownPct).toBeCloseTo(20, 6)
  })
})

// ---------------------------------------------------------------- fin_stats 工具

describe('M84 fin_stats：summary', () => {
  it('桥可用：输出描述统计 / 相关性 / ADF 表 + 快照（engine=py）', async () => {
    const { registry, runtime, workspace, pyCalls } = setup({
      pyHandlers: { stats: () => PY_STATS_RESULT },
    })
    const result = (await registry.execute('fin_stats', { analysis: 'summary', symbols: ['600519', '000001'] }, runtime)) as ToolResult
    expect(result.ok, result.summary).toBe(true)
    expect(result.summary).toContain('py')
    expect(result.detail ?? '').toContain('描述统计')
    expect(result.detail ?? '').toContain('收益相关性')
    expect(result.detail ?? '').toContain('ADF 平稳性')
    expect(result.detail ?? '').toContain('+47.20%')
    const statsCall = pyCalls.find((c) => c.task === 'stats')
    expect(statsCall).toBeDefined()
    expect((statsCall!.params.series as unknown[]).length).toBe(2)
    const snapPath = result.artifacts![0]
    const snap = JSON.parse(fs.readFileSync(path.join(workspace, snapPath), 'utf8')) as { kind?: string; meta?: { engine?: string } }
    expect(snap.kind).toBe('stats')
    expect(snap.meta?.engine).toBe('python-bridge')
  })

  it('统计扩展缺包（kline 正常，stats 任务报缺包）：Node 兜底 + 安装引导', async () => {
    const { registry, runtime } = setup({ pyThrow: '缺少 Python 包 pandas（用于统计分析）' })
    const result = (await registry.execute('fin_stats', { analysis: 'summary', symbols: ['600519', '000001'], persist: false }, runtime)) as ToolResult
    expect(result.ok, result.summary).toBe(true)
    expect(result.summary).toContain('node')
    expect(result.detail ?? '').toContain('已降级 Node 基础统计')
    expect(result.detail ?? '').toContain('group=analytics')
    expect(result.detail ?? '').toContain('缺失项')
    expect(result.detail ?? '').toContain('Pearson')
  })

  it('缺 symbols → 明确失败', async () => {
    const { registry, runtime } = setup()
    const result = (await registry.execute('fin_stats', { analysis: 'summary' }, runtime)) as ToolResult
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('symbols')
  })
})

describe('M84 fin_stats：significance', () => {
  it('桥可用：事件触发 → 表格含显著判定 / Bonferroni / 快照', async () => {
    const { registry, runtime, workspace, pyCalls } = setup({
      pyHandlers: { significance: () => PY_SIG_RESULT },
    })
    const result = (await registry.execute(
      'fin_stats',
      { analysis: 'significance', symbol: '600519', event: { kind: 'ma_cross_up', fast: 5, slow: 20 }, horizons: [1, 5] },
      runtime,
    )) as ToolResult
    expect(result.ok, result.summary).toBe(true)
    expect(result.detail ?? '').toContain('显著')
    expect(result.detail ?? '').toContain('不显著')
    expect(result.detail ?? '').toContain('Bonferroni')
    expect(result.summary).toContain('显著窗口：h=5')
    const call = pyCalls.find((c) => c.task === 'significance')
    expect(call).toBeDefined()
    expect((call!.params.events as number[]).length).toBeGreaterThan(0)
    expect(call!.params.seed).toBeUndefined() // seed 缺省由桥侧固定（可复现）
    const snap = JSON.parse(fs.readFileSync(path.join(workspace, result.artifacts![0]), 'utf8')) as { meta?: { analysis?: string } }
    expect(snap.meta?.analysis).toBe('significance')
  })

  it('桥 absent（kline 走 Node 源）→ 明确失败 + 安装引导（不做 Node 近似）', async () => {
    const { registry, runtime } = setup({ pyStatus: 'absent' })
    const result = (await registry.execute(
      'fin_stats',
      { analysis: 'significance', symbol: '600519', event: { kind: 'drop_pct', pct: 0.1, window: 1 }, persist: false },
      runtime,
    )) as ToolResult
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('统计引擎不可用')
    expect(result.detail ?? '').toContain('group=analytics')
  })

  it('缺 scipy → 失败并给出安装引导', async () => {
    const { registry, runtime } = setup({ pyThrow: '缺少 Python 包 scipy（用于显著性检验）' })
    const result = (await registry.execute(
      'fin_stats',
      { analysis: 'significance', symbol: '600519', event: { kind: 'ma_cross_up' }, persist: false },
      runtime,
    )) as ToolResult
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('scipy')
    expect(result.detail ?? '').toContain('fin_env action=install group=analytics')
  })

  it('事件 0 次：如实返回「无事件样本」+ 放宽建议', async () => {
    const { registry, runtime } = setup()
    const result = (await registry.execute(
      'fin_stats',
      { analysis: 'significance', symbol: '600519', event: { kind: 'drop_pct', pct: 45, window: 1 }, persist: false },
      runtime,
    )) as ToolResult
    expect(result.ok).toBe(true)
    expect(result.summary).toContain('无事件样本')
    expect(result.detail ?? '').toContain('放宽')
  })

  it('缺 event / symbol → 明确失败', async () => {
    const { registry, runtime } = setup()
    const noEvent = (await registry.execute('fin_stats', { analysis: 'significance', symbol: '600519' }, runtime)) as ToolResult
    expect(noEvent.ok).toBe(false)
    expect(noEvent.summary).toContain('event')
    const noSymbol = (await registry.execute('fin_stats', { analysis: 'significance', event: { kind: 'ma_cross_up' } }, runtime)) as ToolResult
    expect(noSymbol.ok).toBe(false)
    expect(noSymbol.summary).toContain('symbol')
  })
})

// ---------------------------------------------------------------- 真脚本冒烟（按本机能力守卫）

function pythonOk(): boolean {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function moduleOk(name: string): boolean {
  if (!pythonOk()) return false
  try {
    execFileSync('python3', ['-c', `import ${name}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const HAS_PY = pythonOk()
const HAS_PANDAS = moduleOk('pandas')
const HAS_SCIPY = moduleOk('scipy')

describe('M84 Python 桥：真脚本冒烟', () => {
  it.runIf(HAS_PY && HAS_PANDAS)('stats：真脚本输出描述统计与相关性（含 ADF 缺包降级说明）', async () => {
    const closes = Array.from({ length: 120 }, (_, i) => 100 + 10 * Math.sin(i / 6) + i * 0.1)
    const res = await runBridge<PyStatsResult>(
      'stats',
      { series: [{ name: 'a', closes }, { name: 'b', closes: closes.map((c) => c * 1.2) }] },
      { python: 'python3', timeoutMs: 30_000 },
    )
    expect(res.data.names).toEqual(['a', 'b'])
    expect(res.data.items.summary?.[0].annualReturnPct).not.toBeNull()
    expect(res.data.items.correlation?.pearson[0][1]).toBeCloseTo(1, 3)
    // 本机有/无 statsmodels 均可：缺失时 notes 给出安装引导
    if (!moduleOk('statsmodels')) {
      expect(res.data.notes.join('')).toContain('statsmodels')
    } else {
      expect(res.data.items.stationarity?.length).toBe(2)
    }
  })

  it.runIf(HAS_PY && HAS_PANDAS)('significance：有 scipy 全量输出 / 无 scipy 给 DEP_MISSING 引导', async () => {
    const closes = Array.from({ length: 120 }, (_, i) => 100 + 10 * Math.sin(i / 6) + i * 0.1)
    const events = [10, 25, 40, 55, 70, 85, 100]
    if (HAS_SCIPY) {
      const res = await runBridge<PySignificanceResult>(
        'significance',
        { closes, events, horizons: [1, 5], bootstrap: 500 },
        { python: 'python3', timeoutMs: 60_000 },
      )
      expect(res.data.events).toBe(7)
      const h1 = res.data.horizons[0]
      expect(h1.samples).toBeGreaterThan(0)
      expect(typeof h1.pValue).toBe('number')
      expect(typeof h1.ciLowPct).toBe('number')
      expect(res.data.bonferroniAlpha).toBeCloseTo(0.025, 6)
    } else {
      await expect(
        runBridge('significance', { closes, events, horizons: [1, 5] }, { python: 'python3', timeoutMs: 30_000 }),
      ).rejects.toMatchObject({ code: 'DEP_MISSING' })
    }
  })
})

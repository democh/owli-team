/**
 * M83 批 B：金融工具与路由测试 —— fin_analyze / fin_strategy / fin_backtest(template='dsl') +
 * /api/finance/analysis、/strategy/lint、/strategy/run、/strategy/meta。
 *
 * 依赖注入：真实网关（py 桥 handler 回放合成 bars；零网络零 spawn）+ Express 真实 HTTP 往返；
 * 快照写入会话工作区 charts/ 并解析回读校验；「模板 ma-cross ↔ 等价 DSL」回测一致性为口径锁定断言。
 */
import fs from 'node:fs'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import express from 'express'
import { describe, expect, it, afterEach } from 'vitest'
import { KLINE_PHASES } from '@multi-agent/shared'
import type { Fetcher } from '../src/finance/fetcher.js'
import { createFinanceGateway } from '../src/finance/gateway.js'
import { DSL_BUILTINS } from '../src/finance/dsl/builtin.js'
import { FinanceStore } from '../src/store/finance.js'
import type { ToolRuntime, ToolResult } from '../src/tools/registry.js'
import { createFinanceRouter } from '../src/routes/finance.js'
import type { ApiDeps } from '../src/routes/index.js'
import { makeEnv } from './helpers.js'

const FIXTURES = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'finance')

function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8')
}

/** 固定时钟（北京时间 2026-09-18 10:00） */
const CLOCK = new Date('2026-09-18T02:00:00.000Z')

const BASE_TS = Date.parse('2025-01-06T00:00:00+08:00')

/** 合成 K 线（正弦波形：有涨有跌，保证金叉与「连涨」边沿触发存在） */
function syntheticBars(n = 160): Array<Record<string, number>> {
  const bars: Array<Record<string, number>> = []
  for (let i = 0; i < n; i++) {
    const close = 100 + 12 * Math.sin(i / 5) + i * 0.05
    const open = i === 0 ? close : 100 + 12 * Math.sin((i - 1) / 5) + (i - 1) * 0.05
    bars.push({
      timestamp: BASE_TS + i * 86_400_000,
      open,
      high: Math.max(open, close) * 1.01,
      low: Math.min(open, close) * 0.99,
      close,
      volume: 15_000 + 3_000 * Math.sin(i / 4),
      turnover: (15_000 + 3_000 * Math.sin(i / 4)) * close * 100,
    })
  }
  return bars
}

/** fixture 回放 Fetcher（主数据；kline 走 py handler 合成） */
function makeFetcher(): Fetcher {
  return async (req) => {
    const url = req.url
    let text: string | undefined
    if (url.includes('clist/get')) {
      const isEtf = /MK002[1-4]/.test(url)
      text = fixture(isEtf ? 'eastmoney-clist-screen-etf.json' : 'eastmoney-clist-screen.json')
    }
    if (text === undefined) throw new Error(`无匹配 fixture：${url}`)
    return { status: 200, ok: true, statusText: 'OK', finalUrl: url, headers: new Headers(), text, setCookies: [] }
  }
}

function setup(opts: { bars?: number; financeEnabled?: boolean } = {}) {
  const bars = syntheticBars(opts.bars ?? 160)
  const env = makeEnv({
    financeEnabled: opts.financeEnabled ?? true,
    financeKlineSnapshotDir: 'charts',
    financeGameMaxPaths: 50,
  })
  const gateway = createFinanceGateway({
    db: env.db,
    fetcher: makeFetcher(),
    pyStatus: async () => 'ready',
    runPy: async (task) => {
      if (task === 'kline') return { bars }
      throw new Error(`fake bridge 未定义任务：${task}`)
    },
    now: () => new Date(CLOCK),
  })
  const store = new FinanceStore(env.db)
  const session = env.sessions.create(['pm'], 'M83 工具测试')
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
  return { env, gateway, runtime, workspace, registry: env.tools, deps: { cfg: env.cfg, finance: gateway, financeStore: store } as unknown as ApiDeps }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn().catch(() => undefined)
})

async function listenRouter(router: express.Router): Promise<string> {
  const app = express()
  app.use(express.json())
  app.use('/api', router)
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const { port } = server.address() as AddressInfo
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return `http://127.0.0.1:${port}`
}

/** 从工具 detail 提取 kline 块模板 JSON（复制即渲染的载荷） */
function blockOf(detail: string | undefined): Record<string, unknown> {
  const m = /```kline title="[^"]+"\n([^\n]+)\n```/.exec(detail ?? '')
  if (!m) throw new Error(`detail 中未找到 kline 块模板：\n${detail}`)
  return JSON.parse(m[1]) as Record<string, unknown>
}

describe('M83 工具：fin_analyze', () => {
  it('分析就绪：摘要含阶段；快照携带 analysis/drawings/render；块模板含 render.showPhases', async () => {
    const { registry, runtime, workspace } = setup()
    const result = (await registry.execute('fin_analyze', { symbol: '600519', persist: true }, runtime)) as ToolResult
    expect(result.ok, result.summary).toBe(true)
    expect(result.summary).toContain('阶段')
    expect(result.artifacts?.length).toBe(1)
    const snapPath = result.artifacts![0]
    const snap = JSON.parse(fs.readFileSync(path.join(workspace, snapPath), 'utf8')) as {
      render?: { showPhases?: boolean; mainIndicator?: string }
      drawings?: unknown[]
      analysis?: { phases?: { current?: string; bands?: unknown[] }; sentiment?: { score?: number }; notes?: string[] }
    }
    expect(snap.render?.showPhases).toBe(true)
    expect(snap.render?.mainIndicator).toBe('MA')
    expect(snap.analysis?.phases?.bands?.length).toBeGreaterThan(0)
    expect(KLINE_PHASES).toContain(snap.analysis?.phases?.current as never)
    expect(typeof snap.analysis?.sentiment?.score).toBe('number')
    expect(snap.analysis?.notes?.length).toBeGreaterThan(0)
    expect((snap.drawings ?? []).length).toBeGreaterThan(0)
    const block = blockOf(result.detail)
    expect(block.src).toBe(snapPath)
    expect((block.render as { showPhases?: boolean }).showPhases).toBe(true)
  })

  it('persist=false：不落盘、且不做块模板', async () => {
    const { registry, runtime } = setup()
    const result = (await registry.execute('fin_analyze', { symbol: '600519', persist: false }, runtime)) as ToolResult
    expect(result.ok).toBe(true)
    expect(result.artifacts).toBeUndefined()
    expect(result.detail ?? '').not.toContain('```kline')
  })
})

describe('M83 工具：fin_strategy', () => {
  const edgeDsl = `name: 连涨观察
inputs: {}
signals:
  - when: "close > ref(close, 1)"
    emit:
      direction: long
      confidence: 0.7
      entry: "close"
      stop_loss: "close - 2"
      take_profit: ["close + 4"]
`

  it('lint：合法源通过 / 非法源给出错误清单（免取数）', async () => {
    const { registry, runtime } = setup()
    const ok = (await registry.execute('fin_strategy', { action: 'lint', dsl: edgeDsl }, runtime)) as ToolResult
    expect(ok.ok).toBe(true)
    expect(ok.summary).toContain('通过')

    const bad = (await registry.execute(
      'fin_strategy',
      { action: 'lint', dsl: 'name: t\nsignals:\n  - when: "closes > 1"\n    emit: { direction: long }' },
      runtime,
    )) as ToolResult
    expect(bad.ok).toBe(false)
    expect(bad.summary).toContain('未通过')
    expect(bad.detail ?? '').toContain('[错误]')
  })

  it('run：触发路径（signal + 快照 + 块模板）与未触发路径（facts 排查提示）', async () => {
    const { registry, runtime, workspace } = setup()
    const hit = (await registry.execute('fin_strategy', { action: 'run', dsl: edgeDsl, symbol: '600519' }, runtime)) as ToolResult
    expect(hit.ok, hit.summary).toBe(true)
    expect(hit.summary).toContain('触发做多信号')
    expect(hit.detail ?? '').toContain('facts 变量快照')
    const snapPath = hit.artifacts![0]
    const snap = JSON.parse(fs.readFileSync(path.join(workspace, snapPath), 'utf8')) as {
      signal?: { direction?: string; entry?: number; groupId?: string }
      drawings?: unknown[]
    }
    expect(snap.signal?.direction).toBe('long')
    expect(typeof snap.signal?.entry).toBe('number')
    expect(snap.signal?.groupId).toBe('strategy:连涨观察')
    const block = blockOf(hit.detail)
    expect(block.src).toBe(snapPath)

    const miss = (await registry.execute(
      'fin_strategy',
      { action: 'run', dsl: 'name: t\nsignals:\n  - when: "close > 999999"\n    emit: { direction: long, entry: "close" }', symbol: '600519' },
      runtime,
    )) as ToolResult
    expect(miss.ok).toBe(true)
    expect(miss.summary).toContain('未触发')
    expect(miss.detail ?? '').toContain('last_when')
  })

  it('run：inputs 覆盖未声明键 → 失败（DSL 执行护栏）', async () => {
    const { registry, runtime } = setup()
    const result = (await registry.execute(
      'fin_strategy',
      { action: 'run', dsl: edgeDsl, symbol: '600519', inputs: { foo: 1 } },
      runtime,
    )) as ToolResult
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('未声明参数')
  })
})

describe('M83 工具：fin_backtest(template=dsl) 口径一致性', () => {
  const maCrossDsl = DSL_BUILTINS.find((b) => b.key === 'ma-cross')!.source

  it('模板 ma-cross ↔ 等价 DSL：总收益 / 交易数一致（同一把尺）', async () => {
    const { registry, runtime } = setup()
    const template = (await registry.execute(
      'fin_backtest',
      { symbol: '600519', template: 'ma-cross', params: { fast: 5, slow: 20 }, persist: false },
      runtime,
    )) as ToolResult
    expect(template.ok, template.summary).toBe(true)

    const dsl = (await registry.execute(
      'fin_backtest',
      { symbol: '600519', template: 'dsl', dsl: maCrossDsl, dsl_inputs: { fast: 5, slow: 20 }, persist: false },
      runtime,
    )) as ToolResult
    expect(dsl.ok, dsl.summary).toBe(true)
    expect(dsl.detail ?? '').toContain('信号源：DSL')

    const metricOf = (detail: string | undefined, label: string): string => {
      const m = new RegExp(`\\| ${label} \\| ([^|]+) \\|`).exec(detail ?? '')
      if (!m) throw new Error(`未找到指标行 ${label}`)
      return m[1].trim()
    }
    expect(metricOf(dsl.detail, '总收益')).toBe(metricOf(template.detail, '总收益'))
    expect(metricOf(dsl.detail, '交易数')).toBe(metricOf(template.detail, '交易数'))
    expect(metricOf(dsl.detail, '最大回撤')).toBe(metricOf(template.detail, '最大回撤'))
  })

  it('互斥校验：dsl 缺失 / 误配均失败', async () => {
    const { registry, runtime } = setup()
    const noDsl = (await registry.execute('fin_backtest', { symbol: '600519', template: 'dsl', persist: false }, runtime)) as ToolResult
    expect(noDsl.ok).toBe(false)
    expect(noDsl.summary).toContain('需提供 dsl 源码')

    const misused = (await registry.execute(
      'fin_backtest',
      { symbol: '600519', template: 'ma-cross', dsl: maCrossDsl, persist: false },
      runtime,
    )) as ToolResult
    expect(misused.ok).toBe(false)
    expect(misused.summary).toContain("仅用于 template='dsl'")
  })
})

describe('M83 路由：analysis / strategy', () => {
  it('GET /finance/strategy/meta：元数据齐备（免 finance 网关）', async () => {
    const { deps } = setup()
    const url = await listenRouter(createFinanceRouter(deps))
    const res = await fetch(`${url}/api/finance/strategy/meta`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { version?: number; functions?: unknown[]; drawing_kinds?: string[]; builtins?: unknown[]; schema?: { type?: string } }
    expect(body.version).toBe(1)
    expect((body.functions ?? []).length).toBeGreaterThanOrEqual(20)
    expect(body.drawing_kinds).toContain('hline')
    expect((body.builtins ?? []).length).toBe(DSL_BUILTINS.length)
    expect(body.schema?.type).toBe('object')
  })

  it('POST /finance/strategy/lint：非法源返回 findings（200 非异常）', async () => {
    const { deps } = setup()
    const url = await listenRouter(createFinanceRouter(deps))
    const res = await fetch(`${url}/api/finance/strategy/lint`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dsl: 'name: t\nsignals:\n  - when: "ref(close, -1) > 0"\n    emit: { direction: long }' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok?: boolean; findings?: Array<{ code?: string }> }
    expect(body.ok).toBe(false)
    expect((body.findings ?? []).map((f) => f.code)).toContain('FUTURE_REF')
  })

  it('POST /finance/strategy/run：执行返回 result（signal / facts / drawings）', async () => {
    const { deps } = setup()
    const url = await listenRouter(createFinanceRouter(deps))
    const res = await fetch(`${url}/api/finance/strategy/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        dsl: 'name: t\nsignals:\n  - when: "close > ref(close, 1)"\n    emit: { direction: long, entry: "close" }',
        symbol: '600519',
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result?: { triggered?: boolean; signal?: { direction?: string }; facts?: { bars?: number } } }
    expect(body.result?.triggered).toBe(true)
    expect(body.result?.signal?.direction).toBe('long')
    expect(body.result?.facts?.bars).toBeGreaterThan(0)
  })

  it('GET /finance/analysis：返回分析结论（阶段 / 情绪 / 关键位）', async () => {
    const { deps } = setup()
    const url = await listenRouter(createFinanceRouter(deps))
    const res = await fetch(`${url}/api/finance/analysis?symbol=600519&limit=160`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { analysis?: { phases?: { current?: string; bands?: unknown[] }; sentiment?: { score?: number }; levels?: unknown } }
    expect(KLINE_PHASES).toContain(body.analysis?.phases?.current as never)
    expect((body.analysis?.phases?.bands ?? []).length).toBeGreaterThan(0)
    expect(typeof body.analysis?.sentiment?.score).toBe('number')
    expect(body.analysis?.levels).toBeDefined()
  })

  it('未启用网关：analysis/run 走 503（lint 免网关）', async () => {
    const { deps } = setup({ financeEnabled: false })
    // 网关仍装配于 deps（测试桩），改用手工剔除网关验证 503 语义
    const url = await listenRouter(createFinanceRouter({ ...deps, finance: undefined } as unknown as ApiDeps))
    const res = await fetch(`${url}/api/finance/analysis?symbol=600519`)
    expect(res.status).toBe(503)
    const lint = await fetch(`${url}/api/finance/strategy/lint`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dsl: 'name: t\nsignals:\n  - when: "close > 1"\n    emit: { direction: long }' }),
    })
    expect(lint.status).toBe(200)
  })
})

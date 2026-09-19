/**
 * M34 金融工具集测试（12 个 fin_* 工具）：注册 / 分类 / 未启用降级 / 契约回执 / 审批门 / 快照落盘。
 *
 * 依赖注入：真实 ToolRegistry（createToolRegistry）+ 真实网关（fixture 回放 Fetcher）+ FinanceStore +
 * 审批桩；不打网络、不 spawn。快照写入会话工作区 charts/ 目录并解析回读校验。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { ApprovalOutcome } from '../src/approval.js'
import type { Fetcher } from '../src/finance/fetcher.js'
import { createFinanceGateway, type PyAvailability } from '../src/finance/gateway.js'
import { FinanceStore } from '../src/store/finance.js'
import { toolCategory } from '../src/tools/categories.js'
import type { ToolRuntime } from '../src/tools/registry.js'
import { makeEnv } from './helpers.js'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'finance')

function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8')
}

/** 固定时钟（北京时间 2026-09-18 10:00） */
const CLOCK = new Date('2026-09-18T02:00:00.000Z')

/**
 * fixture 回放 Fetcher：
 * - clist：按 fs 过滤段区分股票 / ETF 两份底表（含行情列，主数据与筛选底表共用）；
 * - kline：返回 30 根序列（支持回测 ≥10 根样本）；
 * - 其余命中既有 fixture。
 */
function makeFetcher(): Fetcher {
  return async (req) => {
    const url = req.url
    let text: string | undefined
    if (url.includes('clist/get')) {
      const isEtf = /MK002[1-4]/.test(url)
      text = fixture(isEtf ? 'eastmoney-clist-screen-etf.json' : 'eastmoney-clist-screen.json')
    } else if (url.includes('ulist.np')) text = fixture('eastmoney-quote.json')
    else if (url.includes('kline/get')) text = fixture('eastmoney-kline-long.json')
    else if (url.includes('suggest/get')) text = fixture('eastmoney-suggest.json')
    else if (url.includes('security/ann')) text = fixture('notice.json')
    else if (url.includes('roll/get')) text = fixture('sina-roll.json')
    else if (url.includes('f10/lsjz')) text = fixture('fund-lsjz.json')
    else if (url.includes('pingzhongdata')) text = fixture('fund-pingzhongdata.js')
    if (text === undefined) throw new Error(`无匹配 fixture：${url}`)
    return {
      status: 200,
      ok: true,
      statusText: 'OK',
      finalUrl: url,
      headers: new Headers(),
      text,
      setCookies: [],
    }
  }
}

interface PyHarness {
  status?: PyAvailability
  handlers?: Record<string, (params: Record<string, unknown>) => unknown>
}

function approvalOutcome(over: Partial<ApprovalOutcome> = {}): ApprovalOutcome {
  return { approval: {} as ApprovalOutcome['approval'], decision: 'approve', timedOut: false, ...over }
}

function setup(opts: { py?: PyHarness; overrides?: Record<string, unknown> } = {}) {
  const env = makeEnv({
    financeEnabled: true,
    financeKlineSnapshotDir: 'charts',
    financeGameMaxPaths: 50,
    ...(opts.overrides ?? {}),
  })
  const gateway = createFinanceGateway({
    db: env.db,
    fetcher: makeFetcher(),
    pyStatus: async () => opts.py?.status ?? 'ready',
    runPy: async (task, params) => {
      const handler = opts.py?.handlers?.[task]
      if (!handler) throw new Error(`fake bridge 未定义任务：${task}`)
      return handler(params)
    },
    now: () => new Date(CLOCK),
  })
  const store = new FinanceStore(env.db)
  const session = env.sessions.create(['pm'], '金融工具测试')
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
    webFetchAllowedDomains: [],
    webSearch: { enabled: false, apiKey: '', apiUrl: '', htmlUrl: '' },
    httpUserAgent: '',
    httpMinIntervalMs: 0,
    httpTimeoutMs: 15_000,
    loadSkill: () => ({ ok: false, error: 'n/a' }),
    finance: gateway,
    financeStore: store,
  }
  return { env, gateway, store, runtime, workspace, registry: env.tools, session }
}

/** 读取工作区 charts 目录中的快照文件（按前缀过滤） */
function snapshotFiles(workspace: string, re: RegExp): string[] {
  const dir = path.join(workspace, 'charts')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((name) => re.test(name))
}

function readSnapshot<T>(workspace: string, name: string): T {
  return JSON.parse(fs.readFileSync(path.join(workspace, 'charts', name), 'utf8')) as T
}

const FIN_TOOLS = [
  'fin_env',
  'fin_search',
  'fin_quote',
  'fin_kline',
  'fin_indicator',
  'fin_fund',
  'fin_fundamental',
  'fin_news',
  'fin_screen',
  'fin_backtest',
  'fin_game',
  'fin_watch',
] as const

describe('M34 工具：注册 / 分类 / 未启用降级', () => {
  it('12 个 fin_ 工具全部注册为 deferred，分类「金融数据」，readOnly 分布正确', () => {
    const { registry } = setup()
    for (const name of FIN_TOOLS) {
      const tool = registry.list().find((t) => t.name === name)
      expect(tool, `${name} 应已注册`).toBeDefined()
      expect(tool?.tier).toBe('deferred')
      expect(toolCategory(name)).toBe('金融数据')
    }
    const readOnlyOf = (name: string) => registry.list().find((t) => t.name === name)?.readOnly
    expect(readOnlyOf('fin_env')).toBe(false)
    expect(readOnlyOf('fin_watch')).toBe(false)
    for (const name of FIN_TOOLS) {
      if (name === 'fin_env' || name === 'fin_watch') continue
      expect(readOnlyOf(name), name).toBe(true)
    }
  })

  it('FINANCE_ENABLED=false（默认关闭）时不注册任何 fin_ 工具', () => {
    const env = makeEnv({ financeEnabled: false })
    expect(env.tools.list().filter((t) => t.name.startsWith('fin_'))).toHaveLength(0)
  })

  it('未装配网关 → 数据 / 量化工具统一返回「未启用」提示（不抛错）', async () => {
    const { registry, runtime } = setup()
    const bare: ToolRuntime = { ...runtime, finance: undefined }
    const cases: Array<[string, Record<string, unknown>]> = [
      ['fin_env', { action: 'status' }],
      ['fin_search', { query: '600519' }],
      ['fin_quote', { symbols: ['600519'] }],
      ['fin_kline', { symbol: '600519' }],
      ['fin_indicator', { indicator: 'MA', closes: [1, 2, 3, 4, 5] }],
      ['fin_fund', { code: '000001' }],
      ['fin_fundamental', { symbol: '600519' }],
      ['fin_news', {}],
      ['fin_screen', {}],
      ['fin_backtest', { symbol: '600519', template: 'ma-cross' }],
      ['fin_game', { action: 'matrix', topic: '测试' }],
      ['fin_watch', { action: 'list' }],
    ]
    for (const [name, args] of cases) {
      const result = await registry.execute(name, args, bare)
      expect(result.ok, name).toBe(false)
      expect(result.summary, name).toContain('未启用')
    }
  })
})

describe('M34 工具：fin_search / fin_quote', () => {
  it('fin_search：代码 / 名称命中本地主数据并回显归一 symbol 线索', async () => {
    const { registry, runtime } = setup()
    const byCode = await registry.execute('fin_search', { query: '600519' }, runtime)
    expect(byCode.ok).toBe(true)
    expect(byCode.summary).toContain('命中 1 条')
    expect(byCode.detail).toContain('贵州茅台')

    const byName = await registry.execute('fin_search', { query: '茅台' }, runtime)
    expect(byName.ok).toBe(true)
    expect(byName.detail).toContain('600519')

    const byType = await registry.execute('fin_search', { query: 'ETF', type: 'etf' }, runtime)
    if (byType.ok) expect(byType.detail).not.toContain('贵州茅台')
  })

  it('fin_quote：批量快照表格（价格 / 涨跌幅 / 市值格式化）', async () => {
    const { registry, runtime } = setup()
    const result = await registry.execute('fin_quote', { symbols: ['600519', '159915'] }, runtime)
    expect(result.ok).toBe(true)
    expect(result.summary).toContain('获取 2/2 支标的快照')
    expect(result.summary).toContain('eastmoney')
    expect(result.detail).toContain('贵州茅台（sh600519）')
    expect(result.detail).toContain('1,461.00')
    expect(result.detail).toContain('+1.39%')
    expect(result.detail).toContain('18360.00 亿')
    expect(result.detail).toContain('总市值')
  })

  it('fin_quote：fields 子集控制列；全部无法识别 → 明确错误', async () => {
    const { registry, runtime } = setup()
    const subset = await registry.execute('fin_quote', { symbols: ['600519'], fields: ['price', 'pe'] }, runtime)
    expect(subset.ok).toBe(true)
    expect(subset.detail).toContain('| 标的 | 最新价 | PE(动) |')
    expect(subset.detail).not.toContain('总市值')

    const missing = await registry.execute('fin_quote', { symbols: ['不存在的标的xyz'] }, runtime)
    expect(missing.ok).toBe(false)
    expect(missing.summary).toContain('未能识别')
  })
})

describe('M34 工具：fin_kline / fin_indicator', () => {
  it('fin_kline：取数 + 统计 + 落盘快照 + kline 块模板与 artifacts', async () => {
    const { registry, runtime, workspace } = setup()
    const result = await registry.execute('fin_kline', { symbol: '600519' }, runtime)
    expect(result.ok).toBe(true)
    expect(result.summary).toContain('K 线就绪：贵州茅台 日K ×30 根')
    expect(result.detail).toContain('```kline title=')
    expect(result.detail).toContain('区间涨跌')
    const artifacts = result.artifacts ?? []
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]).toMatch(/^charts\/sh600519-day-\d{12}\.json$/)
    const files = snapshotFiles(workspace, /^sh600519-day-/)
    expect(files).toHaveLength(1)
    const snap = readSnapshot<{ kind: string; meta: { symbol: string; bars: number }; indicators: string[] }>(workspace, files[0])
    expect(snap.kind).toBe('kline')
    expect(snap.meta.bars).toBe(30)
    expect(snap.indicators).toEqual(['MA', 'VOL'])
  })

  it('fin_kline：persist=false 不落盘、不给块模板', async () => {
    const { registry, runtime, workspace } = setup()
    const result = await registry.execute('fin_kline', { symbol: '600519', persist: false }, runtime)
    expect(result.ok).toBe(true)
    expect(result.artifacts).toBeUndefined()
    expect(result.detail).toContain('persist=false')
    expect(snapshotFiles(workspace, /^sh600519-day-/)).toHaveLength(0)
  })

  it('fin_indicator：closes 序列模式（免取数）输出最新值与近 5 期', async () => {
    const { registry, runtime } = setup()
    const closes = Array.from({ length: 20 }, (_, i) => 100 + Math.sin(i / 3) * 5)
    const result = await registry.execute('fin_indicator', { indicator: 'MA', closes }, runtime)
    expect(result.ok).toBe(true)
    expect(result.summary).toContain('MA 最新')
    expect(result.detail).toContain('序列模式')
    expect(result.detail).toContain('MA5')
    expect(result.detail).toContain('信号：')
  })
})

describe('M34 工具：fin_fund / fin_fundamental / fin_news', () => {
  it('fin_fund：场外基金档案（名称 / 费率 / 来源）', async () => {
    const { registry, runtime } = setup()
    const result = await registry.execute('fin_fund', { code: '000001', kind: 'fund' }, runtime)
    expect(result.ok).toBe(true)
    expect(result.summary).toContain('华夏成长混合（000001）')
    expect(result.detail).toContain('管理费率')
    expect(result.detail).toContain('来源 eastmoney-fund')
  })

  it('fin_fundamental：年度模式多期拉取 + 报告期标签 + 同比行', async () => {
    const { registry, runtime } = setup({
      py: {
        handlers: {
          fundamentals: (params) => ({
            rows: [
              {
                statDate: `${String(params.year)}-12-31`,
                MBRevenue: 1e11,
                netProfit: 5e10,
                roeAvg: 25.5,
                gpMargin: 91.2,
                npMargin: 51.1,
                epsTTM: 45.6,
              },
            ],
          }),
        },
      },
    })
    const result = await registry.execute('fin_fundamental', { symbol: '600519', reportType: 'year', years: 2 }, runtime)
    expect(result.ok).toBe(true)
    expect(result.summary).toContain('财务数据 2 期')
    expect(result.summary).toContain('2025Q4')
    expect(result.detail).toContain('2024Q4')
    expect(result.detail).toContain('baostock')
    expect(result.detail).toContain('同比')
  })

  it('fin_news：个股公告（官方信源优先）与市场快讯双模式', async () => {
    const { registry, runtime } = setup()
    const bySymbol = await registry.execute('fin_news', { symbol: '600519' }, runtime)
    expect(bySymbol.ok).toBe(true)
    expect(bySymbol.summary).toContain('「贵州茅台」新闻公告')
    expect(bySymbol.detail).toContain('http')

    const byMarket = await registry.execute('fin_news', { market: 'cn' }, runtime)
    expect(byMarket.ok).toBe(true)
    expect(byMarket.summary).toContain('市场新闻公告')
  })
})

describe('M34 工具：fin_screen', () => {
  it('条件筛选（数值 + 排序）+ 命中计数 + 快照落盘', async () => {
    const { registry, runtime, workspace } = setup()
    const result = await registry.execute(
      'fin_screen',
      { conditions: [{ field: 'pe', op: 'lt', value: 20 }], orderBy: { field: 'marketCap', desc: true } },
      runtime,
    )
    expect(result.ok).toBe(true)
    expect(result.summary).toContain('命中 3/6')
    expect(result.summary).toContain('eastmoney')
    // 市值降序：宁德时代（9200 亿）> 沪深300ETF（1500 亿）> 平安银行（2230 亿）？
    const detail = result.detail ?? ''
    expect(detail).toContain('300750')
    expect(detail).toContain('510300')
    expect(detail.indexOf('300750')).toBeLessThan(detail.indexOf('510300'))
    const files = snapshotFiles(workspace, /^screen-\d{12}\.json$/)
    expect(files).toHaveLength(1)
    const snap = readSnapshot<{ kind: string; meta: { matched: number; total: number; limit: number } }>(workspace, files[0])
    expect(snap.kind).toBe('screen')
    expect(snap.meta).toMatchObject({ matched: 3, total: 6, limit: 30 })
  })

  it('type=etf 限定底表；非法字段 → 明确错误', async () => {
    const { registry, runtime } = setup()
    const etf = await registry.execute('fin_screen', { type: 'etf', persist: false }, runtime)
    expect(etf.ok).toBe(true)
    expect(etf.summary).toContain('命中 2/2')

    const bad = await registry.execute('fin_screen', { conditions: [{ field: 'ghost', op: 'gt', value: 1 }] }, runtime)
    expect(bad.ok).toBe(false)
    expect(bad.summary).toContain('不支持的筛选字段')
  })
})

describe('M34 工具：fin_backtest / fin_game', () => {
  it('fin_backtest：ma-cross 30 根样本 → 绩效表 + 交易明细 + 快照', async () => {
    const { registry, runtime, workspace } = setup()
    const result = await registry.execute('fin_backtest', { symbol: '600519', template: 'ma-cross' }, runtime)
    expect(result.ok).toBe(true)
    expect(result.summary).toContain('回测完成')
    expect(result.summary).toContain('ma-cross')
    expect(result.detail).toContain('单边费率')
    expect(result.detail).toContain('交易明细')
    const artifacts = result.artifacts ?? []
    expect(artifacts[0]).toMatch(/^charts\/sh600519-backtest-\d{12}\.json$/)
    const files = snapshotFiles(workspace, /backtest-\d{12}\.json$/)
    expect(files).toHaveLength(1)
    const snap = readSnapshot<{ kind: string; metrics: { trades: number }; trades: unknown[] }>(workspace, files[0])
    expect(snap.kind).toBe('backtest')
    expect(snap.metrics.trades).toBeGreaterThanOrEqual(1)
    expect(snap.trades.length).toBe(snap.metrics.trades)
  })

  it('fin_backtest：区间样本不足 → 错误回执（不落快照）', async () => {
    const { registry, runtime, workspace } = setup()
    const result = await registry.execute(
      'fin_backtest',
      { symbol: '600519', template: 'ma-cross', start: '2026-08-25', end: '2026-09-01' },
      runtime,
    )
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('样本不足')
    expect(snapshotFiles(workspace, /backtest-/)).toHaveLength(0)
  })

  it('fin_game：matrix 推演 → 快照 + game 块 + 固定声明', async () => {
    const { registry, runtime, workspace, env } = setup()
    const result = await registry.execute('fin_game', { action: 'matrix', topic: '茅台多空对峙推演' }, runtime)
    expect(result.ok).toBe(true)
    expect(result.summary).toContain('博弈推演完成')
    expect(result.detail).toContain('模型推演，非预测')
    expect(result.detail).toContain('```game')
    expect(result.detail).toContain(`种子 ${env.cfg.financeGameSeed}`)
    const artifacts = result.artifacts ?? []
    expect(artifacts[0]).toMatch(/^charts\/game-.*-\d{12}\.json$/)
    const files = snapshotFiles(workspace, /^game-.*\.json$/)
    expect(files).toHaveLength(1)
    const snap = readSnapshot<{ kind: string; model: string; meta: { note?: string } }>(workspace, files[0])
    expect(snap.kind).toBe('game')
    expect(snap.model).toBe('matrix')
    expect(snap.meta.note).toBe('模型推演，非预测')
  })

  it('fin_game：simulate paths 按 FINANCE_GAME_MAX_PATHS 截断（护栏说明）', async () => {
    const { registry, runtime } = setup()
    const result = await registry.execute('fin_game', { action: 'simulate', topic: '路径护栏', params: { paths: 9999 } }, runtime)
    expect(result.ok).toBe(true)
    expect(result.detail).toContain('限制为 50')
    expect(result.detail).toContain('模型推演，非预测')
  })
})

describe('M34 工具：fin_watch（审批门四态）', () => {
  it('list 空列表提示；add 无审批通道 → 阻止写操作（安全默认）', async () => {
    const { registry, runtime, store } = setup()
    const empty = await registry.execute('fin_watch', { action: 'list' }, runtime)
    expect(empty.ok).toBe(true)
    expect(empty.summary).toContain('自选列表为空')

    const blocked = await registry.execute('fin_watch', { action: 'add', symbol: '600519' }, runtime)
    expect(blocked.ok).toBe(false)
    expect(blocked.summary).toContain('审批通道未启用')
    expect(store.count()).toBe(0)
  })

  it('add 审批通过 → 落库（upsert 语义）；list 回显；remove 审批通过 → 移除', async () => {
    const { registry, runtime, store } = setup()
    const withApproval: ToolRuntime = { ...runtime, requestApproval: async () => approvalOutcome() }

    const added = await registry.execute('fin_watch', { action: 'add', symbol: '600519', note: '核心持仓' }, withApproval)
    expect(added.ok).toBe(true)
    expect(added.summary).toContain('已添加自选')
    expect(added.summary).toContain('贵州茅台')
    expect(store.count()).toBe(1)
    expect(store.get('sh600519')?.note).toBe('核心持仓')

    const again = await registry.execute('fin_watch', { action: 'add', symbol: 'sh600519' }, withApproval)
    expect(again.ok).toBe(true)
    expect(again.summary).toContain('已更新自选')
    expect(store.count()).toBe(1)

    const list = await registry.execute('fin_watch', { action: 'list' }, withApproval)
    expect(list.ok).toBe(true)
    expect(list.detail).toContain('贵州茅台')

    const removed = await registry.execute('fin_watch', { action: 'remove', symbol: '600519' }, withApproval)
    expect(removed.ok).toBe(true)
    expect(removed.summary).toContain('已移除自选')
    expect(store.count()).toBe(0)
  })

  it('add 审批拒绝 / 超时 / 取消 → 三态区分且不落库', async () => {
    const { registry, runtime, store } = setup()
    const rejected = await registry.execute('fin_watch', { action: 'add', symbol: '600519' }, {
      ...runtime,
      requestApproval: async () => approvalOutcome({ decision: 'reject', feedback: '暂不加' }),
    })
    expect(rejected.ok).toBe(false)
    expect(rejected.summary).toContain('用户未批准')
    expect(rejected.summary).toContain('暂不加')

    const timedOut = await registry.execute('fin_watch', { action: 'add', symbol: '600519' }, {
      ...runtime,
      requestApproval: async () => approvalOutcome({ decision: 'timeout', timedOut: true }),
    })
    expect(timedOut.ok).toBe(false)
    expect(timedOut.summary).toContain('超时')

    const cancelled = await registry.execute('fin_watch', { action: 'add', symbol: '600519' }, {
      ...runtime,
      requestApproval: async () => approvalOutcome({ decision: 'reject', timedOut: true, cancelled: true }),
    })
    expect(cancelled.ok).toBe(false)
    expect(cancelled.summary).toContain('取消')
    expect(store.count()).toBe(0)
  })

  it('remove 不存在的标的 → 提示先查看列表', async () => {
    const { registry, runtime } = setup()
    const result = await registry.execute('fin_watch', { action: 'remove', symbol: '600519' }, {
      ...runtime,
      requestApproval: async () => approvalOutcome(),
    })
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('不存在')
  })
})

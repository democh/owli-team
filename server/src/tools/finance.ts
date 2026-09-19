/**
 * M34 金融工具集（§5.1）：数据类 8 工具 —— fin_env / fin_search / fin_quote / fin_kline /
 * fin_indicator / fin_fund / fin_fundamental / fin_news。
 *
 * 通用纪律：
 * - 全部 tier='deferred'（经 tool_search 检索激活；FINANCE_ENABLED=true 时才注册）；
 * - readOnly 只读（fin_env 含 install 动作例外）；写操作审批门见 fin_watch / fin_env.install；
 * - 结果含 asOf / source / cache 溯源；fin_kline 默认落盘快照并给出 kline 块模板；
 * - 数字必须出自工具（禁止模型编造）：失败时如实返回错误与降级说明。
 *
 * 量化类 4 工具（fin_screen / fin_backtest / fin_game / fin_watch）见 finance_quant.ts。
 */
import { execFile } from 'node:child_process'
import { z } from 'zod'
import type { AppConfig } from '../config.js'
import { sanitizedEnv } from '../finance/bridge/env.js'
import { OPTIONAL_PY_PACKAGES, probePython, REQUIRED_PY_PACKAGES } from '../finance/bridge/probe.js'
import { CN_TZ_OFFSET_MS, adjustLabel, periodLabel } from '../finance/period.js'
import { buildKlineSnapshot, writeChartSnapshot } from '../finance/snapshot.js'
import type { FundamentalPeriod, KlineBar, Quote } from '../finance/types.js'
import type { FinSymbol } from '../finance/symbol.js'
import type { AgentTool, ToolResult, ToolRuntime } from './registry.js'
import {
  approveWrite,
  errorText,
  financeGuard,
  fmtAmount,
  fmtAsOf,
  fmtBarTime,
  fmtNum,
  fmtPct,
  fmtVolume,
  klineBlockTemplate,
  mdTable,
  resolveFinSymbol,
  sourceLine,
  throwIfAborted,
  TYPE_LABELS,
} from './finance_shared.js'

/** 通用 source 参数（auto 按路由表降级；node / py 强制层级） */
const sourcePrefSchema = z.enum(['auto', 'node', 'py']).default('auto')

const assetTypeSchema = z.enum(['stock', 'etf', 'fund', 'index'])

// ---------------------------------------------------------------- fin_env

const envArgs = z.object({
  action: z.enum(['status', 'install', 'refresh']).default('status'),
})

/** pip 安装（5 分钟超时；外部中断（工具护栏）经 signal 联动 kill） */
function execPip(
  python: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile(
      python,
      args,
      {
        timeout: 300_000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        env: sanitizedEnv(),
        ...(signal ? { signal } : {}),
      },
      (err, stdout, stderr) => {
        const output = `${stdout ?? ''}${stderr ? `\n[stderr]\n${stderr}` : ''}`.trim()
        if (err) {
          const code = (err as { code?: number | string }).code
          resolve({ code: typeof code === 'number' ? code : 1, output: output || err.message })
        } else {
          resolve({ code: 0, output })
        }
      },
    )
  })
}

function createFinEnvTool(cfg: AppConfig): AgentTool {
  const probeOpts = (force: boolean) => ({
    ...(cfg.financePython ? { python: cfg.financePython } : {}),
    force,
  })
  return {
    name: 'fin_env',
    tier: 'deferred',
    readOnly: false,
    description:
      'Python 数据桥（baostock / akshare / ta / tablib）状态与安装：action=status 查看解释器、依赖包与数据源健康度；action=refresh 强制重新探测（安装后 / 排查时）；action=install 一键安装依赖（经用户审批，执行 pip install）。金融数据出现「需要 Python 环境」「依赖缺失」提示时用本工具排查。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'install', 'refresh'],
          description: 'status=查看状态（默认）；install=安装依赖（审批门）；refresh=强制重新探测',
        },
      },
    },
    schema: envArgs,
    async execute(args: z.infer<typeof envArgs>, ctx: ToolRuntime): Promise<ToolResult> {
      const guard = financeGuard(ctx)
      if (!guard.ok) return guard.result

      if (args.action === 'install') {
        const before = await probePython(probeOpts(false))
        const python = cfg.financePython || before.python || 'python3'
        const packages = [...REQUIRED_PY_PACKAGES]
        const pipArgs = ['-m', 'pip', 'install', '-U', ...packages]
        if (cfg.financePipIndexUrl) pipArgs.push('-i', cfg.financePipIndexUrl)
        const cmdText = `${python} ${pipArgs.join(' ')}`
        const approval = await approveWrite(
          ctx,
          '安装金融数据 Python 依赖',
          [
            `将执行：${cmdText}`,
            `包：${packages.join('、')}`,
            `镜像：${cfg.financePipIndexUrl || '官方源（PyPI）'}`,
            '影响：在当前 Python 环境安装 / 升级上述包，可能需要 1-3 分钟',
          ].join('\n'),
        )
        if (!approval.ok) return approval.result
        throwIfAborted(ctx)
        const result = await execPip(python, pipArgs, ctx.signal)
        const status = await probePython(probeOpts(true))
        const ready = status.level !== 'absent'
        return {
          ok: ready,
          summary: ready
            ? `依赖安装完成（exit ${result.code}）：${status.summary}`
            : `安装命令已执行（exit ${result.code}）但环境仍不可用：${status.summary}`,
          detail: `$ ${cmdText}\n${result.output.slice(-2000)}\n\n安装后探测：${status.summary}`,
        }
      }

      const status = await probePython(probeOpts(args.action === 'refresh'))
      const health = guard.gateway.health()
      const healthText =
        health.length === 0
          ? '全部来源正常（无失败记录）'
          : health
              .map((item) =>
                item.cooling
                  ? `${item.source}：冷却中（至 ${item.cooldownUntil ? fmtAsOf(item.cooldownUntil) : '?'}；累计失败 ${item.fails} 次：${item.lastError ?? '—'}）`
                  : `${item.source}：正常（累计失败 ${item.fails}）`,
              )
              .join('\n')
      const pkgTable = [...REQUIRED_PY_PACKAGES, ...OPTIONAL_PY_PACKAGES].map((name) => {
        const info = status.packages[name]
        const optional = (OPTIONAL_PY_PACKAGES as readonly string[]).includes(name)
        const label = info?.installed ? `已安装${info.version ? ` ${info.version}` : ''}` : `未安装${optional ? '（可选）' : '（必需）'}`
        return `${name}：${label}`
      })
      return {
        ok: true,
        summary: status.summary,
        detail: [
          `状态：${status.level}${status.python ? `｜解释器 ${status.python}${status.version ? `（${status.version}）` : ''}` : ''}`,
          `包状态：${pkgTable.join('｜')}`,
          `数据源健康度：\n${healthText}`,
          `安装引导：缺包时调用本工具 action=install（经审批执行 python -m pip install -U ${REQUIRED_PY_PACKAGES.join(' ')}；可选包 openpyxl / curl_cffi 可单独 pip 安装）`,
        ].join('\n\n'),
      }
    },
  }
}

// ---------------------------------------------------------------- fin_search

const searchArgs = z.object({
  query: z.string().min(1),
  type: assetTypeSchema.optional(),
  limit: z.number().int().min(1).max(50).default(10),
})

const finSearchTool: AgentTool = {
  name: 'fin_search',
  tier: 'deferred',
  readOnly: true,
  description:
    '金融标的搜索：按代码 / 名称 / 拼音首字母检索 A 股股票、ETF、场外基金与指数，返回归一化 symbol（如 sh600519）供 fin_quote / fin_kline 等工具使用。用户只给了名称或不确定代码时先用本工具。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索词（代码 / 名称 / 拼音首字母，如 600519 / 贵州茅台 / gzmt）' },
      type: { type: 'string', enum: ['stock', 'etf', 'fund', 'index'], description: '限定品种（缺省全部）' },
      limit: { type: 'number', description: '返回条数（默认 10，上限 50）' },
    },
    required: ['query'],
  },
  schema: searchArgs,
  async execute(args: z.infer<typeof searchArgs>, ctx: ToolRuntime): Promise<ToolResult> {
    const guard = financeGuard(ctx)
    if (!guard.ok) return guard.result
    try {
      const res = await guard.gateway.search(args.query, { limit: args.limit })
      let rows = res.data
      if (args.type) rows = rows.filter((row) => row.type === args.type)
      if (rows.length === 0) {
        return {
          ok: false,
          summary: `未找到匹配「${args.query}」的标的（可换关键词，或直接用 6 位代码 / sh600519 形式）`,
          ...(res.degraded ? { detail: `检索降级：${res.degraded}` } : {}),
        }
      }
      const lines = rows.map((row) => `${TYPE_LABELS[row.type]}｜${row.name}（${row.exchange ?? ''}${row.code}）`)
      return {
        ok: true,
        summary: `命中 ${rows.length} 条${args.type ? `（${TYPE_LABELS[args.type]}）` : ''}｜来源 ${res.source}`,
        detail: lines.join('\n'),
      }
    } catch (err) {
      return { ok: false, summary: `标的检索失败：${errorText(err)}` }
    }
  },
}

// ---------------------------------------------------------------- fin_quote

const QUOTE_FIELDS = [
  'price',
  'change',
  'changePct',
  'open',
  'high',
  'low',
  'prevClose',
  'volume',
  'turnover',
  'turnoverRate',
  'pe',
  'pb',
  'marketCap',
  'floatMarketCap',
] as const
type QuoteField = (typeof QUOTE_FIELDS)[number]

const QUOTE_FIELD_LABELS: Record<QuoteField, string> = {
  price: '最新价',
  change: '涨跌额',
  changePct: '涨跌幅',
  open: '今开',
  high: '最高',
  low: '最低',
  prevClose: '昨收',
  volume: '成交量',
  turnover: '成交额',
  turnoverRate: '换手率',
  pe: 'PE(动)',
  pb: 'PB',
  marketCap: '总市值',
  floatMarketCap: '流通市值',
}

/** 默认展示列（行内紧凑；fields 显式给出时按给定顺序） */
const DEFAULT_QUOTE_FIELDS: QuoteField[] = ['price', 'changePct', 'volume', 'turnover', 'turnoverRate', 'pe', 'pb', 'marketCap']

function quoteCell(q: Quote, field: QuoteField): string {
  switch (field) {
    case 'price':
      return fmtNum(q.price)
    case 'change':
      return q.change > 0 ? `+${fmtNum(q.change)}` : fmtNum(q.change)
    case 'changePct':
      return fmtPct(q.changePct)
    case 'open':
      return fmtNum(q.open)
    case 'high':
      return fmtNum(q.high)
    case 'low':
      return fmtNum(q.low)
    case 'prevClose':
      return fmtNum(q.prevClose)
    case 'volume':
      return fmtVolume(q.volume)
    case 'turnover':
      return fmtAmount(q.turnover)
    case 'turnoverRate':
      return fmtPct(q.turnoverRate)
    case 'pe':
      return fmtNum(q.pe)
    case 'pb':
      return fmtNum(q.pb)
    case 'marketCap':
      return fmtAmount(q.marketCap)
    case 'floatMarketCap':
      return fmtAmount(q.floatMarketCap)
  }
}

const quoteArgs = z.object({
  symbols: z.array(z.string().min(1)).min(1).max(50),
  fields: z.array(z.enum(QUOTE_FIELDS)).min(1).max(QUOTE_FIELDS.length).optional(),
  source: sourcePrefSchema,
})

const finQuoteTool: AgentTool = {
  name: 'fin_quote',
  tier: 'deferred',
  readOnly: true,
  description:
    '批量实时行情快照（价 / 涨跌幅 / 量额 / 换手 / 市值 / PE / PB）。symbols 支持代码 / 归一 symbol / 名称，单次 ≤50 支。用于「现价多少」「今天涨跌」「估值多少」类问题；K 线请用 fin_kline。',
  parameters: {
    type: 'object',
    properties: {
      symbols: { type: 'array', items: { type: 'string' }, description: '标的列表（代码 / sh600519 / 名称；≤50）' },
      fields: {
        type: 'array',
        items: { type: 'string', enum: [...QUOTE_FIELDS] },
        description: '展示列（缺省：最新价 / 涨跌幅 / 成交量 / 成交额 / 换手率 / PE / PB / 总市值）',
      },
      source: { type: 'string', enum: ['auto', 'node', 'py'], description: '数据源层级（默认 auto 按路由降级）' },
    },
    required: ['symbols'],
  },
  schema: quoteArgs,
  async execute(args: z.infer<typeof quoteArgs>, ctx: ToolRuntime): Promise<ToolResult> {
    const guard = financeGuard(ctx)
    if (!guard.ok) return guard.result
    const syms: FinSymbol[] = []
    const unresolved: string[] = []
    for (const raw of args.symbols) {
      const resolved = await resolveFinSymbol(guard.gateway, raw)
      if (resolved.ok) {
        if (!syms.some((s) => s.symbol === resolved.symbol.symbol)) syms.push(resolved.symbol)
      } else {
        unresolved.push(raw)
      }
    }
    if (syms.length === 0) {
      return { ok: false, summary: `全部标的未能识别：${unresolved.join('、')}（可先用 fin_search 检索）` }
    }
    try {
      const res = await guard.gateway.quote(syms, { source: args.source })
      const fields = args.fields && args.fields.length > 0 ? (args.fields as QuoteField[]) : DEFAULT_QUOTE_FIELDS
      const rows = res.data.map((q) => [`${q.name}（${q.symbol}）`, ...fields.map((f) => quoteCell(q, f))])
      const table = mdTable(['标的', ...fields.map((f) => QUOTE_FIELD_LABELS[f])], rows)
      const missing = syms.filter((s) => !res.data.some((q) => q.symbol === s.symbol))
      const notes: string[] = [sourceLine({ source: res.source, asOf: res.asOf, cache: res.cache, degraded: res.degraded })]
      if (missing.length > 0) notes.push(`未返回：${missing.map((s) => s.symbol).join('、')}（源未覆盖或已退市）`)
      if (unresolved.length > 0) notes.push(`未识别：${unresolved.join('、')}`)
      return {
        ok: true,
        summary: `获取 ${res.data.length}/${syms.length} 支标的快照（来源 ${res.source}，asOf ${fmtAsOf(res.asOf)}）`,
        detail: `${table}\n\n${notes.join('\n')}`,
      }
    } catch (err) {
      return { ok: false, summary: `行情获取失败：${errorText(err)}` }
    }
  },
}

// ---------------------------------------------------------------- fin_kline

/** K 线区间摘要（工具回灌用；涨跌 / 振幅 / 波动为小数，展示时 ×100） */
interface KlineSummary {
  bars: number
  from: string
  to: string
  baseClose: number
  lastClose: number
  changePct: number
  high: number
  highAt: string
  low: number
  lowAt: string
  amplitudePct: number
  avgVolume: number
  totalVolume: number
  volatilityPct: number
}

export function summarizeKline(bars: KlineBar[]): KlineSummary {
  const first = bars[0]
  const last = bars[bars.length - 1]
  let high = -Infinity
  let low = Infinity
  let highAt = first.timestamp
  let lowAt = first.timestamp
  let volSum = 0
  for (const bar of bars) {
    if (bar.high > high) {
      high = bar.high
      highAt = bar.timestamp
    }
    if (bar.low < low) {
      low = bar.low
      lowAt = bar.timestamp
    }
    volSum += bar.volume
  }
  const returns: number[] = []
  for (let i = 1; i < bars.length; i++) {
    if (bars[i - 1].close > 0) returns.push(bars[i].close / bars[i - 1].close - 1)
  }
  const mean = returns.length > 0 ? returns.reduce((acc, v) => acc + v, 0) / returns.length : 0
  const variance =
    returns.length > 1 ? returns.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (returns.length - 1) : 0
  const std = Math.sqrt(variance)
  return {
    bars: bars.length,
    from: fmtBarTime(first.timestamp),
    to: fmtBarTime(last.timestamp),
    baseClose: first.close,
    lastClose: last.close,
    changePct: first.close > 0 ? last.close / first.close - 1 : 0,
    high,
    highAt: fmtBarTime(highAt),
    low,
    lowAt: fmtBarTime(lowAt),
    amplitudePct: low > 0 ? (high - low) / low : 0,
    avgVolume: volSum / bars.length,
    totalVolume: volSum,
    volatilityPct: std * Math.sqrt(250),
  }
}

const KLINE_INDICATORS = ['MA', 'EMA', 'VOL', 'MACD', 'RSI', 'KDJ', 'BOLL', 'ATR'] as const
const DEFAULT_KLINE_INDICATORS: string[] = ['MA', 'VOL']

const klineArgs = z.object({
  symbol: z.string().min(1),
  period: z.enum(['day', 'week', 'month', 'min5', 'min15', 'min30', 'min60']).default('day'),
  adjust: z.enum(['qfq', 'hfq', 'none']).default('qfq'),
  limit: z.number().int().min(5).max(500).default(250),
  indicators: z.array(z.enum(KLINE_INDICATORS)).min(1).max(KLINE_INDICATORS.length).optional(),
  annotations: z
    .array(
      z.object({
        type: z.string().min(1).max(20),
        price: z.number().optional(),
        label: z.string().max(40).optional(),
      }),
    )
    .max(20)
    .optional(),
  persist: z.boolean().default(true),
  source: sourcePrefSchema,
})

function createFinKlineTool(cfg: AppConfig): AgentTool {
  return {
    name: 'fin_kline',
    tier: 'deferred',
    readOnly: true,
    description:
      'K 线数据主力通道（日 / 周 / 月 / 5-60 分钟；默认前复权）：取数 + 区间统计 + 默认落盘快照，返回现成的 kline 消息块模板（复制到回复即可渲染 K 线图，无需重输出数据）。凡是画 K 线 / 看走势 / 技术分析的数据准备都用本工具（禁止手写或估算行情数据）。',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '标的（代码 / sh600519 / 名称）' },
        period: { type: 'string', enum: ['day', 'week', 'month', 'min5', 'min15', 'min30', 'min60'], description: '周期（默认 day）' },
        adjust: { type: 'string', enum: ['qfq', 'hfq', 'none'], description: '复权（默认 qfq 前复权）' },
        limit: { type: 'number', description: 'K 线根数（默认 250，上限 500）' },
        indicators: {
          type: 'array',
          items: { type: 'string', enum: [...KLINE_INDICATORS] },
          description: 'K 线块渲染的指标面板（默认 ["MA","VOL"]；可选 MA/EMA/VOL/MACD/RSI/KDJ/BOLL/ATR）',
        },
        annotations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', description: '标注类型（如 priceLine）' },
              price: { type: 'number', description: '价格（priceLine 用）' },
              label: { type: 'string', description: '标注文本（如「压力位」）' },
            },
            required: ['type'],
          },
          description: '价格线等标注（可选，≤20 条）',
        },
        persist: { type: 'boolean', description: '是否落盘快照（默认 true；快照进交付件体系可版本 diff）' },
        source: { type: 'string', enum: ['auto', 'node', 'py'], description: '数据源层级（默认 auto）' },
      },
      required: ['symbol'],
    },
    schema: klineArgs,
    async execute(args: z.infer<typeof klineArgs>, ctx: ToolRuntime): Promise<ToolResult> {
      const guard = financeGuard(ctx)
      if (!guard.ok) return guard.result
      const resolved = await resolveFinSymbol(guard.gateway, args.symbol)
      if (!resolved.ok) return resolved.result
      const symbol = resolved.symbol
      const indicators = args.indicators && args.indicators.length > 0 ? [...args.indicators] : [...DEFAULT_KLINE_INDICATORS]
      try {
        const res = await guard.gateway.kline(symbol, args.period, args.adjust, args.limit, { source: args.source })
        const bars = res.data.bars
        if (bars.length === 0) return { ok: false, summary: 'K 线数据为空（源未覆盖该标的或周期）' }
        const stats = summarizeKline(bars)

        let snapshotPath: string | undefined
        if (args.persist) {
          throwIfAborted(ctx)
          const snapshot = buildKlineSnapshot(res.data, {
            indicators,
            ...(args.annotations ? { annotations: args.annotations } : {}),
            ...(res.degraded ? { note: res.degraded } : {}),
          })
          const written = await writeChartSnapshot(ctx.workspace, cfg.financeKlineSnapshotDir, snapshot)
          snapshotPath = written.path
        }

        const name = symbol.name ?? symbol.symbol
        const title = `${name} ${periodLabel(args.period)}K（${adjustLabel(args.adjust)}）`
        const parts = [
          `标的：${name}（${symbol.symbol}） ${periodLabel(args.period)}K · ${adjustLabel(args.adjust)} · ${bars.length} 根（${stats.from} → ${stats.to}）`,
          `价格：区间涨跌 ${fmtPct(stats.changePct * 100)}（首收 ${fmtNum(stats.baseClose)} → 末收 ${fmtNum(stats.lastClose)}）｜最高 ${fmtNum(stats.high)}（${stats.highAt}）｜最低 ${fmtNum(stats.low)}（${stats.lowAt}）｜振幅 ${fmtPct(stats.amplitudePct * 100)}`,
          `量能：日均 ${fmtVolume(stats.avgVolume)}（合计 ${fmtVolume(stats.totalVolume)}）｜年化波动率 ${fmtPct(stats.volatilityPct * 100)}（按 250 交易日折算）`,
          sourceLine({ source: res.source, asOf: res.asOf, cache: res.cache, degraded: res.degraded }),
        ]
        if (snapshotPath) {
          parts.push(`快照：${snapshotPath}（已进交付件体系，可版本 diff）`)
          parts.push('', 'kline 块模板（复制到回复即可渲染）：', klineBlockTemplate(title, snapshotPath, indicators))
        } else {
          parts.push('persist=false：本次未落盘快照，不提供 kline 块（渲染展示请用 persist=true）')
        }
        return {
          ok: true,
          summary: `K 线就绪：${name} ${periodLabel(args.period)}K ×${bars.length} 根（区间涨跌 ${fmtPct(stats.changePct * 100)}；来源 ${res.source}）${snapshotPath ? `；快照 ${snapshotPath}` : ''}`,
          detail: parts.join('\n'),
          ...(snapshotPath ? { artifacts: [snapshotPath] } : {}),
        }
      } catch (err) {
        return { ok: false, summary: `K 线获取失败：${errorText(err)}` }
      }
    },
  }
}

// ---------------------------------------------------------------- fin_indicator

const INDICATORS = ['MA', 'EMA', 'MACD', 'RSI', 'KDJ', 'BOLL', 'ATR'] as const

const indicatorArgs = z.object({
  symbol: z.string().min(1).optional(),
  closes: z.array(z.number()).min(5).max(2000).optional(),
  indicator: z.enum(INDICATORS),
  params: z.record(z.number()).optional(),
  period: z.enum(['day', 'week', 'month', 'min5', 'min15', 'min30', 'min60']).default('day'),
  limit: z.number().int().min(50).max(500).default(250),
  source: sourcePrefSchema,
})

const finIndicatorTool: AgentTool = {
  name: 'fin_indicator',
  tier: 'deferred',
  readOnly: true,
  description:
    '技术指标计算（MA / EMA / MACD / RSI / KDJ / BOLL / ATR）：输入标的（或收盘价序列 closes），返回最新值、近 5 期明细与信号摘要（金叉 / 死叉 / 超买超卖）。报告中的指标数值必须出自本工具（禁止目测近似）。参数：EMA/RSI/ATR 用 period；MACD 用 fast/slow/signal；KDJ 用 n/k/d；BOLL 用 period/mult；MA 固定 5/10/20/60。',
  parameters: {
    type: 'object',
    properties: {
      symbol: { type: 'string', description: '标的（代码 / sh600519 / 名称；与 closes 二选一）' },
      closes: { type: 'array', items: { type: 'number' }, description: '收盘价序列（另一输入方式：已有序列时免取数）' },
      indicator: { type: 'string', enum: [...INDICATORS], description: '指标名' },
      params: { type: 'object', description: '指标参数（如 {"period":14}；键为数字）' },
      period: { type: 'string', enum: ['day', 'week', 'month', 'min5', 'min15', 'min30', 'min60'], description: 'K 线周期（默认 day）' },
      limit: { type: 'number', description: '取数根数（默认 250）' },
      source: { type: 'string', enum: ['auto', 'node', 'py'], description: '数据源层级（默认 auto）' },
    },
    required: ['indicator'],
  },
  schema: indicatorArgs,
  async execute(args: z.infer<typeof indicatorArgs>, ctx: ToolRuntime): Promise<ToolResult> {
    const guard = financeGuard(ctx)
    if (!guard.ok) return guard.result
    const seriesMode = Array.isArray(args.closes) && args.closes.length > 0
    if (!seriesMode && !args.symbol) {
      return { ok: false, summary: '请提供 symbol（在线取数）或 closes（收盘价序列）之一' }
    }
    let bars: KlineBar[]
    let dataLine: string
    if (seriesMode) {
      bars = (args.closes as number[]).map((close, i) => ({ timestamp: i, open: close, high: close, low: close, close, volume: 0 }))
      dataLine = `序列模式（${bars.length} 点，仅收盘价；high/low 以 close 兜底——ATR / KDJ 等依赖高低价的指标不具参考性）`
    } else {
      const resolved = await resolveFinSymbol(guard.gateway, args.symbol!)
      if (!resolved.ok) return resolved.result
      try {
        const res = await guard.gateway.kline(resolved.symbol, args.period, 'qfq', args.limit, { source: args.source })
        bars = res.data.bars
        dataLine = `${resolved.symbol.name ?? resolved.symbol.symbol} ${periodLabel(args.period)}K · ${bars.length} 根（${sourceLine({ source: res.source, asOf: res.asOf, cache: res.cache, degraded: res.degraded })}）`
      } catch (err) {
        return { ok: false, summary: `指标取数失败：${errorText(err)}` }
      }
    }
    if (bars.length < 5) return { ok: false, summary: `数据不足（${bars.length} 点 < 5 点）：请扩大 limit` }
    try {
      const res = await guard.gateway.indicator(args.indicator, bars, args.params ?? {}, { source: args.source })
      const series = res.data
      const timeOf = (i: number): string => (seriesMode ? `#${i + 1}` : fmtBarTime(bars[i].timestamp))
      let lastIdx = -1
      for (let i = series.points.length - 1; i >= 0; i--) {
        const values = series.points[i].values
        if (Object.values(values).some((v) => v !== null && v !== undefined)) {
          lastIdx = i
          break
        }
      }
      if (lastIdx < 0) {
        return { ok: false, summary: `${args.indicator} 暂无有效值（数据长度不足，可扩大 limit 或调小参数周期）` }
      }
      const keys = Object.keys(series.points[lastIdx].values)
      const cellOf = (i: number, key: string): string => {
        const v = series.points[i].values[key]
        return v === null || v === undefined ? '—' : fmtNum(v, 3)
      }
      const latestLine = keys.map((k) => `${k} ${cellOf(lastIdx, k)}`).join('｜')
      const paramLine = Object.entries(series.params)
        .map(([k, v]) => `${k}=${v}`)
        .join('｜')
      const tailStart = Math.max(0, lastIdx - 4)
      const rows: string[][] = []
      for (let i = tailStart; i <= lastIdx; i++) rows.push([timeOf(i), ...keys.map((k) => cellOf(i, k))])
      const signals = series.signals.length > 0 ? series.signals.join('｜') : '（无近期信号）'
      const parts = [
        `指标：${args.indicator}${paramLine ? `（${paramLine}）` : ''}`,
        `数据：${dataLine}`,
        `最新（${timeOf(lastIdx)}）：${latestLine}`,
        `近 ${rows.length} 期：`,
        mdTable(['时间', ...keys], rows),
        `信号：${signals}`,
      ]
      return {
        ok: true,
        summary: `${args.indicator} 最新（${timeOf(lastIdx)}）：${latestLine}`,
        detail: parts.join('\n'),
      }
    } catch (err) {
      return { ok: false, summary: `指标计算失败：${errorText(err)}` }
    }
  },
}

// ---------------------------------------------------------------- fin_fund

const fundArgs = z.object({
  code: z.string().min(1),
  kind: z.enum(['etf', 'fund']).default('etf'),
  source: sourcePrefSchema,
})

const finFundTool: AgentTool = {
  name: 'fin_fund',
  tier: 'deferred',
  readOnly: true,
  description:
    '基金 / ETF 档案：规模、管理费率、跟踪指数、前十大持仓、分红与近 1/3/6/12 月收益。kind=etf 查场内 ETF（代码如 510300），kind=fund 查场外基金（6 位代码如 005827）。',
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string', description: '基金代码（6 位）' },
      kind: { type: 'string', enum: ['etf', 'fund'], description: 'etf=场内 ETF（默认）；fund=场外基金' },
      source: { type: 'string', enum: ['auto', 'node', 'py'], description: '数据源层级（默认 auto）' },
    },
    required: ['code'],
  },
  schema: fundArgs,
  async execute(args: z.infer<typeof fundArgs>, ctx: ToolRuntime): Promise<ToolResult> {
    const guard = financeGuard(ctx)
    if (!guard.ok) return guard.result
    try {
      const res = await guard.gateway.fundProfile(args.code, args.kind, { source: args.source })
      const p = res.data
      const parts = [`档案：${p.name}（${p.code}）｜${p.kind === 'etf' ? 'ETF' : '场外基金'}`]
      const basics: string[] = []
      basics.push(`规模：${p.scale !== undefined ? `${fmtNum(p.scale)} 亿元` : '—'}`)
      basics.push(`管理费率：${p.feeRate !== undefined ? `${fmtNum(p.feeRate)}%` : '—'}`)
      if (p.trackingIndex) basics.push(`跟踪指数：${p.trackingIndex}`)
      parts.push(basics.join('｜'))
      if (p.returns) {
        const r = p.returns
        parts.push(
          `阶段收益：近1月 ${fmtPct(r.m1)}｜近3月 ${fmtPct(r.m3)}｜近6月 ${fmtPct(r.m6)}｜近1年 ${fmtPct(r.y1)}`,
        )
      }
      if (p.holdings && p.holdings.length > 0) {
        const rows = p.holdings.map((h) => [h.name, h.code ?? '—', fmtPct(h.weightPct)])
        parts.push('前十大持仓：', mdTable(['名称', '代码', '权重'], rows))
      }
      if (p.dividends && p.dividends.length > 0) {
        parts.push(`分红：${p.dividends.map((d) => `${d.date} ${fmtNum(d.amount, 3)} 元/份`).join('｜')}`)
      }
      parts.push(sourceLine({ source: res.source, asOf: res.asOf, cache: res.cache, degraded: res.degraded }))
      const ret = p.returns
      const retText = ret ? `近1年 ${fmtPct(ret.y1)}` : '阶段收益 —'
      return {
        ok: true,
        summary: `${p.name}（${p.code}）：${retText}｜来源 ${res.source}`,
        detail: parts.join('\n'),
      }
    } catch (err) {
      return { ok: false, summary: `基金档案获取失败：${errorText(err)}` }
    }
  },
}

// ---------------------------------------------------------------- fin_fundamental

/** 北京时间当前年 / 季度 */
function cnNow(): { year: number; quarter: number } {
  const d = new Date(Date.now() + CN_TZ_OFFSET_MS)
  return { year: d.getUTCFullYear(), quarter: Math.floor(d.getUTCMonth() / 3) + 1 }
}

/** 报告期 → 季度标签（2026-06-30 → 2026Q2） */
function quarterLabel(period: string): string {
  const month = Number(period.slice(5, 7))
  if (!Number.isFinite(month) || month < 1) return period
  return `${period.slice(0, 4)}Q${Math.floor((month - 1) / 3) + 1}`
}

const fundamentalArgs = z.object({
  symbol: z.string().min(1),
  reportType: z.enum(['quarter', 'year']).default('quarter'),
  years: z.number().int().min(1).max(5).optional(),
  source: sourcePrefSchema,
})

const finFundamentalTool: AgentTool = {
  name: 'fin_fundamental',
  tier: 'deferred',
  readOnly: true,
  description:
    '财务基本面数据（baostock 季频盈利）：营收 / 净利 / ROE / 毛利率 / 净利率 / EPS 多期序列与同比。reportType=quarter 取最近若干季（years 默认 1 = 最近 4 季）；reportType=year 取近若干年报（years 默认 3）。基本面分析的数据准备用本工具。',
  parameters: {
    type: 'object',
    properties: {
      symbol: { type: 'string', description: '标的（代码 / sh600519 / 名称；支持股票）' },
      reportType: { type: 'string', enum: ['quarter', 'year'], description: 'quarter=季度累计（默认）；year=年报' },
      years: { type: 'number', description: 'quarter：年数×4 期（默认 1）；year：年数（默认 3）' },
      source: { type: 'string', enum: ['auto', 'node', 'py'], description: '数据源层级（本能力仅 py；默认 auto）' },
    },
    required: ['symbol'],
  },
  schema: fundamentalArgs,
  async execute(args: z.infer<typeof fundamentalArgs>, ctx: ToolRuntime): Promise<ToolResult> {
    const guard = financeGuard(ctx)
    if (!guard.ok) return guard.result
    const resolved = await resolveFinSymbol(guard.gateway, args.symbol, { type: 'stock' })
    if (!resolved.ok) return resolved.result
    const symbol = resolved.symbol
    const years = args.years ?? (args.reportType === 'year' ? 3 : 1)
    const now = cnNow()
    const targets: Array<{ year: number; quarter: number }> = []
    if (args.reportType === 'year') {
      for (let i = 1; i <= years; i++) targets.push({ year: now.year - i, quarter: 4 })
    } else {
      let y = now.year
      let q = now.quarter - 1
      if (q < 1) {
        q = 4
        y -= 1
      }
      for (let i = 0; i < years * 4; i++) {
        targets.push({ year: y, quarter: q })
        q -= 1
        if (q < 1) {
          q = 4
          y -= 1
        }
      }
    }

    const periods = new Map<string, FundamentalPeriod>()
    const failures: string[] = []
    let lastSource = ''
    let lastAsOf = ''
    for (const target of targets) {
      try {
        const res = await guard.gateway.fundamental(symbol, { year: target.year, quarter: target.quarter, source: args.source })
        lastSource = res.source
        lastAsOf = res.asOf
        const hit = res.data.periods[0]
        if (hit && hit.period) periods.set(hit.period, hit)
      } catch (err) {
        failures.push(`${target.year}Q${target.quarter}：${errorText(err)}`)
      }
    }
    const list = [...periods.values()].sort((a, b) => b.period.localeCompare(a.period))
    if (list.length === 0) {
      return {
        ok: false,
        summary: `财务数据获取失败（${failures[0] ?? '无可用报告期'}）`,
        ...(failures.length > 1 ? { detail: failures.join('\n') } : {}),
      }
    }

    const fmtCell = (v: string | number | undefined): string => (typeof v === 'number' ? fmtNum(v, 2) : '—')
    const rows = list.map((p) => [
      p.period,
      fmtCell(p.revenue),
      fmtCell(p.netProfit),
      fmtCell(p.roe),
      fmtCell(p.grossMargin),
      fmtCell(p.netMargin),
      fmtCell(p.eps),
    ])
    const parts = [
      `财务数据：${symbol.name ?? symbol.symbol}（${symbol.symbol}）｜口径：${args.reportType === 'year' ? '年度（Q4 累计）' : '季度累计'}｜来源 ${lastSource}`,
      mdTable(['报告期', '营收(元)', '净利(元)', 'ROE', '毛利率', '净利率', 'EPS(元)'], rows),
    ]

    const latest = list[0]
    const yoyOf = (field: 'revenue' | 'netProfit'): number | undefined => {
      const priorPeriod = `${Number(latest.period.slice(0, 4)) - 1}${latest.period.slice(4)}`
      const prev = periods.get(priorPeriod)
      const a = latest[field]
      const b = prev?.[field]
      if (typeof a !== 'number' || typeof b !== 'number' || b === 0) return undefined
      return a / b - 1
    }
    const yoy = [yoyOf('revenue'), yoyOf('netProfit')]
    if (yoy.some((v) => v !== undefined)) {
      parts.push(`同比（${quarterLabel(latest.period)} vs ${quarterLabel(`${Number(latest.period.slice(0, 4)) - 1}${latest.period.slice(4)}`)}）：营收 ${fmtPct(yoy[0] !== undefined ? yoy[0] * 100 : undefined)}｜净利 ${fmtPct(yoy[1] !== undefined ? yoy[1] * 100 : undefined)}`)
    }
    parts.push('口径说明：baostock 季频盈利（累计值）；ROE / 毛利率 / 净利率为源原始百分数；最新报告期可能尚未披露')
    if (failures.length > 0) parts.push(`部分报告期获取失败：${failures.join('；')}`)
    if (lastAsOf) parts.push(sourceLine({ source: lastSource, asOf: lastAsOf, cache: 'miss' }))

    return {
      ok: true,
      summary: `${symbol.name ?? symbol.symbol} 财务数据 ${list.length} 期（最新 ${quarterLabel(latest.period)}：营收 ${fmtCell(latest.revenue)} 元｜净利 ${fmtCell(latest.netProfit)} 元；来源 ${lastSource}）`,
      detail: parts.join('\n'),
    }
  },
}

// ---------------------------------------------------------------- fin_news

const newsArgs = z.object({
  symbol: z.string().min(1).optional(),
  market: z.string().min(1).max(20).optional(),
  limit: z.number().int().min(1).max(20).default(10),
  since: z.string().min(1).optional(),
  source: sourcePrefSchema,
})

const finNewsTool: AgentTool = {
  name: 'fin_news',
  tier: 'deferred',
  readOnly: true,
  description:
    '个股新闻 / 公告与市场快讯：给定 symbol 取该标的公告（官方信源优先），缺省取市场滚动新闻。返回时间 / 来源 / 信源等级 / 标题 / URL（去重排序）。舆情分析、事件核实的数据准备用本工具；报告引用新闻须注明来源与 URL。',
  parameters: {
    type: 'object',
    properties: {
      symbol: { type: 'string', description: '标的（代码 / sh600519 / 名称；缺省 = 市场新闻）' },
      market: { type: 'string', description: '市场维度（缺省 cn；仅在未给 symbol 时生效）' },
      limit: { type: 'number', description: '条数（默认 10，上限 20）' },
      since: { type: 'string', description: '只看该时刻之后的新闻（ISO 时间，可选）' },
      source: { type: 'string', enum: ['auto', 'node', 'py'], description: '数据源层级（默认 auto）' },
    },
  },
  schema: newsArgs,
  async execute(args: z.infer<typeof newsArgs>, ctx: ToolRuntime): Promise<ToolResult> {
    const guard = financeGuard(ctx)
    if (!guard.ok) return guard.result
    let sym: FinSymbol | undefined
    if (args.symbol) {
      const resolved = await resolveFinSymbol(guard.gateway, args.symbol)
      if (!resolved.ok) return resolved.result
      sym = resolved.symbol
    }
    try {
      const res = await guard.gateway.news({
        ...(sym ? { symbol: sym.symbol } : {}),
        ...(args.market ? { market: args.market } : {}),
        limit: args.limit,
        ...(args.since ? { since: args.since } : {}),
        source: args.source,
      })
      if (res.data.length === 0) {
        return { ok: false, summary: `未获取到${sym ? `「${sym.name ?? sym.symbol}」相关` : ''}新闻 / 公告（可放宽 limit 或换标的）` }
      }
      const lines = res.data.map((item) => {
        const meta = [item.publishedAt ?? '时间未知', item.source, item.tier ?? 'media'].join('｜')
        return `- ${meta}｜${item.title}\n  ${item.url}`
      })
      const tierNote = res.data.some((item) => item.tier === 'official')
        ? '（official=交易所/公司公告，可信度最高）'
        : ''
      return {
        ok: true,
        summary: `${sym ? `「${sym.name ?? sym.symbol}」` : '市场'}新闻公告 ${res.data.length} 条（来源 ${res.source}${res.cache === 'stale' ? '，过期缓存' : ''}）`,
        detail: `${lines.join('\n')}\n\n${sourceLine({ source: res.source, asOf: res.asOf, cache: res.cache, degraded: res.degraded })}${tierNote ? `\n信源等级：${tierNote}` : ''}`,
      }
    } catch (err) {
      return { ok: false, summary: `新闻获取失败：${errorText(err)}` }
    }
  },
}

// ---------------------------------------------------------------- 导出

/** 数据类 8 工具（注册进 createToolRegistry；FINANCE_ENABLED=true 时才有意义） */
export function createFinanceTools(cfg: AppConfig): AgentTool[] {
  return [
    createFinEnvTool(cfg),
    finSearchTool,
    finQuoteTool,
    createFinKlineTool(cfg),
    finIndicatorTool,
    finFundTool,
    finFundamentalTool,
    finNewsTool,
  ]
}

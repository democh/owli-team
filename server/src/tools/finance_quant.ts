/**
 * M34 金融工具集（§5.1）：量化类工具 —— fin_screen / fin_backtest / fin_strategy / fin_stats / fin_game / fin_watch。
 *
 * - fin_screen：全市场筛选（网关底表 10 分钟缓存 → screen.ts 纯计算 → 快照）；
 * - fin_backtest：策略回测（backtest.ts 唯一引擎 → 快照；执行口径"信号次根开盘成交"；
 *   M83：template='dsl' 通道 —— 信号来源为 DSL 共享信号层，与 fin_strategy 口径一致）；
 * - fin_strategy：DSL 策略引擎（lint 静态检查 / run 执行出信号与落图；快照出 kline 块模板）；
 * - fin_stats：统计分析（M84；summary 多标的对比（py 缺失时 Node 兜底）/ significance 事件显著性（桥专属）；
 *   缺库引导 fin_env group=analytics）；
 * - fin_game：多空博弈推演（game 引擎 → 快照 → game 块模板；固定声明"模型推演，非预测"）；
 * - fin_watch：自选列表（写操作审批门 + FinanceStore；全局单表）。
 */
import { z } from 'zod'
import type { AppConfig } from '../config.js'
import { BACKTEST_DEFAULT_PARAMS, BACKTEST_TEMPLATES, DEFAULT_FEE_RATE, DEFAULT_SLIPPAGE, runBacktest } from '../finance/backtest.js'
import { DslExprError } from '../finance/dsl/expr.js'
import { runDsl } from '../finance/dsl/exec.js'
import { parseDsl } from '../finance/dsl/spec.js'
import { buildGameSnapshot, gameSnapshotFilename, MODEL_LABELS, runGame, type GameStatValue } from '../finance/game/index.js'
import { adjustLabel, periodLabel } from '../finance/period.js'
import {
  detectEvents,
  nodeSummary,
  EVENT_KINDS,
  type EventSpec,
  type PySignificanceResult,
  type PyStatsResult,
  type StatsSeriesInput,
} from '../finance/stats.js'
import { describeScreenCondition, screenRows, SCREEN_FIELDS, type ScreenCondition, type ScreenOrderBy } from '../finance/screen.js'
import {
  backtestSnapshotFilename,
  buildKlineSnapshot,
  screenSnapshotFilename,
  snapshotStamp,
  writeJsonSnapshot,
  writeChartSnapshot,
  type BacktestSnapshot,
  type ScreenSnapshot,
} from '../finance/snapshot.js'
import type { ScreenRow } from '../finance/types.js'
import type { AssetType } from '../finance/symbol.js'
import type { AgentTool, ToolResult, ToolRuntime } from './registry.js'
import {
  approveWrite,
  errorText,
  financeGuard,
  fmtAmount,
  fmtBarTime,
  fmtNum,
  fmtPct,
  gameBlockTemplate,
  klineBlockTemplate,
  mdTable,
  resolveFinSymbol,
  sourceLine,
  throwIfAborted,
  TYPE_LABELS,
} from './finance_shared.js'

const sourcePrefSchema = z.enum(['auto', 'node', 'py']).default('auto')

// ---------------------------------------------------------------- fin_screen

const screenConditionSchema = z.object({
  field: z.string().min(1),
  op: z.enum(['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'between', 'contains']),
  value: z.union([z.number(), z.string(), z.tuple([z.number(), z.number()])]),
})

const screenArgs = z.object({
  conditions: z.array(screenConditionSchema).max(12).default([]),
  orderBy: z.object({ field: z.string().min(1), desc: z.boolean().optional() }).optional(),
  limit: z.number().int().min(1).max(100).default(30),
  type: z.enum(['stock', 'etf']).optional(),
  persist: z.boolean().default(true),
  source: sourcePrefSchema,
})

const SCREEN_TABLE_FIELDS: Array<{ key: keyof ScreenRow; label: string; fmt: (row: ScreenRow) => string }> = [
  { key: 'price', label: '最新价', fmt: (r) => fmtNum(r.price) },
  { key: 'changePct', label: '涨跌幅', fmt: (r) => fmtPct(r.changePct) },
  { key: 'turnoverRate', label: '换手率', fmt: (r) => fmtPct(r.turnoverRate) },
  { key: 'pe', label: 'PE(动)', fmt: (r) => fmtNum(r.pe) },
  { key: 'pb', label: 'PB', fmt: (r) => fmtNum(r.pb) },
  { key: 'marketCap', label: '总市值', fmt: (r) => fmtAmount(r.marketCap) },
  { key: 'turnover', label: '成交额', fmt: (r) => fmtAmount(r.turnover) },
]

function createFinScreenTool(cfg: AppConfig): AgentTool {
  return {
    name: 'fin_screen',
    tier: 'deferred',
    readOnly: true,
    description:
      `全市场股票 / ETF 筛选（底表约 5000+ 行，缓存 10 分钟）：conditions 为 AND 条件数组（≤12 条），字段可用：${SCREEN_FIELDS.map((f) => f.key).join(' / ')}；数值算子 gt/gte/lt/lte/eq/neq/between，文本算子 contains/eq/neq（市值等金额单位为元，1 亿 = 1e8）。orderBy 排序（数值降序常用于市值 / 涨幅榜），limit ≤100。首期仅股票与 ETF。`,
    parameters: {
      type: 'object',
      properties: {
        conditions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string', description: '字段（price / changePct / turnoverRate / pe / pb / marketCap / floatMarketCap / turnover / volume / code / name / type）' },
              op: { type: 'string', enum: ['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'between', 'contains'], description: '算子' },
              value: { description: '值（数值 / 文本 / between 用 [min, max]）' },
            },
            required: ['field', 'op', 'value'],
          },
          description: '筛选条件（AND 语义，≤12 条；缺省 = 全表）',
        },
        orderBy: {
          type: 'object',
          properties: {
            field: { type: 'string', description: '排序字段' },
            desc: { type: 'boolean', description: '是否降序（默认升序）' },
          },
          required: ['field'],
          description: '排序（缺省保持底表原序）',
        },
        limit: { type: 'number', description: '返回条数（默认 30，上限 100）' },
        type: { type: 'string', enum: ['stock', 'etf'], description: '品种限定（缺省全部）' },
        persist: { type: 'boolean', description: '是否落盘快照（默认 true）' },
        source: { type: 'string', enum: ['auto', 'node', 'py'], description: '数据源层级（默认 auto）' },
      },
    },
    schema: screenArgs,
    async execute(args: z.infer<typeof screenArgs>, ctx: ToolRuntime): Promise<ToolResult> {
      const guard = financeGuard(ctx)
      if (!guard.ok) return guard.result
      let base
      let outcome
      try {
        base = await guard.gateway.screenBase({ source: args.source })
        let rows = base.data
        if (args.type) rows = rows.filter((row) => row.type === args.type)
        outcome = screenRows(rows, args.conditions as ScreenCondition[], {
          ...(args.orderBy ? { orderBy: args.orderBy as ScreenOrderBy } : {}),
          limit: args.limit,
        })
      } catch (err) {
        return { ok: false, summary: `筛选失败：${errorText(err)}` }
      }

      const rows = outcome.rows.map((row) => [
        row.code,
        row.name,
        ...SCREEN_TABLE_FIELDS.map((f) => f.fmt(row)),
      ])
      const conditionText =
        args.conditions.length > 0
          ? args.conditions.map((cond) => describeScreenCondition(cond as ScreenCondition)).join('｜')
          : '（全部标的）'
      const orderText = args.orderBy
        ? `${SCREEN_FIELDS.find((f) => f.key === args.orderBy!.field)?.label ?? args.orderBy.field} ${args.orderBy.desc ? '降序' : '升序'}`
        : '底表原序'

      let snapshotPath: string | undefined
      if (args.persist) {
        throwIfAborted(ctx)
        const notes: string[] = []
        if (args.type) notes.push(`品种限定：${args.type}`)
        if (base.degraded) notes.push(base.degraded)
        const snap: ScreenSnapshot = {
          kind: 'screen',
          meta: {
            source: base.source,
            asOf: base.asOf,
            conditions: args.conditions,
            ...(args.orderBy ? { orderBy: args.orderBy } : {}),
            total: outcome.total,
            matched: outcome.matched,
            limit: args.limit,
            ...(notes.length > 0 ? { note: notes.join('；') } : {}),
          },
          rows: outcome.rows,
        }
        try {
          const written = await writeJsonSnapshot(ctx.workspace, cfg.financeKlineSnapshotDir, screenSnapshotFilename(), snap)
          snapshotPath = written.path
        } catch (err) {
          return { ok: false, summary: `快照写入失败：${errorText(err)}` }
        }
      }

      const parts = [
        `筛选底表：${outcome.total} 行（已排除缺失字段行）｜命中 ${outcome.matched} 行，展示前 ${outcome.rows.length} 行`,
        `条件：${conditionText}｜排序：${orderText}`,
        mdTable(['代码', '名称', ...SCREEN_TABLE_FIELDS.map((f) => f.label)], rows),
        sourceLine({ source: base.source, asOf: base.asOf, cache: base.cache, degraded: base.degraded }),
      ]
      if (snapshotPath) parts.push(`快照：${snapshotPath}（全量命中行，可版本 diff）`)
      return {
        ok: true,
        summary: `筛选命中 ${outcome.matched}/${outcome.total} 行（展示 ${outcome.rows.length} 行；来源 ${base.source}）${snapshotPath ? `；快照 ${snapshotPath}` : ''}`,
        detail: parts.join('\n'),
        ...(snapshotPath ? { artifacts: [snapshotPath] } : {}),
      }
    },
  }
}

// ---------------------------------------------------------------- fin_backtest

/** 模板默认参数说明（工具 description 内联；避免与引擎常量重复维护） */
const TEMPLATE_DEFAULTS_NOTE = `模板默认参数：${BACKTEST_TEMPLATES.map(
  (t) => `${t}(${Object.entries(BACKTEST_DEFAULT_PARAMS[t]).map(([k, v]) => `${k}=${v}`).join(',')})`,
).join('、')}。`

const backtestArgs = z.object({
  symbol: z.string().min(1),
  template: z.enum(BACKTEST_TEMPLATES),
  params: z.record(z.number()).optional(),
  /** M83：template='dsl' 时的策略源码（YAML） */
  dsl: z.string().min(1).max(20 * 1024).optional(),
  /** M83：DSL inputs 覆盖（仅限策略已声明键） */
  dsl_inputs: z.record(z.union([z.number(), z.string().max(200), z.boolean()])).optional(),
  start: z.string().optional(),
  end: z.string().optional(),
  limit: z.number().int().min(30).max(500).default(250),
  fee: z.number().min(0).max(2).optional(),
  slippage: z.number().min(0).max(2).optional(),
  persist: z.boolean().default(true),
  source: sourcePrefSchema,
})

function createFinBacktestTool(cfg: AppConfig): AgentTool {
  return {
    name: 'fin_backtest',
    tier: 'deferred',
    readOnly: true,
    description:
      `策略回测（Node 自研引擎，唯一口径）：5 个模板 —— ma-cross（均线交叉，params fast/slow）、rsi-reversal（超卖回升买，period/oversold/overbought）、macd-cross（金叉死叉，fast/slow/signal）、boll-breakout（上轨突破买/下轨离场，period/mult）、buy-hold（买入持有基准）；template=dsl 时用 dsl 参数传 DSL 策略源码（YAML，M83 引擎），信号口径与 fin_strategy 一致（建议先 fin_strategy action=lint）。执行口径：第 i 根收盘信号 → 第 i+1 根开盘成交（避免未来函数）；全仓多头；成本默认单边费率 ${DEFAULT_FEE_RATE}% + 滑点 ${DEFAULT_SLIPPAGE}%。${TEMPLATE_DEFAULTS_NOTE}策略验证必须用本工具（禁止用收益数字估算代替）。`,
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '标的（代码 / sh600519 / 名称）' },
        template: { type: 'string', enum: [...BACKTEST_TEMPLATES], description: '策略模板（dsl = 用 dsl 参数传源码）' },
        params: { type: 'object', description: `模板参数（如 {"fast":5,"slow":20}）；缺省用模板默认值` },
        dsl: { type: 'string', description: "DSL 策略源码（YAML；仅 template='dsl'，≤20KB）" },
        dsl_inputs: { type: 'object', description: 'DSL inputs 覆盖（仅限策略已声明键）' },
        start: { type: 'string', description: '区间起点 yyyy-MM-dd（可选）' },
        end: { type: 'string', description: '区间终点 yyyy-MM-dd（可选）' },
        limit: { type: 'number', description: '取数根数（默认 250；起点更早时需放大）' },
        fee: { type: 'number', description: `单边费率 %（默认 ${DEFAULT_FEE_RATE}）` },
        slippage: { type: 'number', description: `单边滑点 %（默认 ${DEFAULT_SLIPPAGE}）` },
        persist: { type: 'boolean', description: '是否落盘快照（默认 true）' },
        source: { type: 'string', enum: ['auto', 'node', 'py'], description: '数据源层级（默认 auto）' },
      },
      required: ['symbol', 'template'],
    },
    schema: backtestArgs,
    async execute(args: z.infer<typeof backtestArgs>, ctx: ToolRuntime): Promise<ToolResult> {
      const guard = financeGuard(ctx)
      if (!guard.ok) return guard.result
      if (args.template === 'dsl' && !args.dsl) {
        return { ok: false, summary: "template='dsl' 需提供 dsl 源码（YAML）；可先用 fin_strategy action=lint 检查" }
      }
      if (args.template !== 'dsl' && args.dsl) {
        return { ok: false, summary: `dsl 参数仅用于 template='dsl'（当前 template=${args.template}）` }
      }
      const resolved = await resolveFinSymbol(guard.gateway, args.symbol)
      if (!resolved.ok) return resolved.result
      const symbol = resolved.symbol
      const name = symbol.name ?? symbol.symbol

      let kline: Awaited<ReturnType<typeof guard.gateway.kline>>
      try {
        kline = await guard.gateway.kline(symbol, 'day', 'qfq', args.limit, { source: args.source })
      } catch (err) {
        return { ok: false, summary: `回测取数失败：${errorText(err)}` }
      }

      let result
      try {
        result = runBacktest(
          kline.data.bars,
          {
            template: args.template,
            ...(args.params ? { params: args.params } : {}),
            ...(args.dsl ? { dsl: args.dsl } : {}),
            ...(args.dsl_inputs ? { dslInputs: args.dsl_inputs } : {}),
          },
          {
            ...(args.fee !== undefined ? { feeRate: args.fee } : {}),
            ...(args.slippage !== undefined ? { slippage: args.slippage } : {}),
            ...(args.start || args.end ? { range: { ...(args.start ? { start: args.start } : {}), ...(args.end ? { end: args.end } : {}) } } : {}),
          },
        )
      } catch (err) {
        return { ok: false, summary: `回测失败：${errorText(err)}` }
      }

      let snapshotPath: string | undefined
      if (args.persist) {
        throwIfAborted(ctx)
        const notes: string[] = []
        if (kline.degraded) notes.push(kline.degraded)
        const snap: BacktestSnapshot = {
          kind: 'backtest',
          symbol: symbol.symbol,
          name,
          meta: {
            source: kline.source,
            asOf: kline.asOf,
            template: result.template,
            params: result.params,
            range: { from: result.from, to: result.to, bars: result.bars },
            feeRate: args.fee ?? DEFAULT_FEE_RATE,
            slippage: args.slippage ?? DEFAULT_SLIPPAGE,
            ...(args.dsl ? { dsl: args.dsl } : {}),
            ...(notes.length > 0 ? { note: notes.join('；') } : {}),
          },
          metrics: result.metrics,
          trades: result.trades,
          equity: result.equity,
          notes: result.notes,
        }
        try {
          const written = await writeJsonSnapshot(ctx.workspace, cfg.financeKlineSnapshotDir, backtestSnapshotFilename(symbol.symbol), snap)
          snapshotPath = written.path
        } catch (err) {
          return { ok: false, summary: `快照写入失败：${errorText(err)}` }
        }
      }

      const m = result.metrics
      const paramLine = Object.entries(result.params)
        .map(([k, v]) => `${k}=${v}`)
        .join('｜')
      const metricRows = [
        ['总收益', fmtPct(m.totalReturn * 100), fmtPct(m.benchmarkReturn * 100)],
        ['年化收益', fmtPct(m.annualReturn * 100), '—'],
        ['最大回撤', fmtPct(-m.maxDrawdown * 100), '—'],
        ['夏普比率', fmtNum(m.sharpe), '—'],
        ['年化波动', fmtPct(m.volatility * 100), '—'],
        ['胜率', m.winRate !== undefined ? fmtPct(m.winRate * 100) : '—', '—'],
        ['交易数', String(m.trades), '1 笔（买入持有）'],
        ['盈亏比', m.profitFactor !== undefined ? fmtNum(m.profitFactor) : '—', '—'],
      ]
      const parts = [
        `回测：${name}（${symbol.symbol}） 日K · 前复权（${result.from} → ${result.to}，${result.bars} 根）`,
        `策略：${result.template}${paramLine ? `（${paramLine}）` : ''}｜成本：单边费率 ${args.fee ?? DEFAULT_FEE_RATE}% + 单边滑点 ${args.slippage ?? DEFAULT_SLIPPAGE}%`,
        mdTable(['指标', '策略', '基准'], metricRows),
      ]
      if (result.trades.length > 0) {
        const tail = result.trades.slice(-10)
        parts.push(
          `交易明细（共 ${result.trades.length} 笔，列出最近 ${tail.length} 笔）：`,
          mdTable(
            ['入场', '出场', '入场价', '出场价', '收益', '持有根数', '强平'],
            tail.map((t) => [t.entryAt, t.exitAt, fmtNum(t.entryPrice), fmtNum(t.exitPrice), fmtPct(t.returnPct * 100), String(t.bars), t.forced ? '是' : '']),
          ),
        )
      }
      parts.push(`说明：\n- ${result.notes.join('\n- ')}`)
      parts.push(sourceLine({ source: kline.source, asOf: kline.asOf, cache: kline.cache, degraded: kline.degraded }))
      if (snapshotPath) parts.push(`快照：${snapshotPath}（含净值曲线与全部成交明细，可版本 diff）`)

      return {
        ok: true,
        summary: `回测完成：${name} ${result.template} 总收益 ${fmtPct(m.totalReturn * 100)}（年化 ${fmtPct(m.annualReturn * 100)}；回撤 ${fmtPct(-m.maxDrawdown * 100)}；夏普 ${fmtNum(m.sharpe)}）vs 基准 ${fmtPct(m.benchmarkReturn * 100)}${snapshotPath ? `；快照 ${snapshotPath}` : ''}`,
        detail: parts.join('\n'),
        ...(snapshotPath ? { artifacts: [snapshotPath] } : {}),
      }
    },
  }
}

// ---------------------------------------------------------------- fin_strategy

const strategyArgs = z.object({
  action: z.enum(['lint', 'run']),
  dsl: z.string().min(1).max(20 * 1024),
  symbol: z.string().min(1).optional(),
  period: z.enum(['day', 'week', 'month', 'min5', 'min15', 'min30', 'min60']).default('day'),
  adjust: z.enum(['qfq', 'hfq', 'none']).default('qfq'),
  limit: z.number().int().min(30).max(500).default(250),
  inputs: z.record(z.union([z.number(), z.string().max(200), z.boolean()])).optional(),
  persist: z.boolean().default(true),
  source: sourcePrefSchema,
})

function createFinStrategyTool(cfg: AppConfig): AgentTool {
  /** lint 结论统一渲染（lint 与 run 前置校验共用） */
  const renderFindings = (findings: Array<{ level: 'error' | 'warning'; path?: string; message: string }>): string[] =>
    findings.map((f) => `- [${f.level === 'error' ? '错误' : '提示'}] ${f.path ? `${f.path}：` : ''}${f.message}`)

  return {
    name: 'fin_strategy',
    tier: 'deferred',
    readOnly: true,
    description:
      'DSL 策略引擎（M83）：把策略想法写成 YAML DSL —— action=lint 静态检查（语法 / 变量 / 函数 / inputs / 落图字段，免取数，可反复调用）/ action=run 执行出信号。run 输出 signal（方向 / 入场 / 止损 / 目标 / R:R）+ drawings 落图 + facts 变量快照（未触发时按各规则 last_when / triggers 排查）；persist=true 落盘快照并给出可直接复制的 kline 块模板（图表 + 信号落图）。DSL 语法：name / inputs（参数声明）/ signals（when 条件 → emit 方向与价位表达式）/ drawings（落图规则）；表达式可用 close / open / high / low / volume 序列与 ma / ema / hhv / llv / ref / cross_up / cross_down / atr / rsi / dif / dea / hist / bb_up / bb_mid / bb_low / vol_ma 等白名单函数（禁 ref 负偏移）。回测验证用 fin_backtest template=dsl（同一信号口径，建议先 lint）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['lint', 'run'], description: 'lint=静态检查（免取数）；run=执行' },
        dsl: { type: 'string', description: 'DSL 策略源码（YAML，≤20KB）' },
        symbol: { type: 'string', description: '标的（action=run 必填；代码 / sh600519 / 名称）' },
        period: { type: 'string', enum: ['day', 'week', 'month', 'min5', 'min15', 'min30', 'min60'], description: 'K 线周期（默认 day）' },
        adjust: { type: 'string', enum: ['qfq', 'hfq', 'none'], description: '复权（默认 qfq）' },
        limit: { type: 'number', description: '取数根数（默认 250）' },
        inputs: { type: 'object', description: 'inputs 参数覆盖（仅限策略已声明键，如 {"fast": 10}）' },
        persist: { type: 'boolean', description: 'run 是否落盘快照并给出 kline 块模板（默认 true）' },
        source: { type: 'string', enum: ['auto', 'node', 'py'], description: '数据源层级（默认 auto）' },
      },
      required: ['action', 'dsl'],
    },
    schema: strategyArgs,
    async execute(args: z.infer<typeof strategyArgs>, ctx: ToolRuntime): Promise<ToolResult> {
      // lint：免取数、免网络（可反复调用）
      if (args.action === 'lint') {
        const parsed = parseDsl(args.dsl)
        const errors = parsed.findings.filter((f) => f.level === 'error')
        const warnings = parsed.findings.filter((f) => f.level === 'warning')
        if (!parsed.ok) {
          return {
            ok: false,
            summary: `DSL lint 未通过：${errors.length} 个错误${warnings.length > 0 ? ` / ${warnings.length} 个提示` : ''}`,
            detail: ['按下列条目修正后重试（lint 免取数，可反复调用）：', ...renderFindings(parsed.findings)].join('\n'),
          }
        }
        const lines = renderFindings(parsed.findings)
        return {
          ok: true,
          summary: `DSL lint 通过${warnings.length > 0 ? `（${warnings.length} 个提示）` : ''}`,
          detail: [
            `策略：${parsed.spec.name}（signals ${parsed.spec.signals.length} 条；drawings ${parsed.spec.drawings.length} 条）`,
            ...(lines.length > 0 ? ['提示：', ...lines] : []),
            '下一步：action=run 执行（或 fin_backtest template=dsl 回测验证）。',
          ].join('\n'),
        }
      }

      // run：取数 → 执行 → 快照 / 块模板
      const guard = financeGuard(ctx)
      if (!guard.ok) return guard.result
      if (!args.symbol) return { ok: false, summary: 'action=run 需要 symbol' }
      const parsed = parseDsl(args.dsl)
      if (!parsed.ok) {
        const errors = parsed.findings.filter((f) => f.level === 'error')
        return {
          ok: false,
          summary: `DSL lint 未通过：${errors.length} 个错误（先修正再 run）`,
          detail: renderFindings(parsed.findings).join('\n'),
        }
      }
      const resolved = await resolveFinSymbol(guard.gateway, args.symbol)
      if (!resolved.ok) return resolved.result
      const symbol = resolved.symbol
      const name = symbol.name ?? symbol.symbol

      let kline: Awaited<ReturnType<typeof guard.gateway.kline>>
      try {
        kline = await guard.gateway.kline(symbol, args.period, args.adjust, args.limit, { source: args.source })
      } catch (err) {
        return { ok: false, summary: `策略取数失败：${errorText(err)}` }
      }

      let run: ReturnType<typeof runDsl>
      try {
        run = runDsl(kline.data.bars, parsed.spec, {
          symbol: symbol.symbol,
          period: args.period,
          adjust: args.adjust,
          ...(args.inputs ? { inputs: args.inputs } : {}),
        })
      } catch (err) {
        if (err instanceof DslExprError) {
          return {
            ok: false,
            summary: `DSL 执行失败：${err.message}`,
            detail: '修正表达式后重试；可用 action=lint 预检（免取数）。',
          }
        }
        return { ok: false, summary: `DSL 执行失败：${errorText(err)}` }
      }

      const render = { mainIndicator: 'MA' as const, subIndicator: 'VOL' as const }
      let snapshotPath: string | undefined
      if (args.persist) {
        throwIfAborted(ctx)
        const snapshot = buildKlineSnapshot(kline.data, {
          indicators: ['MA', 'VOL'],
          render,
          drawings: run.drawings,
          ...(run.signal ? { signal: run.signal } : {}),
          ...(kline.degraded ? { note: kline.degraded } : {}),
        })
        try {
          const written = await writeChartSnapshot(ctx.workspace, cfg.financeKlineSnapshotDir, snapshot)
          snapshotPath = written.path
        } catch (err) {
          return { ok: false, summary: `快照写入失败：${errorText(err)}` }
        }
      }

      const sig = run.signal
      const parts = [
        `策略：${parsed.spec.name}｜${name}（${symbol.symbol}） ${periodLabel(args.period)}K · ${adjustLabel(args.adjust)} · ${kline.data.bars.length} 根`,
      ]
      if (sig) {
        const dir = sig.direction === 'long' ? '做多' : sig.direction === 'short' ? '做空' : '中性'
        parts.push(
          `信号（${fmtBarTime(sig.ts)}）：${dir} · 置信度 ${sig.confidence}｜入场 ${fmtNum(sig.entry)}｜止损 ${fmtNum(sig.stopLoss)}｜目标 ${sig.takeProfit.length > 0 ? sig.takeProfit.map((v) => fmtNum(v)).join(' / ') : '—'}｜${sig.riskReward !== null ? `R:R ${fmtNum(sig.riskReward)}` : 'R:R —'}`,
        )
        parts.push(`触发说明：${sig.rationale}`)
      } else {
        parts.push('信号：未触发（按 facts.signals 各规则 last_when / triggers 排查：哪条 when 为假、历史是否触发过）')
      }
      parts.push(`落图：${run.drawings.length} 条（groupId strategy:${parsed.spec.name}）`)
      parts.push('facts 变量快照：', '```json', JSON.stringify(run.facts, null, 2), '```')
      parts.push(`说明：\n- ${run.notes.join('\n- ')}`)
      parts.push(sourceLine({ source: kline.source, asOf: kline.asOf, cache: kline.cache, degraded: kline.degraded }))
      if (snapshotPath) {
        parts.push(`快照：${snapshotPath}`)
        parts.push(
          '',
          'kline 块模板（复制到回复即可渲染：图 + 策略信号落图）：',
          klineBlockTemplate(`${name} ${parsed.spec.name}`, snapshotPath, ['MA', 'VOL'], { render }),
        )
      }

      return {
        ok: true,
        summary: `DSL 执行完成：${parsed.spec.name}${sig ? ` 触发${sig.direction === 'long' ? '做多' : sig.direction === 'short' ? '做空' : '中性'}信号（${fmtBarTime(sig.ts)}）` : ' 未触发'}；落图 ${run.drawings.length} 条${snapshotPath ? `；快照 ${snapshotPath}` : ''}`,
        detail: parts.join('\n'),
        ...(snapshotPath ? { artifacts: [snapshotPath] } : {}),
      }
    },
  }
}

// ---------------------------------------------------------------- fin_stats

/** 默认前向窗口（significance） */
const STATS_DEFAULT_HORIZONS = [1, 3, 5, 10, 20]

const statsArgs = z.object({
  analysis: z.enum(['summary', 'significance']),
  /** summary：1–5 个标的 */
  symbols: z.array(z.string().min(1)).min(1).max(5).optional(),
  /** significance：单标的 */
  symbol: z.string().min(1).optional(),
  period: z.enum(['day', 'week', 'month', 'min5', 'min15', 'min30', 'min60']).default('day'),
  adjust: z.enum(['qfq', 'hfq', 'none']).default('qfq'),
  limit: z.number().int().min(60).max(500).default(250),
  /** summary：分析项子集（缺省全量） */
  items: z.array(z.enum(['summary', 'distribution', 'correlation', 'stationarity'])).min(1).max(4).optional(),
  /** significance：事件来源（内置检测器） */
  event: z
    .object({
      kind: z.enum(EVENT_KINDS),
      fast: z.number().int().min(1).max(250).optional(),
      slow: z.number().int().min(2).max(500).optional(),
      pct: z.number().min(0.1).max(50).optional(),
      window: z.number().int().min(1).max(250).optional(),
      ratio: z.number().min(1).max(10).optional(),
      price: z.number().positive().optional(),
      tolerancePct: z.number().min(0).max(10).optional(),
    })
    .optional(),
  horizons: z.array(z.number().int().min(1).max(60)).min(1).max(6).optional(),
  bootstrap: z.number().int().min(200).max(10000).optional(),
  persist: z.boolean().default(true),
  source: sourcePrefSchema,
})

/** 桥失败分类：缺包 / 无环境 → 给出安装引导（其余为调用失败） */
function statsFailureHint(message: string): string | undefined {
  if (message.includes('缺少 Python 包') || message.includes('统计引擎不可用')) {
    return `${message}；安装：fin_env action=install group=analytics`
  }
  return undefined
}

/** 相关性矩阵 → Markdown 表（对角线 1，缺失为 —） */
function correlationTable(names: string[], matrix: Array<Array<number | null>>): string {
  const rows = names.map((name, i) => [name, ...matrix[i].map((v) => (v === null ? '—' : fmtNum(v, 3)))])
  return mdTable(['标的', ...names], rows)
}

function createFinStatsTool(cfg: AppConfig): AgentTool {
  return {
    name: 'fin_stats',
    tier: 'deferred',
    readOnly: true,
    description:
      "统计分析（M84；「有理有据」的证据链）：analysis=summary 多标的（1–5）描述统计（年化收益 / 波动 / 最大回撤 / 当前分位 / 偏度峰度）+ 收益相关性矩阵（Pearson / Spearman）+ ADF 平稳性；analysis=significance 条件显著性检验——事件来源为内置检测器（ma_cross_up / ma_cross_down / drop_pct / rise_pct / volume_spike / touch_level），输出事件后前向收益分布（n / 均值 / 中位 / 胜率 / 盈亏比）+ 单样本 t 检验 p 值 + bootstrap 95% CI + Bonferroni 校正 + 与全样本基准对照。summary 在 Python 统计扩展缺失时降级 Node 基础统计（缺项注明）；significance 不做 Node 近似（缺包时给出安装引导，不硬造显著性）。用于支撑位有效性 / 金叉显著性 / 多标的相对强弱等严谨举证。",
    parameters: {
      type: 'object',
      properties: {
        analysis: { type: 'string', enum: ['summary', 'significance'], description: 'summary=多标的对比统计；significance=事件显著性检验' },
        symbols: { type: 'array', items: { type: 'string' }, description: 'summary：标的列表（1–5 个；代码 / sh600519 / 名称）' },
        symbol: { type: 'string', description: 'significance：单标的' },
        period: { type: 'string', enum: ['day', 'week', 'month', 'min5', 'min15', 'min30', 'min60'], description: '周期（默认 day）' },
        adjust: { type: 'string', enum: ['qfq', 'hfq', 'none'], description: '复权（默认 qfq）' },
        limit: { type: 'number', description: '取数根数（默认 250）' },
        items: { type: 'array', items: { type: 'string', enum: ['summary', 'distribution', 'correlation', 'stationarity'] }, description: 'summary：分析项子集（缺省全量）' },
        event: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: [...EVENT_KINDS], description: '事件类型' },
            fast: { type: 'number', description: 'ma_cross：快线周期（默认 5）' },
            slow: { type: 'number', description: 'ma_cross：慢线周期（默认 20）' },
            pct: { type: 'number', description: '涨跌幅阈值 %（drop_pct / rise_pct，默认 5）' },
            window: { type: 'number', description: '回看窗口（涨跌幅根数 / 量比基准窗口，默认 1 / 60）' },
            ratio: { type: 'number', description: 'volume_spike：量比阈值（默认 2）' },
            price: { type: 'number', description: 'touch_level：关键位价格（必填）' },
            tolerancePct: { type: 'number', description: 'touch_level：容差 %（默认 0）' },
          },
          required: ['kind'],
          description: 'significance：事件定义（内置检测器）',
        },
        horizons: { type: 'array', items: { type: 'number' }, description: `significance：前向窗口（默认 ${STATS_DEFAULT_HORIZONS.join('/')}）` },
        bootstrap: { type: 'number', description: 'significance：bootstrap 次数（默认 2000）' },
        persist: { type: 'boolean', description: '是否落盘快照（默认 true）' },
        source: { type: 'string', enum: ['auto', 'node', 'py'], description: '数据源层级（默认 auto）' },
      },
      required: ['analysis'],
    },
    schema: statsArgs,
    async execute(args: z.infer<typeof statsArgs>, ctx: ToolRuntime): Promise<ToolResult> {
      const guard = financeGuard(ctx)
      if (!guard.ok) return guard.result

      // ---------- summary：多标的描述统计 ----------
      if (args.analysis === 'summary') {
        if (!args.symbols || args.symbols.length === 0) {
          return { ok: false, summary: 'analysis=summary 需要 symbols（1–5 个标的）' }
        }
        const series: StatsSeriesInput[] = []
        const problems: string[] = []
        const sourceNotes: string[] = []
        for (const raw of args.symbols) {
          const resolved = await resolveFinSymbol(guard.gateway, raw)
          if (!resolved.ok) {
            problems.push(`${raw}（未识别）`)
            continue
          }
          try {
            const res = await guard.gateway.kline(resolved.symbol, args.period, args.adjust, args.limit, { source: args.source })
            const bars = res.data.bars
            if (bars.length < 60) {
              problems.push(`${raw}（样本 ${bars.length} 根 < 60）`)
              continue
            }
            series.push({
              name: `${resolved.symbol.name ?? resolved.symbol.symbol}（${resolved.symbol.symbol}）`,
              timestamps: bars.map((b) => b.timestamp),
              closes: bars.map((b) => b.close),
            })
            sourceNotes.push(`${resolved.symbol.symbol}：${sourceLine({ source: res.source, asOf: res.asOf, cache: res.cache, degraded: res.degraded })}`)
          } catch (err) {
            problems.push(`${raw}（取数失败：${errorText(err)}）`)
          }
        }
        if (series.length === 0) return { ok: false, summary: `全部标的取数失败：${problems.join('、')}` }

        let pyResult: PyStatsResult | undefined
        let engineNote: string | undefined
        try {
          const res = await guard.gateway.pyStats<PyStatsResult>('stats', {
            series,
            items: args.items ?? ['summary', 'distribution', 'correlation', 'stationarity'],
          })
          pyResult = res.data
        } catch (err) {
          const msg = errorText(err)
          const hint = statsFailureHint(msg)
          engineNote = hint ? `${hint}——已降级 Node 基础统计` : `统计扩展调用失败（${msg}）——已降级 Node 基础统计`
        }

        const parts: string[] = [
          `统计分析：${series.length} 个标的 ${periodLabel(args.period)}K · ${adjustLabel(args.adjust)}（引擎：${pyResult ? 'Python 统计扩展' : 'Node 基础统计'}）`,
        ]
        if (pyResult) {
          const summaryRows = (pyResult.items.summary ?? []).map((s) => [
            s.name,
            s.annualReturnPct !== null ? fmtPct(s.annualReturnPct) : '—',
            s.annualVolPct !== null ? fmtPct(s.annualVolPct) : '—',
            fmtPct(-(s.maxDrawdownPct ?? 0)),
            s.changePct !== null ? fmtPct(s.changePct) : '—',
            s.percentile !== null ? `${(s.percentile * 100).toFixed(1)}%` : '—',
            s.skew !== null ? fmtNum(s.skew) : '—',
            s.kurtosis !== null ? fmtNum(s.kurtosis) : '—',
          ])
          parts.push('描述统计：', mdTable(['标的', '年化收益', '年化波动', '最大回撤', '区间涨跌', '当前分位', '偏度', '峰度'], summaryRows))
          if (pyResult.items.correlation) {
            const c = pyResult.items.correlation
            parts.push(`收益相关性（对齐 ${c.points} 个共同交易日）：`, correlationTable(c.names, c.pearson))
            parts.push('Spearman 秩相关：', correlationTable(c.names, c.spearman))
          }
          if (pyResult.items.stationarity && pyResult.items.stationarity.length > 0) {
            const adfRows = pyResult.items.stationarity.map((s) => [s.name, s.priceP !== null ? fmtNum(s.priceP, 4) : '—', s.returnP !== null ? fmtNum(s.returnP, 4) : '—'])
            parts.push('ADF 平稳性（p 值；<0.05 拒绝单位根）：价格序列 / 收益序列', mdTable(['标的', '价格 p', '收益 p'], adfRows))
          }
          if (pyResult.notes.length > 0) parts.push(`说明：\n- ${pyResult.notes.join('\n- ')}`)
        } else {
          const fallback = nodeSummary(series)
          const rows = fallback.summaries.map((s) => [
            s.name,
            fmtPct(s.changePct),
            s.annualReturnPct !== null ? fmtPct(s.annualReturnPct) : '—',
            s.annualVolPct !== null ? fmtPct(s.annualVolPct) : '—',
            fmtPct(-s.maxDrawdownPct),
          ])
          parts.push('描述统计：', mdTable(['标的', '区间涨跌', '年化收益', '年化波动', '最大回撤'], rows))
          if (fallback.correlation) {
            parts.push(`收益相关性（Pearson；对齐 ${fallback.correlation.points} 个共同交易日）：`, correlationTable(fallback.correlation.names, fallback.correlation.pearson))
          }
          parts.push(`降级说明：${engineNote ?? 'Python 统计扩展不可用'}`)
          parts.push(`缺失项：${fallback.missing.join('、')}`)
        }
        if (problems.length > 0) parts.push(`未纳入：${problems.join('、')}`)
        parts.push(`数据源：\n- ${sourceNotes.join('\n- ')}`)

        let snapshotPath: string | undefined
        if (args.persist) {
          throwIfAborted(ctx)
          const snap = {
            kind: 'stats',
            meta: {
              analysis: 'summary',
              engine: pyResult ? 'python-bridge' : 'node',
              asOf: new Date().toISOString(),
              symbols: series.map((s) => s.name),
              period: args.period,
              adjust: args.adjust,
              bars: series.map((s) => s.closes.length),
              ...(engineNote ? { note: engineNote } : {}),
            },
            result: pyResult ?? nodeSummary(series),
          }
          try {
            const written = await writeJsonSnapshot(ctx.workspace, cfg.financeKlineSnapshotDir, `stats-${snapshotStamp()}.json`, snap)
            snapshotPath = written.path
          } catch (err) {
            return { ok: false, summary: `快照写入失败：${errorText(err)}` }
          }
        }
        if (snapshotPath) parts.push(`快照：${snapshotPath}`)
        return {
          ok: true,
          summary: `统计完成：${series.length} 标的信息（引擎 ${pyResult ? 'py' : 'node'}）${snapshotPath ? `；快照 ${snapshotPath}` : ''}`,
          detail: parts.join('\n'),
          ...(snapshotPath ? { artifacts: [snapshotPath] } : {}),
        }
      }

      // ---------- significance：事件显著性检验 ----------
      if (!args.symbol) return { ok: false, summary: 'analysis=significance 需要 symbol' }
      if (!args.event) return { ok: false, summary: 'analysis=significance 需要 event（事件定义：kind + 参数）' }
      const resolved = await resolveFinSymbol(guard.gateway, args.symbol)
      if (!resolved.ok) return resolved.result
      let kline: Awaited<ReturnType<typeof guard.gateway.kline>>
      try {
        kline = await guard.gateway.kline(resolved.symbol, args.period, args.adjust, args.limit, { source: args.source })
      } catch (err) {
        return { ok: false, summary: `显著性取数失败：${errorText(err)}` }
      }
      const bars = kline.data.bars
      const detected = detectEvents(bars, args.event as EventSpec)
      if (!detected.ok) return { ok: false, summary: `事件检测失败：${detected.error}` }
      const horizons = args.horizons ?? STATS_DEFAULT_HORIZONS
      if (detected.events.length === 0) {
        return {
          ok: true,
          summary: `无事件样本：${detected.label} 未触发（0 次）——请放宽事件参数或扩大 limit`,
          detail: `标的：${resolved.symbol.name ?? resolved.symbol.symbol}（${resolved.symbol.symbol}）· ${bars.length} 根\n事件：${detected.label}\n请放宽事件参数（如降低 pct / 提高 tolerancePct / 调整快慢周期）或扩大 limit 后重试。\n${sourceLine({ source: kline.source, asOf: kline.asOf, cache: kline.cache, degraded: kline.degraded })}`,
        }
      }
      let sig: PySignificanceResult
      try {
        const res = await guard.gateway.pyStats<PySignificanceResult>('significance', {
          timestamps: bars.map((b) => b.timestamp),
          closes: bars.map((b) => b.close),
          events: detected.events,
          horizons,
          ...(args.bootstrap !== undefined ? { bootstrap: args.bootstrap } : {}),
        })
        sig = res.data
      } catch (err) {
        const msg = errorText(err)
        const hint = statsFailureHint(msg)
        return {
          ok: false,
          summary: `显著性检验失败：${msg}`,
          detail: hint
            ? `${hint}\n统计能力不做 Node 降级（不硬造 t 检验 / bootstrap 近似值）。`
            : '统计桥调用失败；可先 fin_env action=status 排查 Python 环境。',
        }
      }

      const name = resolved.symbol.name ?? resolved.symbol.symbol
      const rows = sig.horizons.map((h) => [
        `h=${h.horizon}`,
        String(h.samples),
        h.meanPct !== null ? fmtPct(h.meanPct) : '—',
        h.medianPct !== null ? fmtPct(h.medianPct) : '—',
        h.winRate !== null ? `${(h.winRate * 100).toFixed(1)}%` : '—',
        h.profitFactor !== null ? fmtNum(h.profitFactor) : '—',
        h.pValue !== null ? (h.pValue < 0.0005 ? '<0.001' : h.pValue.toFixed(4)) : '—',
        h.ciLowPct !== null && h.ciHighPct !== null ? `[${h.ciLowPct.toFixed(2)}, ${h.ciHighPct.toFixed(2)}]%` : '—',
        h.significant === null ? '—' : h.significant ? '显著' : '不显著',
        h.excessPct !== null ? fmtPct(h.excessPct) : '—',
      ])
      const significantList = sig.horizons.filter((h) => h.significant === true).map((h) => `h=${h.horizon}`)
      const conclusion = significantList.length > 0 ? `显著窗口：${significantList.join(' / ')}` : '无显著窗口（口径见上）'
      const parts = [
        `显著性检验：${name}（${resolved.symbol.symbol}） ${periodLabel(args.period)}K · ${adjustLabel(args.adjust)} · ${sig.bars} 根`,
        `事件：${detected.label}｜触发 ${sig.events} 次｜前向窗口 ${sig.horizons.map((h) => h.horizon).join('/')}｜bootstrap ${sig.bootstrap} 次（seed ${sig.seed}）`,
        mdTable(['窗口', '样本', '均值', '中位', '胜率', '盈亏比', 'p 值', '95% CI', '判定', 'vs 基准'], rows),
        `结论：${conclusion}（α=${sig.alpha}；Bonferroni α'=${sig.bonferroniAlpha}）`,
      ]
      if (sig.notes.length > 0) parts.push(`说明：\n- ${sig.notes.join('\n- ')}`)
      parts.push(sourceLine({ source: kline.source, asOf: kline.asOf, cache: kline.cache, degraded: kline.degraded }))

      let snapshotPath: string | undefined
      if (args.persist) {
        throwIfAborted(ctx)
        const snap = {
          kind: 'stats',
          meta: {
            analysis: 'significance',
            engine: 'python-bridge',
            asOf: new Date().toISOString(),
            symbol: resolved.symbol.symbol,
            period: args.period,
            adjust: args.adjust,
            bars: bars.length,
            event: { ...args.event, label: detected.label },
          },
          result: sig,
        }
        try {
          const written = await writeJsonSnapshot(ctx.workspace, cfg.financeKlineSnapshotDir, `stats-${snapshotStamp()}.json`, snap)
          snapshotPath = written.path
        } catch (err) {
          return { ok: false, summary: `快照写入失败：${errorText(err)}` }
        }
      }
      if (snapshotPath) parts.push(`快照：${snapshotPath}`)
      return {
        ok: true,
        summary: `显著性检验完成：${name} 事件「${detected.label}」×${sig.events}｜${conclusion}${snapshotPath ? `；快照 ${snapshotPath}` : ''}`,
        detail: parts.join('\n'),
        ...(snapshotPath ? { artifacts: [snapshotPath] } : {}),
      }
    },
  }
}

// ---------------------------------------------------------------- fin_game

const gameArgs = z.object({
  action: z.enum(['matrix', 'sequence', 'evolve', 'simulate']),
  topic: z.string().min(1).max(80),
  symbol: z.string().min(1).max(40).optional(),
  params: z.record(z.unknown()).optional(),
  seed: z.number().int().min(0).optional(),
  persist: z.boolean().default(true),
})

function statText(value: GameStatValue): string {
  if (Array.isArray(value)) return `[${value.join(', ')}]`
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)))
  return value
}

function createFinGameTool(cfg: AppConfig): AgentTool {
  return {
    name: 'fin_game',
    tier: 'deferred',
    readOnly: true,
    description:
      '多空博弈建模与模拟推演（纯计算可复现：相同 seed + params 输出逐位一致）：matrix=静态矩阵博弈（纳什均衡 / 博弈类型识别 / 敏感性扫描）、sequence=序贯博弈（逆向归纳）、evolve=演化博弈（复制动态 / ESS）、simulate=ABM 蒙特卡洛（价格路径分位 / 级联统计）。结果含结论要点、快照与 game 块模板（复制到回复可渲染）。输出固定为「模型推演，非预测」，模型假设与参数必须列明。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['matrix', 'sequence', 'evolve', 'simulate'], description: '博弈模型' },
        topic: { type: 'string', description: '议题（如「茅台多空对峙推演」，≤80 字）' },
        symbol: { type: 'string', description: '关联标的（仅作标注，不参与计算）' },
        params: { type: 'object', description: '模型参数（matrix：capital/priceImpact/carryCost/retreatLoss；simulate：paths/rounds/lambda/sigma 等；缺省用模型默认值）' },
        seed: { type: 'number', description: `随机种子（默认 ${cfg.financeGameSeed}；用于复现）` },
        persist: { type: 'boolean', description: '是否落盘快照（默认 true）' },
      },
      required: ['action', 'topic'],
    },
    schema: gameArgs,
    async execute(args: z.infer<typeof gameArgs>, ctx: ToolRuntime): Promise<ToolResult> {
      const guard = financeGuard(ctx)
      if (!guard.ok) return guard.result

      const params: Record<string, unknown> = { ...(args.params ?? {}) }
      let capNote = ''
      if (args.action === 'simulate' && typeof params.paths === 'number' && params.paths > cfg.financeGameMaxPaths) {
        params.paths = cfg.financeGameMaxPaths
        capNote = `paths 已按 FINANCE_GAME_MAX_PATHS 限制为 ${cfg.financeGameMaxPaths}（计算护栏）`
      }
      const seed = args.seed ?? cfg.financeGameSeed

      let result
      try {
        result = runGame({
          action: args.action,
          topic: args.topic,
          ...(args.symbol ? { symbol: args.symbol } : {}),
          params,
          seed,
        })
      } catch (err) {
        return { ok: false, summary: `博弈推演失败：${errorText(err)}` }
      }

      let snapshotPath: string | undefined
      if (args.persist) {
        throwIfAborted(ctx)
        const snap = buildGameSnapshot(result, { note: '模型推演，非预测' })
        try {
          const written = await writeJsonSnapshot(ctx.workspace, cfg.financeKlineSnapshotDir, gameSnapshotFilename(result.topic), snap)
          snapshotPath = written.path
        } catch (err) {
          return { ok: false, summary: `快照写入失败：${errorText(err)}` }
        }
      }

      const statLine = Object.entries(result.stats)
        .map(([k, v]) => `${k}=${statText(v)}`)
        .join('｜')
      const paramLine = Object.entries(result.params)
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
        .join('｜')
      const parts = [
        `博弈推演：${MODEL_LABELS[result.model]}｜议题：${result.topic}${result.symbol ? `｜标的：${result.symbol}` : ''}｜种子 ${result.seed}`,
        `参数：${paramLine || '（默认）'}`,
        `指标：${statLine || '—'}`,
        `结论要点：${result.narrative}`,
      ]
      if (result.warnings && result.warnings.length > 0) parts.push(`提示：${result.warnings.join('；')}`)
      if (capNote) parts.push(capNote)
      if (snapshotPath) {
        parts.push(`快照：${snapshotPath}（参数 / 种子 / 全量结果，可复现）`)
        parts.push('', 'game 块模板（复制到回复即可渲染）：', gameBlockTemplate(result.topic, snapshotPath, result.model))
      } else {
        parts.push('persist=false：本次未落盘快照，不提供 game 块（渲染展示请用 persist=true）')
      }
      parts.push('声明：模型推演，非预测——模型假设与参数见上，结论不替代事实数据。')
      return {
        ok: true,
        summary: `博弈推演完成：${MODEL_LABELS[result.model]}「${result.topic}」${result.stats.gameType ? `｜识别为 ${String(result.stats.gameType)}` : ''}${snapshotPath ? `；快照 ${snapshotPath}` : ''}`,
        detail: parts.join('\n'),
        ...(snapshotPath ? { artifacts: [snapshotPath] } : {}),
      }
    },
  }
}

// ---------------------------------------------------------------- fin_watch

const watchArgs = z.object({
  action: z.enum(['add', 'remove', 'list']),
  symbol: z.string().min(1).optional(),
  note: z.string().max(120).optional(),
})

const finWatchTool: AgentTool = {
  name: 'fin_watch',
  tier: 'deferred',
  readOnly: false,
  description:
    '自选列表管理（全局单表）：action=add 添加（写操作，需用户审批）/ remove 移除（审批）/ list 查看。用户说「加自选」「关注这支」「不想看了」时使用；add 会先归一化标的（名称 / 代码均可）。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['add', 'remove', 'list'], description: '操作' },
      symbol: { type: 'string', description: '标的（add / remove 必填；代码 / sh600519 / 名称）' },
      note: { type: 'string', description: '备注（add 可选，≤120 字）' },
    },
    required: ['action'],
  },
  schema: watchArgs,
  async execute(args: z.infer<typeof watchArgs>, ctx: ToolRuntime): Promise<ToolResult> {
    const guard = financeGuard(ctx)
    if (!guard.ok) return guard.result
    const store = ctx.financeStore
    if (!store) return { ok: false, summary: '自选列表未启用（服务端未装配 FinanceStore）' }
    // M57：自选按用户（会话属主；单用户兼容模式 '' 口径）
    const userId = ctx.userId ?? ''

    if (args.action === 'list') {
      const items = store.list(userId)
      if (items.length === 0) return { ok: true, summary: '自选列表为空（用 action=add 添加）' }
      const rows = items.map((item) => [
        item.symbol,
        item.name,
        TYPE_LABELS[item.type as AssetType] ?? item.type,
        item.note ?? '—',
        item.createdAt.slice(0, 10),
      ])
      return { ok: true, summary: `自选 ${items.length} 条`, detail: mdTable(['标的', '名称', '品种', '备注', '加入日期'], rows) }
    }

    if (!args.symbol) return { ok: false, summary: `action=${args.action} 需要 symbol` }

    if (args.action === 'add') {
      const resolved = await resolveFinSymbol(guard.gateway, args.symbol)
      if (!resolved.ok) return resolved.result
      const sym = resolved.symbol
      const label = `${sym.name ?? sym.symbol}（${sym.symbol}｜${TYPE_LABELS[sym.type]}）`
      const approval = await approveWrite(
        ctx,
        '加入自选列表',
        `将 ${label} 加入自选列表${args.note ? `\n备注：${args.note}` : ''}`,
      )
      if (!approval.ok) return approval.result
      const { item, created } = store.add({
        symbol: sym.symbol,
        type: sym.type,
        name: sym.name ?? sym.symbol,
        ...(args.note ? { note: args.note } : {}),
        userId,
      })
      return {
        ok: true,
        summary: `已${created ? '添加' : '更新'}自选：${item.name}（${item.symbol}）`,
        detail: `自选总数：${store.count(userId)}${item.note ? `\n备注：${item.note}` : ''}\n自选列表已同步。`,
      }
    }

    // remove：先本地定位（支持带/不带交易所前缀），审批后删除
    const raw = args.symbol.trim()
    const items = store.list(userId)
    const resolved = await resolveFinSymbol(guard.gateway, raw)
    const candidates = resolved.ok ? [resolved.symbol.symbol, raw] : [raw]
    const hit = items.find((item) => candidates.includes(item.symbol)) ?? items.find((item) => item.symbol.endsWith(raw))
    if (!hit) {
      return { ok: false, summary: `自选列表中不存在「${raw}」（先用 action=list 查看当前列表）` }
    }
    const approval = await approveWrite(ctx, '移出自选列表', `将从自选列表移除：${hit.name}（${hit.symbol}）`)
    if (!approval.ok) return approval.result
    const removed = store.remove(hit.symbol, userId)
    return removed
      ? { ok: true, summary: `已移除自选：${hit.name}（${hit.symbol}）`, detail: `自选剩余：${store.count(userId)} 条` }
      : { ok: false, summary: `移除失败：「${hit.symbol}」可能已被删除` }
  },
}

// ---------------------------------------------------------------- 导出

/** 量化类 6 工具（注册进 createToolRegistry；FINANCE_ENABLED=true 时才有意义） */
export function createFinanceQuantTools(cfg: AppConfig): AgentTool[] {
  return [createFinScreenTool(cfg), createFinBacktestTool(cfg), createFinStrategyTool(cfg), createFinStatsTool(cfg), createFinGameTool(cfg), finWatchTool]
}

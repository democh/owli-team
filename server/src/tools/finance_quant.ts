/**
 * M34 金融工具集（§5.1）：量化类 4 工具 —— fin_screen / fin_backtest / fin_game / fin_watch。
 *
 * - fin_screen：全市场筛选（网关底表 10 分钟缓存 → screen.ts 纯计算 → 快照）；
 * - fin_backtest：策略回测（backtest.ts 唯一引擎 → 快照；执行口径"信号次根开盘成交"）；
 * - fin_game：多空博弈推演（game 引擎 → 快照 → game 块模板；固定声明"模型推演，非预测"）；
 * - fin_watch：自选列表（写操作审批门 + FinanceStore；全局单表）。
 */
import { z } from 'zod'
import type { AppConfig } from '../config.js'
import { BACKTEST_DEFAULT_PARAMS, BACKTEST_TEMPLATES, DEFAULT_FEE_RATE, DEFAULT_SLIPPAGE, runBacktest } from '../finance/backtest.js'
import { buildGameSnapshot, gameSnapshotFilename, MODEL_LABELS, runGame, type GameStatValue } from '../finance/game/index.js'
import { describeScreenCondition, screenRows, SCREEN_FIELDS, type ScreenCondition, type ScreenOrderBy } from '../finance/screen.js'
import { backtestSnapshotFilename, screenSnapshotFilename, writeJsonSnapshot, type BacktestSnapshot, type ScreenSnapshot } from '../finance/snapshot.js'
import type { ScreenRow } from '../finance/types.js'
import type { AssetType } from '../finance/symbol.js'
import type { AgentTool, ToolResult, ToolRuntime } from './registry.js'
import {
  approveWrite,
  errorText,
  financeGuard,
  fmtAmount,
  fmtAsOf,
  fmtNum,
  fmtPct,
  gameBlockTemplate,
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
      `策略回测（Node 自研引擎，唯一口径）：5 个模板 —— ma-cross（均线交叉，params fast/slow）、rsi-reversal（超卖回升买，period/oversold/overbought）、macd-cross（金叉死叉，fast/slow/signal）、boll-breakout（上轨突破买/下轨离场，period/mult）、buy-hold（买入持有基准）。执行口径：第 i 根收盘信号 → 第 i+1 根开盘成交（避免未来函数）；全仓多头；成本默认单边费率 ${DEFAULT_FEE_RATE}% + 滑点 ${DEFAULT_SLIPPAGE}%。${TEMPLATE_DEFAULTS_NOTE}策略验证必须用本工具（禁止用收益数字估算代替）。`,
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '标的（代码 / sh600519 / 名称）' },
        template: { type: 'string', enum: [...BACKTEST_TEMPLATES], description: '策略模板' },
        params: { type: 'object', description: `模板参数（如 {"fast":5,"slow":20}）；缺省用模板默认值` },
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
          { template: args.template, ...(args.params ? { params: args.params } : {}) },
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

/** 量化类 4 工具（注册进 createToolRegistry；FINANCE_ENABLED=true 时才有意义） */
export function createFinanceQuantTools(cfg: AppConfig): AgentTool[] {
  return [createFinScreenTool(cfg), createFinBacktestTool(cfg), createFinGameTool(cfg), finWatchTool]
}

/**
 * M34：金融投研路由（挂载于 /api 之下；设计见 docs/finance-invest-design.md；M83 增分析与策略端点）。
 *
 * - GET    /finance/env：环境与数据源健康度（Python 桥探测 / 反爬冷却可视 / 运行参数回显）
 * - GET    /finance/watchlist：自选列表（sort 升序；全局单表跨会话共享）
 * - POST   /finance/watchlist：添加 / 更新自选（symbol 唯一 upsert；经网关归一化）
 * - DELETE /finance/watchlist/:symbol：移除自选
 * - GET    /finance/quote：批量实时行情（symbols 逗号分隔 ≤50；未识别标的单列返回）
 * - GET    /finance/kline：K 线 + 技术指标序列（K 线块 / 画布节点图表数据源）
 * - GET    /finance/analysis：K 线智能分析（M83：阶段 / 情绪 / 关键位 / 特征；客户端直连）
 * - POST   /finance/strategy/lint：DSL 静态检查（M83；免取数）
 * - POST   /finance/strategy/run：DSL 执行（M83；输出 signal / drawings / facts）
 * - GET    /finance/strategy/meta：DSL 元数据（M83；编辑器联想 / 文档）
 * - GET    /finance/search：标的检索（代码 / 名称 / 拼音）
 * - GET    /finance/news：个股公告 / 市场快讯
 * - POST   /finance/game：多空博弈推演（纯计算可复现；paths 受 FINANCE_GAME_MAX_PATHS 护栏）
 *
 * 未装配 FinanceGateway（FINANCE_ENABLED=false）时统一 503；上游数据源全失败 502（与 canvas 路由上游失败语义一致）。
 * 反爬联动：来源连续失败进入冷却后由网关自动跳过（路由层无感）；冷却状态经 GET /finance/env 透出
 * （cooling / cooldownUntil / lastError），便于「数据变慢/降级」时排查是否触发风控。
 */
import { Router } from 'express'
import type { Request, Response } from 'express'
import type { AuthUser } from '../auth/service.js'
import { z } from 'zod'
import { KLINE_RENDER_INDICATORS } from '@multi-agent/shared'
import { analyzeKline } from '../finance/analysis/index.js'
import { probePython } from '../finance/bridge/probe.js'
import { DslExprError } from '../finance/dsl/expr.js'
import { runDsl } from '../finance/dsl/exec.js'
import { buildDslMeta } from '../finance/dsl/meta.js'
import { parseDsl } from '../finance/dsl/spec.js'
import { GAME_MODELS, GameError, MODEL_LABELS, runGame } from '../finance/game/index.js'
import type { IndicatorName, IndicatorSeries } from '../finance/indicator.js'
import { ADJUSTS, PERIODS } from '../finance/period.js'
import { ASSET_TYPES, type AssetType, type FinSymbol } from '../finance/symbol.js'
import { errorText, resolveFinSymbol, TYPE_LABELS } from '../tools/finance_shared.js'
import type { ApiDeps } from './index.js'

/** 服务端可算指标（VOL 由渲染端从 bars.volume 绘制，不入计算） */
const INDICATOR_NAMES = ['MA', 'EMA', 'MACD', 'RSI', 'KDJ', 'BOLL', 'ATR'] as const
/** 渲染面板可用指标（含前端计算项；单源 shared：主图 8 + 副图 5） */
const RENDER_INDICATORS = KLINE_RENDER_INDICATORS
/** 默认指标面板（与 fin_kline 工具默认一致） */
const DEFAULT_RENDER_INDICATORS = ['MA', 'VOL']

/** DSL 源码上限（与 finance/dsl/spec.ts 护栏一致） */
const DSL_MAX = 20 * 1024

const sourcePref = z.enum(['auto', 'node', 'py']).default('auto')

const quoteQuery = z.object({
  /** 逗号分隔（如 sh600519,sz159915）；支持代码 / 名称，≤50 */
  symbols: z.string().min(1),
  source: sourcePref,
})

const klineQuery = z.object({
  symbol: z.string().min(1),
  period: z.enum(PERIODS).default('day'),
  adjust: z.enum(ADJUSTS).default('qfq'),
  limit: z.coerce.number().int().min(5).max(500).default(250),
  /** 逗号分隔指标面板（缺省 MA,VOL） */
  indicators: z.string().optional(),
  source: sourcePref,
})

const searchQuery = z.object({
  q: z.string().min(1).max(40),
  type: z.enum(ASSET_TYPES).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
})

const newsQuery = z.object({
  symbol: z.string().min(1).max(40).optional(),
  market: z.string().min(1).max(20).optional(),
  limit: z.coerce.number().int().min(1).max(20).default(10),
  since: z.string().min(1).optional(),
  source: sourcePref,
})

const watchAddBody = z.object({
  symbol: z.string().min(1).max(40),
  note: z.string().max(120).optional(),
  /** 显式品种（消歧：000001 = 平安银行 / 上证指数 / 场外基金） */
  type: z.enum(ASSET_TYPES).optional(),
})

const gameBody = z.object({
  action: z.enum(GAME_MODELS),
  topic: z.string().min(1).max(80),
  symbol: z.string().max(40).optional(),
  params: z.record(z.unknown()).optional(),
  seed: z.number().int().min(0).optional(),
})

// M83：分析与策略

const analysisQuery = z.object({
  symbol: z.string().min(1),
  period: z.enum(PERIODS).default('day'),
  adjust: z.enum(ADJUSTS).default('qfq'),
  limit: z.coerce.number().int().min(60).max(500).default(250),
  source: sourcePref,
})

const strategyLintBody = z.object({
  dsl: z.string().min(1).max(DSL_MAX),
})

const strategyRunBody = z.object({
  dsl: z.string().min(1).max(DSL_MAX),
  symbol: z.string().min(1),
  period: z.enum(PERIODS).default('day'),
  adjust: z.enum(ADJUSTS).default('qfq'),
  limit: z.coerce.number().int().min(30).max(500).default(250),
  inputs: z.record(z.union([z.number(), z.string().max(200), z.boolean()])).optional(),
  source: sourcePref,
})

export function createFinanceRouter(deps: ApiDeps): Router {
  const router = Router()

  const userOf = (req: Request): AuthUser | undefined => (req as Request & { user?: AuthUser }).user
  /** M57：自选 / 环境回显的用户口径（'' = 单用户兼容模式） */
  const watchUserIdOf = (req: Request): string => userOf(req)?.id ?? ''

  const requireFinance = (res: Response): boolean => {
    if (!deps.finance || !deps.financeStore) {
      res.status(503).json({ error: '金融数据未启用（FINANCE_ENABLED=false 或网关未装配）' })
      return false
    }
    return true
  }

  /** zod 校验失败 → 400（中文路径 + 消息，与 schedules 路由同模式；Input=unknown 使 T 取输出类型） */
  const parseOr400 = <T>(res: Response, schema: z.ZodType<T, z.ZodTypeDef, unknown>, raw: unknown, label: string): T | undefined => {
    const parsed = schema.safeParse(raw ?? {})
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      res.status(400).json({ error: `${label}参数非法：${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}` })
      return undefined
    }
    return parsed.data
  }

  /** 上游数据源全失败 → 502（降级链在网关内完成，此处即最终失败） */
  const upstreamError = (res: Response, err: unknown, label: string): void => {
    res.status(502).json({ error: `${label}失败：${errorText(err)}` })
  }

  // ---------------------------------------------------------------- 环境与健康度

  router.get('/finance/env', async (req, res) => {
    if (!requireFinance(res)) return
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true'
    const probeOpts = {
      ...(deps.cfg.financePython ? { python: deps.cfg.financePython } : {}),
      ...(refresh ? { force: true } : {}),
    }
    const py = deps.financeProbe ? await deps.financeProbe(probeOpts) : await probePython(probeOpts)
    res.json({
      enabled: true,
      py,
      /** 数据源健康度（反爬联动：冷却中的源被路由跳过） */
      health: deps.finance!.health(),
      // M57：自选按用户（多用户；单用户兼容模式 '' 口径）
      watchlistCount: deps.financeStore!.count(watchUserIdOf(req)),
      settings: {
        quoteRefreshMs: deps.cfg.financeQuoteRefreshMs,
        minIntervalMs: deps.cfg.financeMinIntervalMs,
        snapshotDir: deps.cfg.financeKlineSnapshotDir,
        gameMaxPaths: deps.cfg.financeGameMaxPaths,
        gameSeed: deps.cfg.financeGameSeed,
      },
    })
  })

  // ---------------------------------------------------------------- 自选列表

  router.get('/finance/watchlist', (req, res) => {
    if (!requireFinance(res)) return
    res.json({ items: deps.financeStore!.list(watchUserIdOf(req)) })
  })

  router.post('/finance/watchlist', async (req, res) => {
    if (!requireFinance(res)) return
    const body = parseOr400(res, watchAddBody, req.body, '自选')
    if (!body) return
    const resolved = await resolveFinSymbol(
      deps.finance!,
      body.symbol,
      body.type ? { type: body.type as AssetType } : {},
    )
    if (!resolved.ok) {
      return res.status(400).json({
        error: resolved.result.summary,
        ...(resolved.result.detail ? { detail: resolved.result.detail } : {}),
      })
    }
    const sym = resolved.symbol
    const { item, created } = deps.financeStore!.add({
      symbol: sym.symbol,
      type: sym.type,
      name: sym.name ?? sym.symbol,
      ...(body.note ? { note: body.note } : {}),
      // M57：按用户归属
      userId: watchUserIdOf(req),
    })
    res.json({
      item,
      created,
      label: `${item.name}（${item.symbol}｜${TYPE_LABELS[item.type as AssetType] ?? item.type}）`,
    })
  })

  router.delete('/finance/watchlist/:symbol', (req, res) => {
    if (!requireFinance(res)) return
    const userId = watchUserIdOf(req)
    const raw = req.params.symbol.trim()
    const items = deps.financeStore!.list(userId)
    let hit = items.find((item) => item.symbol === raw)
    if (!hit) {
      // 容错：前端传 6 位代码（sh600519 → 600519）；命中多条要求完整 symbol
      const matches = items.filter((item) => item.symbol.endsWith(raw))
      if (matches.length > 1) {
        return res.status(400).json({ error: `「${raw}」命中多条自选（${matches.map((i) => i.symbol).join('、')}），请使用完整 symbol` })
      }
      hit = matches[0]
    }
    if (!hit) return res.status(404).json({ error: `自选列表中不存在「${raw}」` })
    deps.financeStore!.remove(hit.symbol, userId)
    res.json({ ok: true, removed: hit })
  })

  // ---------------------------------------------------------------- 行情 / K 线 / 检索 / 新闻

  router.get('/finance/quote', async (req, res) => {
    if (!requireFinance(res)) return
    const query = parseOr400(res, quoteQuery, req.query, '行情')
    if (!query) return
    const raws = query.symbols
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (raws.length === 0) return res.status(400).json({ error: 'symbols 不能为空（逗号分隔，如 sh600519,sz159915）' })
    if (raws.length > 50) return res.status(400).json({ error: `symbols 单次最多 50 支（收到 ${raws.length}）` })

    const gateway = deps.finance!
    const syms: FinSymbol[] = []
    const unresolved: string[] = []
    for (const raw of raws) {
      const resolved = await resolveFinSymbol(gateway, raw)
      if (resolved.ok) {
        if (!syms.some((s) => s.symbol === resolved.symbol.symbol)) syms.push(resolved.symbol)
      } else {
        unresolved.push(raw)
      }
    }
    if (syms.length === 0) {
      return res.status(400).json({ error: `全部标的未能识别：${unresolved.join('、')}（可先用 /finance/search 检索）` })
    }
    try {
      const result = await gateway.quote(syms, { source: query.source })
      res.json({
        quotes: result.data,
        unresolved,
        source: result.source,
        asOf: result.asOf,
        ...(result.cache ? { cache: result.cache } : {}),
        ...(result.degraded ? { degraded: result.degraded } : {}),
      })
    } catch (err) {
      upstreamError(res, err, '行情获取')
    }
  })

  router.get('/finance/kline', async (req, res) => {
    if (!requireFinance(res)) return
    const query = parseOr400(res, klineQuery, req.query, 'K 线')
    if (!query) return

    const renderList = (query.indicators ?? DEFAULT_RENDER_INDICATORS.join(','))
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
    const invalid = renderList.filter((name) => !(RENDER_INDICATORS as readonly string[]).includes(name))
    if (invalid.length > 0) {
      return res.status(400).json({ error: `指标不支持：${invalid.join('、')}（可选 ${RENDER_INDICATORS.join('/')}）` })
    }
    const render = [...new Set(renderList)]
    const computable = render.filter((name) => (INDICATOR_NAMES as readonly string[]).includes(name)) as IndicatorName[]

    const gateway = deps.finance!
    const resolved = await resolveFinSymbol(gateway, query.symbol)
    if (!resolved.ok) {
      return res.status(400).json({
        error: resolved.result.summary,
        ...(resolved.result.detail ? { detail: resolved.result.detail } : {}),
      })
    }

    try {
      const result = await gateway.kline(resolved.symbol, query.period, query.adjust, query.limit, { source: query.source })
      const bars = result.data.bars
      if (bars.length === 0) return res.status(502).json({ error: 'K 线数据为空（源未覆盖该标的或周期）' })

      // 指标逐项计算（Node 纯计算；单项失败不影响 K 线主体返回）
      const indicators: IndicatorSeries[] = []
      const warnings: string[] = []
      for (const name of computable) {
        try {
          const series = await gateway.indicator(name, bars, {}, { source: query.source })
          indicators.push(series.data)
        } catch (err) {
          warnings.push(`${name} 指标计算失败：${errorText(err)}`)
        }
      }

      res.json({
        kline: result.data,
        indicators,
        render,
        ...(warnings.length > 0 ? { warnings } : {}),
        cache: result.cache,
        ...(result.degraded ? { degraded: result.degraded } : {}),
      })
    } catch (err) {
      upstreamError(res, err, 'K 线获取')
    }
  })

  router.get('/finance/search', async (req, res) => {
    if (!requireFinance(res)) return
    const query = parseOr400(res, searchQuery, req.query, '检索')
    if (!query) return
    try {
      const result = await deps.finance!.search(query.q, { limit: query.limit })
      let rows = result.data
      if (query.type) rows = rows.filter((row) => row.type === query.type)
      res.json({
        rows,
        source: result.source,
        asOf: result.asOf,
        ...(result.cache ? { cache: result.cache } : {}),
        ...(result.degraded ? { degraded: result.degraded } : {}),
      })
    } catch (err) {
      upstreamError(res, err, '标的检索')
    }
  })

  router.get('/finance/news', async (req, res) => {
    if (!requireFinance(res)) return
    const query = parseOr400(res, newsQuery, req.query, '新闻')
    if (!query) return
    const gateway = deps.finance!
    let symbol: string | undefined
    if (query.symbol) {
      const resolved = await resolveFinSymbol(gateway, query.symbol)
      if (!resolved.ok) {
        return res.status(400).json({
          error: resolved.result.summary,
          ...(resolved.result.detail ? { detail: resolved.result.detail } : {}),
        })
      }
      symbol = resolved.symbol.symbol
    }
    try {
      const result = await gateway.news({
        ...(symbol ? { symbol } : {}),
        ...(query.market ? { market: query.market } : {}),
        limit: query.limit,
        ...(query.since ? { since: query.since } : {}),
        source: query.source,
      })
      res.json({
        items: result.data,
        source: result.source,
        asOf: result.asOf,
        ...(result.cache ? { cache: result.cache } : {}),
        ...(result.degraded ? { degraded: result.degraded } : {}),
      })
    } catch (err) {
      upstreamError(res, err, '新闻获取')
    }
  })

  // ---------------------------------------------------------------- 分析与策略（M83）

  router.get('/finance/analysis', async (req, res) => {
    if (!requireFinance(res)) return
    const query = parseOr400(res, analysisQuery, req.query, '分析')
    if (!query) return
    const gateway = deps.finance!
    const resolved = await resolveFinSymbol(gateway, query.symbol)
    if (!resolved.ok) {
      return res.status(400).json({
        error: resolved.result.summary,
        ...(resolved.result.detail ? { detail: resolved.result.detail } : {}),
      })
    }
    try {
      const result = await gateway.kline(resolved.symbol, query.period, query.adjust, query.limit, { source: query.source })
      const bars = result.data.bars
      if (bars.length === 0) return res.status(502).json({ error: 'K 线数据为空（源未覆盖该标的或周期）' })
      const analysis = analyzeKline(bars, { period: query.period, adjust: query.adjust })
      res.json({
        analysis,
        symbol: resolved.symbol.symbol,
        name: result.data.name,
        source: result.source,
        asOf: result.asOf,
        ...(result.cache ? { cache: result.cache } : {}),
        ...(result.degraded ? { degraded: result.degraded } : {}),
      })
    } catch (err) {
      upstreamError(res, err, 'K 线分析')
    }
  })

  router.post('/finance/strategy/lint', (req, res) => {
    const body = parseOr400(res, strategyLintBody, req.body, '策略 lint')
    if (!body) return
    const parsed = parseDsl(body.dsl)
    res.json({ ok: parsed.ok, findings: parsed.findings, ...(parsed.ok ? { name: parsed.spec.name } : {}) })
  })

  router.post('/finance/strategy/run', async (req, res) => {
    if (!requireFinance(res)) return
    const body = parseOr400(res, strategyRunBody, req.body, '策略执行')
    if (!body) return
    const parsed = parseDsl(body.dsl)
    if (!parsed.ok) {
      return res.status(400).json({ error: 'DSL 校验未通过（先修正 findings 再执行）', findings: parsed.findings })
    }
    const gateway = deps.finance!
    const resolved = await resolveFinSymbol(gateway, body.symbol)
    if (!resolved.ok) {
      return res.status(400).json({
        error: resolved.result.summary,
        ...(resolved.result.detail ? { detail: resolved.result.detail } : {}),
      })
    }
    try {
      const result = await gateway.kline(resolved.symbol, body.period, body.adjust, body.limit, { source: body.source })
      const bars = result.data.bars
      if (bars.length === 0) return res.status(502).json({ error: 'K 线数据为空（源未覆盖该标的或周期）' })
      const run = runDsl(bars, parsed.spec, {
        symbol: resolved.symbol.symbol,
        period: body.period,
        adjust: body.adjust,
        ...(body.inputs ? { inputs: body.inputs } : {}),
      })
      res.json({
        result: run,
        source: result.source,
        asOf: result.asOf,
        ...(result.cache ? { cache: result.cache } : {}),
        ...(result.degraded ? { degraded: result.degraded } : {}),
      })
    } catch (err) {
      if (err instanceof DslExprError) return res.status(400).json({ error: `DSL 执行失败：${err.message}` })
      upstreamError(res, err, '策略执行')
    }
  })

  router.get('/finance/strategy/meta', (_req, res) => {
    res.json(buildDslMeta())
  })

  // ---------------------------------------------------------------- 博弈推演

  router.post('/finance/game', (req, res) => {
    if (!requireFinance(res)) return
    const body = parseOr400(res, gameBody, req.body, '博弈')
    if (!body) return
    const params: Record<string, unknown> = { ...(body.params ?? {}) }
    let capNote: string | undefined
    if (body.action === 'simulate' && typeof params.paths === 'number' && params.paths > deps.cfg.financeGameMaxPaths) {
      params.paths = deps.cfg.financeGameMaxPaths
      capNote = `paths 已按 FINANCE_GAME_MAX_PATHS 限制为 ${deps.cfg.financeGameMaxPaths}（计算护栏）`
    }
    const seed = body.seed ?? deps.cfg.financeGameSeed
    try {
      const result = runGame({
        action: body.action,
        topic: body.topic,
        ...(body.symbol ? { symbol: body.symbol } : {}),
        params,
        seed,
      })
      res.json({
        ...result,
        modelLabel: MODEL_LABELS[result.model],
        ...(capNote ? { note: capNote } : {}),
      })
    } catch (err) {
      if (err instanceof GameError) return res.status(400).json({ error: err.message })
      res.status(500).json({ error: `博弈推演失败：${errorText(err)}` })
    }
  })

  return router
}

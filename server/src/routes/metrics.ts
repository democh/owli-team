/**
 * 指标接口（M5 / M9）：
 * - GET /metrics/tools   —— 工具执行观测（次数 / 失败率 / 平均耗时）
 * - GET /metrics/summary —— 全局汇总（回合数 / token / 费用 / 压缩次数 / 平均回合耗时 / 好评率）
 * 数据源：run_events（回合与压缩统计）+ usage（token/费用）+ tool_metrics（工具）+ feedback（反馈）。
 */
import { Router } from 'express'
import type { MetricsSummary } from '@multi-agent/shared'
import type { ApiDeps } from './index.js'

export function createMetricsRouter(deps: ApiDeps): Router {
  const router = Router()

  // GET /api/metrics/tools?sinceMs=3600000 → 按工具聚合（缺省全量）
  router.get('/metrics/tools', (req, res) => {
    const sinceMs = Number(req.query.sinceMs)
    const rows = deps.metrics.summary(Number.isFinite(sinceMs) && sinceMs > 0 ? sinceMs : undefined)
    res.json({ tools: rows })
  })

  // GET /api/metrics/summary?sinceMs= → 全局指标
  router.get('/metrics/summary', (req, res) => {
    const sinceMs = Number(req.query.sinceMs)
    const window = Number.isFinite(sinceMs) && sinceMs > 0 ? sinceMs : undefined
    const events = deps.events.stats(window)
    const usage = deps.usage.summary(window)
    const tools = deps.metrics.summary(window)
    const toolCalls = tools.reduce((n, t) => n + t.calls, 0)
    const toolFailures = tools.reduce((n, t) => n + t.failures, 0)
    const summary: MetricsSummary = {
      runs: events.runs,
      turns: events.turns,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      costUsd: Math.round(usage.costUsd * 1_000_000) / 1_000_000,
      compressions: events.compressions,
      toolCalls,
      toolFailures,
      avgTurnMs: events.avgTurnMs,
    }
    res.json({ summary, byKind: usage.byKind, tools, feedback: deps.feedback.stats(window) })
  })

  return router
}

/**
 * 指标接口（M5 / M9 / M61）：
 * - GET /metrics/tools      —— 工具执行观测（次数 / 失败率 / 平均耗时）
 * - GET /metrics/summary    —— 全局汇总（回合数 / token / 费用 / 压缩次数 / 平均回合耗时 / 好评率）
 * - GET /metrics/scheduling —— 调度健康聚合（M61-D6：路由 / 波次 / 抑制 / 冲突 / 接单）
 * 数据源：run_events（回合与压缩统计 / 调度轨迹）+ usage（token/费用）+ tool_metrics（工具）+ feedback（反馈）。
 */
import { Router } from 'express'
import type { AgentMetric, MetricsSummary } from '@multi-agent/shared'
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

  // GET /api/metrics/agents?sinceMs= → 角色级质量指标（M89）
  router.get('/metrics/agents', (req, res) => {
    const sinceMs = Number(req.query.sinceMs)
    const window = Number.isFinite(sinceMs) && sinceMs > 0 ? sinceMs : undefined
    const usage = new Map(deps.usage.byAgent(window).map((row) => [row.agentId, row]))
    const tools = new Map(deps.metrics.agentSummary(window).map((row) => [row.agentId, row]))
    const steps = new Map((deps.plans?.stepStatsByAgent(window) ?? []).map((row) => [row.agentId, row]))
    const reviews = new Map((deps.reviews?.statsByAgent(window) ?? []).map((row) => [row.agentId, row]))
    const ids = new Set<string>([...usage.keys(), ...tools.keys(), ...steps.keys(), ...reviews.keys()])
    const agents: AgentMetric[] = [...ids]
      .map((agentId) => {
        const u = usage.get(agentId)
        const t = tools.get(agentId)
        const s = steps.get(agentId)
        const r = reviews.get(agentId)
        return {
          agentId,
          turns: u?.calls ?? 0,
          promptTokens: u?.promptTokens ?? 0,
          completionTokens: u?.completionTokens ?? 0,
          costUsd: u?.costUsd ?? 0,
          toolCalls: t?.calls ?? 0,
          toolFailures: t?.failures ?? 0,
          planStepsDone: s?.done ?? 0,
          planStepsBlocked: s?.blocked ?? 0,
          reviews: r?.reviews ?? 0,
          reviewFails: r?.fails ?? 0,
        }
      })
      // 默认按模型调用量倒序（最重的角色在最上方）
      .sort((a, b) => b.turns - a.turns || b.toolCalls - a.toolCalls)
    res.json({ agents })
  })

  // GET /api/metrics/scheduling?sinceMs= → 调度健康聚合（M61-D6）
  router.get('/metrics/scheduling', (req, res) => {
    const sinceMs = Number(req.query.sinceMs)
    const window = Number.isFinite(sinceMs) && sinceMs > 0 ? sinceMs : undefined
    res.json({ scheduling: deps.events.schedulingStats(window) })
  })

  return router
}

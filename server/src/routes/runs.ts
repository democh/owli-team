import { Router } from 'express'
import { initSse, startSseHeartbeat } from '../sse.js'
import { approvalDecisionSchema, firstIssue, queueOrderSchema } from './schemas.js'
import type { ApiDeps } from './index.js'

/** 运行流（SSE 重附着）+ 停止 + 通知降级轮询（§18） */
export function createRunsRouter(deps: ApiDeps): Router {
  const router = Router()

  /** 订阅 / 重附着运行流：先快照重放再续流（§18.2） */
  router.get('/runs/:runId/stream', (req, res) => {
    const { runId } = req.params
    if (!deps.engine.hasRun(runId)) {
      return res.status(404).json({ error: '运行不存在或已结束，可刷新会话查看结果' })
    }
    initSse(res)
    const stopHeartbeat = startSseHeartbeat(res)
    const unsubscribe = deps.engine.attach(runId, res)
    req.on('close', () => {
      stopHeartbeat()
      unsubscribe?.()
    })
  })

  router.post('/runs/:runId/stop', (req, res) => {
    const ok = deps.engine.stop(req.params.runId)
    res.json({ ok })
  })

  /** M14：指挥台重排队列 —— 仅调整未出手顺序（当前发言人不受影响），广播 queue:updated */
  router.post('/runs/:runId/queue', (req, res) => {
    const parsed = queueOrderSchema.safeParse(req.body ?? {})
    if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) })
    try {
      res.json(deps.engine.reorderQueue(req.params.runId, parsed.data.agentIds))
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  /**
   * M4：继续生成——续写已中断（stopped / error）的 Agent 消息。
   * 以持久化 Run 反查所属会话（原 Run 可能已从内存移除）。
   */
  router.post('/runs/:runId/messages/:messageId/resume', (req, res) => {
    const run = deps.runs.get(req.params.runId)
    const message = run ? deps.sessions.messageById(run.sessionId, req.params.messageId) : undefined
    if (!run || !message) return res.status(404).json({ error: '消息不存在' })
    try {
      const result = deps.engine.resumeMessage(run.sessionId, message.id)
      res.status(202).json({ accepted: true, ...result })
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  /** M8：重新生成——以相同上下文重跑某条 Agent 消息（仅文本，不重放工具副作用） */
  router.post('/runs/:runId/messages/:messageId/regenerate', (req, res) => {
    const run = deps.runs.get(req.params.runId)
    const message = run ? deps.sessions.messageById(run.sessionId, req.params.messageId) : undefined
    if (!run || !message) return res.status(404).json({ error: '消息不存在' })
    try {
      const result = deps.engine.regenerateMessage(run.sessionId, message.id)
      res.status(202).json({ accepted: true, ...result })
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  /** M8：本 Run 用量汇总（顶部用量条「本 Run 费用」） */
  router.get('/runs/:runId/usage', (req, res) => {
    res.json({ usage: deps.usage.sumByRun(req.params.runId) })
  })

  /** M9：Run 全链路轨迹（trace 抽屉数据源：回合/工具/压缩/调度事件） */
  router.get('/runs/:runId/trace', (req, res) => {
    const run = deps.runs.get(req.params.runId)
    if (!run) return res.status(404).json({ error: '运行记录不存在' })
    const limit = Number(req.query.limit)
    const events = deps.events.listByRun(req.params.runId, Number.isFinite(limit) && limit > 0 ? limit : 500)
    res.json({ run, events, usage: deps.usage.sumByRun(req.params.runId) })
  })

  router.get('/runs/active', (_req, res) => {
    res.json({ runs: deps.engine.listActiveRuns() })
  })

  /**
   * M7：审批决定——批准 / 拒绝 / 自定义反馈（custom 必须附 feedback）。
   * 决策后引擎侧 Promise 恢复，工具继续执行（批准）或回灌可修正反馈（拒绝）。
   */
  router.post('/runs/:runId/approvals/:approvalId', (req, res) => {
    const parsed = approvalDecisionSchema.safeParse(req.body ?? {})
    if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) })
    const { decision, feedback } = parsed.data
    if (decision === 'custom' && !feedback?.trim()) {
      return res.status(400).json({ error: 'custom 决策需附 feedback（修改意见）' })
    }
    const approval = deps.approvals.decide(req.params.runId, req.params.approvalId, decision, feedback)
    if (!approval) return res.status(404).json({ error: '审批不存在或已处理' })
    res.json({ approval })
  })

  /** M7：某 Run 的审批列表（挂起 + 历史；SSE 重附着时恢复审批卡状态） */
  router.get('/runs/:runId/approvals', (req, res) => {
    res.json({ approvals: deps.approvals.forRun(req.params.runId) })
  })

  /** WS 降级轮询：同一 NotificationCenter（§18.6） */
  router.get('/notifications', (req, res) => {
    const since = Number(req.query.since ?? 0)
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined
    res.json(deps.notify.list(sessionId, Number.isFinite(since) ? since : 0))
  })

  return router
}

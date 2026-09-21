import { Router } from 'express'
import type { Request } from 'express'
import { initSse, startSseHeartbeat } from '../sse.js'
import type { AuthUser } from '../auth/service.js'
import { approvalDecisionSchema, firstIssue, queueOrderSchema } from './schemas.js'
import type { ApiDeps } from './index.js'

/**
 * M79-AF：轮询游标参数解析（`?cursors=<encodeURIComponent(JSON)>`；JSON `{sessionId: seq}`）。
 * 防御式：非字符串 / 非对象 / 非数值一律忽略（缺省回退全量语义，兜底安全）。
 */
function parseCursorsParam(raw: unknown): Record<string, number> | undefined {
  if (typeof raw !== 'string' || !raw) return undefined
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = v
    }
    return Object.keys(out).length > 0 ? out : undefined
  } catch {
    return undefined
  }
}

/** 运行流（SSE 重附着）+ 停止 + 通知降级轮询（§18） */
export function createRunsRouter(deps: ApiDeps): Router {
  const router = Router()

  /**
   * M79-AF：审批可见性 / 操作权统一判定 —— 本 Run 触发者 ∪ 会话属主。
   * 触发者缺失（兼容模式 / 历史直调）→ 放行（行为与旧版零差异）。
   * admin 对无权会话由守卫 404 前置拦截（M79-G 隐私语义，无归属旁路）。
   * 与 WS 推送（publishApprovalFrame 定向）、SSE（engine.canSeeApproval）同一口径。
   */
  const canHandleApproval = (runId: string, req: Request): boolean => {
    if (!deps.access.multiUser) return true
    const user = (req as Request & { user?: AuthUser }).user
    if (!user) return true
    const triggerId = deps.engine.triggerUserIdOf(runId)
    if (!triggerId || triggerId === user.id) return true
    const sessionId =
      deps.engine.listActiveRuns().find((r) => r.runId === runId)?.sessionId ??
      deps.runs.get(runId)?.sessionId
    return !!sessionId && deps.access.sessionRole(user, sessionId) === 'owner'
  }

  /** 订阅 / 重附着运行流：先快照重放再续流（§18.2）；M79-AF：订阅带身份（审批 SSE 定向过滤） */
  router.get('/runs/:runId/stream', (req, res) => {
    const { runId } = req.params
    if (!deps.engine.hasRun(runId)) {
      return res.status(404).json({ error: '运行不存在或已结束，可刷新会话查看结果' })
    }
    initSse(res)
    const stopHeartbeat = startSseHeartbeat(res)
    const user = (req as Request & { user?: AuthUser }).user
    const unsubscribe = deps.engine.attach(runId, res, user?.id)
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

  /** M8：本 Run 用量汇总（底栏上下文电池「本 Run 费用」） */
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

  router.get('/runs/active', (req, res) => {
    // M57：仅返回本人可见会话的活跃 Run
    const user = (req as Request & { user?: AuthUser }).user
    res.json({
      runs: deps.engine.listActiveRuns().filter((run) => deps.access.canAccessSession(user, run.sessionId)),
    })
  })

  /**
   * M7：审批决定——批准 / 拒绝 / 自定义反馈（custom 必须附 feedback）。
   * 决策后引擎侧 Promise 恢复，工具继续执行（批准）或回灌可修正反馈（拒绝）。
   * M79-AF：操作口径 = 本 Run 触发者 ∪ 会话属主（与审批推送定向一致；viewer 已由守卫 403）。
   * 触发者缺失（兼容模式 / 历史直调）→ 放行（行为与旧版零差异）。
   */
  router.post('/runs/:runId/approvals/:approvalId', (req, res) => {
    const parsed = approvalDecisionSchema.safeParse(req.body ?? {})
    if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) })
    const { decision, feedback } = parsed.data
    if (decision === 'custom' && !feedback?.trim()) {
      return res.status(400).json({ error: 'custom 决策需附 feedback（修改意见）' })
    }
    // M57：决策人归因（多用户审计）
    const approver = (req as Request & { user?: AuthUser }).user
    // M79-AF：审批定向复核——非触发者且非属主 → 403（与推送 / SSE / 读面同一口径）
    if (!canHandleApproval(req.params.runId, req)) {
      return res.status(403).json({ error: '审批仅由发起本轮的成员或会话属主处理' })
    }
    const approval = deps.approvals.decide(req.params.runId, req.params.approvalId, decision, feedback, approver?.id)
    if (!approval) return res.status(404).json({ error: '审批不存在或已处理' })
    res.json({ approval })
  })

  /** M7：某 Run 的审批列表（挂起 + 历史；SSE 重附着时恢复审批卡状态）— M79-AF：非触发者/非属主返回空 */
  router.get('/runs/:runId/approvals', (req, res) => {
    if (!canHandleApproval(req.params.runId, req)) {
      return res.json({ approvals: [] })
    }
    res.json({ approvals: deps.approvals.forRun(req.params.runId) })
  })

  /**
   * WS 降级轮询：同一 NotificationCenter（§18.6）；M57：仅返回本人可见会话的事件（全局主题仅 admin）。
   * M79-AF：可选 `cursors`（JSON `{sessionId: seq}`）——客户端携带 per-session 游标只拉增量；
   * 非法 / 缺省回退全量（since 语义），防御式解析（非对象 / 非数值一律忽略）。
   */
  router.get('/notifications', (req, res) => {
    const since = Number(req.query.since ?? 0)
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined
    const cursors = parseCursorsParam(req.query.cursors)
    const result = deps.notify.list(sessionId, Number.isFinite(since) ? since : 0, cursors)
    const user = (req as Request & { user?: AuthUser }).user
    const isAdminUser = !deps.access.multiUser || user?.role === 'admin'
    const visible = deps.access.visibleSessionIds(user)
    const notifications = result.notifications.filter((env) =>
      env.sessionId.startsWith('__')
        ? isAdminUser
        : visible === undefined || visible.has(env.sessionId),
    )
    res.json({ ...result, notifications })
  })

  return router
}

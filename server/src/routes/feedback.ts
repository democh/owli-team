/**
 * 反馈接口（M9）：👍/👎 + 原因落 feedback 表；导出为评测候选集。
 * - POST /api/feedback           写入/覆盖（同 messageId 覆盖）
 * - GET  /api/feedback?messageId= 单条查询（前端已反馈状态）
 * - GET  /api/feedback/export     导出（评测数据集来源）
 */
import { Router } from 'express'
import { feedbackSchema, firstIssue } from './schemas.js'
import type { ApiDeps } from './index.js'

export function createFeedbackRouter(deps: ApiDeps): Router {
  const router = Router()

  router.post('/feedback', (req, res) => {
    const parsed = feedbackSchema.safeParse(req.body ?? {})
    if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) })
    const item = deps.feedback.add(parsed.data)
    res.status(201).json({ item })
  })

  router.get('/feedback', (req, res) => {
    const messageId = String(req.query.messageId ?? '')
    if (messageId) {
      const item = deps.feedback.getByMessage(messageId)
      return res.json({ item: item ?? null })
    }
    const sinceMs = Number(req.query.sinceMs)
    res.json({ items: deps.feedback.listAll(Number.isFinite(sinceMs) && sinceMs > 0 ? sinceMs : undefined) })
  })

  router.get('/feedback/export', (req, res) => {
    const sinceMs = Number(req.query.sinceMs)
    const items = deps.feedback.listAll(Number.isFinite(sinceMs) && sinceMs > 0 ? sinceMs : undefined)
    res.json({ exportedAt: new Date().toISOString(), count: items.length, items })
  })

  return router
}

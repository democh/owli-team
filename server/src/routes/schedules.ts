/**
 * M35：定时任务路由（挂载于 /api 之下；设计见 design.md §50）。
 * - GET    /sessions/:id/schedules：会话任务清单（按 next_run_at 排序）
 * - POST   /sessions/:id/schedules：创建（规格校验 / 上限 / 成员校验在 ScheduleService 收口）
 * - PATCH  /schedules/:id：部分更新（仅文案变化不打乱调度节奏；spec 变化全量重校验）
 * - DELETE /schedules/:id：删除
 * - POST   /schedules/:id/run：立即触发一次（不推进调度；会话忙报错）
 * - POST   /schedules/:id/pause | /resume：启停（resume 重算 next 并重置失败计数）
 * 未装配 ScheduleService 时统一 503（与 MCP / 媒体路由未装配语义一致）。
 * 变更经 notify:schedule-changed 广播；提醒触发经 notify:schedule-reminder 广播。
 */
import { Router } from 'express'
import { z } from 'zod'
import type { ApiDeps } from './index.js'

const SpecSchema = z.object({
  kind: z.enum(['once', 'cron']),
  /** kind='once'：绝对触发时刻（ISO，含时区偏移） */
  at: z.string().optional(),
  /** kind='cron'：5 段表达式（分 时 日 月 周） */
  expr: z.string().optional(),
  /** IANA 时区（缺省 = 服务器默认时区） */
  tz: z.string().optional(),
})

const CreateSchema = z.object({
  title: z.string().min(1),
  kind: z.enum(['run', 'remind']),
  instruction: z.string().min(1),
  targetAgentId: z.string().optional(),
  spec: SpecSchema,
})

const UpdateSchema = z.object({
  title: z.string().min(1).optional(),
  instruction: z.string().min(1).optional(),
  targetAgentId: z.string().nullable().optional(),
  spec: SpecSchema.optional(),
})

export function createSchedulesRouter(deps: ApiDeps): Router {
  const router = Router()

  const requireService = (res: import('express').Response): boolean => {
    if (!deps.schedules) {
      res.status(503).json({ error: '定时任务服务未装配' })
      return false
    }
    return true
  }

  router.get('/sessions/:id/schedules', (req, res) => {
    if (!requireService(res)) return
    if (!deps.sessions.getSession(req.params.id)) return res.status(404).json({ error: '会话不存在' })
    res.json({ schedules: deps.schedules!.list(req.params.id) })
  })

  router.post('/sessions/:id/schedules', (req, res) => {
    if (!requireService(res)) return
    const sessionId = req.params.id
    if (!deps.sessions.getSession(sessionId)) return res.status(404).json({ error: '会话不存在' })
    const parsed = CreateSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      return res.status(400).json({ error: `定时任务参数非法：${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}` })
    }
    const result = deps.schedules!.create({
      sessionId,
      title: parsed.data.title,
      kind: parsed.data.kind,
      instruction: parsed.data.instruction,
      targetAgentId: parsed.data.targetAgentId,
      spec: parsed.data.spec,
      createdBy: 'user',
    })
    if (!result.ok) return res.status(400).json({ error: result.error })
    res.json({ task: result.task })
  })

  router.patch('/schedules/:id', (req, res) => {
    if (!requireService(res)) return
    const parsed = UpdateSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      return res.status(400).json({ error: `定时任务参数非法：${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}` })
    }
    const result = deps.schedules!.update(req.params.id, parsed.data)
    if (!result.ok) {
      const status = result.error === '定时任务不存在' ? 404 : 400
      return res.status(status).json({ error: result.error })
    }
    res.json({ task: result.task })
  })

  router.delete('/schedules/:id', (req, res) => {
    if (!requireService(res)) return
    const result = deps.schedules!.remove(req.params.id)
    if (!result.ok) return res.status(404).json({ error: result.error })
    res.json({ ok: true })
  })

  router.post('/schedules/:id/run', (req, res) => {
    if (!requireService(res)) return
    const result = deps.schedules!.runNow(req.params.id)
    if (!result.ok) {
      const status = result.error === '定时任务不存在' ? 404 : 400
      return res.status(status).json({ error: result.error })
    }
    res.json({ task: result.task, runId: result.runId, messageId: result.messageId, skipped: result.skipped })
  })

  router.post('/schedules/:id/pause', (req, res) => {
    if (!requireService(res)) return
    const result = deps.schedules!.setEnabled(req.params.id, false)
    if (!result.ok) return res.status(404).json({ error: result.error })
    res.json({ task: result.task })
  })

  router.post('/schedules/:id/resume', (req, res) => {
    if (!requireService(res)) return
    const result = deps.schedules!.setEnabled(req.params.id, true)
    if (!result.ok) {
      const status = result.error === '定时任务不存在' ? 404 : 400
      return res.status(status).json({ error: result.error })
    }
    res.json({ task: result.task })
  })

  return router
}

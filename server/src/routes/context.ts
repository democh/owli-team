/**
 * 上下文与记忆接口（M2）：
 * - GET    /api/sessions/:id/context        → 分层快照（前端「上下文抽屉」）
 * - GET    /api/sessions/:id/memory         → 记忆列表
 * - POST   /api/sessions/:id/memory         → 新增记忆（用户手动）
 * - PATCH  /api/sessions/:id/memory/:memId  → 编辑单条
 * - DELETE /api/sessions/:id/memory/:memId  → 删除单条
 */
import { Router } from 'express'
import type { MemoryKind } from '@multi-agent/shared'
import { MEMORY_KINDS } from '../store/memory.js'
import type { ApiDeps } from './index.js'

export function createContextRouter(deps: ApiDeps): Router {
  const router = Router()

  router.get('/sessions/:id/context', (req, res) => {
    const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : undefined
    try {
      res.json({ context: deps.context.snapshot(req.params.id, agentId) })
    } catch {
      res.status(404).json({ error: '会话不存在' })
    }
  })

  router.get('/sessions/:id/memory', (req, res) => {
    if (!deps.sessions.get(req.params.id)) return res.status(404).json({ error: '会话不存在' })
    res.json({ memory: deps.memory.list(req.params.id) })
  })

  router.post('/sessions/:id/memory', (req, res) => {
    const session = deps.sessions.getSession(req.params.id)
    if (!session) return res.status(404).json({ error: '会话不存在' })
    const body = req.body as { kind?: unknown; content?: unknown }
    const kind = String(body?.kind ?? '')
    if (!MEMORY_KINDS.includes(kind as MemoryKind)) {
      return res.status(400).json({ error: `kind 必须是：${MEMORY_KINDS.join(' / ')}` })
    }
    const content = String(body?.content ?? '').trim()
    if (!content) return res.status(400).json({ error: 'content 不能为空' })
    // M57：写入携带用户归属（多用户隔离；单用户兼容模式缺省）
    const result = deps.memory.upsertScoped('session', req.params.id, kind as MemoryKind, content, {
      source: 'user',
      sourceSessionId: req.params.id,
      userId: session.ownerId,
    })
    res.status(201).json({ item: result?.item, added: result?.added ?? false })
  })

  router.patch('/sessions/:id/memory/:memId', (req, res) => {
    const content = String((req.body as { content?: unknown })?.content ?? '').trim()
    if (!content) return res.status(400).json({ error: 'content 不能为空' })
    const item = deps.memory.patch(req.params.memId, content)
    if (!item) return res.status(404).json({ error: '记忆不存在' })
    res.json({ item })
  })

  router.delete('/sessions/:id/memory/:memId', (req, res) => {
    if (!deps.memory.remove(req.params.memId)) return res.status(404).json({ error: '记忆不存在' })
    res.json({ ok: true })
  })

  return router
}

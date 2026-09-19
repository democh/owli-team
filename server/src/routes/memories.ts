/**
 * 向量记忆接口（M25.3c）：
 * - GET    /api/memories                → 跨 scope 列表（scope/owner/kind/status/q/limit/offset）
 * - GET    /api/memories/stats          → 运行状态（后端/扩展/模型/维度/队列/命中率）
 * - POST   /api/memories/reindex        → 后台重建（force=true 丢弃 vec0 镜像重灌）
 * - POST   /api/memories/recall         → 语义召回调试（返回评分明细；force 绕过开关）
 * - POST   /api/memories/:id/supersede  → 时间有效性替代（旧条目 → superseded）
 * - PATCH  /api/memories/:id/status     → 状态流转（候选审核：active / archived / candidate）
 *
 * 旧 /api/sessions/:id/memory（GET/POST/PATCH/DELETE）保持兼容，见 routes/context.ts。
 */
import { Router } from 'express'
import type { MemoryKind, MemoryScope, MemoryStatus } from '@multi-agent/shared'
import { MEMORY_KINDS, MEMORY_SCOPES, MEMORY_STATUSES } from '../store/memory.js'
import type { ApiDeps } from './index.js'

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function asNumber(value: unknown): number | undefined {
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

export function createMemoriesRouter(deps: ApiDeps): Router {
  const router = Router()

  router.get('/memories', (req, res) => {
    const rawScope = asString(req.query.scope)
    if (rawScope && !MEMORY_SCOPES.includes(rawScope as MemoryScope)) {
      return res.status(400).json({ error: `scope 必须是：${MEMORY_SCOPES.join(' / ')}` })
    }
    const rawKind = asString(req.query.kind)
    if (rawKind && !MEMORY_KINDS.includes(rawKind as MemoryKind)) {
      return res.status(400).json({ error: `kind 必须是：${MEMORY_KINDS.join(' / ')}` })
    }
    const rawStatus = asString(req.query.status) === 'all' ? undefined : asString(req.query.status)
    if (rawStatus && !MEMORY_STATUSES.includes(rawStatus as MemoryStatus)) {
      return res.status(400).json({ error: `status 必须是：${MEMORY_STATUSES.join(' / ')} / all` })
    }
    const items = deps.memory.query({
      scope: rawScope as MemoryScope | undefined,
      ownerId: asString(req.query.owner),
      kind: rawKind as MemoryKind | undefined,
      status: rawStatus as MemoryStatus | undefined,
      q: asString(req.query.q),
      limit: asNumber(req.query.limit),
      offset: asNumber(req.query.offset),
    })
    res.json({ memory: items })
  })

  router.get('/memories/stats', (_req, res) => {
    const hits = deps.memory.hitSummary()
    res.json({
      stats: {
        ...deps.memories.stats(),
        hits: {
          ...hits,
          /** 命中率 = 被召回过的 active 条目 / active 总数 */
          hitRate: hits.active > 0 ? Math.round((hits.hitItems / hits.active) * 100) / 100 : 0,
        },
      },
    })
  })

  router.post('/memories/reindex', async (req, res) => {
    const force = Boolean((req.body as { force?: unknown } | undefined)?.force)
    const result = await deps.memories.reindex(force)
    if (!result.ok) return res.status(400).json({ error: result.error ?? '重建失败', result })
    res.json({ result })
  })

  router.post('/memories/recall', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const query = asString(body.query)
    if (!query) return res.status(400).json({ error: 'query 不能为空' })
    const outcome = await deps.memories.recall({
      query,
      sessionId: asString(body.sessionId),
      agentId: asString(body.agentId),
      projectId: asString(body.projectId),
      topK: asNumber(body.topK),
      minScore: asNumber(body.minScore),
      budgetTokens: asNumber(body.budgetTokens),
      // 评分调试：绕过「语义召回开关」（休眠/超时仍静默跳过）
      force: true,
    })
    res.json({ outcome })
  })

  router.post('/memories/:id/supersede', (req, res) => {
    const old = deps.memory.get(req.params.id)
    if (!old) return res.status(404).json({ error: '记忆不存在' })
    const newId = asString((req.body as { newId?: unknown } | undefined)?.newId)
    if (!newId) return res.status(400).json({ error: 'newId 不能为空' })
    const next = deps.memory.get(newId)
    if (!next) return res.status(404).json({ error: '替代条目不存在' })
    if (next.id === old.id) return res.status(400).json({ error: '不能自我取代' })
    if (old.scope !== next.scope || old.ownerId !== next.ownerId) {
      return res.status(400).json({ error: '仅同 scope 同 owner 的条目可互相取代' })
    }
    deps.memory.markSuperseded(old.id, next.id)
    res.json({ item: deps.memory.get(old.id) })
  })

  router.patch('/memories/:id/status', (req, res) => {
    const status = asString((req.body as { status?: unknown } | undefined)?.status)
    if (!status || !MEMORY_STATUSES.includes(status as MemoryStatus)) {
      return res.status(400).json({ error: `status 必须是：${MEMORY_STATUSES.join(' / ')}` })
    }
    const item = deps.memory.setStatus(req.params.id, status as MemoryStatus)
    if (!item) return res.status(404).json({ error: '记忆不存在' })
    // 流转回 active（候选审核通过）→ 加速嵌入消费
    if (status === 'active') void deps.memories.poke()
    res.json({ item })
  })

  return router
}

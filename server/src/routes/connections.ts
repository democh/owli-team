/**
 * 连接中心路由（M22）：连接 CRUD / 测试 / 会话绑定 / 审计查询。
 *
 * 安全：
 * - secret 明文永不回传（列表 / 详情只给 secretSet 标记）；
 * - 创建 / 更新 / 删除 / 测试 / 绑定全部落审计（actor='user'）；
 * - 删除连接后使数据库句柄失效（防陈旧池连接）。
 */
import { Router } from 'express'
import { z } from 'zod'
import type { ConnectionDefinition } from '@multi-agent/shared'
import type { ApiDeps } from './index.js'
import { analyzeSql, isReadOnlyStatement } from '../connections/db/guard.js'

const ConnectionInputSchema = z.object({
  name: z.string().min(1).max(60),
  kind: z.enum(['postgres', 'mysql', 'sqlite', 'ssh', 'chrome', 'embedding', 'media']),
  config: z.record(z.unknown()).default({}),
  secret: z.record(z.unknown()).nullable().optional(),
  enabled: z.boolean().optional(),
})

const ConnectionUpdateSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  config: z.record(z.unknown()).optional(),
  secret: z.record(z.unknown()).nullable().optional(),
  enabled: z.boolean().optional(),
})

const BindSchema = z.object({ connectionId: z.string().min(1) })

/** 面板操作事件序号（notify:op 按 id 去重；同一毫秒内的连续操作也不重复） */
let panelOpSeq = 0

/** 面板手工操作 → notify:op（操作流 / 直播窗实时可视化；无会话时仅落审计） */
function publishPanelOp(deps: ApiDeps, sessionId: string | undefined, payload: Record<string, unknown>): void {
  if (!sessionId) return
  deps.notify.publish({
    type: 'notify:op',
    sessionId,
    payload: { ...payload, ts: new Date().toISOString(), sessionId },
  })
}

/** 校验连接存在且为数据库类型（失败时已写响应） */
function requireDbConnection(
  deps: ApiDeps,
  id: string,
  res: import('express').Response,
): ConnectionDefinition | undefined {
  const connection = deps.connections.get(id)
  if (!connection) {
    res.status(404).json({ error: '连接不存在' })
    return undefined
  }
  if (connection.kind !== 'postgres' && connection.kind !== 'mysql' && connection.kind !== 'sqlite') {
    res.status(400).json({ error: `连接「${connection.name}」不是数据库类型（${connection.kind}）` })
    return undefined
  }
  return connection
}

/** async 处理器包装（Express 4 不捕获 async 异常） */
function wrap(
  fn: (req: import('express').Request, res: import('express').Response) => Promise<void>,
): import('express').RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next)
  }
}

export function createConnectionsRouter(deps: ApiDeps): Router {
  const router = Router()

  // ---------- 驱动可用性探测（表单预检） ----------
  router.get(
    '/connections/probe',
    wrap(async (req, res) => {
      const kind = String(req.query.kind ?? '')
      if (kind !== 'postgres' && kind !== 'mysql' && kind !== 'sqlite') {
        res.status(400).json({ error: 'kind 需为 postgres / mysql / sqlite' })
        return
      }
      const result = await deps.db.probe(kind)
      res.json(result)
    }),
  )

  // ---------- CRUD ----------
  router.get('/connections', (_req, res) => {
    res.json({ connections: deps.connections.list() })
  })

  router.get('/connections/:id', (req, res) => {
    const connection = deps.connections.get(req.params.id)
    if (!connection) {
      res.status(404).json({ error: '连接不存在' })
      return
    }
    res.json({ connection })
  })

  router.post('/connections', (req, res) => {
    const parsed = ConnectionInputSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: `参数校验失败：${parsed.error.issues[0]?.message ?? '非法请求'}` })
      return
    }
    try {
      const connection = deps.connections.create(parsed.data)
      deps.audit.record({
        actor: 'user',
        action: 'connection.create',
        resourceType: 'connection',
        resourceId: connection.id,
        detail: { name: connection.name, kind: connection.kind },
      })
      res.json({ connection })
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  router.put(
    '/connections/:id',
    wrap(async (req, res) => {
      const parsed = ConnectionUpdateSchema.safeParse(req.body)
      if (!parsed.success) {
        res.status(400).json({ error: `参数校验失败：${parsed.error.issues[0]?.message ?? '非法请求'}` })
        return
      }
      try {
        const connection = deps.connections.update(req.params.id, parsed.data)
        if (!connection) {
          res.status(404).json({ error: '连接不存在' })
          return
        }
        // 配置 / 凭据变化 → 使缓存句柄失效（下次执行按新配置重建；ssh / embedding 同效）
        await Promise.all([deps.db.invalidate(connection.id), deps.ssh.invalidate(connection.id)])
        deps.embeddings.invalidate(connection.id)
        deps.audit.record({
          actor: 'user',
          action: 'connection.update',
          resourceType: 'connection',
          resourceId: connection.id,
          detail: { fields: Object.keys(parsed.data) },
        })
        res.json({ connection })
      } catch (err) {
        res.status(400).json({ error: (err as Error).message })
      }
    }),
  )

  router.delete(
    '/connections/:id',
    wrap(async (req, res) => {
      const existing = deps.connections.get(req.params.id)
      if (!existing) {
        res.status(404).json({ error: '连接不存在' })
        return
      }
      await deps.db.invalidate(existing.id)
      await deps.ssh.invalidate(existing.id)
      deps.embeddings.invalidate(existing.id)
      deps.connections.remove(existing.id)
      deps.audit.record({
        actor: 'user',
        action: 'connection.delete',
        resourceType: 'connection',
        resourceId: existing.id,
        detail: { name: existing.name, kind: existing.kind },
      })
      res.json({ ok: true })
    }),
  )

  // ---------- 测试 ----------
  router.post(
    '/connections/:id/test',
    wrap(async (req, res) => {
      const connection = deps.connections.get(req.params.id)
      if (!connection) {
        res.status(404).json({ error: '连接不存在' })
        return
      }
      if (connection.kind === 'postgres' || connection.kind === 'mysql' || connection.kind === 'sqlite') {
        const result = await deps.db.test(connection.id, 'user')
        res.json({ result, connection: deps.connections.get(connection.id) })
        return
      }
      if (connection.kind === 'chrome') {
        const { discoverExecutables, discoverEndpoints } = await import('../browser/discover.js')
        const [executables, endpoints] = await Promise.all([discoverExecutables(), discoverEndpoints()])
        const endpoint = typeof connection.config.endpoint === 'string' ? connection.config.endpoint : ''
        if (endpoint) {
          try {
            const { resolveCdpEndpoint } = await import('../browser/cdp.js')
            const wsUrl = await resolveCdpEndpoint(endpoint)
            deps.connections.setStatus(connection.id, 'ok')
            res.json({
              result: { ok: true, detail: `CDP 端点可用：${wsUrl.replace(/\/devtools\/browser\/.*/, '/devtools/browser/***')}` },
              connection: deps.connections.get(connection.id),
            })
            return
          } catch (err) {
            deps.connections.setStatus(connection.id, 'error', (err as Error).message)
            res.json({ result: { ok: false, error: (err as Error).message }, connection: deps.connections.get(connection.id) })
            return
          }
        }
        const detail =
          executables.length > 0
            ? `发现浏览器：${executables.map((e) => e.version ?? e.path).join('；')}`
            : '未发现本机浏览器可执行文件（可在连接配置中手动指定路径）'
        deps.connections.setStatus(connection.id, executables.length > 0 ? 'ok' : 'error', executables.length > 0 ? undefined : detail)
        res.json({
          result: { ok: executables.length > 0, detail, endpoints: endpoints.length },
          connection: deps.connections.get(connection.id),
        })
        return
      }
      if (connection.kind === 'ssh') {
        const result = await deps.ssh.test(connection.id, 'user')
        res.json({ result, connection: deps.connections.get(connection.id) })
        return
      }
      // M25：嵌入连接测试（成功回报端点实际模型/维度，供表单 dim 留空时回填）
      if (connection.kind === 'embedding') {
        const result = await deps.embeddings.probeConnection(connection.id)
        deps.connections.setStatus(connection.id, result.ok ? 'ok' : 'error', result.ok ? undefined : result.error)
        deps.audit.record({
          actor: 'user',
          action: 'connection.test',
          resourceType: 'connection',
          resourceId: connection.id,
          ok: result.ok,
          error: result.ok ? undefined : result.error,
          detail: result.ok ? { model: result.model, dim: result.dim, latencyMs: result.latencyMs } : undefined,
        })
        res.json({
          result: result.ok
            ? { ok: true, latencyMs: result.latencyMs, detail: `模型 ${result.model} · 维度 ${result.dim}` }
            : { ok: false, error: result.error },
          connection: deps.connections.get(connection.id),
        })
        return
      }
      // M31：媒体连接测试（provider 探活 + 模板完整性；结果直接回给连接表单）
      if (connection.kind === 'media') {
        if (!deps.media) {
          res.json({ result: { ok: false, error: '媒体生成服务未装配' } })
          return
        }
        const result = await deps.media.test(connection)
        deps.connections.setStatus(connection.id, result.ok ? 'ok' : 'error', result.ok ? undefined : result.error)
        deps.audit.record({
          actor: 'user',
          action: 'connection.test',
          resourceType: 'connection',
          resourceId: connection.id,
          ok: result.ok,
          error: result.ok ? undefined : result.error,
          detail: result.ok
            ? { provider: String(connection.config.provider ?? ''), latencyMs: result.latencyMs }
            : undefined,
        })
        res.json({
          result: result.ok ? { ok: true, latencyMs: result.latencyMs, detail: result.detail } : { ok: false, error: result.error },
          connection: deps.connections.get(connection.id),
        })
        return
      }
      res.json({ result: { ok: false, error: `不支持的连接类型：${connection.kind}` } })
    }),
  )

  // ---------- 数据库工作台（M23：Navicat 式面板——结构 / SQL / 表数据浏览） ----------

  const SqlBodySchema = z.object({
    sql: z.string().min(1).max(20_000),
    sessionId: z.string().optional(),
    /** true = 只做护栏判定（返回 mode，不执行）；面板写语句确认流用 */
    dryRun: z.boolean().optional(),
  })

  router.get(
    '/connections/:id/schema',
    wrap(async (req, res) => {
      const connection = requireDbConnection(deps, req.params.id, res)
      if (!connection) return
      try {
        const outcome = await deps.db.exec({
          connectionId: connection.id,
          mode: 'schema',
          actor: 'user',
          requireBinding: false,
        })
        res.json({ tables: outcome.schema?.tables ?? [], truncated: outcome.schema?.truncated ?? false })
      } catch (err) {
        res.status(400).json({ error: (err as Error).message })
      }
    }),
  )

  /** 面板 SQL 执行：mode 由服务端护栏判定（只读→query，其余→execute，读写在连接开关约束下） */
  router.post(
    '/connections/:id/sql',
    wrap(async (req, res) => {
      const connection = requireDbConnection(deps, req.params.id, res)
      if (!connection) return
      const parsed = SqlBodySchema.safeParse(req.body)
      if (!parsed.success) {
        res.status(400).json({ error: '参数校验失败：需要非空 sql（≤20000 字符）' })
        return
      }
      const analysis = analyzeSql(parsed.data.sql)
      if (!analysis.ok) {
        res.status(400).json({ error: analysis.reason ?? 'SQL 不合法' })
        return
      }
      const mode: 'query' | 'execute' = isReadOnlyStatement(analysis) ? 'query' : 'execute'
      // 面板确认流：dryRun 只做护栏判定（写语句先弹确认框，不在未确认时执行）
      if (parsed.data.dryRun) {
        res.json({ mode, dryRun: true })
        return
      }
      try {
        const outcome = await deps.db.exec({
          connectionId: connection.id,
          sql: parsed.data.sql,
          mode,
          actor: 'user',
          sessionId: parsed.data.sessionId,
          requireBinding: false,
        })
        const result = outcome.query!
        publishPanelOp(deps, parsed.data.sessionId, {
          id: `db:panel:${connection.id}:${Date.now()}:${++panelOpSeq}`,
          actor: 'user',
          kind: 'db',
          action: `db.${mode}`,
          target: `conn:${connection.name}`,
          status: 'ok',
          durationMs: outcome.durationMs,
          summary: mode === 'query' ? `${result.rowCount} 行（${outcome.durationMs}ms）` : `影响 ${result.affectedRows ?? '未知'} 行（${outcome.durationMs}ms）`,
          detail: parsed.data.sql.slice(0, 1000),
          preview:
            mode === 'query' && result.rows.length > 0 ? { columns: result.columns, rows: result.rows.slice(0, 5) } : undefined,
        })
        res.json({ mode, result })
      } catch (err) {
        publishPanelOp(deps, parsed.data.sessionId, {
          id: `db:panel:${connection.id}:${Date.now()}:${++panelOpSeq}`,
          actor: 'user',
          kind: 'db',
          action: `db.${mode}`,
          target: `conn:${connection.name}`,
          status: 'error',
          summary: `执行失败：${(err as Error).message}`,
          detail: parsed.data.sql.slice(0, 1000),
        })
        res.status(400).json({ error: (err as Error).message })
      }
    }),
  )

  const RowsQuerySchema = z.object({
    offset: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    orderBy: z.string().min(1).max(200).optional(),
    desc: z.enum(['true', 'false']).optional(),
    schema: z.string().min(1).max(200).optional(),
    sessionId: z.string().optional(),
  })

  /** 表数据分页浏览（表名 / 列名白名单校验在 manager 内；偏移与行数服务端钳制） */
  router.get(
    '/connections/:id/tables/:table/rows',
    wrap(async (req, res) => {
      const connection = requireDbConnection(deps, req.params.id, res)
      if (!connection) return
      const parsed = RowsQuerySchema.safeParse(req.query)
      if (!parsed.success) {
        res.status(400).json({ error: '分页参数非法（offset ≥ 0，limit 1-500）' })
        return
      }
      try {
        const outcome = await deps.db.tableData({
          connectionId: connection.id,
          table: req.params.table,
          schema: parsed.data.schema,
          offset: parsed.data.offset,
          limit: parsed.data.limit,
          orderBy: parsed.data.orderBy,
          desc: parsed.data.desc === 'true',
          actor: 'user',
          sessionId: parsed.data.sessionId,
        })
        res.json(outcome)
      } catch (err) {
        res.status(400).json({ error: (err as Error).message })
      }
    }),
  )

  // ---------- SSH 终端（M23：一次性 token 签发；数据流走 /ws/ssh 通道） ----------
  router.get('/connections/:id/ssh/terminal-token', (req, res) => {
    const connection = deps.connections.get(req.params.id)
    if (!connection) {
      res.status(404).json({ error: '连接不存在' })
      return
    }
    if (connection.kind !== 'ssh') {
      res.status(400).json({ error: `连接「${connection.name}」不是 SSH 类型（${connection.kind}）` })
      return
    }
    if (!connection.enabled) {
      res.status(400).json({ error: `连接「${connection.name}」已禁用` })
      return
    }
    res.json(deps.streamTokens.issue(`ssh:${connection.id}`, 'takeover'))
  })

  // ---------- 会话绑定 ----------
  router.get('/sessions/:id/connections', (req, res) => {
    if (!deps.sessions.getSession(req.params.id)) {
      res.status(404).json({ error: '会话不存在' })
      return
    }
    res.json({ bindings: deps.connections.connectionsOf(req.params.id) })
  })

  router.post('/sessions/:id/connections', (req, res) => {
    if (!deps.sessions.getSession(req.params.id)) {
      res.status(404).json({ error: '会话不存在' })
      return
    }
    const parsed = BindSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: '参数校验失败：缺少 connectionId' })
      return
    }
    const connection = deps.connections.get(parsed.data.connectionId)
    if (!connection) {
      res.status(404).json({ error: '连接不存在' })
      return
    }
    // M25：嵌入连接全局共享（不参与会话绑定；在「设置」中选择使用）
    if (connection.kind === 'embedding') {
      res.status(400).json({ error: '嵌入连接不参与会话绑定（在「设置 → 向量记忆」中选择）' })
      return
    }
    // M31 → M56：媒体连接全局共享（不参与会话绑定；在「设置 → 媒体生成」中配置启用）
    if (connection.kind === 'media') {
      res.status(400).json({ error: '媒体连接不参与会话绑定（在「设置 → 媒体生成」中配置启用）' })
      return
    }
    deps.connections.bind(req.params.id, connection.id)
    deps.audit.record({
      actor: 'user',
      action: 'connection.bind',
      resourceType: 'connection',
      resourceId: connection.id,
      sessionId: req.params.id,
      detail: { name: connection.name, kind: connection.kind },
    })
    res.json({ bindings: deps.connections.connectionsOf(req.params.id) })
  })

  router.delete('/sessions/:id/connections/:connectionId', (req, res) => {
    const removed = deps.connections.unbind(req.params.id, req.params.connectionId)
    if (removed) {
      deps.audit.record({
        actor: 'user',
        action: 'connection.unbind',
        resourceType: 'connection',
        resourceId: req.params.connectionId,
        sessionId: req.params.id,
      })
    }
    res.json({ bindings: deps.connections.connectionsOf(req.params.id) })
  })

  // ---------- 审计 ----------
  router.get('/audit', (req, res) => {
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined
    const action = typeof req.query.action === 'string' ? req.query.action : undefined
    const since = typeof req.query.since === 'string' ? req.query.since : undefined
    const limit = Number(req.query.limit ?? 200)
    res.json({ entries: deps.audit.list({ sessionId, action, since, limit: Number.isFinite(limit) ? limit : 200 }) })
  })

  return router
}

/**
 * M27：MCP 管理路由（挂载于 /api 之下）。
 * - 服务器 CRUD（secret 明文永不回传，仅 secretSet 标记；凭据经 SecretVault 加密落库）；
 * - 生命周期：test（含真实连接）/ reconnect / refresh（工具清单刷新）/ 启停（enabled）；
 * - 工具目录 + 角色可达性矩阵（防「工具注册后零角色可达」：控制台警示徽章数据源）；
 * - 会话绑定（最小权限模型：未绑定的会话看不到 MCP 工具）。
 * - M28：mcp.json 直配（文件权威同步 / 状态 / 手动同步 / 粘贴导入 ui 源）；source='json' 的服务器只读。
 * 全部写操作落审计（mcp.* action）+ 广播 notify:mcp-changed（保留主题 __mcp__，多标签同步）。
 */
import { Router } from 'express'
import { z } from 'zod'
import type { McpServerConfig, McpToolDirectoryEntry, McpTransportKind } from '@multi-agent/shared'
import { MCP_TOPIC } from '@multi-agent/shared'
import type { ApiDeps } from './index.js'
import { matchesToolPattern } from '../tools/registry.js'

const McpConfigSchema = z.object({
  command: z.string().min(1).max(1_000).optional(),
  args: z.array(z.string().max(2_000)).max(100).optional(),
  cwd: z.string().max(2_000).optional(),
  url: z.string().min(1).max(2_000).optional(),
  timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
  approvalPolicy: z.enum(['risky', 'always', 'never']).optional(),
  readOnlyOverride: z.enum(['auto', 'readonly', 'write']).optional(),
  // M28：本服务器全部工具常驻（跳过延迟发现）
  eagerLoad: z.boolean().optional(),
})

const McpCreateSchema = z.object({
  name: z.string().min(1).max(40),
  displayName: z.string().max(80).nullable().optional(),
  transport: z.enum(['stdio', 'http']),
  config: McpConfigSchema,
  secret: z.record(z.unknown()).nullable().optional(),
  enabled: z.boolean().optional(),
})

const McpUpdateSchema = z.object({
  name: z.string().min(1).max(40).optional(),
  displayName: z.string().max(80).nullable().optional(),
  transport: z.enum(['stdio', 'http']).optional(),
  config: McpConfigSchema.optional(),
  secret: z.record(z.unknown()).nullable().optional(),
  enabled: z.boolean().optional(),
})

const BindSchema = z.object({ serverId: z.string().min(1) })

/** 传输入参语义校验（stdio 需 command / http 需合法 url） */
function validateTransportConfig(transport: McpTransportKind, config: McpServerConfig): string | undefined {
  if (transport === 'stdio' && !config.command) return 'stdio 服务器缺少 command（启动命令）'
  if (transport === 'http') {
    if (!config.url) return 'http 服务器缺少 url（Streamable HTTP 端点）'
    if (!/^https?:\/\//.test(config.url)) return 'url 需以 http:// 或 https:// 开头'
  }
  return undefined
}

/** async 处理器包装（Express 4 不捕获 async 异常） */
function wrap(
  fn: (req: import('express').Request, res: import('express').Response) => Promise<void>,
): import('express').RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next)
  }
}

export function createMcpRouter(deps: ApiDeps): Router {
  const router = Router()
  const store = deps.mcp
  const runtime = deps.mcpRuntime
  if (!store || !runtime) {
    // 未装配（测试 / 裁剪场景）：全部子路由 503，行为与现状零差异
    router.use((_req, res) => {
      res.status(503).json({ error: 'MCP 未装配' })
    })
    return router
  }

  /** M27：变更广播（保留主题 __mcp__；多标签刷新，不进未读计数） */
  const announce = (action: string, serverId?: string): void => {
    deps.notify.publish({
      type: 'notify:mcp-changed',
      sessionId: MCP_TOPIC,
      payload: { action, serverId },
    })
  }

  // ---------- 服务器 CRUD ----------

  router.get('/mcp/servers', (_req, res) => {
    res.json({ servers: store.list() })
  })

  router.get('/mcp/servers/:id', (req, res) => {
    const server = store.get(req.params.id)
    if (!server) {
      res.status(404).json({ error: 'MCP 服务器不存在' })
      return
    }
    res.json({ server })
  })

  router.post('/mcp/servers', (req, res) => {
    const parsed = McpCreateSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: `参数校验失败：${parsed.error.issues[0]?.message ?? '非法请求'}` })
      return
    }
    const invalid = validateTransportConfig(parsed.data.transport, parsed.data.config)
    if (invalid) {
      res.status(400).json({ error: invalid })
      return
    }
    try {
      const server = store.create({ ...parsed.data, source: 'ui' })
      deps.audit.record({
        actor: 'user',
        action: 'mcp.create',
        resourceType: 'mcp',
        resourceId: server.id,
        detail: { name: server.name, transport: server.transport },
      })
      announce('created', server.id)
      res.json({ server })
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  router.put(
    '/mcp/servers/:id',
    wrap(async (req, res) => {
      const parsed = McpUpdateSchema.safeParse(req.body ?? {})
      if (!parsed.success) {
        res.status(400).json({ error: `参数校验失败：${parsed.error.issues[0]?.message ?? '非法请求'}` })
        return
      }
      const existing = store.get(req.params.id)
      if (!existing) {
        res.status(404).json({ error: 'MCP 服务器不存在' })
        return
      }
      // M28：mcp.json 管理的服务器只读（文件权威；管理台/API 的编辑与删除均被拒绝）
      if (existing.source === 'json') {
        res.status(409).json({ error: `服务器「${existing.name}」由 mcp.json 管理，请编辑配置文件后同步` })
        return
      }
      const transport = parsed.data.transport ?? existing.transport
      const config = parsed.data.config ?? existing.config
      const invalid = validateTransportConfig(transport, config)
      if (invalid) {
        res.status(400).json({ error: invalid })
        return
      }
      let server
      try {
        server = store.update(req.params.id, parsed.data)
      } catch (err) {
        res.status(400).json({ error: (err as Error).message })
        return
      }
      if (!server) {
        res.status(404).json({ error: 'MCP 服务器不存在' })
        return
      }
      // 语义化重连：禁用 → 断开回收；启用 / 名称 / 传输 / 配置 / 凭据变化 → 重连（工具名与凭据随之刷新）
      const needsReconnect = ['name', 'transport', 'config', 'secret', 'enabled'].some((key) => key in parsed.data)
      if (!server.enabled) {
        await runtime.disconnect(server.id)
      } else if (needsReconnect) {
        void runtime.connect(server.id).catch(() => undefined)
      }
      deps.audit.record({
        actor: 'user',
        action: 'mcp.update',
        resourceType: 'mcp',
        resourceId: server.id,
        detail: { name: server.name, fields: Object.keys(parsed.data), reconnect: needsReconnect && server.enabled },
      })
      announce('updated', server.id)
      // 生命周期动作（断开）已改状态 / 清工具：响应回读终态，避免陈旧快照
      res.json({ server: store.get(server.id) ?? server })
    }),
  )

  router.delete(
    '/mcp/servers/:id',
    wrap(async (req, res) => {
      const existing = store.get(req.params.id)
      if (!existing) {
        res.status(404).json({ error: 'MCP 服务器不存在' })
        return
      }
      // M28：mcp.json 管理的服务器只读（删除 = 从文件移除后同步）
      if (existing.source === 'json') {
        res.status(409).json({ error: `服务器「${existing.name}」由 mcp.json 管理，请从配置文件移除后同步` })
        return
      }
      // 先断连（注销工具 + 回收 stdio 子进程），再删除（session_mcp_servers 双 FK 级联解绑）
      await runtime.disconnect(existing.id)
      store.remove(existing.id)
      deps.audit.record({
        actor: 'user',
        action: 'mcp.delete',
        resourceType: 'mcp',
        resourceId: existing.id,
        detail: { name: existing.name, transport: existing.transport },
      })
      announce('deleted', existing.id)
      res.json({ ok: true })
    }),
  )

  // ---------- 生命周期 ----------

  router.post(
    '/mcp/servers/:id/test',
    wrap(async (req, res) => {
      const existing = store.get(req.params.id)
      if (!existing) {
        res.status(404).json({ error: 'MCP 服务器不存在' })
        return
      }
      const result = await runtime.test(existing.id)
      deps.audit.record({
        actor: 'user',
        action: 'mcp.test',
        resourceType: 'mcp',
        resourceId: existing.id,
        ok: result.ok,
        error: result.ok ? undefined : result.error,
        detail: result.ok ? { latencyMs: result.latencyMs, toolCount: result.toolCount } : undefined,
      })
      res.json({ result, server: store.get(existing.id) })
    }),
  )

  router.post(
    '/mcp/servers/:id/reconnect',
    wrap(async (req, res) => {
      const existing = store.get(req.params.id)
      if (!existing) {
        res.status(404).json({ error: 'MCP 服务器不存在' })
        return
      }
      if (!existing.enabled) {
        res.status(400).json({ error: `服务器「${existing.name}」已禁用，请先启用后再重连` })
        return
      }
      await runtime.restart(existing.id)
      deps.audit.record({
        actor: 'user',
        action: 'mcp.reconnect',
        resourceType: 'mcp',
        resourceId: existing.id,
        detail: { name: existing.name },
      })
      res.json({ server: store.get(existing.id) })
    }),
  )

  router.post(
    '/mcp/servers/:id/refresh',
    wrap(async (req, res) => {
      const existing = store.get(req.params.id)
      if (!existing) {
        res.status(404).json({ error: 'MCP 服务器不存在' })
        return
      }
      await runtime.refreshTools(existing.id)
      deps.audit.record({
        actor: 'user',
        action: 'mcp.refresh',
        resourceType: 'mcp',
        resourceId: existing.id,
        detail: { name: existing.name },
      })
      res.json({ server: store.get(existing.id) })
    }),
  )

  // ---------- M28：mcp.json 直配（状态 / 手动同步 / 粘贴导入） ----------

  const jsonImportSchema = z.object({ json: z.string().min(2).max(200_000) })

  router.get('/mcp/json-config', (_req, res) => {
    if (!deps.mcpJson) {
      res.status(503).json({ error: 'MCP JSON 配置未装配' })
      return
    }
    res.json({ config: deps.mcpJson.currentStatus() })
  })

  router.post(
    '/mcp/json-config/sync',
    wrap(async (_req, res) => {
      if (!deps.mcpJson) {
        res.status(503).json({ error: 'MCP JSON 配置未装配' })
        return
      }
      const result = await deps.mcpJson.sync('manual')
      deps.audit.record({
        actor: 'user',
        action: 'mcp.json-sync',
        resourceType: 'mcp',
        ok: result.ok,
        error: result.ok ? undefined : result.errors[0],
        detail: { trigger: result.trigger, ...result.summary },
      })
      announce('json-synced')
      res.json({ result, status: deps.mcpJson.currentStatus(), servers: store.list() })
    }),
  )

  router.post(
    '/mcp/json-config/import',
    wrap(async (req, res) => {
      if (!deps.mcpJson) {
        res.status(503).json({ error: 'MCP JSON 配置未装配' })
        return
      }
      const parsed = jsonImportSchema.safeParse(req.body ?? {})
      if (!parsed.success) {
        res.status(400).json({ error: '参数校验失败：缺少 json 文本' })
        return
      }
      const outcome = await deps.mcpJson.importAsUi(parsed.data.json)
      deps.audit.record({
        actor: 'user',
        action: 'mcp.json-import',
        resourceType: 'mcp',
        ok: outcome.created.length > 0 || outcome.errors.length === 0,
        detail: { created: outcome.created, skipped: outcome.skipped.map((s) => s.name) },
      })
      if (outcome.created.length > 0) announce('json-imported')
      res.json({ outcome, servers: store.list() })
    }),
  )

  // ---------- 工具目录 + 角色可达性矩阵 ----------

  router.get('/mcp/tools', (_req, res) => {
    const agents = deps.prompts.list()
    const tools: McpToolDirectoryEntry[] = []
    for (const server of store.list()) {
      for (const tool of server.tools) {
        // 显式白名单命中（精确名或通配）；未声明 tools 的角色 = 全部工具（仅参与 reachable）
        const usedByAgents = agents
          .filter((agent) => agent.tools && agent.tools.length > 0 && matchesToolPattern(agent.tools, tool.registeredName))
          .map((agent) => agent.id)
        const reachable = usedByAgents.length > 0 || agents.some((agent) => !agent.tools || agent.tools.length === 0)
        tools.push({
          registeredName: tool.registeredName,
          rawName: tool.rawName,
          server: server.name,
          serverId: server.id,
          description: tool.description,
          readOnly: tool.readOnly,
          usedByAgents,
          reachable,
          // M28：延迟发现徽章（常驻 / 按需）数据源
          deferByDefault: tool.deferByDefault,
        })
      }
    }
    res.json({ tools })
  })

  // ---------- 会话绑定（最小权限：未绑定不可见） ----------

  router.get('/sessions/:id/mcp-servers', (req, res) => {
    if (!deps.sessions.getSession(req.params.id)) {
      res.status(404).json({ error: '会话不存在' })
      return
    }
    res.json({ bindings: store.serversOf(req.params.id) })
  })

  router.post('/sessions/:id/mcp-servers', (req, res) => {
    if (!deps.sessions.getSession(req.params.id)) {
      res.status(404).json({ error: '会话不存在' })
      return
    }
    const parsed = BindSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: '参数校验失败：缺少 serverId' })
      return
    }
    const server = store.get(parsed.data.serverId)
    if (!server) {
      res.status(404).json({ error: 'MCP 服务器不存在' })
      return
    }
    store.bind(req.params.id, server.id)
    deps.audit.record({
      actor: 'user',
      action: 'mcp.bind',
      resourceType: 'mcp',
      resourceId: server.id,
      sessionId: req.params.id,
      detail: { name: server.name },
    })
    announce('bound', server.id)
    res.json({ bindings: store.serversOf(req.params.id) })
  })

  router.delete('/sessions/:id/mcp-servers/:serverId', (req, res) => {
    const removed = store.unbind(req.params.id, req.params.serverId)
    if (removed) {
      deps.audit.record({
        actor: 'user',
        action: 'mcp.unbind',
        resourceType: 'mcp',
        resourceId: req.params.serverId,
        sessionId: req.params.id,
      })
      announce('unbound', req.params.serverId)
    }
    res.json({ bindings: store.serversOf(req.params.id) })
  })

  return router
}

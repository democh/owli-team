/**
 * M27 测试：/api/mcp 管理路由 —— 服务器 CRUD（凭据脱敏）/ 校验 / 生命周期（test·reconnect·refresh·启停）/
 * 工具目录授权矩阵 / 会话绑定；全部写操作落审计（mcp.*）+ 广播 notify:mcp-changed（主题 __mcp__）。
 *
 * 环境：tmp 目录播种 agents/（pm 白名单 mcp__echo__*；critic 白名单 read_file），
 * 真实 express listen(0) HTTP 往返；MCP 运行时用可观测 stub 工厂（无子进程）。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { afterEach, describe, expect, it } from 'vitest'
import type { McpServerDefinition, McpToolDirectoryEntry, NotifyType } from '@multi-agent/shared'
import { MCP_TOPIC } from '@multi-agent/shared'
import { SecretVault } from '../src/connections/crypto.js'
import { loadConfig } from '../src/config.js'
import type { McpClientFactory } from '../src/mcp/client.js'
import { McpJsonConfigService } from '../src/mcp/json-config.js'
import { McpRuntimeManager } from '../src/mcp/manager.js'
import type { ApiDeps } from '../src/routes/index.js'
import { createMcpRouter } from '../src/routes/mcp.js'
import { AuditStore } from '../src/store/audit.js'
import { openDatabase } from '../src/store/db.js'
import { McpServerStore } from '../src/store/mcp-servers.js'
import { SessionStore } from '../src/store/sessions.js'
import { PromptLibrary } from '../src/store/prompts.js'
import { createToolRegistry } from '../src/tools/builtin.js'
import { makeTmpDir } from './helpers.js'

const JSON_HEADERS = { 'content-type': 'application/json' }

interface PublishedNotification {
  type: NotifyType
  sessionId: string
  payload: Record<string, unknown>
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const fn of cleanups.splice(0)) {
    await fn().catch(() => undefined)
  }
})

/** 播种：pm（白名单 = mcp__echo__* 通配）/ critic（白名单 = read_file，用于零可达警示） */
function seedApiAgents(agentsDir: string): void {
  const agentMd = (id: string, name: string, tools: string[]): string =>
    [
      '---',
      `id: ${id}`,
      `name: ${name}`,
      `role: ${name}`,
      `title: ${name}`,
      `description: 测试角色 ${id}`,
      'capabilities: [协作]',
      'avatar:',
      '  icon: user',
      '  gradient: ["#6366f1", "#818cf8"]',
      'handoff: []',
      `tools: [${tools.join(', ')}]`,
      '---',
      '',
      '## 职责',
      '',
      '测试正文。',
      '',
    ].join('\n')
  fs.mkdirSync(path.join(agentsDir, 'development', 'pm'), { recursive: true })
  fs.mkdirSync(path.join(agentsDir, 'development', 'critic'), { recursive: true })
  fs.writeFileSync(path.join(agentsDir, '_protocol.md'), '# 全局协作协议\n\n测试。\n')
  fs.writeFileSync(
    path.join(agentsDir, 'development', '_group.yaml'),
    [
      'id: development',
      'name: 研发团队',
      'description: 测试场景',
      'icon: code',
      'theme: ["#3b82f6", "#60a5fa"]',
      'objective: 交付可用软件',
      'chain: [pm]',
      'defaultSkills: []',
      'parallel: false',
      'rounds: false',
      'order: 10',
      '',
    ].join('\n'),
  )
  fs.writeFileSync(path.join(agentsDir, 'development', 'pm', 'AGENT.md'), agentMd('pm', '产品经理', ['mcp__echo__*']))
  fs.writeFileSync(path.join(agentsDir, 'development', 'critic', 'AGENT.md'), agentMd('critic', '挑刺官', ['read_file']))
}

/** stub 工厂：command=solo-mcp 返回独有工具（零可达用例）；command/url 含 broken 时模拟连接失败 */
function makeApiServerFactory(): McpClientFactory {
  return async (opts) => {
    if (opts.config.command === 'broken' || (opts.config.url ?? '').includes('broken')) {
      throw new Error('spawn failed: broken')
    }
    const solo = opts.config.command === 'solo-mcp'
    const tools = solo
      ? [{ name: 'only', description: '服务器独有工具', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }]
      : [
          { name: 'echo', description: '回显', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
          { name: 'write_note', description: '写笔记', inputSchema: { type: 'object' } },
          { name: 'image', description: '图片块', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
        ]
    return {
      serverInfo: { name: solo ? 'solo-server' : 'echo-stub', version: '1.0.0' },
      listTools: async () => tools,
      callTool: async () => ({ ok: true, content: 'stub', blockCount: 1 }),
      close: async () => undefined,
      onToolsChanged: () => undefined,
    }
  }
}

interface ApiEnv {
  db: ReturnType<typeof openDatabase>
  store: McpServerStore
  sessions: SessionStore
  manager: McpRuntimeManager
  published: PublishedNotification[]
  url: string
  close: () => Promise<void>
  /** M28：JSON 直配服务与临时配置文件路径 */
  mcpJson: McpJsonConfigService
  mcpJsonFile: string
}

async function makeApiEnv(options: { json?: boolean } = {}): Promise<ApiEnv> {
  const dir = makeTmpDir('ma-m27-api-')
  const agentsDir = path.join(dir, 'agents')
  seedApiAgents(agentsDir)
  const prompts = new PromptLibrary({ agentsDir, promptsDir: path.join(dir, 'prompts'), onWarn: () => undefined })
  const db = openDatabase(':memory:', { memory: true, noExtensions: true })
  const sessions = new SessionStore(db)
  const vault = SecretVault.load({ keyMaterial: 'd'.repeat(64), keyFile: path.join(dir, 'secrets.key') })
  const store = new McpServerStore(db, vault)
  const audit = new AuditStore(db)
  const registry = createToolRegistry(loadConfig())
  const published: PublishedNotification[] = []
  const notify = {
    publish: (input: PublishedNotification) => {
      published.push(input)
      return input
    },
  }
  const manager = new McpRuntimeManager({
    store,
    registry,
    rootDir: process.cwd(),
    defaultTimeoutMs: 20_000,
    factory: makeApiServerFactory(),
  })
  // M28：JSON 直配（与 index.ts 相同装配；默认装配，json:false 时缺省 → 三端点 503）
  const mcpJsonFile = path.join(makeTmpDir('ma-m28-api-'), 'mcp.json')
  const mcpJson = new McpJsonConfigService({
    filePath: mcpJsonFile,
    pollMs: 0,
    store,
    runtime: manager,
    publish: (payload) => {
      notify.publish({ type: 'notify:mcp-changed', sessionId: MCP_TOPIC, payload })
    },
  })
  const deps = {
    mcp: store,
    mcpRuntime: manager,
    audit,
    prompts,
    sessions,
    notify,
    ...(options.json === false ? {} : { mcpJson }),
  } as unknown as ApiDeps
  const app = express()
  app.use(express.json())
  app.use('/api', createMcpRouter(deps))
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: `内部错误：${err.message}` })
  })
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const { port } = server.address() as AddressInfo
  const close = async (): Promise<void> => {
    await manager.stopAll().catch(() => undefined)
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  cleanups.push(close)
  return { db, store, sessions, manager, published, url: `http://127.0.0.1:${port}`, close, mcpJson, mcpJsonFile }
}

function auditRows(env: ApiEnv, action?: string): Array<{ action: string; ok: number; resource_id: string | null }> {
  return action
    ? env.db.all<{ action: string; ok: number; resource_id: string | null }>(
        'SELECT action, ok, resource_id FROM audit_log WHERE action = ? ORDER BY rowid ASC',
        action,
      )
    : env.db.all('SELECT action, ok, resource_id FROM audit_log ORDER BY rowid ASC')
}

function mcpBroadcasts(env: ApiEnv, action?: string): PublishedNotification[] {
  return env.published.filter(
    (p) => p.type === 'notify:mcp-changed' && p.sessionId === MCP_TOPIC && (!action || p.payload.action === action),
  )
}

describe('M27：/api/mcp 服务器 CRUD', () => {
  it('创建/查询/更新/删除全链路：凭据脱敏 + 审计 mcp.* + 广播 notify:mcp-changed（主题 __mcp__）', async () => {
    const env = await makeApiEnv()
    const created = (await (
      await fetch(`${env.url}/api/mcp/servers`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          name: 'echo',
          displayName: '回显服务器',
          transport: 'stdio',
          config: { command: 'node', args: ['echo.mjs'] },
          secret: { env: { API_TOKEN: 's3cret-value' } },
        }),
      })
    ).json()) as { server: McpServerDefinition }
    expect(created.server.id.startsWith('mcp_')).toBe(true)
    expect(created.server.name).toBe('echo')
    expect(created.server.secretSet).toBe(true)
    expect(created.server.status).toBe('idle')
    // 明文凭据绝不回传
    expect(JSON.stringify(created)).not.toContain('s3cret-value')
    expect(auditRows(env, 'mcp.create')).toHaveLength(1)
    expect(mcpBroadcasts(env, 'created')).toHaveLength(1)

    const list = (await (await fetch(`${env.url}/api/mcp/servers`)).json()) as { servers: McpServerDefinition[] }
    expect(list.servers).toHaveLength(1)
    const detail = (await (await fetch(`${env.url}/api/mcp/servers/${created.server.id}`)).json()) as {
      server: McpServerDefinition
    }
    expect(detail.server.displayName).toBe('回显服务器')
    expect((await fetch(`${env.url}/api/mcp/servers/mcp_nope`)).status).toBe(404)

    const updated = (await (
      await fetch(`${env.url}/api/mcp/servers/${created.server.id}`, {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ displayName: '回声', config: { command: 'node', timeoutMs: 5_000 }, secret: null }),
      })
    ).json()) as { server: McpServerDefinition }
    expect(updated.server.displayName).toBe('回声')
    expect(updated.server.secretSet).toBe(false)
    expect(updated.server.config.timeoutMs).toBe(5_000)
    expect(auditRows(env, 'mcp.update')).toHaveLength(1)
    expect(mcpBroadcasts(env, 'updated')).toHaveLength(1)

    const deleted = (await (
      await fetch(`${env.url}/api/mcp/servers/${created.server.id}`, { method: 'DELETE' })
    ).json()) as { ok: boolean }
    expect(deleted.ok).toBe(true)
    expect(env.store.get(created.server.id)).toBeUndefined()
    expect(auditRows(env, 'mcp.delete')).toHaveLength(1)
    expect(mcpBroadcasts(env, 'deleted')).toHaveLength(1)
  })

  it('校验：非法 slug / stdio 缺 command / http 缺 url 或非 http(s) / 重名 → 400', async () => {
    const env = await makeApiEnv()
    const post = (body: unknown): Promise<Response> =>
      fetch(`${env.url}/api/mcp/servers`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) })
    expect((await post({ name: 'Bad Name', transport: 'stdio', config: { command: 'x' } })).status).toBe(400)
    expect((await post({ name: 'ok-name', transport: 'stdio', config: {} })).status).toBe(400)
    expect((await post({ name: 'ok-name', transport: 'http', config: {} })).status).toBe(400)
    const badUrl = await post({ name: 'ok-name', transport: 'http', config: { url: 'ftp://x' } })
    expect(badUrl.status).toBe(400)
    expect(((await badUrl.json()) as { error: string }).error).toContain('http')

    expect((await post({ name: 'dup', transport: 'stdio', config: { command: 'x' } })).status).toBe(200)
    expect((await post({ name: 'dup', transport: 'stdio', config: { command: 'x' } })).status).toBe(400)
    // timeoutMs 越界 / transport 非法 → schema 层 400
    expect(
      (await post({ name: 'range', transport: 'stdio', config: { command: 'x', timeoutMs: 10 } })).status,
    ).toBe(400)
    expect((await post({ name: 't', transport: 'sse', config: {} })).status).toBe(400)
  })
})

describe('M27：/api/mcp 生命周期', () => {
  it('test / refresh / reconnect：真实连接注入工具目录；禁用后拒绝重连；失败回报 error 并审计 ok=0', async () => {
    const env = await makeApiEnv()
    const created = (await (
      await fetch(`${env.url}/api/mcp/servers`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ name: 'echo', transport: 'stdio', config: { command: 'echo-mcp' } }),
      })
    ).json()) as { server: McpServerDefinition }

    const tested = (await (
      await fetch(`${env.url}/api/mcp/servers/${created.server.id}/test`, { method: 'POST' })
    ).json()) as { result: { ok: boolean; toolCount?: number; detail?: string }; server: McpServerDefinition }
    expect(tested.result.ok).toBe(true)
    expect(tested.result.toolCount).toBe(3)
    expect(tested.server.status).toBe('ok')
    expect(tested.server.tools.map((t) => t.rawName).sort()).toEqual(['echo', 'image', 'write_note'])
    expect(auditRows(env, 'mcp.test')).toHaveLength(1)

    const refreshed = (await (
      await fetch(`${env.url}/api/mcp/servers/${created.server.id}/refresh`, { method: 'POST' })
    ).json()) as { server: McpServerDefinition }
    expect(refreshed.server.tools).toHaveLength(3)
    expect(auditRows(env, 'mcp.refresh')).toHaveLength(1)

    const reconnected = (await (
      await fetch(`${env.url}/api/mcp/servers/${created.server.id}/reconnect`, { method: 'POST' })
    ).json()) as { server: McpServerDefinition }
    expect(reconnected.server.status).toBe('ok')
    expect(auditRows(env, 'mcp.reconnect')).toHaveLength(1)

    // 禁用：PUT enabled=false → 断开（状态 idle + 工具清空），重连被拒绝
    const disabled = (await (
      await fetch(`${env.url}/api/mcp/servers/${created.server.id}`, {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ enabled: false }),
      })
    ).json()) as { server: McpServerDefinition }
    expect(disabled.server.enabled).toBe(false)
    expect(disabled.server.status).toBe('idle')
    expect(disabled.server.tools).toEqual([])
    expect((await fetch(`${env.url}/api/mcp/servers/${created.server.id}/reconnect`, { method: 'POST' })).status).toBe(400)

    // 连接失败：test 回报 error（lastError 可读）
    const broken = (await (
      await fetch(`${env.url}/api/mcp/servers`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ name: 'broken-srv', transport: 'stdio', config: { command: 'broken' } }),
      })
    ).json()) as { server: McpServerDefinition }
    const failed = (await (
      await fetch(`${env.url}/api/mcp/servers/${broken.server.id}/test`, { method: 'POST' })
    ).json()) as { result: { ok: boolean; error?: string } }
    expect(failed.result.ok).toBe(false)
    expect(failed.result.error).toContain('broken')
    const failedAudits = auditRows(env, 'mcp.test')
    expect(failedAudits).toHaveLength(2)
    expect(failedAudits[1]!.ok).toBe(0)
    expect((await fetch(`${env.url}/api/mcp/servers/mcp_nope/test`, { method: 'POST' })).status).toBe(404)
  })
})

describe('M27：/api/mcp/tools 授权矩阵', () => {
  it('通配白名单命中 usedByAgents；无白名单角色参与 reachable；零可达可识别（警示徽章数据源）', async () => {
    const env = await makeApiEnv()
    const create = async (body: unknown): Promise<McpServerDefinition> => {
      const res = (await (
        await fetch(`${env.url}/api/mcp/servers`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) })
      ).json()) as { server: McpServerDefinition }
      await fetch(`${env.url}/api/mcp/servers/${res.server.id}/test`, { method: 'POST' })
      return res.server
    }
    await create({ name: 'echo', transport: 'stdio', config: { command: 'echo-mcp' } })
    await create({ name: 'solo', transport: 'stdio', config: { command: 'solo-mcp' } })

    const { tools } = (await (await fetch(`${env.url}/api/mcp/tools`)).json()) as { tools: McpToolDirectoryEntry[] }
    expect(tools).toHaveLength(4)
    const echo = tools.find((t) => t.registeredName === 'mcp__echo__echo')!
    expect(echo.server).toBe('echo')
    expect(echo.readOnly).toBe(true)
    expect(echo.usedByAgents).toEqual(['pm']) // pm 白名单 mcp__echo__* 通配命中
    expect(echo.reachable).toBe(true)
    expect(tools.find((t) => t.registeredName === 'mcp__echo__write_note')!.readOnly).toBe(false)

    // solo 服务器：两个角色均有白名单且不匹配 → usedByAgents 空 / reachable false（零可达警示）
    const solo = tools.find((t) => t.registeredName === 'mcp__solo__only')!
    expect(solo.usedByAgents).toEqual([])
    expect(solo.reachable).toBe(false)
  })
})

describe('M27：会话绑定端点（最小权限）', () => {
  it('绑定 / 查询 / 解绑：审计 + 广播；未知会话与服务器 404；缺 serverId 400', async () => {
    const env = await makeApiEnv()
    const session = env.sessions.create(['pm'], 'M27 API 绑定')
    const server = env.store.create({ name: 'echo', transport: 'stdio', config: { command: 'x' } })

    const empty = (await (await fetch(`${env.url}/api/sessions/${session.id}/mcp-servers`)).json()) as {
      bindings: Array<{ server: McpServerDefinition }>
    }
    expect(empty.bindings).toEqual([])

    const bound = (await (
      await fetch(`${env.url}/api/sessions/${session.id}/mcp-servers`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ serverId: server.id }),
      })
    ).json()) as { bindings: Array<{ server: McpServerDefinition }> }
    expect(bound.bindings.map((b) => b.server.id)).toEqual([server.id])
    expect(auditRows(env, 'mcp.bind')).toHaveLength(1)
    expect(mcpBroadcasts(env, 'bound')).toHaveLength(1)

    expect(
      (
        await fetch(`${env.url}/api/sessions/${session.id}/mcp-servers`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ serverId: 'mcp_nope' }),
        })
      ).status,
    ).toBe(404)
    expect(
      (
        await fetch(`${env.url}/api/sessions/sess-none/mcp-servers`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ serverId: server.id }),
        })
      ).status,
    ).toBe(404)
    expect(
      (
        await fetch(`${env.url}/api/sessions/${session.id}/mcp-servers`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({}),
        })
      ).status,
    ).toBe(400)

    const unbound = (await (
      await fetch(`${env.url}/api/sessions/${session.id}/mcp-servers/${server.id}`, { method: 'DELETE' })
    ).json()) as { bindings: unknown[] }
    expect(unbound.bindings).toEqual([])
    expect(auditRows(env, 'mcp.unbind')).toHaveLength(1)
    expect(mcpBroadcasts(env, 'unbound')).toHaveLength(1)
    // 重复解绑：幂等，无新审计
    await fetch(`${env.url}/api/sessions/${session.id}/mcp-servers/${server.id}`, { method: 'DELETE' })
    expect(auditRows(env, 'mcp.unbind')).toHaveLength(1)
  })

  it('删除服务器：级联解绑会话（双 FK ON DELETE CASCADE）', async () => {
    const env = await makeApiEnv()
    const session = env.sessions.create(['pm'], 'M27 级联')
    const server = env.store.create({ name: 'echo', transport: 'stdio', config: { command: 'x' } })
    env.store.bind(session.id, server.id)

    await fetch(`${env.url}/api/mcp/servers/${server.id}`, { method: 'DELETE' })
    const { bindings } = (await (await fetch(`${env.url}/api/sessions/${session.id}/mcp-servers`)).json()) as {
      bindings: unknown[]
    }
    expect(bindings).toEqual([])
    expect(env.store.isBound(session.id, server.id)).toBe(false)
  })
})

describe('M28：/api/mcp/json-config（JSON 直配）', () => {
  it('GET 状态 → POST 同步：创建 source=json + 审计 mcp.json-sync + 广播；source=json 的编辑/删除被 409 拒绝', async () => {
    const env = await makeApiEnv()
    const before = (await (await fetch(`${env.url}/api/mcp/json-config`)).json()) as {
      config: { exists: boolean; entries: string[] }
    }
    expect(before.config.exists).toBe(false)

    fs.writeFileSync(env.mcpJsonFile, JSON.stringify({ mcpServers: { fromjson: { command: 'stub' } } }))
    const synced = (await (
      await fetch(`${env.url}/api/mcp/json-config/sync`, { method: 'POST' })
    ).json()) as {
      result: { ok: boolean; summary: { created: number } }
      status: { entries: string[]; lastResult: string }
      servers: McpServerDefinition[]
    }
    expect(synced.result.ok).toBe(true)
    expect(synced.result.summary.created).toBe(1)
    expect(synced.status.entries).toEqual(['fromjson'])
    expect(synced.status.lastResult).toBe('ok')
    const server = synced.servers.find((entry) => entry.name === 'fromjson')!
    expect(server.source).toBe('json')
    expect(auditRows(env, 'mcp.json-sync')).toHaveLength(1)
    expect(mcpBroadcasts(env, 'json-synced').length).toBeGreaterThan(0)

    // 只读保护：文件权威 → 管理台/API 编辑与删除均 409
    const put = await fetch(`${env.url}/api/mcp/servers/${server.id}`, {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ enabled: false }),
    })
    expect(put.status).toBe(409)
    expect(((await put.json()) as { error: string }).error).toContain('mcp.json')
    expect(env.store.get(server.id)!.enabled).toBe(true)
    const del = await fetch(`${env.url}/api/mcp/servers/${server.id}`, { method: 'DELETE' })
    expect(del.status).toBe(409)
    expect(env.store.get(server.id)).toBeTruthy()
  })

  it('POST import：粘贴导入创建 ui 源（同名冲突跳过并报告）；坏 JSON 零创建报错明示', async () => {
    const env = await makeApiEnv()
    fs.writeFileSync(env.mcpJsonFile, JSON.stringify({ mcpServers: { dup: { command: 'stub' } } }))
    await fetch(`${env.url}/api/mcp/json-config/sync`, { method: 'POST' })

    const body = (await (
      await fetch(`${env.url}/api/mcp/json-config/import`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          json: JSON.stringify({
            mcpServers: { dup: { command: 'stub' }, fresh: { url: 'https://f.example/mcp' } },
          }),
        }),
      })
    ).json()) as { outcome: { created: string[]; skipped: Array<{ name: string; reason: string }> } }
    expect(body.outcome.created).toEqual(['fresh'])
    expect(body.outcome.skipped.map((entry) => entry.name)).toEqual(['dup'])
    expect(env.store.findByName('fresh')!.source).toBe('ui')
    // json 源不受粘贴导入影响
    expect(env.store.findByName('dup')!.source).toBe('json')
    expect(auditRows(env, 'mcp.json-import')).toHaveLength(1)
    expect(mcpBroadcasts(env, 'json-imported').length).toBeGreaterThan(0)

    const bad = (await (
      await fetch(`${env.url}/api/mcp/json-config/import`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ json: '{oops' }),
      })
    ).json()) as { outcome: { created: string[]; errors: string[] } }
    expect(bad.outcome.created).toEqual([])
    expect(bad.outcome.errors.length).toBeGreaterThan(0)

    const missing = await fetch(`${env.url}/api/mcp/json-config/import`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    })
    expect(missing.status).toBe(400)
  })

  it('未装配 mcpJson（裁剪场景）：三端点均 503，既有 MCP 路由不受影响', async () => {
    const env = await makeApiEnv({ json: false })
    for (const [method, path] of [
      ['GET', '/api/mcp/json-config'],
      ['POST', '/api/mcp/json-config/sync'],
      ['POST', '/api/mcp/json-config/import'],
    ] as const) {
      const res = await fetch(`${env.url}${path}`, { method, ...(method === 'POST' ? { headers: JSON_HEADERS, body: '{}' } : {}) })
      expect(res.status).toBe(503)
    }
    expect((await fetch(`${env.url}/api/mcp/servers`)).status).toBe(200)
  })
})

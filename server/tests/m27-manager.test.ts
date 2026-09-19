/**
 * M27 测试：McpRuntimeManager —— 连接生命周期 / 工具注入与注销 / 会话可用性 / 调用（扁平化·超时·中断）/
 * 状态广播 / 关停回收。
 *
 * 协议保真：主体用 InMemoryTransport 注入 clientFactory（真实 SDK 协议往返，无子进程）；
 * 另有一条真实 stdio 用例 spawn tests/fixtures/echo-mcp.mjs 验证默认工厂的进程链路。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { SecretVault } from '../src/connections/crypto.js'
import { loadConfig } from '../src/config.js'
import { flattenCallResult, MCP_RESULT_MAX_BYTES, type McpClientFactory, type McpConnectionHandle } from '../src/mcp/client.js'
import { McpRuntimeManager } from '../src/mcp/manager.js'
import { openDatabase } from '../src/store/db.js'
import { McpServerStore } from '../src/store/mcp-servers.js'
import { SessionStore } from '../src/store/sessions.js'
import { createToolRegistry } from '../src/tools/builtin.js'
import { isToolAbortError, type AgentTool, type ToolRuntime } from '../src/tools/registry.js'
import { makeTmpDir } from './helpers.js'

const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/echo-mcp.mjs', import.meta.url))

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const fn of cleanups.splice(0)) {
    await fn().catch(() => undefined)
  }
})

/** 工具执行上下文（MCP 调用只依赖 sessionId 与 signal，其余字段与具体用例无关） */
function toolCtx(sessionId: string, signal?: AbortSignal): ToolRuntime {
  return {
    sessionId,
    runId: 'run-m27',
    agentId: 'pm',
    workspace: '/tmp/m27-workspace',
    participants: [],
    todos: [],
    allowRunCommand: false,
    allowedCommands: [],
    allowSensitive: false,
    webFetchAllowedDomains: [],
    webSearch: { enabled: false, apiKey: '', apiUrl: '', htmlUrl: '' },
    httpUserAgent: '',
    httpMinIntervalMs: 0,
    httpTimeoutMs: 1_000,
    signal,
    loadSkill: () => ({ ok: false }),
  } as unknown as ToolRuntime
}

async function waitFor(cond: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('等待条件超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function createInMemoryServer(): McpServer {
  const server = new McpServer({ name: 'in-memory-echo', version: '2.1.0' })
  server.registerTool(
    'echo',
    { description: '回显输入文本', inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } },
    async ({ text }) => ({ content: [{ type: 'text', text: `echo:${text}` }] }),
  )
  server.registerTool(
    'add',
    { description: '两数求和', inputSchema: { a: z.number(), b: z.number() }, annotations: { readOnlyHint: true } },
    async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }),
  )
  server.registerTool(
    'slow',
    { description: '延时返回', inputSchema: { ms: z.number() }, annotations: { readOnlyHint: true } },
    async ({ ms }) => {
      await new Promise((resolve) => setTimeout(resolve, ms))
      return { content: [{ type: 'text', text: `slept:${ms}` }] }
    },
  )
  server.registerTool(
    'write_note',
    { description: '写入笔记（写类）', inputSchema: { note: z.string() } },
    async ({ note }) => ({ content: [{ type: 'text', text: `saved:${note}` }] }),
  )
  return server
}

/** InMemoryTransport 工厂：每次连接创建一对配对的客户端/服务器（真实 SDK 协议往返） */
function makeInMemoryFactory(): { factory: McpClientFactory; created: Array<{ server: McpServer; handle: McpConnectionHandle }> } {
  const created: Array<{ server: McpServer; handle: McpConnectionHandle }> = []
  const factory: McpClientFactory = async () => {
    const server = createInMemoryServer()
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: 'm27-test-client', version: '0.0.0' }, { capabilities: {} })
    await client.connect(clientTransport)
    const info = client.getServerVersion()
    const handle: McpConnectionHandle = {
      serverInfo: info ? { name: info.name, version: info.version } : undefined,
      listTools: async () => {
        const result = await client.listTools()
        return (result.tools ?? []).map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema as Record<string, unknown> | undefined,
          annotations: tool.annotations as { readOnlyHint?: boolean } | undefined,
        }))
      },
      callTool: async (name, args, opts) =>
        flattenCallResult(
          await client.callTool({ name, arguments: (args ?? {}) as Record<string, unknown> }, undefined, {
            timeout: opts?.timeoutMs,
            signal: opts?.signal,
          }),
        ),
      close: async () => {
        await client.close().catch(() => undefined)
        await server.close().catch(() => undefined)
      },
      onToolsChanged: (cb) => {
        client.setNotificationHandler(ToolListChangedNotificationSchema, () => cb())
      },
    }
    created.push({ server, handle })
    return handle
  }
  return { factory, created }
}

function makeManagerEnv(factory?: McpClientFactory) {
  const db = openDatabase(':memory:', { memory: true, noExtensions: true })
  const vault = SecretVault.load({
    keyMaterial: 'b'.repeat(64),
    keyFile: path.join(makeTmpDir('ma-m27-vault-'), 'secrets.key'),
  })
  const store = new McpServerStore(db, vault)
  const sessions = new SessionStore(db)
  const registry = createToolRegistry(loadConfig())
  const published: Array<{ serverId?: string; action: string }> = []
  const manager = new McpRuntimeManager({
    store,
    registry,
    rootDir: process.cwd(),
    defaultTimeoutMs: 20_000,
    publish: (payload) => published.push(payload),
    ...(factory ? { factory } : {}),
  })
  cleanups.push(() => manager.stopAll())
  return { store, sessions, registry, manager, published }
}

describe('M27：McpRuntimeManager 生命周期', () => {
  it('connect：状态 ok / 工具注入（readOnlyHint 判定）/ 快照回写 / 广播 connected', async () => {
    const { factory, created } = makeInMemoryFactory()
    const env = makeManagerEnv(factory)
    const server = env.store.create({ name: 'echo-one', transport: 'stdio', config: { command: 'in-memory' } })
    await env.manager.connect(server.id)

    const after = env.store.get(server.id)!
    expect(after.status).toBe('ok')
    expect(after.tools.map((t) => t.rawName).sort()).toEqual(['add', 'echo', 'slow', 'write_note'])
    expect(after.tools.find((t) => t.rawName === 'echo')!.readOnly).toBe(true)
    expect(after.tools.find((t) => t.rawName === 'echo')!.description).toBe('回显输入文本')
    expect(after.tools.find((t) => t.rawName === 'write_note')!.readOnly).toBe(false)

    expect(env.registry.get('mcp__echo-one__echo')).toBeTruthy()
    expect(env.registry.isReadOnly('mcp__echo-one__echo')).toBe(true)
    expect(env.registry.isReadOnly('mcp__echo-one__write_note')).toBe(false)
    // 工具描述带来源标注（控制台与模型侧辨识）
    expect(env.registry.get('mcp__echo-one__echo')!.description).toContain('server=echo-one')
    expect(env.published.some((p) => p.action === 'connected' && p.serverId === server.id)).toBe(true)
    expect(created).toHaveLength(1)
  })

  it('readOnlyOverride：readonly 强制只读 / write 强制写类（覆盖注解）', async () => {
    const { factory } = makeInMemoryFactory()
    const env = makeManagerEnv(factory)
    const ro = env.store.create({ name: 'ro-srv', transport: 'stdio', config: { command: 'x', readOnlyOverride: 'readonly' } })
    const rw = env.store.create({ name: 'rw-srv', transport: 'stdio', config: { command: 'x', readOnlyOverride: 'write' } })
    await env.manager.connect(ro.id)
    await env.manager.connect(rw.id)

    expect(env.store.get(ro.id)!.tools.every((t) => t.readOnly)).toBe(true)
    expect(env.store.get(rw.id)!.tools.find((t) => t.rawName === 'echo')!.readOnly).toBe(false)
    expect(env.registry.isReadOnly('mcp__rw-srv__write_note')).toBe(false)
  })

  it('tools/list_changed：动态新增工具自动注入；disconnect 注销全部工具并清空快照', async () => {
    const { factory, created } = makeInMemoryFactory()
    const env = makeManagerEnv(factory)
    const server = env.store.create({ name: 'echo-one', transport: 'stdio', config: { command: 'in-memory' } })
    await env.manager.connect(server.id)

    // 服务器动态注册新工具 → SDK 广播通知 → 管理器自动刷新
    created[0]!.server.registerTool('late_tool', { description: '后注册的工具' }, async () => ({
      content: [{ type: 'text', text: 'late' }],
    }))
    await waitFor(() => Boolean(env.registry.get('mcp__echo-one__late_tool')))
    expect(env.store.get(server.id)!.tools.some((t) => t.rawName === 'late_tool')).toBe(true)
    expect(env.published.some((p) => p.action === 'tools')).toBe(true)

    await env.manager.disconnect(server.id)
    expect(env.registry.get('mcp__echo-one__echo')).toBeUndefined()
    expect(env.registry.get('mcp__echo-one__late_tool')).toBeUndefined()
    const after = env.store.get(server.id)!
    expect(after.status).toBe('idle')
    expect(after.tools).toEqual([])
    expect(env.published.some((p) => p.action === 'disconnected')).toBe(true)
  })

  it('connect 失败：状态 error + lastError + 广播 error；test() 返回失败明细（含未知服务器）', async () => {
    const env = makeManagerEnv(async () => {
      throw new Error('connect boom')
    })
    const server = env.store.create({ name: 'bad', transport: 'stdio', config: { command: 'x' } })
    await env.manager.connect(server.id)
    const after = env.store.get(server.id)!
    expect(after.status).toBe('error')
    expect(after.lastError).toContain('connect boom')
    expect(env.published.some((p) => p.action === 'error')).toBe(true)

    const result = await env.manager.test(server.id)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('connect boom')

    const missing = await env.manager.test('mcp_nope')
    expect(missing.ok).toBe(false)
    expect(missing.error).toContain('不存在')
  })

  it('test：未连接走真实连接（服务器自称信息 + 工具数）；已连接直报现状', async () => {
    const { factory } = makeInMemoryFactory()
    const env = makeManagerEnv(factory)
    const server = env.store.create({ name: 'echo-one', transport: 'stdio', config: { command: 'x' } })
    const first = await env.manager.test(server.id)
    expect(first.ok).toBe(true)
    expect(first.toolCount).toBe(4)
    expect(first.detail).toContain('连接成功')
    expect(first.detail).toContain('in-memory-echo v2.1.0')

    const second = await env.manager.test(server.id)
    expect(second.ok).toBe(true)
    expect(second.latencyMs).toBe(0)
    expect(second.detail).toContain('已连接')
  })

  it('stopAll：注销全部工具且进入停止态（不再重连）', async () => {
    const { factory } = makeInMemoryFactory()
    const env = makeManagerEnv(factory)
    const server = env.store.create({ name: 'echo-one', transport: 'stdio', config: { command: 'x' } })
    await env.manager.connect(server.id)
    await env.manager.stopAll()
    expect(env.registry.get('mcp__echo-one__echo')).toBeUndefined()
    await env.manager.connect(server.id)
    expect(env.registry.get('mcp__echo-one__echo')).toBeUndefined()
    expect(env.registry.get('mcp__echo-one__add')).toBeUndefined()
  })
})

describe('M27：McpRuntimeManager 调用与可用性', () => {
  it('executeRegisteredTool：未绑定拒绝 / 绑定成功调用 / 禁用与断开执行期再校验', async () => {
    const { factory } = makeInMemoryFactory()
    const env = makeManagerEnv(factory)
    const session = env.sessions.create(['pm'], 'M27 调用')
    const server = env.store.create({ name: 'echo-one', transport: 'stdio', config: { command: 'x' } })
    await env.manager.connect(server.id)
    const echo = env.registry.get('mcp__echo-one__echo')! as AgentTool

    const denied = await echo.execute({ text: 'hi' }, toolCtx(session.id))
    expect(denied.ok).toBe(false)
    expect(denied.summary).toContain('未绑定')

    env.store.bind(session.id, server.id)
    const ok = await echo.execute({ text: 'hi' }, toolCtx(session.id))
    expect(ok.ok).toBe(true)
    expect(ok.summary).toBe('MCP echo-one/echo 调用完成（1 块）')
    expect(ok.detail).toBe('echo:hi')

    env.store.update(server.id, { enabled: false })
    const disabled = await echo.execute({ text: 'hi' }, toolCtx(session.id))
    expect(disabled.ok).toBe(false)
    expect(disabled.summary).toContain('已禁用')

    env.store.update(server.id, { enabled: true })
    await env.manager.disconnect(server.id)
    const offline = await echo.execute({ text: 'hi' }, toolCtx(session.id))
    expect(offline.ok).toBe(false)
    expect(offline.summary).toContain('不可用')
  })

  it('filterForSession / isToolUsable：启用 + 已连接 + 已绑定三条件齐备才可用；非 MCP 工具不受影响', async () => {
    const { factory } = makeInMemoryFactory()
    const env = makeManagerEnv(factory)
    const session = env.sessions.create(['pm'], 'M27 过滤')
    const server = env.store.create({ name: 'echo-one', transport: 'stdio', config: { command: 'x' } })
    await env.manager.connect(server.id)
    const readFile = env.registry.get('read_file')!
    const echo = env.registry.get('mcp__echo-one__echo')!

    expect(env.manager.isToolUsable(session.id, 'mcp__echo-one__echo')).toBe(false)
    // 非 MCP 工具不属于 MCP 可用性判定（由注册表白名单管）
    expect(env.manager.isToolUsable(session.id, 'read_file')).toBe(false)
    expect(env.manager.filterForSession(session.id, [readFile, echo]).map((t) => t.name)).toEqual(['read_file'])

    env.store.bind(session.id, server.id)
    expect(env.manager.isToolUsable(session.id, 'mcp__echo-one__echo')).toBe(true)
    expect(env.manager.filterForSession(session.id, [readFile, echo]).map((t) => t.name)).toEqual([
      'read_file',
      'mcp__echo-one__echo',
    ])

    // 状态漂移（error）→ 不可用
    env.store.setStatus(server.id, 'error', 'boom')
    expect(env.manager.filterForSession(session.id, [readFile, echo]).map((t) => t.name)).toEqual(['read_file'])
    env.store.setStatus(server.id, 'ok')

    // 其他会话未绑定 → 不可见
    const other = env.sessions.create(['pm'], 'M27 其他会话')
    expect(env.manager.isToolUsable(other.id, 'mcp__echo-one__echo')).toBe(false)
  })

  it('approvalInfoFor：默认 risky；配置更新立即生效；未注册工具返回 undefined', async () => {
    const { factory } = makeInMemoryFactory()
    const env = makeManagerEnv(factory)
    const server = env.store.create({ name: 'echo-one', transport: 'stdio', config: { command: 'x' } })
    await env.manager.connect(server.id)
    expect(env.manager.approvalInfoFor('mcp__echo-one__echo')).toEqual({ policy: 'risky', slug: 'echo-one' })
    env.store.update(server.id, { config: { command: 'x', approvalPolicy: 'never' } })
    expect(env.manager.approvalInfoFor('mcp__echo-one__echo')).toEqual({ policy: 'never', slug: 'echo-one' })
    expect(env.manager.approvalInfoFor('read_file')).toBeUndefined()
  })

  it('调用超时：服务器 timeoutMs 生效 → 超时摘要（不抛错）；中断：signal abort → 上抛 AbortError', async () => {
    const { factory } = makeInMemoryFactory()
    const env = makeManagerEnv(factory)
    const session = env.sessions.create(['pm'], 'M27 超时')
    const server = env.store.create({ name: 'echo-one', transport: 'stdio', config: { command: 'x', timeoutMs: 100 } })
    await env.manager.connect(server.id)
    env.store.bind(session.id, server.id)
    const slow = env.registry.get('mcp__echo-one__slow')! as AgentTool

    const result = await slow.execute({ ms: 500 }, toolCtx(session.id))
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('调用超时')
    expect(result.summary).toContain('已中断')

    // 中断：AbortError 与内置工具护栏语义一致（回合停止联动）
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 60)
    let caught: unknown
    try {
      await slow.execute({ ms: 1_000 }, toolCtx(session.id, ctrl.signal))
    } catch (err) {
      caught = err
    }
    expect(caught).toBeTruthy()
    expect(isToolAbortError(caught)).toBe(true)
  })

  it('真实 stdio 工厂：spawn 夹具子进程 → 连接 / 工具清单 / 调用 / 断开注销', async () => {
    const env = makeManagerEnv()
    const server = env.store.create({
      name: 'fixture',
      transport: 'stdio',
      config: { command: process.execPath, args: [FIXTURE_PATH] },
    })
    const result = await env.manager.test(server.id)
    expect(result.ok).toBe(true)
    expect(result.toolCount).toBe(6)
    expect(env.store.get(server.id)!.tools.map((t) => t.rawName).sort()).toEqual([
      'add',
      'big',
      'echo',
      'image',
      'slow',
      'write_note',
    ])
    expect(env.registry.isReadOnly('mcp__fixture__echo')).toBe(true)
    expect(env.registry.isReadOnly('mcp__fixture__write_note')).toBe(false)

    const session = env.sessions.create(['pm'], 'M27 夹具')
    env.store.bind(session.id, server.id)
    const echo = env.registry.get('mcp__fixture__echo')! as AgentTool
    const called = await echo.execute({ text: 'hi' }, toolCtx(session.id))
    expect(called.ok).toBe(true)
    expect(called.detail).toBe('echo:hi')

    await env.manager.disconnect(server.id)
    expect(env.registry.get('mcp__fixture__echo')).toBeUndefined()
  })
})

describe('M27：flattenCallResult 结果扁平化', () => {
  it('text 拼接 / 图片·音频占位 / resource·resource_link·未知块', () => {
    const joined = flattenCallResult({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })
    expect(joined.ok).toBe(true)
    expect(joined.content).toBe('a\nb')
    expect(joined.blockCount).toBe(2)

    const image = flattenCallResult({ content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }] })
    expect(image.content).toBe('[图片 image/png 6B]')
    expect(image.blockCount).toBe(1)

    const audio = flattenCallResult({ content: [{ type: 'audio', data: 'aGVsbG8=', mimeType: 'audio/mpeg' }] })
    expect(audio.content).toBe('[音频 audio/mpeg 6B]')

    const resource = flattenCallResult({ content: [{ type: 'resource', uri: 'file:///x', text: 'body' }] })
    expect(resource.content).toBe('[资源 file:///x]\nbody')

    const link = flattenCallResult({ content: [{ type: 'resource_link', uri: 'file:///y' }] })
    expect(link.content).toBe('[资源链接 file:///y]')

    const unknown = flattenCallResult({ content: [{ type: 'weird' }] })
    expect(unknown.content).toBe('[weird 块]')
  })

  it('structuredContent（4KB 截断）/ 旧版 toolResult / isError / 空结果', () => {
    const structured = flattenCallResult({ content: [{ type: 'text', text: 'x' }], structuredContent: { k: 'v' } })
    expect(structured.content).toBe('x\n[structuredContent]\n{\n  "k": "v"\n}')

    const longStructured = flattenCallResult({ structuredContent: { s: 'z'.repeat(5_000) } })
    expect(longStructured.content).toContain('（已截断）')
    expect(longStructured.content.length).toBeLessThan(4_300)

    const legacy = flattenCallResult({ toolResult: { a: 1 } })
    expect(legacy.content).toBe('{\n  "a": 1\n}')

    const errored = flattenCallResult({ isError: true, content: [{ type: 'text', text: 'boom' }] })
    expect(errored.ok).toBe(false)
    expect(errored.content).toBe('boom')

    const empty = flattenCallResult({ content: [] })
    expect(empty.content).toBe('（空结果）')
    expect(empty.blockCount).toBe(0)
  })

  it('detail 硬上限 64KB：超出截断并追加提示', () => {
    const big = flattenCallResult({ content: [{ type: 'text', text: 'A'.repeat(70_000) }] })
    expect(big.ok).toBe(true)
    expect(big.content).toContain('上限，已截断')
    const head = big.content.split('\n…')[0]!
    expect(Buffer.byteLength(head, 'utf8')).toBe(MCP_RESULT_MAX_BYTES)
    expect(head.startsWith('A'.repeat(64))).toBe(true)
    expect(big.blockCount).toBe(1)
  })
})

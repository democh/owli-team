/**
 * M27 测试：引擎接线 —— 通配白名单（mcp__<slug>__* / mcp__*）、回合工具清单按会话绑定过滤、
 * approvalGate 的 MCP 审批规则（risky 写类拦截 / risky 只读放行 / always 全拦 / never 豁免）。
 *
 * 环境：tmp 目录播种 agents/（pm 无 tools 白名单 = 全部工具；critic 白名单 = mcp__echo__*），
 * 真实 Engine + 脚本化 Provider（不回真实模型），MCP 侧用可观测 stub 工厂（无子进程）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { abortError, type ChatRequest, type LlmChunk } from '../src/llm/provider.js'
import { SecretVault } from '../src/connections/crypto.js'
import type { McpClientFactory } from '../src/mcp/client.js'
import { McpRuntimeManager } from '../src/mcp/manager.js'
import { Engine } from '../src/orchestration/engine.js'
import { McpServerStore } from '../src/store/mcp-servers.js'
import { appendUserMessage, makeEnv, makeTmpDir, routePassThrough, waitRunFinished } from './helpers.js'

type Env = ReturnType<typeof makeEnv>

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const fn of cleanups.splice(0)) {
    await fn().catch(() => undefined)
  }
})

/** 播种：agents/{_protocol.md, development/{_group.yaml, pm/AGENT.md, critic/AGENT.md}} */
function seedAgents(agentsDir: string): void {
  const agentMd = (id: string, name: string, extra: string[] = []): string =>
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
      ...extra,
      '---',
      '',
      '## 职责',
      '',
      '测试正文。',
      '',
    ].join('\n')
  fs.mkdirSync(path.join(agentsDir, 'development', 'pm'), { recursive: true })
  fs.mkdirSync(path.join(agentsDir, 'development', 'critic'), { recursive: true })
  fs.writeFileSync(path.join(agentsDir, '_protocol.md'), '# 全局协作协议\n\n测试：保持结论收敛。\n')
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
  // pm：不声明 tools（缺省 = 全部已注册工具，含 MCP 注入项）
  fs.writeFileSync(path.join(agentsDir, 'development', 'pm', 'AGENT.md'), agentMd('pm', '产品经理'))
  // critic：白名单只有整台 MCP 服务器（通配）
  fs.writeFileSync(
    path.join(agentsDir, 'development', 'critic', 'AGENT.md'),
    agentMd('critic', '挑刺官', ['tools: [mcp__echo__*]']),
  )
  // M57 P3：solo 白名单不含任何 mcp 模式（personal 自动授予用例的对照组）
  fs.mkdirSync(path.join(agentsDir, 'development', 'solo'), { recursive: true })
  fs.writeFileSync(path.join(agentsDir, 'development', 'solo', 'AGENT.md'), agentMd('solo', '独行客', ["tools: ['read_file']"]))
}

const STUB_REMOTE_TOOLS = [
  { name: 'echo', description: '回显', inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  { name: 'write_note', description: '写笔记', inputSchema: { type: 'object', properties: { note: { type: 'string' } } } },
]

/** 可观测 stub 工厂：记录每次调用的 raw 工具名（断言审批放行 / 拦截后的真实执行与否） */
function makeStubFactory(): { factory: McpClientFactory; callLog: string[] } {
  const callLog: string[] = []
  const factory: McpClientFactory = async () => ({
    serverInfo: { name: 'stub-echo', version: '1.0.0' },
    listTools: async () => STUB_REMOTE_TOOLS,
    callTool: async (name, args) => {
      callLog.push(name)
      return { ok: true, content: `stub:${name}:${JSON.stringify(args ?? {})}`, blockCount: 1 }
    },
    close: async () => undefined,
    onToolsChanged: () => undefined,
  })
  return { factory, callLog }
}

function makeEngineEnv(): { env: Env; engine: Engine; store: McpServerStore; manager: McpRuntimeManager; callLog: string[] } {
  const agentsDir = path.join(makeTmpDir('ma-m27-engine-'), 'agents')
  seedAgents(agentsDir)
  const env = makeEnv({ agentsDir, approvalTimeoutMs: 80 })
  const vault = SecretVault.load({
    keyMaterial: 'c'.repeat(64),
    keyFile: path.join(env.cfg.dataDir, 'secrets.key'),
  })
  const store = new McpServerStore(env.db, vault)
  const { factory, callLog } = makeStubFactory()
  const manager = new McpRuntimeManager({
    store,
    registry: env.tools,
    rootDir: env.cfg.rootDir,
    defaultTimeoutMs: env.cfg.toolTimeoutMs,
    factory,
  })
  const engine = new Engine({
    cfg: env.cfg,
    prompts: env.prompts,
    skills: env.skills,
    sessions: env.sessions,
    artifacts: env.artifacts,
    memory: env.memory,
    context: env.context,
    provider: env.provider,
    tools: env.tools,
    notify: env.notify,
    tasks: env.tasks,
    runs: env.runs,
    usage: env.usage,
    metrics: env.metrics,
    approvals: env.approvals,
    plans: env.plans,
    reviews: env.reviews,
    planReviews: env.planReviews,
    versions: env.versions,
    events: env.events,
    mcp: manager,
  })
  cleanups.push(() => manager.stopAll())
  return { env, engine, store, manager, callLog }
}

/** 覆写 Provider 剧本（沿用 m7 模式）：每回合一次 chatStream；记录模型侧工具清单 */
function scriptProvider(env: Env, script: (round: number) => LlmChunk[]): { toolsLists: string[][] } {
  const toolsLists: string[][] = []
  const provider = env.provider as unknown as {
    chatStream: (req: ChatRequest, signal: AbortSignal) => AsyncIterable<LlmChunk>
  }
  let round = 0
  provider.chatStream = async function* (req, signal) {
    // M48：平台路由请求直通（不占 round / 不记工具清单）
    const route = routePassThrough(req)
    if (route) {
      for (const chunk of route) yield chunk
      return
    }
    toolsLists.push((req.tools ?? []).map((t) => t.name))
    const chunks = script(round++)
    for (const chunk of chunks) {
      if (signal.aborted) throw abortError()
      yield chunk
    }
  }
  return { toolsLists }
}

const done: LlmChunk = { type: 'done' }
const handoffUser: LlmChunk = { type: 'text', text: '完成。\n@用户' }

function toolCall(name: string, args: Record<string, unknown> = {}): LlmChunk {
  return { type: 'tool_calls', calls: [{ id: `call_${name}`, name, arguments: JSON.stringify(args) }] }
}

async function runTurn(env: Env, engine: Engine, sessionId: string, content: string): Promise<string> {
  const message = appendUserMessage(env, sessionId, content)
  const { runId } = engine.launch(sessionId, message.id)
  await waitRunFinished(engine, runId)
  return runId
}

function approvalRows(env: Env, runId: string): Array<{ action: string; status: string }> {
  return env.db.all<{ action: string; status: string }>(
    'SELECT action, status FROM approvals WHERE run_id = ? ORDER BY rowid ASC',
    runId,
  )
}

describe('M27：引擎回合工具清单', () => {
  it('会话过滤：未绑定不可见 MCP 工具；绑定后可见；非 MCP 工具不受影响', async () => {
    const { env, engine, store, manager } = makeEngineEnv()
    const server = store.create({ name: 'echo', transport: 'stdio', config: { command: 'stub' } })
    await manager.connect(server.id)
    const session = env.sessions.create(['pm'], 'M27 过滤') // pm 无白名单 = 全部工具
    const { toolsLists } = scriptProvider(env, () => [handoffUser, done])

    await runTurn(env, engine, session.id, '第一轮')
    const unbound = toolsLists[toolsLists.length - 1]!
    expect(unbound).toContain('read_file')
    expect(unbound).not.toContain('mcp__echo__echo')
    expect(unbound).not.toContain('mcp__echo__write_note')

    store.bind(session.id, server.id)
    await runTurn(env, engine, session.id, '第二轮')
    const bound = toolsLists[toolsLists.length - 1]!
    expect(bound).toContain('read_file')
    expect(bound).toContain('mcp__echo__echo')
    expect(bound).toContain('mcp__echo__write_note')
  })

  it('通配白名单：mcp__<slug>__* 命中整台服务器 / mcp__* 命中全部 MCP / 前缀通配精确生效', async () => {
    const { env, engine, store, manager } = makeEngineEnv()
    const server = store.create({ name: 'echo', transport: 'stdio', config: { command: 'stub' } })
    await manager.connect(server.id)

    const names = (tools: string[]): string[] => env.tools.forAgent({ tools }).map((t) => t.name)
    expect(names(['mcp__echo__*'])).toEqual(['mcp__echo__echo', 'mcp__echo__write_note'])
    expect(names(['mcp__*'])).toEqual(['mcp__echo__echo', 'mcp__echo__write_note'])
    expect(names(['read_file', 'mcp__echo__echo'])).toEqual(['read_file', 'mcp__echo__echo'])
    expect(names(['mcp__other__*'])).toEqual([])
    expect(names(['mcp__echo__wri*'])).toEqual(['mcp__echo__write_note'])
    expect(names([])).toContain('mcp__echo__echo')

    // 引擎级：critic 白名单 = mcp__echo__* → 模型侧仅见 MCP 工具；且通配前缀匹配整台服务器
    const session = env.sessions.create(['critic'], 'M27 通配')
    store.bind(session.id, server.id)
    const { toolsLists } = scriptProvider(env, () => [handoffUser, done])
    await runTurn(env, engine, session.id, '看一眼')
    expect(toolsLists[toolsLists.length - 1]).toEqual(['mcp__echo__echo', 'mcp__echo__write_note'])
  })
})

describe('M27：approvalGate 的 MCP 审批规则', () => {
  it('risky（默认）：写类拦截挂起（超时自动拒绝，未触达远端）/ 只读放行直调', async () => {
    const { env, engine, store, manager, callLog } = makeEngineEnv()
    const server = store.create({ name: 'echo', transport: 'stdio', config: { command: 'stub' } })
    await manager.connect(server.id)
    const session = env.sessions.create(['pm'], 'M27 审批')
    store.bind(session.id, server.id)

    // 写类：挂起 → 80ms 超时自动拒绝 → 工具未真正执行
    scriptProvider(env, (round) =>
      round === 0 ? [toolCall('mcp__echo__write_note', { note: 'x' }), done] : [handoffUser, done],
    )
    const run1 = await runTurn(env, engine, session.id, '写笔记')
    const rows1 = approvalRows(env, run1)
    expect(rows1).toHaveLength(1)
    expect(rows1[0]!.action).toContain('MCP 工具（echo）')
    expect(rows1[0]!.status).toBe('timeout')
    expect(callLog).not.toContain('write_note')

    // 只读：不拦截，直调成功
    scriptProvider(env, (round) =>
      round === 0 ? [toolCall('mcp__echo__echo', { text: 'hi' }), done] : [handoffUser, done],
    )
    const run2 = await runTurn(env, engine, session.id, '回显')
    expect(approvalRows(env, run2)).toHaveLength(0)
    expect(callLog).toContain('echo')
  })

  it('always：只读也拦截；never：写类豁免直调', async () => {
    const { env, engine, store, manager, callLog } = makeEngineEnv()
    const server = store.create({ name: 'echo', transport: 'stdio', config: { command: 'stub' } })
    await manager.connect(server.id)
    const session = env.sessions.create(['pm'], 'M27 策略')
    store.bind(session.id, server.id)

    // always：只读工具同样挂起审批
    store.update(server.id, { config: { command: 'stub', approvalPolicy: 'always' } })
    scriptProvider(env, (round) =>
      round === 0 ? [toolCall('mcp__echo__echo', { text: 'x' }), done] : [handoffUser, done],
    )
    const run1 = await runTurn(env, engine, session.id, 'always 策略')
    const rows1 = approvalRows(env, run1)
    expect(rows1).toHaveLength(1)
    expect(rows1[0]!.action).toContain('MCP 工具（echo）')

    // never：写类豁免，无审批直接执行
    store.update(server.id, { config: { command: 'stub', approvalPolicy: 'never' } })
    scriptProvider(env, (round) =>
      round === 0 ? [toolCall('mcp__echo__write_note', { note: 'y' }), done] : [handoffUser, done],
    )
    const run2 = await runTurn(env, engine, session.id, 'never 策略')
    expect(approvalRows(env, run2)).toHaveLength(0)
    expect(callLog).toContain('write_note')
  })

  it('未装配 MCP（engine.mcp 缺省）时零差异：mcp__ 名按普通未知工具处理，approvalGate 不特殊拦截', async () => {
    const agentsDir = path.join(makeTmpDir('ma-m27-engine-'), 'agents')
    seedAgents(agentsDir)
    const env = makeEnv({ agentsDir, approvalTimeoutMs: 80 })
    const session = env.sessions.create(['pm'], 'M27 未装配')
    // 未注册的 mcp__ 工具：得到未知工具回灌，不产生审批挂起
    scriptProvider(env, (round) =>
      round === 0 ? [toolCall('mcp__echo__echo', { text: 'x' }), done] : [handoffUser, done],
    )
    const runId = await runTurn(env, env.engine, session.id, '普通对话')
    expect(approvalRows(env, runId)).toHaveLength(0)
  })
})

describe('M57 P3：personal MCP（属主会话自动授予 + 非属主隔离）', () => {
  it('属主会话：白名单无 mcp 的 solo 也自动获得 personal 工具；非属主 / 无属主会话不可见', async () => {
    const { env, engine, store, manager } = makeEngineEnv()
    const alice = env.users.create({ username: 'alice', displayName: 'Alice', passwordHash: 'x', role: 'member' })
    const server = store.create({
      name: 'mine',
      transport: 'stdio',
      config: { command: 'stub' },
      scope: 'personal',
      ownerId: alice.id,
    })
    expect(server.scope).toBe('personal')
    expect(server.ownerId).toBe(alice.id)
    await manager.connect(server.id)

    const ownedSession = env.sessions.create(['solo'], '属主会话', { ownerId: alice.id })
    store.bind(ownedSession.id, server.id)
    const orphanSession = env.sessions.create(['solo'], '无属主会话') // 兼容语义：session.ownerId 缺省
    store.bind(orphanSession.id, server.id)

    const { toolsLists } = scriptProvider(env, () => [handoffUser, done])
    await runTurn(env, engine, ownedSession.id, '干活')
    const owned = toolsLists[toolsLists.length - 1]!
    // solo 白名单只有 read_file；personal 工具仍被自动并入（execute 模式）
    expect(owned).toContain('read_file')
    expect(owned).toContain('mcp__mine__echo')
    expect(owned).toContain('mcp__mine__write_note')

    await runTurn(env, engine, orphanSession.id, '干活')
    const orphan = toolsLists[toolsLists.length - 1]!
    expect(orphan).not.toContain('mcp__mine__echo') // 非属主会话：绑定也不可见
  })

  it('manager 单元：personalToolNames / filterForSession(ownerId) / 执行侧最小权限（ctx.userId）', async () => {
    const { env, store, manager } = makeEngineEnv()
    const alice = env.users.create({ username: 'alice', displayName: 'Alice', passwordHash: 'x', role: 'member' })
    const bob = env.users.create({ username: 'bob', displayName: 'Bob', passwordHash: 'x', role: 'member' })
    const server = store.create({
      name: 'mine',
      transport: 'stdio',
      config: { command: 'stub' },
      scope: 'personal',
      ownerId: alice.id,
    })
    await manager.connect(server.id)
    const session = env.sessions.create(['solo'], 'S', { ownerId: alice.id })
    store.bind(session.id, server.id)

    expect(manager.personalToolNames(alice.id).sort()).toEqual(['mcp__mine__echo', 'mcp__mine__write_note'])
    expect(manager.personalToolNames(bob.id)).toEqual([])

    const names = (ownerId?: string): string[] =>
      manager.filterForSession(session.id, env.tools.list(), ownerId).map((tool) => tool.name)
    expect(names(alice.id)).toContain('mcp__mine__echo')
    expect(names(bob.id)).not.toContain('mcp__mine__echo')
    expect(names(undefined)).not.toContain('mcp__mine__echo')

    // 执行侧最小权限：他人触发（ctx.userId = bob）→ 拒绝；属主 → 放行
    const tool = env.tools.get('mcp__mine__echo')!
    const asBob = await tool.execute(
      { text: 'x' },
      { sessionId: session.id, userId: bob.id } as unknown as Parameters<typeof tool.execute>[1],
    )
    expect(asBob.ok).toBe(false)
    expect(asBob.summary).toContain('他人私有')
    const asAlice = await tool.execute(
      { text: 'x' },
      { sessionId: session.id, userId: alice.id } as unknown as Parameters<typeof tool.execute>[1],
    )
    expect(asAlice.ok).toBe(true)
  })
})

/**
 * M28 测试：引擎接线 —— 发现态判定（auto 阈值自适应 / on / off）、
 * 工具清单重算（tool_search 激活在下一子轮即时生效）、执行门（未激活拒绝 / 激活放行）、
 * 激活集合 Run 级生命周期（跨子轮保留、不跨 Run）。
 *
 * 环境：tmp 目录播种 agents/（pm 无白名单；引擎可见 50 = 注册 56 − git 6：sandbox 会话无仓库，M47 模式门过滤），
 * 真实 Engine + 脚本化 Provider（不回真实模型）；ToolDiscoveryService 无嵌入（纯词法，确定性）。
 * M47：网关门控由 NET_ENABLED pin 固定开启（引擎按环境可用性过滤清单，避免依赖本地 .env / CI 缺省差异）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { abortError, type ChatRequest, type LlmChunk } from '../src/llm/provider.js'
import { Engine } from '../src/orchestration/engine.js'
import { ToolDiscoveryService } from '../src/tools/discovery.js'
import { appendUserMessage, makeEnv, makeTmpDir, routePassThrough, waitRunFinished } from './helpers.js'

type Env = ReturnType<typeof makeEnv>
type ToolCallRecordLike = { name: string; status: string; summary?: string }

/** M47：pin 门控开启（联网工具无环境门控，计数与环境无关，ADR 0136） */
const NET_ENABLED: Parameters<typeof makeEnv>[0] = {
  allowRunCommand: true,
}

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
  // pm：不声明 tools（缺省 = 全部已注册工具 = 56）
  fs.writeFileSync(path.join(agentsDir, 'development', 'pm', 'AGENT.md'), agentMd('pm', '产品经理'))
  // critic：小集合白名单（延迟集合仅 web_fetch 1 个 → auto 不启用，全量加载）
  fs.writeFileSync(
    path.join(agentsDir, 'development', 'critic', 'AGENT.md'),
    agentMd('critic', '挑刺官', ['tools: [read_file, web_fetch]']),
  )
}

/** 与 helpers.makeEnv 相同依赖 + 可注入 ToolDiscoveryService（helpers 默认不装配发现） */
function makeEngine(env: Env, toolSearch?: ToolDiscoveryService): Engine {
  return new Engine({
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
    toolSearch,
    // M47：与 helpers.makeEnv 一致 —— sandbox 会话 git 工具不进模型清单
    isGitMode: (sessionId) => env.workspace.isGitMode(sessionId),
  })
}

/** 覆写 Provider 剧本：每子轮一次 chatStream；记录模型侧工具清单 */
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

async function runTurn(engine: Engine, env: Env, sessionId: string, content: string): Promise<void> {
  const message = appendUserMessage(env, sessionId, content)
  const { runId } = engine.launch(sessionId, message.id)
  await waitRunFinished(engine, runId)
}

/** 读取最近一条 Agent 消息的工具调用记录（状态断言用） */
function lastToolCalls(env: Env, sessionId: string): ToolCallRecordLike[] {
  const messages = env.sessions.messages(sessionId).filter((m) => m.role === 'agent')
  const last = messages[messages.length - 1]
  return (last?.toolCalls ?? []) as unknown as ToolCallRecordLike[]
}

describe('M28：发现态判定（auto 阈值自适应）', () => {
  it('大集合（pm 引擎可见 50）：延迟 28 个 ≥ 10 → 启用；schema 仅核心 21 个（含 tool_search）', async () => {
    const agentsDir = path.join(makeTmpDir('ma-m28-engine-'), 'agents')
    seedAgents(agentsDir)
    const env = makeEnv({ agentsDir, ...NET_ENABLED })
    const engine = makeEngine(env, new ToolDiscoveryService())
    const session = env.sessions.create(['pm'], 'M28 大集合')
    const { toolsLists } = scriptProvider(env, () => [handoffUser, done])

    await runTurn(engine, env, session.id, '打个招呼')
    const tools = toolsLists[0]!
    expect(tools).toHaveLength(21)
    expect(tools).toContain('tool_search')
    expect(tools).toContain('read_file')
    expect(tools).toContain('write_plan')
    expect(tools).not.toContain('web_fetch')
    expect(tools).not.toContain('run_command')
    expect(tools).not.toContain('git_status')
    expect(tools).not.toContain('ssh_exec')
    expect(tools).not.toContain('db_query')
  })

  it('小集合（critic 白名单）：延迟 1 个 < 阈值 → 不启用，全量加载与 M28 前一致', async () => {
    const agentsDir = path.join(makeTmpDir('ma-m28-engine-'), 'agents')
    seedAgents(agentsDir)
    const env = makeEnv({ agentsDir, ...NET_ENABLED })
    const engine = makeEngine(env, new ToolDiscoveryService())
    const session = env.sessions.create(['critic'], 'M28 小集合')
    const { toolsLists } = scriptProvider(env, () => [handoffUser, done])

    await runTurn(engine, env, session.id, '看下文件')
    const tools = toolsLists[0]!
    expect(tools.sort()).toEqual(['read_file', 'web_fetch'])
    expect(tools).not.toContain('tool_search')
  })

  it('TOOL_SEARCH_MODE=off：强制禁用（全量 61 个，仅隐藏 tool_search；git 6 被模式门过滤）', async () => {
    const agentsDir = path.join(makeTmpDir('ma-m28-engine-'), 'agents')
    seedAgents(agentsDir)
    const env = makeEnv({ agentsDir, ...NET_ENABLED, toolSearchMode: 'off' })
    const engine = makeEngine(env, new ToolDiscoveryService())
    const session = env.sessions.create(['pm'], 'M28 off')
    const { toolsLists } = scriptProvider(env, () => [handoffUser, done])

    await runTurn(engine, env, session.id, '打个招呼')
    const tools = toolsLists[0]!
    expect(tools).toHaveLength(61)
    expect(tools).toContain('web_fetch')
    // M47：sandbox 会话无仓库 → git 工具不进清单（repo / worktree 模式下才可见）
    expect(tools).not.toContain('git_status')
    expect(tools).not.toContain('tool_search')
  })

  it('TOOL_SEARCH_MODE=on：小集合也强制启用（延迟工具隐藏，tool_search 在列）', async () => {
    const agentsDir = path.join(makeTmpDir('ma-m28-engine-'), 'agents')
    seedAgents(agentsDir)
    const env = makeEnv({ agentsDir, toolSearchMode: 'on' })
    const engine = makeEngine(env, new ToolDiscoveryService())
    const session = env.sessions.create(['critic'], 'M28 on')
    const { toolsLists } = scriptProvider(env, () => [handoffUser, done])

    await runTurn(engine, env, session.id, '看下文件')
    const tools = toolsLists[0]!
    expect(tools.sort()).toEqual(['read_file', 'tool_search'])
  })

  it('未装配 toolSearch（engine 缺省）：不启用发现，行为与 M28 前一致', async () => {
    const agentsDir = path.join(makeTmpDir('ma-m28-engine-'), 'agents')
    seedAgents(agentsDir)
    const env = makeEnv({ agentsDir, ...NET_ENABLED })
    const engine = makeEngine(env, undefined)
    const session = env.sessions.create(['pm'], 'M28 未装配')
    const { toolsLists } = scriptProvider(env, () => [handoffUser, done])

    await runTurn(engine, env, session.id, '打个招呼')
    const tools = toolsLists[0]!
    expect(tools).toHaveLength(61)
    expect(tools).toContain('web_fetch')
    expect(tools).not.toContain('tool_search')
  })
})

describe('M28：激活链路（检索 → 下一子轮清单生效 → Run 级生命周期）', () => {
  it('tool_search 激活延迟工具 → 下一子轮可调用；新 Run 激活集合重置', async () => {
    const agentsDir = path.join(makeTmpDir('ma-m28-engine-'), 'agents')
    seedAgents(agentsDir)
    const env = makeEnv({ agentsDir, ...NET_ENABLED })
    const engine = makeEngine(env, new ToolDiscoveryService())
    const session = env.sessions.create(['pm'], 'M28 激活')

    // Run 1：子轮 1 检索数据库 → 子轮 2 应看到激活后的工具
    const { toolsLists } = scriptProvider(env, (round) =>
      round === 0 ? [toolCall('tool_search', { query: '数据库' }), done] : [handoffUser, done],
    )
    await runTurn(engine, env, session.id, '查一下数据库')

    expect(toolsLists[0]).toHaveLength(21)
    expect(toolsLists[0]).not.toContain('db_query')
    // 子轮 2：激活工具并入清单
    expect(toolsLists[1]!.length).toBeGreaterThan(21)
    expect(toolsLists[1]!.some((name) => name.startsWith('db_'))).toBe(true)

    // 回灌协议：summary 列激活名（与子轮 2 清单一致）
    const entry = lastToolCalls(env, session.id).find((c) => c.name === 'tool_search')!
    expect(entry.status).toBe('ok')
    expect(entry.summary).toContain('已激活')
    const activatedNames = entry.summary!.replace(/^已激活 \d+ 个工具：/, '').split('、')
    expect(activatedNames.length).toBeGreaterThan(0)
    for (const name of activatedNames) expect(toolsLists[1]).toContain(name)

    // Run 2：新 Run 激活集合不保留（db_* 回到延迟）
    const second = scriptProvider(env, () => [handoffUser, done])
    await runTurn(engine, env, session.id, '再来一轮')
    expect(second.toolsLists[0]).toHaveLength(21)
    expect(second.toolsLists[0]).not.toContain('db_query')
  })

  it('空命中：类别概览回灌（防死路）', async () => {
    const agentsDir = path.join(makeTmpDir('ma-m28-engine-'), 'agents')
    seedAgents(agentsDir)
    const env = makeEnv({ agentsDir, ...NET_ENABLED })
    const engine = makeEngine(env, new ToolDiscoveryService())
    const session = env.sessions.create(['pm'], 'M28 空命中')
    scriptProvider(env, (round) =>
      round === 0 ? [toolCall('tool_search', { query: 'zzzzqqqq' }), done] : [handoffUser, done],
    )
    await runTurn(engine, env, session.id, '随便查')
    const entry = lastToolCalls(env, session.id).find((c) => c.name === 'tool_search')!
    expect(entry.status).toBe('ok')
    expect(entry.summary).toContain('未命中')
  })
})

describe('M28：执行门（延迟工具未激活拒绝）', () => {
  it('未激活直调 db_query → 拒绝并引导 tool_search（不进入工具层）', async () => {
    const agentsDir = path.join(makeTmpDir('ma-m28-engine-'), 'agents')
    seedAgents(agentsDir)
    const env = makeEnv({ agentsDir, ...NET_ENABLED })
    const engine = makeEngine(env, new ToolDiscoveryService())
    const session = env.sessions.create(['pm'], 'M28 执行门')
    scriptProvider(env, (round) =>
      round === 0 ? [toolCall('db_query', { connection: 'pg', sql: 'select 1' }), done] : [handoffUser, done],
    )
    await runTurn(engine, env, session.id, '查个数据')
    const entry = lastToolCalls(env, session.id).find((c) => c.name === 'db_query')!
    expect(entry.status).toBe('error')
    // 工具层语义是「数据库工具未启用」；出现「未加载」证明是执行门拦截（先于工具执行）
    expect(entry.summary).toContain('未加载')
    expect(entry.summary).toContain('tool_search')
  })

  it('激活后放行：进入工具层（无连接中心 → 工具层「未启用」语义）', async () => {
    const agentsDir = path.join(makeTmpDir('ma-m28-engine-'), 'agents')
    seedAgents(agentsDir)
    const env = makeEnv({ agentsDir, ...NET_ENABLED })
    const engine = makeEngine(env, new ToolDiscoveryService())
    const session = env.sessions.create(['pm'], 'M28 激活放行')
    scriptProvider(env, (round) => {
      if (round === 0) return [toolCall('tool_search', { query: '数据库查询', limit: 10 }), done]
      if (round === 1) return [toolCall('db_query', { connection: 'pg', sql: 'select 1' }), done]
      return [handoffUser, done]
    })
    await runTurn(engine, env, session.id, '先检索再查询')
    const entry = lastToolCalls(env, session.id).find((c) => c.name === 'db_query')!
    expect(entry.status).toBe('error')
    // 已激活：不再被执行门拦截；由工具层返回「未启用」提示
    expect(entry.summary).toContain('未启用')
    expect(entry.summary).not.toContain('未加载')
  })

  it('小集合（发现未启用）：延迟工具不设门，行为与 M28 前一致', async () => {
    const agentsDir = path.join(makeTmpDir('ma-m28-engine-'), 'agents')
    seedAgents(agentsDir)
    const env = makeEnv({ agentsDir, ...NET_ENABLED })
    const engine = makeEngine(env, new ToolDiscoveryService())
    const session = env.sessions.create(['critic'], 'M28 小集合放行')
    scriptProvider(env, (round) =>
      round === 0 ? [toolCall('web_fetch', { url: 'https://example.invalid/' }), done] : [handoffUser, done],
    )
    await runTurn(engine, env, session.id, '抓个网页')
    const entry = lastToolCalls(env, session.id).find((c) => c.name === 'web_fetch')!
    expect(entry.summary).not.toContain('未加载')
  })
})

describe('M28：L3 发现区块（tool_discovery 注入）', () => {
  it('启用时 system 注入 <tool_discovery>（含类别概览）；未启用不注入', async () => {
    const agentsDir = path.join(makeTmpDir('ma-m28-engine-'), 'agents')
    seedAgents(agentsDir)
    const env = makeEnv({ agentsDir, ...NET_ENABLED })
    const engine = makeEngine(env, new ToolDiscoveryService())

    const systems: string[] = []
    const provider = env.provider as unknown as {
      chatStream: (req: ChatRequest, signal: AbortSignal) => AsyncIterable<LlmChunk>
    }
    const script = (round: number): LlmChunk[] => (round === 0 ? [handoffUser, done] : [done])
    let round = 0
    provider.chatStream = async function* (req, signal) {
      // M48：平台路由请求直通（不占 round / 不记 system）
      const route = routePassThrough(req)
      if (route) {
        for (const chunk of route) yield chunk
        return
      }
      systems.push(req.system)
      for (const chunk of script(round++)) {
        if (signal.aborted) throw abortError()
        yield chunk
      }
    }

    // pm（大集合）：注入
    const big = env.sessions.create(['pm'], 'M28 区块 大')
    await runTurn(engine, env, big.id, '打个招呼')
    expect(systems[systems.length - 1]).toContain('<tool_discovery>')
    expect(systems[systems.length - 1]).toContain('tool_search')
    // M47：sandbox 会话 git 工具被过滤 → 区块不含 Git 类别（联网 2 = web_fetch + web_search 在列）
    expect(systems[systems.length - 1]).not.toContain('Git（')
    expect(systems[systems.length - 1]).toContain('联网（2 个）')

    // critic（小集合）：不注入
    const small = env.sessions.create(['critic'], 'M28 区块 小')
    await runTurn(engine, env, small.id, '看下文件')
    expect(systems[systems.length - 1]).not.toContain('<tool_discovery>')
  })
})

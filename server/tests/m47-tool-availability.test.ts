/**
 * M47 测试：工具可用性门控与失败语义收敛。
 *
 * - 环境门控单一事实来源（toolUnavailableReason）：未启用工具不进模型清单与可发现范围；
 * - 执行期精确提示：fin_* 整组未启用（markUnavailable → 可行动指引）/ 参数必填中文「为必填项」；
 * - 会话模式门控（isGitMode）：sandbox 会话 git 工具不可见，repo 模式恢复可见；
 * - tool_search：发现未启用 → ok:true「直接可用」（非失败语义，消除历史误报）；
 * - 中断语义：用户停止 ≠ 工具失败（status='stopped'、不写失败指标）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { abortError, type ChatRequest, type LlmChunk } from '../src/llm/provider.js'
import { Engine } from '../src/orchestration/engine.js'
import {
  GIT_TOOL_NAMES,
  RUN_COMMAND_DISABLED_SUMMARY,
  WEB_FETCH_DISABLED_SUMMARY,
  WEB_SEARCH_DISABLED_SUMMARY,
  toolUnavailableReason,
} from '../src/tools/availability.js'
import { ToolDiscoveryService } from '../src/tools/discovery.js'
import { FINANCE_DISABLED_SUMMARY } from '../src/tools/finance_shared.js'
import { toolAbortError, type ToolRuntime } from '../src/tools/registry.js'
import { appendUserMessage, makeEnv, makeTmpDir, routePassThrough, waitRunFinished } from './helpers.js'

type Env = ReturnType<typeof makeEnv>
type ToolCallRecordLike = { name: string; status: string; summary?: string }

/** M47：pin 网关门控开启（除专门验证门控的用例外，保证工具计数与环境无关） */
const NET_ENABLED: Parameters<typeof makeEnv>[0] = {
  webSearch: { enabled: true, apiKey: '', apiUrl: '', htmlUrl: '' },
  webFetchAllowedDomains: ['example.invalid'],
  allowRunCommand: true,
}

/** 播种：agents/{_protocol.md, development/{_group.yaml, pm/AGENT.md, critic/AGENT.md}}（与 m28 同构） */
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
  // pm：不声明 tools（缺省 = 全部已注册工具）；critic：小集合白名单（发现不启用）
  fs.writeFileSync(path.join(agentsDir, 'development', 'pm', 'AGENT.md'), agentMd('pm', '产品经理'))
  fs.writeFileSync(
    path.join(agentsDir, 'development', 'critic', 'AGENT.md'),
    agentMd('critic', '挑刺官', ['tools: [read_file, web_fetch]']),
  )
}

/** 与 helpers.makeEnv 相同依赖 + 可覆盖 toolSearch / isGitMode（缺省与 helpers 一致：workspace 判定） */
function makeEngine(
  env: Env,
  opts: { toolSearch?: ToolDiscoveryService; isGitMode?: (sessionId: string) => boolean } = {},
): Engine {
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
    toolSearch: opts.toolSearch,
    isGitMode: opts.isGitMode ?? ((sessionId) => env.workspace.isGitMode(sessionId)),
  })
}

/** 覆写 Provider 剧本：记录模型侧工具清单与 system（发现区块断言用） */
function scriptProvider(
  env: Env,
  script: (round: number) => LlmChunk[],
): { toolsLists: string[][]; systems: string[] } {
  const toolsLists: string[][] = []
  const systems: string[] = []
  const provider = env.provider as unknown as {
    chatStream: (req: ChatRequest, signal: AbortSignal) => AsyncIterable<LlmChunk>
  }
  let round = 0
  provider.chatStream = async function* (req, signal) {
    // M48：平台路由请求直通（不占 round / 不记工具清单与 system）
    const route = routePassThrough(req)
    if (route) {
      for (const chunk of route) yield chunk
      return
    }
    toolsLists.push((req.tools ?? []).map((t) => t.name))
    systems.push(req.system)
    const chunks = script(round++)
    for (const chunk of chunks) {
      if (signal.aborted) throw abortError()
      yield chunk
    }
  }
  return { toolsLists, systems }
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

describe('M47：环境门控单一事实来源（toolUnavailableReason）', () => {
  const base = loadConfig()
  const off = {
    ...base,
    webSearch: { ...base.webSearch, enabled: false },
    webFetchAllowedDomains: [],
    allowRunCommand: false,
  }
  const on = {
    ...base,
    webSearch: { ...base.webSearch, enabled: true },
    webFetchAllowedDomains: ['example.com'],
    allowRunCommand: true,
  }

  it('未启用 → 统一「未启用」文案（含配置指引，可行动）', () => {
    expect(toolUnavailableReason('web_search', off)).toBe(WEB_SEARCH_DISABLED_SUMMARY)
    expect(toolUnavailableReason('web_fetch', off)).toBe(WEB_FETCH_DISABLED_SUMMARY)
    expect(toolUnavailableReason('run_command', off)).toBe(RUN_COMMAND_DISABLED_SUMMARY)
  })

  it('已启用 / 无关工具 → 无门控（不误伤）', () => {
    for (const name of ['web_search', 'web_fetch', 'run_command', 'git_status', 'read_file', 'fin_quote']) {
      expect(toolUnavailableReason(name, on)).toBeUndefined()
    }
    // 联网门关闭不影响其他工具
    expect(toolUnavailableReason('read_file', off)).toBeUndefined()
    expect(toolUnavailableReason('git_status', off)).toBeUndefined()
  })
})

describe('M47：执行期精确提示（未启用 / 参数校验本地化）', () => {
  const runtime = {} as ToolRuntime

  it('fin_* 整组未启用：不注册但「已知」→ 执行期给配置指引（非泛化「未知工具」）', async () => {
    const env = makeEnv({ financeEnabled: false })
    expect(env.tools.list().some((tool) => tool.name.startsWith('fin_'))).toBe(false)
    expect(env.tools.unavailableNames()).toContain('fin_quote')
    const result = await env.tools.execWithAbort('fin_quote', { symbols: ['600519'] }, runtime)
    expect(result.ok).toBe(false)
    expect(result.summary).toBe(FINANCE_DISABLED_SUMMARY)
    // 真·未知工具仍走通用报错（不误标为「未启用」）
    const unknown = await env.tools.execWithAbort('no_such_tool', {}, runtime)
    expect(unknown.summary).toContain('未知工具')
  })

  it('必填参数缺失 → 中文「为必填项」（不再透出 zod 英文 Required）', async () => {
    const env = makeEnv()
    const result = await env.tools.execWithAbort('tool_search', {}, runtime)
    expect(result.ok).toBe(false)
    expect(result.summary).toBe('参数校验失败：query 为必填项')
  })
})

describe('M47：引擎清单门控（未启用工具不进 schema 与可发现范围）', () => {
  it('联网三工具关闭 → 不进模型清单（同集合下 read_file 等在列）', async () => {
    const agentsDir = path.join(makeTmpDir('ma-m47-'), 'agents')
    seedAgents(agentsDir)
    const env = makeEnv({
      agentsDir,
      financeEnabled: false,
      webSearch: { enabled: false, apiKey: '', apiUrl: '', htmlUrl: '' },
      webFetchAllowedDomains: [],
      allowRunCommand: false,
    })
    const engine = makeEngine(env) // 不装配 toolSearch：全量清单（仅隐藏 tool_search）
    const session = env.sessions.create(['pm'], 'M47 环境门控')
    const { toolsLists } = scriptProvider(env, () => [handoffUser, done])
    await runTurn(engine, env, session.id, '打个招呼')
    const tools = toolsLists[0]!
    expect(tools).not.toContain('web_fetch')
    expect(tools).not.toContain('web_search')
    expect(tools).not.toContain('run_command')
    expect(tools).toContain('read_file')
    expect(tools).toContain('write_file')
    // 59 − 3（联网/命令被环境门过滤）− 6（git：sandbox 会话被模式门过滤）− 1（tool_search：未装配发现）
    expect(tools).toHaveLength(49)
  })

  it('发现启用（大集合）：未启用工具与 git 不进 <tool_discovery> 可检索范围', async () => {
    const agentsDir = path.join(makeTmpDir('ma-m47-'), 'agents')
    seedAgents(agentsDir)
    const env = makeEnv({
      agentsDir,
      financeEnabled: false,
      webSearch: { enabled: false, apiKey: '', apiUrl: '', htmlUrl: '' },
      webFetchAllowedDomains: [],
      allowRunCommand: false,
    })
    const engine = makeEngine(env, { toolSearch: new ToolDiscoveryService() })
    const session = env.sessions.create(['pm'], 'M47 发现范围')
    const { systems } = scriptProvider(env, () => [handoffUser, done])
    await runTurn(engine, env, session.id, '打个招呼')
    const system = systems[systems.length - 1]!
    expect(system).toContain('<tool_discovery>')
    expect(system).not.toContain('联网（')
    expect(system).not.toContain('命令执行（')
    expect(system).not.toContain('Git（')
    // 类别概览仍含可达的重型工具（证明区块本身在注入，而非整体缺失）
    expect(system).toContain('数据库（4 个）')
  })

  it('会话模式门控：isGitMode=false（sandbox）→ git 工具不可见；true（repo）→ 可见', async () => {
    const agentsDir = path.join(makeTmpDir('ma-m47-'), 'agents')
    seedAgents(agentsDir)
    const env = makeEnv({ agentsDir, financeEnabled: false, ...NET_ENABLED })
    const session = env.sessions.create(['pm'], 'M47 模式门控')

    const hidden = scriptProvider(env, () => [handoffUser, done])
    await runTurn(makeEngine(env, { isGitMode: () => false }), env, session.id, '第一轮')
    const hiddenTools = hidden.toolsLists[0]!
    for (const name of GIT_TOOL_NAMES) expect(hiddenTools).not.toContain(name)
    expect(hiddenTools).toHaveLength(52) // 59 − 6（git）− 1（tool_search）

    const shown = scriptProvider(env, () => [handoffUser, done])
    await runTurn(makeEngine(env, { isGitMode: () => true }), env, session.id, '第二轮')
    const shownTools = shown.toolsLists[0]!
    for (const name of GIT_TOOL_NAMES) expect(shownTools).toContain(name)
    expect(shownTools).toHaveLength(58) // 59 − 1（tool_search）
  })
})

describe('M47：tool_search 未启用发现 → 直接可用（非失败语义）', () => {
  it('小集合（发现未启用）：脚本化调用 → ok + 直接可用，且不写失败指标', async () => {
    const agentsDir = path.join(makeTmpDir('ma-m47-'), 'agents')
    seedAgents(agentsDir)
    const env = makeEnv({ agentsDir, financeEnabled: false, ...NET_ENABLED })
    const engine = makeEngine(env, { toolSearch: new ToolDiscoveryService() })
    const session = env.sessions.create(['critic'], 'M47 直接可用')
    scriptProvider(env, (round) =>
      round === 0 ? [toolCall('tool_search', { query: '数据库' }), done] : [handoffUser, done],
    )
    await runTurn(engine, env, session.id, '查数据库')
    const entry = lastToolCalls(env, session.id).find((call) => call.name === 'tool_search')!
    expect(entry.status).toBe('ok')
    expect(entry.summary).toContain('直接可用')
    expect(env.metrics.summary().find((row) => row.toolName === 'tool_search')?.failures ?? 0).toBe(0)
  })
})

describe('M47：中断语义（用户停止 ≠ 工具失败）', () => {
  it('停止运行：运行中的工具 → status=stopped，不写失败指标', async () => {
    const agentsDir = path.join(makeTmpDir('ma-m47-'), 'agents')
    seedAgents(agentsDir)
    const env = makeEnv({ agentsDir, financeEnabled: false, ...NET_ENABLED })
    let started = false
    env.tools.register({
      name: 'slow_probe',
      description: '测试用慢工具（挂起等待中断信号）',
      parameters: { type: 'object', properties: {} },
      schema: z.object({}),
      execute: (_args: unknown, ctx: ToolRuntime) =>
        new Promise((_resolve, reject) => {
          started = true
          ctx.signal?.addEventListener('abort', () => reject(toolAbortError()), { once: true })
        }),
    })
    const engine = makeEngine(env)
    const session = env.sessions.create(['pm'], 'M47 中断')
    scriptProvider(env, (round) => (round === 0 ? [toolCall('slow_probe'), done] : [handoffUser, done]))

    const message = appendUserMessage(env, session.id, '慢操作')
    const { runId } = engine.launch(session.id, message.id)
    for (let i = 0; i < 300 && !started; i++) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(started).toBe(true)
    engine.stop(runId)
    await waitRunFinished(engine, runId)

    const entry = lastToolCalls(env, session.id).find((call) => call.name === 'slow_probe')!
    expect(entry.status).toBe('stopped')
    expect(entry.summary).toContain('已停止')
    // 中断不落失败指标（该工具既无失败记录，也允许整体无记录）
    expect(env.metrics.summary().find((row) => row.toolName === 'slow_probe')?.failures ?? 0).toBe(0)
  })
})

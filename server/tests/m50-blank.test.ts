/**
 * M50：空场景（blank）—— 不引入任何业务角色，单助手直聊（通用助手 general）。
 *
 * 覆盖：
 * - 资产：blank 场景居首（order=1、chain=[general]）/ 场景协议装载 /
 *   general 白名单差集（注册清单仅 handoff 未覆盖 —— 单助手不参与接力）；
 * - 直通路由：单成员编制未 @ 消息直达本人（零 platform_route 请求、零 routing trace）；
 * - 收尾：mentions=['user'] + notify:awaiting-user + run:end completed（无系统事件条）；
 * - 隔离：roster_catalog 不含 blank 场景 / general；PRS 幻觉召集 general 被 knownIds 丢弃；
 *   handoff(通用助手) 被 resolveAgent 过滤 → 拒「不在场」且不自动召集；
 * - 实时派生：编制增为 [general, pm] → 直通退出、恢复平台路由；
 * - M28 分层：general 回合核心常驻（tool_search / 文件 / 计算在列）+ 重型工具延迟
 *   （browser_* / web_* / run_command / db_* 不在列）；system 注入 <tool_discovery>；
 *   tool_search 激活后下一子轮并入清单（按需发现闭环）；
 * - 真 Mock 剧本全链（eval blank-scene 同款）：财务快报 → write_file 落盘 + @用户
 *   收尾 completed（general 白名单常驻 write_plan / submit_review 不误触发范式分支）。
 */
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@multi-agent/shared'
import type { ChatRequest, LlmChunk } from '../src/llm/provider.js'
import { Engine } from '../src/orchestration/engine.js'
import { ROUTER_AGENT_ID } from '../src/orchestration/platform-router.js'
import { buildRosterCatalogBlock } from '../src/orchestration/roster-catalog.js'
import { ToolDiscoveryService } from '../src/tools/discovery.js'
import { matchesToolPattern } from '../src/tools/registry.js'
import { appendUserMessage, makeEnv, routePassThrough, waitRunFinished } from './helpers.js'

type Env = ReturnType<typeof makeEnv>

// ---------- 脚本化 Provider ----------

interface Hit {
  agentId: string
  /** 平台路由请求（responseFormat 非空）标记 */
  routed: boolean
}

function installScript(env: Env, script: (req: ChatRequest) => LlmChunk[]): { hits: Hit[]; requests: ChatRequest[] } {
  const hits: Hit[] = []
  const requests: ChatRequest[] = []
  const provider = env.provider as unknown as {
    chatStream: (req: ChatRequest, signal: AbortSignal) => AsyncIterable<LlmChunk>
  }
  provider.chatStream = async function* (req) {
    requests.push(req)
    hits.push({ agentId: req.meta.agentId, routed: Boolean(req.responseFormat) })
    for (const chunk of script(req)) yield chunk
  }
  return { hits, requests }
}

const textChunk = (text: string): LlmChunk => ({ type: 'text', text })
const doneChunk: LlmChunk = { type: 'done' }
const routePlanChunk = (plan: unknown): LlmChunk[] => [textChunk(JSON.stringify(plan)), doneChunk]
const handoffChunk = (target: string): LlmChunk => ({
  type: 'tool_calls',
  calls: [
    {
      id: `c_${target}_${Math.random().toString(36).slice(2, 6)}`,
      name: 'handoff',
      arguments: JSON.stringify({ target, reason: '测试转交' }),
    },
  ],
})
const toolCallChunk = (name: string, args: Record<string, unknown> = {}): LlmChunk => ({
  type: 'tool_calls',
  calls: [{ id: `call_${name}`, name, arguments: JSON.stringify(args) }],
})

/** 上一消息为工具结果时的回灌正文 */
function lastToolContent(req: ChatRequest): string {
  const last = req.messages[req.messages.length - 1]
  return last?.role === 'tool' ? String(last.content ?? '') : ''
}

const afterToolResult = (req: ChatRequest): boolean =>
  req.messages.length > 0 && req.messages[req.messages.length - 1]?.role === 'tool'

/** 交还用户式收尾：首轮 handoff(user) → 次轮文本（避免触发 fallback 继续找人） */
const handToUser = (req: ChatRequest): LlmChunk[] =>
  afterToolResult(req) ? [textChunk('已完成，交还用户。')] : [handoffChunk('user')]

function agentMessages(env: Env, sessionId: string, agentId: string): ChatMessage[] {
  return env.sessions.messages(sessionId).filter((m) => m.role === 'agent' && m.agentId === agentId)
}

type ToolCallRecordLike = { name: string; status: string; summary?: string }

/** 读取最近一条 Agent 消息的工具调用记录（激活闭环断言用） */
function lastToolCalls(env: Env, sessionId: string): ToolCallRecordLike[] {
  const messages = env.sessions.messages(sessionId).filter((m) => m.role === 'agent')
  const last = messages[messages.length - 1]
  return (last?.toolCalls ?? []) as unknown as ToolCallRecordLike[]
}

const routingTraces = (env: Env, runId: string): Array<{ payload: Record<string, unknown> }> =>
  env.events.listByRun(runId).filter((e) => e.type === 'routing:dispatched') as Array<{
    payload: Record<string, unknown>
  }>

// ---------- M28 装配（m28-engine-search.test.ts 同款） ----------

/** M47：pin 网关门控开启（断言的是「分层」而非「环境不可用」） */
const NET_ENABLED: Parameters<typeof makeEnv>[0] = {
  webSearch: { enabled: true, apiKey: '', apiUrl: '', htmlUrl: '' },
  webFetchAllowedDomains: ['example.invalid'],
  allowRunCommand: true,
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

// ---------- 资产与直通路由 ----------

describe('M50：空场景资产与直通路由', () => {
  it('① 资产：blank 居首 / 协议装载 / general 白名单差集（仅 handoff 未覆盖）', () => {
    const env = makeEnv()

    // 场景与角色排序：blank（order=1）居首，general 为首位角色
    expect(env.prompts.groups()[0]?.id).toBe('blank')
    expect(env.prompts.groups()[0]?.chain).toEqual(['general'])
    expect(env.prompts.list()[0]?.id).toBe('general')

    const general = env.prompts.get('general')!
    expect(general.group).toBe('blank')
    // 单助手：无 handoff（不参与接力）、无灵魂（经典模式）
    expect(general.handoff).toEqual([])
    expect(env.prompts.soul('general')).toBeUndefined()

    // 场景协议装载
    const protocol = env.prompts.groupProtocol('blank')
    expect(protocol).toContain('<scene_protocol scene="blank">')
    expect(protocol).toContain('单助手规则')

    // 白名单差集：注册清单中仅 handoff 未被覆盖（fin_* / mcp__* 通配参与匹配）
    const missed = env.tools.list().map((t) => t.name).filter((name) => !matchesToolPattern(general.tools, name))
    expect(missed).toEqual(['handoff'])
    // 白名单精确条目全部真实存在（防资产笔误）
    const registered = new Set(env.tools.list().map((t) => t.name))
    for (const entry of general.tools ?? []) {
      if (!entry.endsWith('*')) expect(registered.has(entry), `白名单工具不存在：${entry}`).toBe(true)
    }
  })

  it('② 直通：单成员编制未 @ 消息直达本人（零 PRS 请求、零 routing trace）', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['general'], 'M50 直通')
    const { hits, requests } = installScript(env, handToUser)
    const message = appendUserMessage(env, session.id, '帮我查一下这个说法对不对')
    const { runId, queue } = env.engine.launch(session.id, message.id)
    await waitRunFinished(env.engine, runId)

    expect(queue).toEqual(['general'])
    expect(hits[0].agentId).toBe('general')
    expect(hits.some((h) => h.routed)).toBe(false)
    expect(requests.some((r) => r.responseFormat?.name === 'platform_route')).toBe(false)
    expect(routingTraces(env, runId)).toHaveLength(0)
    expect(agentMessages(env, session.id, 'general')).toHaveLength(1)
  })

  it('③ 收尾：mentions=[user] + notify:awaiting-user + run:end completed（无系统事件条）', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['general'], 'M50 收尾')
    installScript(env, handToUser)
    const message = appendUserMessage(env, session.id, '写一段自我介绍')
    const { runId } = env.engine.launch(session.id, message.id)
    await waitRunFinished(env.engine, runId)

    const replies = agentMessages(env, session.id, 'general')
    expect(replies).toHaveLength(1)
    expect(replies[0].mentions).toEqual(['user'])
    expect(env.published.some((n) => n.type === 'notify:awaiting-user')).toBe(true)
    expect(env.events.listByRun(runId).find((e) => e.type === 'run:end')?.payload.reason).toBe('completed')
    // 单助手场景不落任何系统事件条（无召集 / 无降级提示）
    expect(env.sessions.messages(session.id).some((m) => m.role === 'system')).toBe(false)
  })
})

// ---------- 隔离：general 不可被平台召集 / 不可被转交 ----------

describe('M50：隔离（general 不进可召集目录 / PRS 与 handoff 均不可达）', () => {
  it('可召集目录（roster_catalog）不含 blank 场景与 general；业务角色照常', () => {
    const env = makeEnv()
    const block = buildRosterCatalogBlock(env.prompts, [])
    expect(block).toContain('chief')
    expect(block).not.toContain('general')
    expect(block).not.toContain('空场景')
  })

  it('PRS 幻觉召集 general → knownIds 过滤丢弃（无召集、无落库、无事件条）', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm'], 'M50 幻觉召集')
    const { hits } = installScript(env, (req) =>
      req.responseFormat
        ? routePlanChunk({
            members: ['general', 'nope'],
            assignments: [{ agentId: 'pm', task: '澄清需求' }],
            reason: '幻觉测试',
          })
        : handToUser(req),
    )
    const message = appendUserMessage(env, session.id, '帮我规划个活动')
    const { runId } = env.engine.launch(session.id, message.id)
    await waitRunFinished(env.engine, runId)

    expect(hits[0]).toMatchObject({ agentId: ROUTER_AGENT_ID, routed: true })
    // members 全被丢弃：编制不变、无系统事件条、trace 无 members
    expect(env.sessions.getSession(session.id)?.participantIds).toEqual(['pm'])
    expect(env.sessions.messages(session.id).some((m) => m.role === 'system')).toBe(false)
    const traces = routingTraces(env, runId)
    expect(traces.some((e) => e.payload.assignments !== undefined)).toBe(true)
    expect(traces.some((e) => e.payload.members !== undefined)).toBe(false)
    // 派发照常：pm 接手
    expect(agentMessages(env, session.id, 'pm')).toHaveLength(1)
  })

  it('handoff(通用助手) → resolveAgent 过滤：拒「不在场」且不自动召集', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['backend'], 'M50 拒绝转交')
    const { requests } = installScript(env, (req) => {
      if (req.meta.agentId !== 'backend') return handToUser(req)
      if (!afterToolResult(req)) return [handoffChunk('通用助手')]
      if (lastToolContent(req).includes('不在场')) return [handoffChunk('user')]
      return handToUser(req)
    })
    const message = appendUserMessage(env, session.id, '@backend 处理下这个')
    const { runId, queue } = env.engine.launch(session.id, message.id)
    await waitRunFinished(env.engine, runId)

    expect(queue).toEqual(['backend'])
    // 拒绝回执：不在场（无「将自动召集」路径）
    const toolReq = requests.find((r) => r.meta.agentId === 'backend' && afterToolResult(r))!
    expect(lastToolContent(toolReq)).toContain('不在场')
    expect(lastToolContent(toolReq)).not.toContain('自动召集')
    // 无自动召集：编制不变、无事件条、无成员变更通知
    expect(env.sessions.getSession(session.id)?.participantIds).toEqual(['backend'])
    expect(env.sessions.messages(session.id).some((m) => m.role === 'system')).toBe(false)
    expect(env.published.some((n) => n.type === 'notify:members-changed')).toBe(false)
    expect(env.events.listByRun(runId).find((e) => e.type === 'run:end')?.payload.reason).toBe('completed')
  })
})

// ---------- 实时派生：编制变化即退出直通 ----------

describe('M50：直通实时派生', () => {
  it('编制增为 [general, pm]：未 @ 消息恢复平台路由（soloBlank 不成立）', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['general', 'pm'], 'M50 加人退出')
    const { hits } = installScript(env, (req) => routePassThrough(req) ?? handToUser(req))
    const message = appendUserMessage(env, session.id, '帮我看看这个需求怎么推进')
    const { runId, queue } = env.engine.launch(session.id, message.id)
    await waitRunFinished(env.engine, runId)

    expect(queue).toEqual([])
    expect(hits[0]).toMatchObject({ agentId: ROUTER_AGENT_ID, routed: true })
    const traces = routingTraces(env, runId)
    expect(traces.some((e) => e.payload.assignments !== undefined)).toBe(true)
    // 派发编制首位（general：list() 场景序 blank 最前）接手
    expect(agentMessages(env, session.id, 'general')).toHaveLength(1)
    expect(env.sessions.getSession(session.id)?.participantIds).toEqual(['general', 'pm'])
  })
})

// ---------- M28 分层：核心常驻 + 重型工具按需（tool_search 闭环） ----------

describe('M50：M28 工具分层（核心常驻 + 重型工具 tool_search 按需）', () => {
  it('general 回合：核心在列、重型延迟、发现区块注入；激活后下一子轮并入', async () => {
    const env = makeEnv({ ...NET_ENABLED })
    const engine = makeEngine(env, new ToolDiscoveryService())
    const session = env.sessions.create(['general'], 'M50 工具分层')

    const systems: string[] = []
    const toolsLists: string[][] = []
    const provider = env.provider as unknown as {
      chatStream: (req: ChatRequest, signal: AbortSignal) => AsyncIterable<LlmChunk>
    }
    let round = 0
    provider.chatStream = async function* (req) {
      // 平台路由请求直通（本用例为直通会话，防御性保留）
      const route = routePassThrough(req)
      if (route) {
        for (const chunk of route) yield chunk
        return
      }
      systems.push(req.system)
      toolsLists.push((req.tools ?? []).map((t) => t.name))
      const chunks = round === 0 ? [toolCallChunk('tool_search', { query: '联网搜索' }), doneChunk] : handToUser(req)
      round++
      for (const chunk of chunks) yield chunk
    }

    const message = appendUserMessage(env, session.id, '帮我联网查个资料')
    const { runId } = engine.launch(session.id, message.id)
    await waitRunFinished(engine, runId)

    const first = toolsLists[0]!
    // 核心常驻：文件 / 计算 / 发现入口在列
    expect(first).toContain('tool_search')
    expect(first).toContain('read_file')
    expect(first).toContain('write_file')
    expect(first).toContain('calc')
    // 重型工具延迟：浏览器 / 联网 / 命令 / 数据库不在首轮清单；handoff 白名单外
    expect(first).not.toContain('browser_open')
    expect(first).not.toContain('web_search')
    expect(first).not.toContain('web_fetch')
    expect(first).not.toContain('run_command')
    expect(first).not.toContain('db_query')
    expect(first).not.toContain('handoff')
    // L3 发现区块：system 注入类别概览
    expect(systems[0]).toContain('<tool_discovery>')
    expect(systems[0]).toContain('tool_search')
    // 激活闭环：检索命中 → 下一子轮清单并入（与回灌激活名单一致）
    expect(toolsLists.length).toBeGreaterThan(1)
    const second = toolsLists[1]!
    const searchEntry = lastToolCalls(env, session.id).find((c) => c.name === 'tool_search')!
    expect(searchEntry.status).toBe('ok')
    expect(searchEntry.summary).toContain('已激活')
    const activated = searchEntry.summary!.replace(/^已激活 \d+ 个工具：/, '').split('、')
    expect(activated.length).toBeGreaterThan(0)
    for (const name of activated) expect(second).toContain(name)
    expect(second.some((name) => name === 'web_search' || name === 'web_fetch')).toBe(true)
  })
})

// ---------- 真 Mock 剧本全链（eval blank-scene 同款） ----------

describe('M50：真 Mock 剧本 × general solo', () => {
  it('财务快报：write_file 落盘 + @用户收尾 + completed（无计划卡挂起）', async () => {
    const env = makeEnv({ ...NET_ENABLED })
    const engine = makeEngine(env, new ToolDiscoveryService())
    const session = env.sessions.create(['general'], 'M50 真剧本')

    // 不替换 provider：走真 Mock 剧本 —— general 白名单常驻 write_plan / submit_review，
    // 普通消息不得被误判为规划 / 评审范式（误判将发出 write_plan 挂起且无交付件）
    const message = appendUserMessage(env, session.id, '整理一份财务数据快报：营收 120 万、成本 68 万，现金流为正。')
    const { runId } = engine.launch(session.id, message.id)
    await waitRunFinished(engine, runId)

    const replies = agentMessages(env, session.id, 'general')
    expect(replies).toHaveLength(1)
    // 脚本化工具批：交付件落盘（工具卡全 ok，无 write_plan）
    expect(replies[0].toolCalls?.map((t) => t.name)).toEqual(['write_todos', 'write_file'])
    expect(replies[0].toolCalls?.every((t) => t.status === 'ok')).toBe(true)
    expect(replies[0].mentions).toEqual(['user'])
    expect(env.artifacts.list(session.id).map((f) => f.path)).toContain('docs/交付件-财务.md')
    expect(env.events.listByRun(runId).find((e) => e.type === 'run:end')?.payload.reason).toBe('completed')
    // 单助手：无系统事件条（无召集 / 无降级）
    expect(env.sessions.messages(session.id).some((m) => m.role === 'system')).toBe(false)
  })
})

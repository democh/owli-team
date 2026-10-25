/**
 * M48：调度平台化 —— 平台路由步（PRS）与未在场 handoff 自动增援（测试替身 Provider 脚本化）。
 *
 * 覆盖：
 * - launch 路由矩阵：@ 直达（零变化）/ 消息级显式 plan·review → 编制首位 /
 *   未 @ → PRS（非角色回合：不产生消息、不占波次）/ 空编制开场 → PRS 组队；
 * - PRS 降级：有编制失败 → 在场首位接手（fallback trace）；空编制失败 → 事件条提示并收尾；
 * - 会话级 planFirst 顺延：首波消费规划范式（PRS 不占波次）；
 * - 插话补位：未 @ 插话 → 首位未发言者（不再有调度官优先）；
 * - 未在场 handoff 自动增援：转交资产存在但未在场的角色 → 平台落库召集后接手；
 * - handoff 工具解析矩阵：在场 / 未在场资产（将自动召集）/ 完全未知 / 未注入解析器；
 * - coerceRoutePlan 容错矩阵：未知 / 已在场 / 'user' 丢弃、去重截断、上限；
 * - POST /sessions：空选择 = 零编制开场（原样落库，不填充）；显式选择链序不变；
 * - MockProvider 路由剧本：零编制开聊 → 召集 pm/architect/qa → 派发 pm → 全链接力至交还。
 */
import type { AddressInfo } from 'node:net'
import express from 'express'
import { describe, expect, it } from 'vitest'
import type { ChatMessage, TurnMode } from '@multi-agent/shared'
import type { ApiDeps } from '../src/routes/index.js'
import { createSessionsRouter } from '../src/routes/sessions.js'
import type { ChatRequest, LlmChunk } from '../src/llm/provider.js'
import { ROUTER_AGENT_ID, coerceRoutePlan } from '../src/orchestration/platform-router.js'
import type { ToolRuntime } from '../src/tools/registry.js'
import { appendUserMessage, makeEnv, waitRunFinished } from './helpers.js'

type Env = ReturnType<typeof makeEnv>

// ---------- 脚本化 Provider ----------

interface Hit {
  agentId: string
  mode?: TurnMode
  /** M48：平台路由请求（responseFormat 非空）标记 */
  routed: boolean
}

function installScript(
  env: Env,
  script: (req: ChatRequest) => LlmChunk[],
): { hits: Hit[]; requests: ChatRequest[] } {
  const hits: Hit[] = []
  const requests: ChatRequest[] = []
  const provider = env.provider as unknown as {
    chatStream: (req: ChatRequest, signal: AbortSignal) => AsyncIterable<LlmChunk>
  }
  provider.chatStream = async function* (req) {
    requests.push(req)
    hits.push({ agentId: req.meta.agentId, mode: req.meta.mode, routed: Boolean(req.responseFormat) })
    for (const chunk of script(req)) yield chunk
  }
  return { hits, requests }
}

const textChunk = (text: string): LlmChunk => ({ type: 'text', text })
const doneChunk: LlmChunk = { type: 'done' }
/** 平台路由剧本：结构化 JSON 输出（引擎 extractJson 解析） */
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

const routingTraces = (env: Env, runId: string): Array<{ payload: Record<string, unknown> }> =>
  env.events.listByRun(runId).filter((e) => e.type === 'routing:dispatched') as Array<{
    payload: Record<string, unknown>
  }>

// ---------- launch 路由矩阵 ----------

describe('M48：launch 路由矩阵', () => {
  it('① @ 直达：首发队列 = 被 @ 成员，平台路由不介入（零变化）', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['chief', 'backend'], 'M48 @直达')
    const { hits } = installScript(env, handToUser)
    const message = appendUserMessage(env, session.id, '@backend 帮我看下这个报错')
    const { runId, queue } = env.engine.launch(session.id, message.id)
    await waitRunFinished(env.engine, runId)

    expect(queue).toEqual(['backend'])
    expect(hits[0].agentId).toBe('backend')
    expect(hits.some((h) => h.routed)).toBe(false)
    expect(routingTraces(env, runId)).toHaveLength(0)
  })

  it('② 消息级显式 plan → 编制首位（不走 PRS，直接投场景首棒）', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm', 'backend'], 'M48 显式范式')
    const { hits } = installScript(env, handToUser)
    const message = appendUserMessage(env, session.id, '先出个登录改造计划再动手')
    const { runId, queue } = env.engine.launch(session.id, message.id, { mode: 'plan' })
    await waitRunFinished(env.engine, runId)

    expect(queue).toEqual(['pm'])
    expect(hits[0].agentId).toBe('pm')
    expect(hits[0].mode).toBe('plan')
    expect(hits.some((h) => h.routed)).toBe(false)
    expect(env.sessions.messages(session.id).find((m) => m.id === message.id)?.mode).toBe('plan')
  })

  it('③ 未 @ 有编制 → PRS 派发（非角色回合：无消息、不占波次；任务便条注入）', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['backend', 'qa'], 'M48 路由派发')
    const { hits, requests } = installScript(env, (req) =>
      req.responseFormat
        ? routePlanChunk({
            members: [],
            assignments: [{ agentId: 'qa', task: '排查报错并给出结论' }],
            reason: '验证需要',
          })
        : handToUser(req),
    )
    const message = appendUserMessage(env, session.id, '看看这个报错是什么原因')
    const { runId, queue } = env.engine.launch(session.id, message.id)
    await waitRunFinished(env.engine, runId)

    // 路由决策：派发 qa（而非编制首位 backend）
    expect(queue).toEqual([])
    expect(hits[0]).toMatchObject({ agentId: ROUTER_AGENT_ID, routed: true })
    expect(agentMessages(env, session.id, 'qa')).toHaveLength(1)
    expect(agentMessages(env, session.id, 'backend')).toHaveLength(0)
    // 非角色回合：不产生 '__router__' 消息
    expect(env.sessions.messages(session.id).some((m) => m.agentId === ROUTER_AGENT_ID)).toBe(false)
    // 任务便条：接手者回合指令含「上一棒期望（来自 平台）」
    const qaReq = requests.find((r) => r.meta.agentId === 'qa')!
    const qaLast = String(qaReq.messages[qaReq.messages.length - 1]?.content ?? '')
    expect(qaLast).toContain('上一棒期望（来自 平台）：排查报错并给出结论')
    // trace 留痕：assignments 可审计；未召集（members 空）
    const traces = routingTraces(env, runId)
    expect(traces.some((e) => e.payload.assignments !== undefined)).toBe(true)
    expect(traces.some((e) => e.payload.members !== undefined)).toBe(false)
    expect(env.sessions.getSession(session.id)?.participantIds).toEqual(['backend', 'qa'])
  })

  it('④ 空编制开场 → PRS 组队：召集落库（事件条 + trace）后派发首棒', async () => {
    const env = makeEnv()
    const session = env.sessions.create([], 'M48 空编制组队')
    const { hits } = installScript(env, (req) =>
      req.responseFormat
        ? routePlanChunk({
            members: ['pm', 'architect', 'qa'],
            assignments: [{ agentId: 'pm', task: '澄清需求与验收标准' }],
            reason: '需要产品 / 架构 / 测试协作',
          })
        : handToUser(req),
    )
    const message = appendUserMessage(env, session.id, '帮我做一个登录功能')
    const { runId, queue } = env.engine.launch(session.id, message.id)
    await waitRunFinished(env.engine, runId)

    expect(queue).toEqual([])
    expect(hits[0]).toMatchObject({ agentId: ROUTER_AGENT_ID, routed: true })
    // 召集落库：成员表（编制链序）+ 「平台 召集了」事件条 + 广播
    expect(env.sessions.getSession(session.id)?.participantIds).toEqual(['pm', 'architect', 'qa'])
    const event = env.sessions.messages(session.id).find((m) => m.role === 'system')
    expect(event?.content).toBe('平台 召集了 费利、艾达、诺娃 加入协作（需要产品 / 架构 / 测试协作）')
    expect(env.published.some((n) => n.type === 'notify:members-changed')).toBe(true)
    // 派发首棒：pm 接手发言
    expect(agentMessages(env, session.id, 'pm')).toHaveLength(1)
    const traces = routingTraces(env, runId)
    expect(
      traces.some(
        (e) =>
          e.payload.source === 'route' &&
          JSON.stringify(e.payload.members) === JSON.stringify(['pm', 'architect', 'qa']),
      ),
    ).toBe(true)
    expect(traces.some((e) => e.payload.assignments !== undefined)).toBe(true)
  })

  it('会话级 planFirst：PRS 不占波次 —— 业务首波消费规划范式', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['backend'], 'M48 规划顺延', { planFirst: true })
    const { hits } = installScript(env, (req) =>
      req.responseFormat
        ? routePlanChunk({ members: [], assignments: [{ agentId: 'backend', task: '改登录流程' }], reason: '直接派发' })
        : handToUser(req),
    )
    const message = appendUserMessage(env, session.id, '改一下登录流程')
    const { runId } = env.engine.launch(session.id, message.id)
    await waitRunFinished(env.engine, runId)

    const routed = hits.filter((h) => h.routed)
    const backendHit = hits.find((h) => !h.routed && h.agentId === 'backend')!
    expect(routed).toHaveLength(1)
    expect(hits.findIndex((h) => h.routed)).toBeLessThan(hits.findIndex((h) => !h.routed && h.agentId === 'backend'))
    expect(backendHit.mode).toBe('plan')
  })
})

// ---------- PRS 降级 ----------

describe('M48：PRS 降级（绝不阻断主链路）', () => {
  it('有编制 + 路由失败 → 在场首位接手（fallback trace 可审计）', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['backend', 'qa'], 'M48 降级接手')
    const { hits } = installScript(env, (req) =>
      req.responseFormat ? [textChunk('抱歉，我无法理解这个请求'), doneChunk] : handToUser(req),
    )
    const message = appendUserMessage(env, session.id, '随便看看')
    const { runId } = env.engine.launch(session.id, message.id)
    await waitRunFinished(env.engine, runId)

    expect(hits[0].routed).toBe(true)
    expect(agentMessages(env, session.id, 'backend')).toHaveLength(1)
    expect(agentMessages(env, session.id, 'qa')).toHaveLength(0)
    const trace = routingTraces(env, runId).find((e) => e.payload.fallback === true)
    expect(trace).toBeTruthy()
    expect(env.events.listByRun(runId).find((e) => e.type === 'run:end')?.payload.reason).toBe('completed')
  })

  it('空编制 + 路由失败 → 系统事件条提示并收尾（不静默）', async () => {
    const env = makeEnv()
    const session = env.sessions.create([], 'M48 降级收尾')
    installScript(env, () => [textChunk('嗯'), doneChunk])
    const message = appendUserMessage(env, session.id, '帮我看个事情')
    const { runId } = env.engine.launch(session.id, message.id)
    await waitRunFinished(env.engine, runId)

    const system = env.sessions.messages(session.id).find((m) => m.role === 'system')
    expect(system?.content).toContain('平台未能为该需求匹配到合适的成员')
    expect(env.published.some((n) => n.type === 'notify:plan-updated')).toBe(true)
    expect(env.sessions.messages(session.id).filter((m) => m.role === 'agent')).toHaveLength(0)
    expect(env.events.listByRun(runId).find((e) => e.type === 'run:end')?.payload.reason).toBe('completed')
  })
})

// ---------- 插话补位 ----------

describe('M48：插话补位（未 @ 插话不触发 PRS）', () => {
  it('运行中插话且队列已空：首位未发言者接手（按 fresh 规则，非编制首位）', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['backend', 'qa'], 'M48 插话补位')
    const injectMessage = { id: '' }
    installScript(env, (req) => {
      if (req.meta.agentId === 'backend' && !afterToolResult(req) && !injectMessage.id) {
        const injected = appendUserMessage(env, session.id, '顺便说一句，优先保证稳定')
        injectMessage.id = injected.id
        env.engine.inject(session.id, injected.id)
      }
      return handToUser(req)
    })
    const message = appendUserMessage(env, session.id, '@backend 把发布流程重做一遍')
    const { runId, queue } = env.engine.launch(session.id, message.id)
    await waitRunFinished(env.engine, runId)

    expect(queue).toEqual(['backend'])
    // 补位命中 fresh[0]=qa（backend 已发言；不再是编制首位 backend 自己）
    expect(agentMessages(env, session.id, 'qa')).toHaveLength(1)
    expect(agentMessages(env, session.id, 'backend')).toHaveLength(1)
    // 插话补位不经 PRS
    expect(routingTraces(env, runId)).toHaveLength(0)
  })
})

// ---------- 未在场 handoff 自动增援 ----------

describe('M48：未在场 handoff 自动增援', () => {
  it('成员转交资产存在但未在场的角色 → 平台落库召集（事件条 + trace）后接手', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['backend'], 'M48 自动增援')
    // M86：单助手会话缺省为手动接力（不自动召唤）；本用例验证自动接力能力，显式开启
    env.sessions.setRelay(session.id, 'auto')
    const { requests } = installScript(env, (req) => {
      if (req.meta.agentId === 'backend') {
        return afterToolResult(req) ? [textChunk('已转交设计增援。')] : [handoffChunk('architect')]
      }
      return handToUser(req)
    })
    const message = appendUserMessage(env, session.id, '@backend 把发布页做出来')
    const { runId } = env.engine.launch(session.id, message.id)
    await waitRunFinished(env.engine, runId)

    // 自动召集落库：成员表 + 「平台 召集了 …（…转交时自动召集）」事件条
    expect(env.sessions.getSession(session.id)?.participantIds).toEqual(['backend', 'architect'])
    const event = env.sessions.messages(session.id).find((m) => m.role === 'system')
    expect(event?.content).toBe('平台 召集了 艾达 加入协作（马克斯 转交时自动召集）')
    expect(env.published.some((n) => n.type === 'notify:members-changed')).toBe(true)
    // 接手发言：architect 在同一 Run 内接手（无需手动邀请）
    expect(agentMessages(env, session.id, 'architect')).toHaveLength(1)
    // trace：source=handoff 可审计
    const trace = routingTraces(env, runId).find((e) => e.payload.source === 'handoff')
    expect(trace?.payload).toMatchObject({ members: ['architect'] })
    // handoff 工具回执：不再报「不在场」，改为「将自动召集」提示（回灌至 backend 的工具结果）
    const backendToolReq = requests.find((r) => r.meta.agentId === 'backend' && afterToolResult(r))!
    expect(lastToolContent(backendToolReq)).toContain('将自动召集')
    expect(env.events.listByRun(runId).find((e) => e.type === 'run:end')?.payload.reason).toBe('completed')
  })

  it('handoff 工具解析矩阵：在场放行 / 未在场资产放行并标注 / 未知拒绝 / 未注入解析器退回旧语义', async () => {
    const env = makeEnv()
    const tool = env.tools.get('handoff')!
    const run = (args: Record<string, unknown>, ctx: Partial<ToolRuntime>) =>
      tool.execute(args, ctx as ToolRuntime)

    // 在场成员：直接放行
    const present = await run(
      { target: 'backend', reason: '看个问题' },
      { participants: [{ id: 'backend', name: '马克斯' }] },
    )
    expect(present.ok).toBe(true)
    expect(present.handoff?.targets).toEqual(['backend'])

    // 未在场但资产存在：放行并标注「将自动召集」
    const absent = await run(
      { target: '艾达', reason: '需要设计' },
      {
        participants: [{ id: 'backend', name: '马克斯' }],
        resolveAgent: (token) => (token === '艾达' ? { id: 'architect', name: '艾达' } : undefined),
      },
    )
    expect(absent.ok).toBe(true)
    expect(absent.handoff?.targets).toEqual(['architect'])
    expect(absent.detail).toContain('将自动召集：艾达')

    // 完全未知：拒绝并给在场名单
    const unknown = await run(
      { target: 'nope', reason: '试试' },
      {
        participants: [{ id: 'backend', name: '马克斯' }],
        resolveAgent: () => undefined,
      },
    )
    expect(unknown.ok).toBe(false)
    expect(unknown.summary).toContain('「nope」不在场')

    // 混合目标：资产存在者放行、未知者列入「部分未转交」
    const mixed = await run(
      { target: ['architect', 'nope'], reason: '并行' },
      {
        participants: [{ id: 'backend', name: '马克斯' }],
        resolveAgent: (token) => (token === 'architect' ? { id: 'architect', name: '艾达' } : undefined),
      },
    )
    expect(mixed.ok).toBe(true)
    expect(mixed.handoff?.targets).toEqual(['architect'])
    expect(mixed.detail).toContain('将自动召集：艾达')
    expect(mixed.detail).toContain('部分未转交')

    // 未注入解析器（旧测试替身）：未在场仍按旧语义拒绝
    const legacy = await run({ target: 'architect', reason: '旧语义' }, { participants: [{ id: 'backend', name: '马克斯' }] })
    expect(legacy.ok).toBe(false)
    expect(legacy.summary).toContain('不在场')
  })
})

// ---------- coerceRoutePlan 容错矩阵 ----------

describe('M48：coerceRoutePlan 容错', () => {
  const opts = { presentIds: ['backend', 'qa'], knownIds: new Set(['backend', 'qa', 'pm', 'architect']) }

  it('members：仅保留「资产存在且未在场」；未知 / 已在场 / user 与重复一律丢弃', () => {
    const plan = coerceRoutePlan(
      { members: ['pm', 'backend', 'nope', 'user', 'pm', ' architect '], assignments: [{ agentId: 'pm', task: '澄清' }], reason: 'r' },
      opts,
    )
    expect(plan?.members).toEqual(['pm', 'architect'])
  })

  it('assignments：未知 / user / 空任务丢弃；agentId 按在场∪members 判定；去重', () => {
    const plan = coerceRoutePlan(
      {
        members: ['pm'],
        assignments: [
          { agentId: 'pm', task: '先澄清需求' },
          { agentId: 'pm', task: '重复项被去重' },
          { agentId: 'nope', task: '未知' },
          { agentId: 'user', task: '交还' },
          { agentId: 'qa', task: '  ' },
        ],
        reason: 'r',
      },
      opts,
    )
    expect(plan?.assignments).toEqual([{ agentId: 'pm', task: '先澄清需求' }])
  })

  it('上限与截断：assignments 截断至 4 位；超长 task 折叠截断', () => {
    const long = 'x'.repeat(200)
    const plan = coerceRoutePlan(
      {
        members: ['pm', 'architect', 'devops'],
        assignments: [
          { agentId: 'backend', task: long },
          { agentId: 'qa', task: 't2' },
          { agentId: 'pm', task: 't3' },
          { agentId: 'architect', task: 't4' },
          { agentId: 'devops', task: 't5（第 5 位超上限被截断）' },
        ],
        reason: 'r',
      },
      { presentIds: ['backend', 'qa'], knownIds: new Set(['backend', 'qa', 'pm', 'architect', 'devops']) },
    )
    expect(plan?.assignments).toHaveLength(4)
    expect(plan?.assignments.map((a) => a.agentId)).toEqual(['backend', 'qa', 'pm', 'architect'])
    expect(plan?.assignments[0].task.length).toBeLessThan(130)
    expect(plan?.assignments[0].task.endsWith('…')).toBe(true)
  })

  it('无有效派发 / 输入非对象 → null（引擎按失败路径降级）', () => {
    expect(coerceRoutePlan(undefined, opts)).toBeNull()
    expect(coerceRoutePlan({ members: ['pm'], assignments: [], reason: 'r' }, opts)).toBeNull()
    expect(coerceRoutePlan({ members: ['pm'], assignments: [{ agentId: 'nope', task: 'x' }], reason: 'r' }, opts)).toBeNull()
  })
})

// ---------- POST /sessions：零编制创建语义 ----------

async function mountSessionsApi(env: Env): Promise<{ url: string; close: () => Promise<void> }> {
  const deps = env as unknown as ApiDeps
  const app = express()
  app.use(express.json())
  app.use('/api', createSessionsRouter(deps))
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

function postJson(url: string, body: unknown): Promise<globalThis.Response> {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

describe('M48：POST /sessions 零编制创建', () => {
  it('空数组 / 缺省 participantIds → 原样落库为空（平台路由步按首条需求自动组队）', async () => {
    const env = makeEnv()
    const api = await mountSessionsApi(env)
    try {
      const empty = await postJson(`${api.url}/api/sessions`, { participantIds: [] })
      expect(empty.status).toBe(201)
      const a = (await empty.json()) as { session: { participantIds: string[] } }
      expect(a.session.participantIds).toEqual([])

      const omitted = await postJson(`${api.url}/api/sessions`, { title: '只带标题' })
      expect(omitted.status).toBe(201)
      const b = (await omitted.json()) as { session: { participantIds: string[] } }
      expect(b.session.participantIds).toEqual([])
    } finally {
      await api.close()
    }
  })

  it('显式选择：按 list() 编制链序落库（既有语义不变）', async () => {
    const env = makeEnv()
    const api = await mountSessionsApi(env)
    try {
      const res = await postJson(`${api.url}/api/sessions`, { participantIds: ['backend', 'chief'] })
      expect(res.status).toBe(201)
      const body = (await res.json()) as { session: { participantIds: string[] } }
      expect(body.session.participantIds).toEqual(['chief', 'backend'])
    } finally {
      await api.close()
    }
  })
})

// ---------- MockProvider 路由剧本（零编制开场 → 自动组队 → 接力交还） ----------

describe('M48：MockProvider 路由剧本（确定性，供演示 / E2E / eval）', () => {
  it('零编制会话：无 @ 消息 → 召集 pm/architect/qa → 派发 pm → 全链接力至交还', async () => {
    const env = makeEnv()
    const session = env.sessions.create([], 'M48 Mock 路由剧本')
    const message = appendUserMessage(env, session.id, '帮我做一个登录功能')
    const { runId, queue } = env.engine.launch(session.id, message.id)
    await waitRunFinished(env.engine, runId)

    expect(queue).toEqual([])
    // 召集：成员表按编制链序增长；trace 与事件条留痕
    expect(env.sessions.getSession(session.id)?.participantIds).toEqual(['pm', 'architect', 'qa'])
    const traces = routingTraces(env, runId)
    expect(
      traces.some(
        (e) =>
          e.payload.source === 'route' &&
          JSON.stringify(e.payload.members) === JSON.stringify(['pm', 'architect', 'qa']),
      ),
    ).toBe(true)
    expect(env.sessions.messages(session.id).some((m) => m.role === 'system' && m.content.includes('平台 召集了'))).toBe(true)

    // 接力：pm 首棒开工，全链依次推进，最终交还用户
    expect(agentMessages(env, session.id, 'pm').length).toBeGreaterThan(0)
    expect(agentMessages(env, session.id, 'architect').length).toBeGreaterThan(0)
    expect(agentMessages(env, session.id, 'qa').length).toBeGreaterThan(0)
    const end = env.events.listByRun(runId).find((e) => e.type === 'run:end')
    expect(end?.payload.reason).toBe('completed')
  })
})

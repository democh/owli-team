/**
 * M16 测试：灵魂装配（L0 顺序与护栏）、system 消息（落库但不进 LLM 窗口）、
 * 动态成员 API（邀请 / 移出 / 换灵魂 + 事件条 + 运行中语义）、波次引擎集成
 * （@≥2 首波并行 / handoff 多目标 fan-out / 波内隔离与事件序 / attach 多流重放 /
 * removeFromQueue）、mock 灵魂风格（换装后输出变化）。
 */
import type { AddressInfo } from 'node:net'
import express from 'express'
import { describe, expect, it } from 'vitest'
import type { AgentDefinition, ChatMessage, Session } from '@multi-agent/shared'
import { buildSystemPrompt, buildWindow } from '../src/context/assembler.js'
import { textOfContent } from '../src/llm/content.js'
import type { ChatRequest, LlmChunk } from '../src/llm/provider.js'
import type { ApiDeps } from '../src/routes/index.js'
import { createSessionsRouter } from '../src/routes/sessions.js'
import { appendUserMessage, makeEnv, sendAndWait, waitRunFinished } from './helpers.js'

type Env = ReturnType<typeof makeEnv>

function agentDef(id: string, name: string, handoff: string[] = []): AgentDefinition {
  return { id, name, role: '测试', title: '', description: '', capabilities: [], avatar: {}, group: 'test', handoff }
}

function chatMessage(over: Partial<ChatMessage>): ChatMessage {
  return {
    id: `m_${Math.random().toString(36).slice(2, 8)}`,
    sessionId: 's1',
    role: 'agent',
    content: '',
    mentions: [],
    status: 'complete',
    createdAt: new Date().toISOString(),
    ...over,
  }
}

interface SseEvent {
  type: string
  [key: string]: unknown
}

/** 以假 Response 附着 SSE，收集事件（同 m4.test.ts 模式） */
function attachEvents(env: Env, runId: string): SseEvent[] {
  const events: SseEvent[] = []
  const res = {
    writableEnded: false,
    write: (payload: string) => {
      for (const line of payload.split('\n')) {
        if (!line.startsWith('data: ')) continue
        try {
          events.push(JSON.parse(line.slice(6)) as SseEvent)
        } catch {
          // 心跳等非 JSON 帧忽略
        }
      }
      return true
    },
    end: () => undefined,
  }
  env.engine.attach(runId, res as unknown as Parameters<typeof env.engine.attach>[1])
  return events
}

async function waitFor(cond: () => boolean, timeoutMs = 5000, label = '条件'): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`${label}未在预期时间内满足`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

async function waitApproval(env: Env, runId: string, timeoutMs = 5000) {
  const start = Date.now()
  for (;;) {
    const pending = env.approvals.pendingOf(runId)
    if (pending.length > 0) return pending[0]
    if (Date.now() - start > timeoutMs) throw new Error('审批未在预期时间内出现')
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** 覆写 provider：按请求脚本产出（收集请求供断言） */
function scriptProvider(env: Env, script: (req: ChatRequest) => LlmChunk[]): ChatRequest[] {
  const calls: ChatRequest[] = []
  const provider = env.provider as unknown as {
    chatStream: (req: ChatRequest, signal: AbortSignal) => AsyncIterable<LlmChunk>
  }
  provider.chatStream = async function* (req) {
    const chunks = script(req)
    calls.push(req)
    for (const chunk of chunks) yield chunk
  }
  return calls
}

async function mountSessionsApi(env: Env): Promise<{ url: string; close: () => Promise<void> }> {
  const deps = env as unknown as ApiDeps
  const app = express()
  app.use(express.json())
  app.use('/api', createSessionsRouter(deps))
  // 测试诊断：把内部错误序列化到响应体
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: `内部错误：${err.message}` })
  })
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

// ---------- 灵魂装配（L0） ----------

describe('M16：灵魂装配（buildSystemPrompt）', () => {
  const base = {
    protocol: '# 全局协作协议',
    groupProtocol: '# 场景协议：发散期禁止评判',
    agent: agentDef('ideator', '卢娜', ['challenger']),
    agentBody: '我是卢娜，负责狂想发散。',
    roster: [agentDef('ideator', '卢娜'), agentDef('challenger', '维克多')],
    preloadedSkills: [],
    skillsIndex: '',
    workspaceListing: '',
    memoryBlock: '',
    summaryBlock: '',
  }

  it('有灵魂：L0 = 全局协议 → 场景协议 → 人设 → 灵魂段（含优先级护栏句）', () => {
    const { text } = buildSystemPrompt({
      ...base,
      soul: {
        meta: { id: 'wild', name: '狂野', tagline: '嘴上没门，脑洞没边', traits: ['话痨'], tone: '热情跳脱' },
        quirks: ['开口先来一句兄弟们'],
        body: '## 表达示例\n\n兄弟们，点子来了！',
      },
    })
    const order = [text.indexOf('全局协作协议'), text.indexOf('场景协议'), text.indexOf('# 你当前的角色'), text.indexOf('# 你的灵魂')]
    expect(order.every((idx) => idx >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(text).toContain('灵魂：狂野（wild）')
    expect(text).toContain('口癖与小习惯：开口先来一句兄弟们')
    expect(text).toContain('灵魂只影响表达风格与互动方式')
  })

  it('无灵魂：不注入灵魂段（行为同现状）', () => {
    const { text } = buildSystemPrompt(base)
    expect(text).not.toContain('你的灵魂')
    expect(text).toContain('# 你当前的角色')
  })
})

// ---------- system 消息 ----------

describe('M16：system 消息（事件条）', () => {
  it('buildWindow 过滤 system：会话含成员事件条时不进 LLM 窗口', () => {
    const messages: ChatMessage[] = [
      chatMessage({ seq: 1, role: 'user', content: '开始吧' }),
      chatMessage({ seq: 2, role: 'system', agentId: 'ideator', content: '费利 邀请了 卢娜 加入协作' }),
      chatMessage({ seq: 3, role: 'agent', agentId: 'pm', content: '收到。' }),
    ]
    const out = buildWindow({
      messages,
      agentId: 'pm',
      agents: [agentDef('pm', '费利'), agentDef('ideator', '卢娜')],
      fromSeq: 0,
      budgetTokens: 100_000,
      toolDetailKeep: 6,
    })
    expect(out.messages).toHaveLength(2)
    expect(out.messages.some((m) => textOfContent(m.content).includes('加入了协作'))).toBe(false)
  })

  it('engine 级：事件条落库可回放，但请求窗口与 system 提示均不含其内容', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm'], 'M16 事件条')
    env.sessions.appendMessage({
      sessionId: session.id,
      role: 'system',
      agentId: 'qa',
      content: '诺娃 加入了协作',
      mentions: [],
      status: 'complete',
    })
    const requests = scriptProvider(env, () => [
      { type: 'text', text: '收到。\n@用户' },
      { type: 'done' },
    ])
    await sendAndWait(env, session.id, '开始吧')

    // 落库可回放
    const all = env.sessions.messages(session.id)
    expect(all.some((m) => m.role === 'system' && m.content.includes('加入了协作'))).toBe(true)
    // LLM 窗口与 system 提示均不含事件条内容
    expect(requests[0].messages.some((m) => textOfContent(m.content).includes('加入了协作'))).toBe(false)
    expect(requests[0].system.includes('加入了协作')).toBe(false)
  })
})

// ---------- 动态成员 API ----------

describe('M16：动态成员 API', () => {
  it('POST 邀请：201 + 编制链序追加 + system 事件条 + notify:members-changed', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm'], 'M16 邀请')
    const api = await mountSessionsApi(env)
    try {
      const res = await postJson(`${api.url}/api/sessions/${session.id}/members`, {
        agentIds: ['qa', 'architect'],
      })
      expect(res.status).toBe(201)
      const body = (await res.json()) as { session: Session; message: ChatMessage }
      // 追加以编制链顺序（architect 在 qa 之前），既有成员顺序不变
      expect(body.session.participantIds).toEqual(['pm', 'architect', 'qa'])
      expect(body.message.role).toBe('system')
      expect(body.message.agentId).toBe('architect')
      expect(body.message.content).toBe('费利 邀请了 艾达、诺娃 加入协作')
      expect(body.message.turnIndex).toBe(-1) // 计划约定：事件条 turnIndex = -1
      expect(env.published.some((n) => n.type === 'notify:members-changed')).toBe(true)
      // 事件条持久化
      expect(env.sessions.messages(session.id).some((m) => m.role === 'system')).toBe(true)
    } finally {
      await api.close()
    }
  })

  it('POST 邀请可带 souls（邀请即选风格）；非法 soul / 归属错误 / 重复邀请 / 不存在角色 → 400', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm'], 'M16 邀请 soul')
    const api = await mountSessionsApi(env)
    try {
      const ok = await postJson(`${api.url}/api/sessions/${session.id}/members`, {
        agentIds: ['ideator'],
        souls: { ideator: 'zen' },
      })
      expect(ok.status).toBe(201)
      const body = (await ok.json()) as { session: Session }
      expect(body.session.memberSouls).toEqual({ ideator: 'zen' })

      const ghost = await postJson(`${api.url}/api/sessions/${session.id}/members`, {
        agentIds: ['facilitator'],
        souls: { facilitator: 'ghost' },
      })
      expect(ghost.status).toBe(400)
      const wrong = await postJson(`${api.url}/api/sessions/${session.id}/members`, {
        agentIds: ['facilitator'],
        souls: { ideator: 'wild' },
      })
      expect(wrong.status).toBe(400)

      const dup = await postJson(`${api.url}/api/sessions/${session.id}/members`, { agentIds: ['ideator'] })
      expect(dup.status).toBe(400)
      const unknown = await postJson(`${api.url}/api/sessions/${session.id}/members`, { agentIds: ['nope'] })
      expect(unknown.status).toBe(400)
    } finally {
      await api.close()
    }
  })

  it('DELETE 移出：system 事件条 + 灵魂覆盖清理；最后一名 / 不在会话 → 拒绝', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm', 'qa'], 'M16 移出')
    env.sessions.setMemberSouls(session.id, { qa: 'friendly' })
    const api = await mountSessionsApi(env)
    try {
      const last = await fetch(`${api.url}/api/sessions/${session.id}/members/pm`, { method: 'DELETE' })
      // pm 可以移出（还剩 qa）
      expect(last.status).toBe(200)

      const only = await fetch(`${api.url}/api/sessions/${session.id}/members/qa`, { method: 'DELETE' })
      expect(only.status).toBe(400)
      const onlyBody = (await only.json()) as { error: string }
      expect(onlyBody.error).toContain('至少保留 1 名')

      // 先加回 pm 再移出 qa
      await postJson(`${api.url}/api/sessions/${session.id}/members`, { agentIds: ['pm'] })
      const res = await fetch(`${api.url}/api/sessions/${session.id}/members/qa`, { method: 'DELETE' })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { session: Session; message: ChatMessage }
      expect(body.session.participantIds).toEqual(['pm'])
      expect(body.session.memberSouls).toBeUndefined() // qa 的换装随之清理
      expect(body.message.role).toBe('system')
      expect(body.message.content).toBe('诺娃 离开了协作')

      const missing = await fetch(`${api.url}/api/sessions/${session.id}/members/qa`, { method: 'DELETE' })
      expect(missing.status).toBe(404)
    } finally {
      await api.close()
    }
  })

  it('PATCH 换灵魂：切换 / 恢复默认 / 重复与非法拒绝（真实 agents 资产）', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['qa'], 'M16 换灵魂')
    const api = await mountSessionsApi(env)
    const patch = (body: unknown): Promise<globalThis.Response> =>
      fetch(`${api.url}/api/sessions/${session.id}/members/qa`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    try {
      // 初始为默认（strict），恢复默认 → 400
      const noop = await patch({ soul: null })
      expect(noop.status).toBe(400)

      const change = await patch({ soul: 'friendly' })
      expect(change.status).toBe(200)
      const body = (await change.json()) as { session: Session; message: ChatMessage }
      expect(body.session.memberSouls).toEqual({ qa: 'friendly' })
      expect(body.message.content).toBe('诺娃 换上了『亲和』灵魂')
      expect(env.published.filter((n) => n.type === 'notify:members-changed').length).toBe(1)

      const again = await patch({ soul: 'friendly' })
      expect(again.status).toBe(400)
      const ghost = await patch({ soul: 'ghost' })
      expect(ghost.status).toBe(400)

      const reset = await patch({ soul: null })
      expect(reset.status).toBe(200)
      const resetBody = (await reset.json()) as { session: Session; message: ChatMessage }
      expect(resetBody.session.memberSouls).toBeUndefined()
      expect(resetBody.message.content).toBe('诺娃 恢复了默认灵魂')

      const notMember = await fetch(`${api.url}/api/sessions/${session.id}/members/pm`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ soul: 'friendly' }),
      })
      expect(notMember.status).toBe(404)
    } finally {
      await api.close()
    }
  })
})

// ---------- 波次引擎集成 ----------

describe('M16：波次引擎（并行 / 隔离 / 事件序）', () => {
  it('@≥2 首波并行：单次 wave:start(2 人)、2×turn:start 先于 2×turn:end、消息相邻且同波次号、波内互不可见', async () => {
    const env = makeEnv()
    // M46-2：串行执行默认开启（全局并行上限收紧 1）；本用例验证并行特性 → 显式关闭串行
    const session = env.sessions.create(['pm', 'architect', 'qa'], 'M16 并行', { serial: false })
    const requests = scriptProvider(env, (req) => {
      const text = req.meta.agentId === 'pm' ? 'PM 首波产出。\n@用户' : 'ARCH 首波产出。\n@用户'
      return [
        { type: 'text', text },
        { type: 'done' },
      ]
    })
    const user = appendUserMessage(env, session.id, '@费利 @艾达 一起看登录')
    const { runId } = env.engine.launch(session.id, user.id)
    const events = attachEvents(env, runId)
    await waitRunFinished(env.engine, runId)

    // 事件序
    const waves = events.filter((e) => e.type === 'wave:start')
    expect(waves).toHaveLength(1)
    expect(waves[0].members).toEqual(['pm', 'architect'])
    const turnStartIdx = events.map((e, i) => (e.type === 'turn:start' ? i : -1)).filter((i) => i >= 0)
    const firstTurnEnd = events.findIndex((e) => e.type === 'turn:end')
    expect(turnStartIdx).toHaveLength(2)
    expect(firstTurnEnd).toBeGreaterThan(turnStartIdx[1])
    expect(events.filter((e) => e.type === 'turn:end')).toHaveLength(2)

    // 消息：相邻 + 同波次号 + seq 单调
    const all = env.sessions.messages(session.id)
    const agents = all.filter((m) => m.role === 'agent')
    expect(agents.map((m) => m.agentId)).toEqual(['pm', 'architect'])
    expect(agents[0].turnIndex).toBe(0)
    expect(agents[1].turnIndex).toBe(0)
    const firstIdx = all.findIndex((m) => m.id === agents[0].id)
    expect(all[firstIdx + 1].id).toBe(agents[1].id)
    expect(agents[1].seq!).toBeGreaterThan(agents[0].seq!)

    // 波内隔离：各自请求均不含对方本波输出（excludeMessageIds）
    expect(requests).toHaveLength(2)
    const pmReq = requests.find((r) => r.meta.agentId === 'pm')!
    const archReq = requests.find((r) => r.meta.agentId === 'architect')!
    expect(pmReq.messages.some((m) => textOfContent(m.content).includes('ARCH 首波产出'))).toBe(false)
    expect(archReq.messages.some((m) => textOfContent(m.content).includes('PM 首波产出'))).toBe(false)
    // 并行上下文指令注入
    expect(pmReq.messages.some((m) => textOfContent(m.content).includes('本波并行成员'))).toBe(true)
    expect(archReq.messages.some((m) => textOfContent(m.content).includes('本波并行成员'))).toBe(true)
  })

  it('handoff 多目标 → 下一波 fan-out 并行（wave:start 第二波 2 人）', async () => {
    const env = makeEnv()
    // M46-2：fan-out 验证并行波 → 显式关闭串行
    const session = env.sessions.create(['pm', 'qa', 'architect'], 'M16 fanout', { serial: false })
    scriptProvider(env, (req) => {
      const lastIsTool = req.messages[req.messages.length - 1]?.role === 'tool'
      if (req.meta.agentId === 'pm' && !lastIsTool) {
        return [
          {
            type: 'tool_calls',
            calls: [
              {
                id: 'c_handoff',
                name: 'handoff',
                arguments: JSON.stringify({ target: ['qa', 'architect'], reason: '两条线并行推进' }),
              },
            ],
          },
          { type: 'done' },
        ]
      }
      if (req.meta.agentId === 'pm') return [{ type: 'text', text: '交接完成。' }, { type: 'done' }]
      const text = req.meta.agentId === 'qa' ? 'QA 波产出。\n@用户' : 'ARCH 波产出。\n@用户'
      return [{ type: 'text', text }, { type: 'done' }]
    })
    const user = appendUserMessage(env, session.id, '@费利 你做统筹')
    const { runId } = env.engine.launch(session.id, user.id)
    const events = attachEvents(env, runId)
    await waitRunFinished(env.engine, runId)

    const waves = events.filter((e) => e.type === 'wave:start')
    expect(waves).toHaveLength(2)
    expect(waves[0].members).toEqual(['pm'])
    expect(waves[1].members).toEqual(['qa', 'architect'])
    // pm 的 toolCalls 记录了 handoff
    const pmMsg = env.sessions.messages(session.id).find((m) => m.agentId === 'pm')!
    expect(pmMsg.toolCalls?.some((t) => t.name === 'handoff' && t.status === 'ok')).toBe(true)
  })

  it('不 @ 时默认串行：每波成员长度为 1（行为完全同现状）', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm', 'architect'], 'M16 串行')
    const user = appendUserMessage(env, session.id, '做个登录功能')
    const { runId } = env.engine.launch(session.id, user.id)
    const events = attachEvents(env, runId)
    await waitRunFinished(env.engine, runId)

    const waves = events.filter((e) => e.type === 'wave:start')
    expect(waves.length).toBeGreaterThanOrEqual(2)
    expect(waves.every((w) => (w.members as string[]).length === 1)).toBe(true)
    expect(waves[0].members).toEqual(['pm'])
    expect(waves[1].members).toEqual(['architect'])
  })

  it('attach 多流重放：波进行中附着 → 补发 wave:start(2 人) + 2×turn:start + 已产出 delta', async () => {
    const env = makeEnv()
    // M46-2：attach 重放验证并行波 → 显式关闭串行
    const session = env.sessions.create(['pm', 'architect'], 'M16 attach', { serial: false })
    const provider = env.provider as unknown as {
      chatStream: (req: ChatRequest, signal: AbortSignal) => AsyncIterable<LlmChunk>
    }
    provider.chatStream = async function* (req) {
      const lead = req.meta.agentId === 'pm' ? 'PM 长文输出' : 'ARCH 长文输出'
      const text = `${lead}——分批产出用于 attach 重放断言的内容。\n\n@用户`
      for (let i = 0; i < text.length; i += 4) {
        await new Promise((r) => setTimeout(r, 12))
        yield { type: 'text', text: text.slice(i, i + 4) }
      }
      yield { type: 'done' }
    }
    const user = appendUserMessage(env, session.id, '@费利 @艾达 一起看')
    const { runId } = env.engine.launch(session.id, user.id)
    await waitFor(
      () =>
        env.sessions
          .messages(session.id)
          .filter((m) => m.role === 'agent' && m.status === 'streaming' && m.content.length >= 4).length >= 2,
      5000,
      '双流产出',
    )
    const events = attachEvents(env, runId)
    await waitRunFinished(env.engine, runId)

    const waves = events.filter((e) => e.type === 'wave:start')
    expect(waves).toHaveLength(1)
    expect(waves[0].members).toEqual(['pm', 'architect'])
    expect(events.filter((e) => e.type === 'turn:start')).toHaveLength(2)
    expect(events.filter((e) => e.type === 'message:delta').length).toBeGreaterThanOrEqual(2)
    expect(events.some((e) => e.type === 'run:end')).toBe(true)
  })

  it('运行中成员变更：正在发言拒绝移出；队列成员移出即时生效（removeFromQueue + queue:updated）', async () => {
    const env = makeEnv({ parallelMax: 1 }) // 关闭并行：首波 1 人，其余排队
    const session = env.sessions.create(['qa', 'architect', 'pm'], 'M16 运行中')
    scriptProvider(env, (req) => {
      const lastIsTool = req.messages[req.messages.length - 1]?.role === 'tool'
      if (req.meta.agentId === 'qa' && !lastIsTool) {
        return [
          {
            type: 'tool_calls',
            calls: [
              {
                id: 'c_approval',
                name: 'request_approval',
                arguments: JSON.stringify({ action: '等待确认', detail: '需要人工拍板' }),
              },
            ],
          },
          { type: 'done' },
        ]
      }
      return [
        { type: 'text', text: `${req.meta.agentId} 完成。\n@用户` },
        { type: 'done' },
      ]
    })
    const user = appendUserMessage(env, session.id, '@诺娃 @艾达 @费利 一起看看')
    const { runId } = env.engine.launch(session.id, user.id)
    const events = attachEvents(env, runId)
    await waitApproval(env, runId)
    expect(env.engine.isMemberActive(runId, 'qa')).toBe(true)

    const api = await mountSessionsApi(env)
    try {
      // 正在发言 → 400 拒绝
      const active = await fetch(`${api.url}/api/sessions/${session.id}/members/qa`, { method: 'DELETE' })
      expect(active.status).toBe(400)
      const activeBody = (await active.json()) as { error: string }
      expect(activeBody.error).toContain('正在发言')

      // 队列中的 pm：engine.removeFromQueue 命中 → 二次幂等
      expect(env.engine.removeFromQueue(runId, 'pm')).toEqual({ removed: true, queue: ['architect'] })
      expect(env.engine.removeFromQueue(runId, 'pm').removed).toBe(false)
      expect(events.some((e) => e.type === 'queue:updated')).toBe(true)

      // 队列中的 architect：API 移出 → 200 + 队列剔除 + 成员事件条
      const res = await fetch(`${api.url}/api/sessions/${session.id}/members/architect`, { method: 'DELETE' })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { session: Session }
      expect(body.session.participantIds).toEqual(['qa', 'pm'])
      expect(env.engine.activeRunOf(session.id)?.queue).toEqual([])

      // 运行中加入成员：允许（下一回合 roster 即时生效）
      const added = await postJson(`${api.url}/api/sessions/${session.id}/members`, { agentIds: ['refiner'] })
      expect(added.status).toBe(201)
      expect(env.sessions.getSession(session.id)?.participantIds).toContain('refiner')
    } finally {
      await api.close()
    }
    env.engine.stop(runId)
    await waitRunFinished(env.engine, runId)
  })

  it('运行中删除会话 → 400 拒绝；停止后可删除（审核 H-2）', async () => {
    const env = makeEnv({ parallelMax: 1 })
    const session = env.sessions.create(['qa', 'pm'])
    scriptProvider(env, (req) => {
      if (req.meta.agentId === 'qa') {
        return [
          {
            type: 'tool_calls',
            calls: [
              {
                id: 'c_approval',
                name: 'request_approval',
                arguments: JSON.stringify({ action: '等待确认', detail: '需要人工拍板' }),
              },
            ],
          },
          { type: 'done' },
        ]
      }
      return [{ type: 'text', text: `${req.meta.agentId} 完成。\n@用户` }, { type: 'done' }]
    })
    const user = appendUserMessage(env, session.id, '@诺娃 看看')
    const { runId } = env.engine.launch(session.id, user.id)
    await waitApproval(env, runId)

    const api = await mountSessionsApi(env)
    try {
      const blocked = await fetch(`${api.url}/api/sessions/${session.id}`, { method: 'DELETE' })
      expect(blocked.status).toBe(400)
      expect(((await blocked.json()) as { error: string }).error).toContain('运行中')
      expect(env.sessions.getSession(session.id)).toBeTruthy()
    } finally {
      await api.close()
    }

    env.engine.stop(runId)
    await waitRunFinished(env.engine, runId)

    const api2 = await mountSessionsApi(env)
    try {
      const ok = await fetch(`${api2.url}/api/sessions/${session.id}?deleteWorkspace=false`, { method: 'DELETE' })
      expect(ok.status).toBe(200)
      expect(env.sessions.getSession(session.id)).toBeUndefined()
    } finally {
      await api2.close()
    }
  })
})

// ---------- mock 灵魂风格（透传链路） ----------

describe('M16：mock 灵魂风格（换装后输出变化）', () => {
  it('qa 默认 strict 灵魂 → 风格化输出；会话覆盖 friendly 后输出变化', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['qa'], 'M16 灵魂风格')
    await sendAndWait(env, session.id, '帮我看看登录功能的测试')
    const first = env.sessions.messages(session.id).filter((m) => m.role === 'agent')
    expect(first[0].content).toContain('缺陷计数先行')
    expect(first[0].content).toContain('结论先行；含糊描述一律退回')

    // 会话级换装（PATCH 的底层语义）：下一 Run 生效；换主题避免覆盖写审批
    env.sessions.setMemberSouls(session.id, { qa: 'friendly' })
    await sendAndWait(env, session.id, '@诺娃 做个评论功能的测试')
    const second = env.sessions.messages(session.id).filter((m) => m.role === 'agent')
    expect(second[1].content).toContain('整体很顺！')
    expect(second[1].content).not.toContain('缺陷计数先行')
    // 风格只改表达：交付件与转交语义不变
    expect(second[1].artifacts?.length).toBe(1)
  })

  it('无灵魂角色（challenger）不注入风格：与现状输出一致', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['challenger'], 'M16 无灵魂')
    await sendAndWait(env, session.id, '看看这个点子')
    const agent = env.sessions.messages(session.id).find((m) => m.role === 'agent')!
    expect(agent.content).toContain('先复述最强版本')
    expect(agent.content).not.toContain('缺陷计数先行')
  })
})

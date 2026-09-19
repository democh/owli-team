/**
 * M4 LLM 韧性集成测试（引擎级）：
 * - 429（Retry-After）/ 5xx 注入 → Run 自动重试成功；重试耗尽 → Run 报错；
 * - 首 token 超时注入 → 单次尝试中断并重试成功；
 * - context_length_exceeded → 强制压缩 + 重新装配 + 重试成功（整个 Run 仅一次）；
 * - usage 落库（turn / summary）与成本估算（LLM_PRICING_JSON 单价）；
 * - 继续生成（resumeMessage）：被中断消息续写、守卫与互斥。
 *
 * 注：部分测试替身故意在产出任何增量前抛错/挂起，用于覆盖失败路径。
 */
/* eslint-disable require-yield -- 测试替身：故意在输出前抛错或挂起 */
import { describe, expect, it } from 'vitest'
import { abortError, type ChatRequest, type LlmChunk } from '../src/llm/provider.js'
import { appendUserMessage, makeEnv, routePassThrough, sendAndWait, waitRunFinished } from './helpers.js'

type ScriptResult = LlmChunk[] | { throw: unknown }
type ProbeScript = (req: ChatRequest, round: number) => ScriptResult

/** 探针 Provider：按脚本逐请求产出（零延时），支持注入异常；记录每次请求 */
function probeScript(env: ReturnType<typeof makeEnv>, script: ProbeScript): { requests: ChatRequest[] } {
  const requests: ChatRequest[] = []
  let round = 0
  const provider = env.provider as unknown as {
    chatStream: (req: ChatRequest, signal: AbortSignal) => AsyncIterable<LlmChunk>
  }
  provider.chatStream = async function* (req: ChatRequest, signal: AbortSignal) {
    // M48：平台路由请求直通（不消费 round / 不入探针记录）
    const route = routePassThrough(req)
    if (route) {
      for (const chunk of route) yield chunk
      return
    }
    requests.push(req)
    const result = script(req, round)
    round++
    if (!Array.isArray(result)) throw result.throw
    for (const chunk of result) {
      if (signal.aborted) throw abortError()
      yield chunk
    }
  }
  return { requests }
}

function httpError(status: number, message: string, headers?: Record<string, string>): Error {
  return Object.assign(new Error(message), { status, ...(headers ? { headers } : {}) })
}

function usageChunk(promptTokens: number, completionTokens: number): LlmChunk {
  return { type: 'usage', usage: { promptTokens, completionTokens } }
}

function textReply(text: string, usage: [number, number] = [12, 8]): LlmChunk[] {
  return [{ type: 'text', text }, usageChunk(...usage), { type: 'done' }]
}

interface SseEvent {
  type: string
  [key: string]: unknown
}

/** 以假 Response 附着 SSE，收集事件（write 收到的是 `data: {...}\n\n` 帧） */
function attachEvents(env: ReturnType<typeof makeEnv>, runId: string): SseEvent[] {
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

function agentMessages(env: ReturnType<typeof makeEnv>, sessionId: string) {
  return env.sessions.messages(sessionId).filter((m) => m.role === 'agent')
}

describe('M4：流式重试（引擎注入）', () => {
  it('429（带 Retry-After）注入 → 自动重试成功，SSE 收到重试提示与 usage', async () => {
    const env = makeEnv({ llmMaxRetries: 3, llmRetryBaseDelayMs: 1 })
    const session = env.sessions.create(['pm'])
    const { requests } = probeScript(env, (_req, round) => {
      if (round === 0) return { throw: httpError(429, 'Rate limit reached', { 'retry-after': '0' }) }
      return textReply('重试后成功产出。\n@用户')
    })
    const m1 = appendUserMessage(env, session.id, '做一个登录页')
    const { runId } = env.engine.launch(session.id, m1.id)
    const events = attachEvents(env, runId)
    await waitRunFinished(env.engine, runId)

    const agents = agentMessages(env, session.id)
    expect(agents).toHaveLength(1)
    expect(agents[0].content).toContain('重试后成功产出')
    expect(agents[0].status).toBe('complete')
    // 一次失败 + 一次成功
    expect(requests.filter((r) => !r.responseFormat)).toHaveLength(2)
    // SSE：重试提示 + usage 事件
    expect(events.some((e) => e.type === 'error' && String(e.message).includes('自动重试'))).toBe(true)
    expect(events.some((e) => e.type === 'usage')).toBe(true)
    // usage 落库（kind=turn，agent 归属正确）
    const rows = env.db.all<{ prompt_tokens: number; completion_tokens: number; kind: string }>(
      'SELECT prompt_tokens, completion_tokens, kind FROM usage WHERE run_id = ?',
      runId,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('turn')
    expect(rows[0].prompt_tokens).toBe(12)
    expect(rows[0].completion_tokens).toBe(8)
  })

  it('5xx 持续失败至重试耗尽 → Run 报错、消息进入 error，不再超限重试', async () => {
    const env = makeEnv({ llmMaxRetries: 2, llmRetryBaseDelayMs: 1 })
    const session = env.sessions.create(['pm'])
    const { requests } = probeScript(env, (_req, round) => ({ throw: httpError(500, `boom-${round}`) }))
    const m1 = appendUserMessage(env, session.id, '做一个登录页')
    const { runId } = env.engine.launch(session.id, m1.id)
    await waitRunFinished(env.engine, runId)

    const agents = agentMessages(env, session.id)
    expect(agents).toHaveLength(1)
    expect(agents[0].status).toBe('error')
    expect(agents[0].content).toBe('')
    // maxAttempts = LLM_MAX_RETRIES = 2
    expect(requests.filter((r) => !r.responseFormat)).toHaveLength(2)
    const run = env.runs.get(runId)
    expect(run?.state).toBe('done')
    expect(run?.error).toContain('boom')
  })

  it('首 token 超时注入 → 单次尝试被中断并重试成功', async () => {
    const env = makeEnv({ llmMaxRetries: 2, llmRetryBaseDelayMs: 1, firstTokenTimeoutMs: 40 })
    const session = env.sessions.create(['pm'])
    let attempts = 0
    const provider = env.provider as unknown as {
      chatStream: (req: ChatRequest, signal: AbortSignal) => AsyncIterable<LlmChunk>
    }
    provider.chatStream = async function* (req: ChatRequest, signal: AbortSignal) {
      // M48：平台路由请求直通（不占 attempts 计数）
      const route = routePassThrough(req)
      if (route) {
        for (const chunk of route) yield chunk
        return
      }
      attempts++
      if (attempts === 1) {
        // 首 token 迟迟不来：挂起等待单次尝试超时中断
        await new Promise<void>((_, reject) => {
          signal.addEventListener('abort', () => reject(abortError()), { once: true })
        })
      }
      yield { type: 'text', text: '超时后重试成功。\n@用户' }
      yield usageChunk(10, 6)
      yield { type: 'done' }
    }
    const m1 = appendUserMessage(env, session.id, '做一个登录页')
    const { runId } = env.engine.launch(session.id, m1.id)
    await waitRunFinished(env.engine, runId)

    expect(attempts).toBe(2)
    const agents = agentMessages(env, session.id)
    expect(agents[0].content).toContain('超时后重试成功')
    expect(agents[0].status).toBe('complete')
  })
})

describe('M4：context_length 压缩重试', () => {
  it('400 context_length_exceeded → 强制压缩 + 重新装配 + 重试成功（仅一次）', async () => {
    const env = makeEnv({ llmMaxRetries: 1, llmRetryBaseDelayMs: 1 })
    const session = env.sessions.create(['pm'])
    // 先跑两个完整回合，制造可压缩历史
    await sendAndWait(env, session.id, '第一个需求：登录页')
    await sendAndWait(env, session.id, '第二个需求：注册页')
    const beforeMessages = env.sessions.countMessages(session.id)

    let plannerCalls = 0
    probeScript(env, (req) => {
      if (req.responseFormat) {
        // 摘要请求（压缩器）：返回可解析的结构化摘要
        return textReply(
          JSON.stringify({
            completed: ['已完成前两轮需求'],
            decisions: [],
            constraints: [],
            artifacts: [],
            openQuestions: [],
            nextSteps: [],
          }),
          [50, 20],
        )
      }
      plannerCalls++
      if (plannerCalls === 1) {
        return { throw: httpError(400, "This model's maximum context length is 65536 tokens") }
      }
      return textReply('压缩后重试成功。\n@用户', [30, 10])
    })

    const m3 = appendUserMessage(env, session.id, '第三个需求：支付页')
    const { runId } = env.engine.launch(session.id, m3.id)
    await waitRunFinished(env.engine, runId)

    // 规划请求：1 次失败（context_length）+ 1 次压缩后成功
    expect(plannerCalls).toBe(2)
    const agents = agentMessages(env, session.id)
    expect(agents.at(-1)?.content).toContain('压缩后重试成功')
    expect(agents.at(-1)?.status).toBe('complete')
    // 压缩事件双通道：SSE + 通知
    expect(env.published.filter((n) => n.type === 'notify:context-compressed').length).toBeGreaterThanOrEqual(1)
    // 摘要 usage 落库（kind=summary，归属当前 Run）
    const summaryRows = env.db.all<{ run_id: string; kind: string }>(
      "SELECT run_id, kind FROM usage WHERE kind = 'summary'",
    )
    expect(summaryRows.length).toBeGreaterThanOrEqual(1)
    expect(summaryRows.every((r) => r.run_id === runId)).toBe(true)
    // 压缩水位前进（摘要已落盘）
    const summary = env.summaries.get(session.id)
    expect(summary?.untilSeq ?? 0).toBeGreaterThan(0)
    // 消息未被压缩损坏（压缩只影响装配视角，不删原始消息）
    expect(env.sessions.countMessages(session.id)).toBeGreaterThan(beforeMessages)
  })

  it('压缩后仍超长 → 只重试一次，Run 报错', async () => {
    const env = makeEnv({ llmMaxRetries: 1, llmRetryBaseDelayMs: 1 })
    const session = env.sessions.create(['pm'])
    await sendAndWait(env, session.id, '第一个需求：登录页')
    await sendAndWait(env, session.id, '第二个需求：注册页')

    let plannerCalls = 0
    probeScript(env, (req) => {
      if (req.responseFormat) {
        return textReply(
          JSON.stringify({
            completed: [],
            decisions: [],
            constraints: [],
            artifacts: [],
            openQuestions: [],
            nextSteps: [],
          }),
          [50, 20],
        )
      }
      plannerCalls++
      return { throw: httpError(400, 'context_length_exceeded') }
    })

    const m3 = appendUserMessage(env, session.id, '第三个需求：支付页')
    const { runId } = env.engine.launch(session.id, m3.id)
    await waitRunFinished(env.engine, runId)

    // 首轮 + 压缩重试一轮 = 2 次规划请求；第二次仍失败直接报错，不再循环
    expect(plannerCalls).toBe(2)
    const agents = agentMessages(env, session.id)
    expect(agents.at(-1)?.status).toBe('error')
    expect(env.runs.get(runId)?.error).toContain('context_length')
  })
})

describe('M4：usage 采集与成本', () => {
  it('每 Run/每角色 token 与费用落库（kind=turn，cost>0）', async () => {
    const env = makeEnv({ llmPricing: { 'deepseek-flash': { prompt: 0.001, completion: 0.002 } } })
    const session = env.sessions.create(['pm'])
    // @ 直达：本 Run 无平台路由调用，usage 行仅归 pm（M48）
    const m1 = appendUserMessage(env, session.id, '@pm 做一个登录页')
    const { runId } = env.engine.launch(session.id, m1.id)
    await waitRunFinished(env.engine, runId)

    // MockProvider：工具子轮 + 文本子轮 → 至少 2 条 turn 记录
    const sum = env.usage.sumByRun(runId)
    expect(sum.promptTokens).toBeGreaterThan(0)
    expect(sum.completionTokens).toBeGreaterThan(0)
    expect(sum.costUsd).toBeGreaterThan(0)

    const rows = env.db.all<{ agent_id: string; kind: string; model: string; cost_usd: number }>(
      'SELECT agent_id, kind, model, cost_usd FROM usage WHERE run_id = ?',
      runId,
    )
    expect(rows.length).toBeGreaterThanOrEqual(2)
    expect(rows.every((r) => r.kind === 'turn' && r.agent_id === 'pm')).toBe(true)
    expect(rows.every((r) => r.model === env.cfg.llmModel)).toBe(true)
    expect(rows.every((r) => r.cost_usd > 0)).toBe(true)
    // 会话汇总含该 Run
    expect(env.usage.sumBySession(session.id).promptTokens).toBe(sum.promptTokens)
  })
})

describe('M4：继续生成（resumeMessage）', () => {
  it('被中断的 Agent 消息续写：内容追加、状态回 complete、usage 归属新 Run', async () => {
    const env = makeEnv({ llmMaxRetries: 1 })
    const session = env.sessions.create(['pm'])
    appendUserMessage(env, session.id, '做一个登录页')
    const interrupted = env.sessions.appendMessage({
      sessionId: session.id,
      role: 'agent',
      agentId: 'pm',
      content: '我已经完成了第一部分的梳理，',
      mentions: [],
      status: 'stopped',
      turnIndex: 0,
    })
    const { requests } = probeScript(env, () => textReply('接下来是第二部分。\n@用户'))

    const { runId } = env.engine.resumeMessage(session.id, interrupted.id)
    await waitRunFinished(env.engine, runId)

    expect(interrupted.status).toBe('complete')
    expect(interrupted.content).toBe('我已经完成了第一部分的梳理，接下来是第二部分。\n@用户')
    // 请求携带「assistant 前缀 + 续写指令」
    const msgs = requests[0].messages
    expect(msgs.some((m) => m.role === 'assistant' && m.content === '我已经完成了第一部分的梳理，')).toBe(true)
    expect(msgs[msgs.length - 1].content).toContain('续写')
    // usage 归属 resume 的 Run
    expect(env.usage.sumByRun(runId).completionTokens).toBe(8)
    expect(env.runs.get(runId)?.state).toBe('done')
  })

  it('守卫：complete/streaming/非 Agent 消息、缺内容与互斥拒绝', async () => {
    const env = makeEnv({ llmMaxRetries: 1 })
    const session = env.sessions.create(['pm'])
    const userMsg = appendUserMessage(env, session.id, '任务')
    const complete = env.sessions.appendMessage({
      sessionId: session.id,
      role: 'agent',
      agentId: 'pm',
      content: '完整回复',
      mentions: [],
      status: 'complete',
      turnIndex: 0,
    })
    const streaming = env.sessions.appendMessage({
      sessionId: session.id,
      role: 'agent',
      agentId: 'pm',
      content: '生成中',
      mentions: [],
      status: 'streaming',
      turnIndex: 0,
    })
    const empty = env.sessions.appendMessage({
      sessionId: session.id,
      role: 'agent',
      agentId: 'pm',
      content: '   ',
      mentions: [],
      status: 'stopped',
      turnIndex: 0,
    })

    expect(() => env.engine.resumeMessage(session.id, complete.id)).toThrow('已完整生成')
    expect(() => env.engine.resumeMessage(session.id, streaming.id)).toThrow('仍在生成中')
    expect(() => env.engine.resumeMessage(session.id, empty.id)).toThrow('没有可续写的内容')
    expect(() => env.engine.resumeMessage(session.id, userMsg.id)).toThrow('只能续写 Agent 消息')
    expect(() => env.engine.resumeMessage('s_missing', complete.id)).toThrow('会话不存在')

    // 会话已有活跃 Run → 互斥拒绝
    const provider = env.provider as unknown as {
      chatStream: (req: ChatRequest, signal: AbortSignal) => AsyncIterable<LlmChunk>
    }
    provider.chatStream = async function* (_req: ChatRequest, signal: AbortSignal) {
      await new Promise<void>((_, reject) => {
        signal.addEventListener('abort', () => reject(abortError()), { once: true })
      })
    }
    const pending = env.sessions.appendMessage({
      sessionId: session.id,
      role: 'agent',
      agentId: 'pm',
      content: '被中断的草稿',
      mentions: [],
      status: 'stopped',
      turnIndex: 0,
    })
    const m2 = appendUserMessage(env, session.id, '长任务')
    const { runId } = env.engine.launch(session.id, m2.id)
    expect(() => env.engine.resumeMessage(session.id, pending.id)).toThrow('会话已有运行中的任务')
    env.engine.stop(runId)
    await waitRunFinished(env.engine, runId)
  })
})

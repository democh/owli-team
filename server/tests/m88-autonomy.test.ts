/**
 * M88：自动编排（意图判定）的引擎链路。
 *
 * 覆盖：
 * - 无 @ 消息：PRS 的 intent 块决定首波范式（needsPlan → plan 挂起；modeSource=router 落库）；
 * - 会话策略 never-plan：同一需求直接执行（不挂起）；
 * - 显式「先出计划」：规则判定直接投首棒 plan（不走 PRS，modeSource=user）；
 * - 收口评审门：计划带验收标准 → 作者收口波以 review 范式发言（submit_review）。
 */
import { describe, expect, it } from 'vitest'
import type { Plan } from '@multi-agent/shared'
import type { ChatRequest, LlmChunk } from '../src/llm/provider.js'
import { appendUserMessage, makeEnv, waitRunFinished } from './helpers.js'

type Env = ReturnType<typeof makeEnv>

async function waitFor<T>(fn: () => T | undefined | false, what: string, timeoutMs = 8000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = fn()
    if (value) return value
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

const doneChunk: LlmChunk = { type: 'done' }
const textChunk = (text: string): LlmChunk => ({ type: 'text', text })
const toolChunk = (name: string, args: Record<string, unknown>): LlmChunk => ({
  type: 'tool_calls',
  calls: [{ id: `c_${name}_${Math.random().toString(36).slice(2, 6)}`, name, arguments: JSON.stringify(args) }],
})
const routePlanChunk = (plan: unknown): LlmChunk[] => [textChunk(JSON.stringify(plan)), doneChunk]

interface Script {
  requests: ChatRequest[]
}

/** 脚本：PRS 返回带 intent 的结构化方案；plan 波提交计划；其余回合按需完成步骤 / 评审 */
function installScript(
  env: Env,
  opts: {
    intent: Record<string, unknown>
    assignments?: Array<{ agentId: string; task: string }>
    planStep?: Record<string, unknown>
  },
): Script {
  const requests: ChatRequest[] = []
  const provider = env.provider as unknown as {
    chatStream: (req: ChatRequest, signal: AbortSignal) => AsyncIterable<LlmChunk>
  }
  provider.chatStream = async function* (req) {
    requests.push(req)
    if (req.responseFormat) {
      for (const chunk of routePlanChunk({
        members: [],
        assignments: opts.assignments ?? [{ agentId: 'pm', task: '出方案并推进' }],
        reason: '测试路由',
        intent: opts.intent,
      }))
        yield chunk
      return
    }
    const tools = new Set((req.tools ?? []).map((t) => t.name))
    const lastTool = [...req.messages].reverse().find((m) => m.role === 'tool')
    // 规划波：提交一次计划（工具结果回灌后改为收尾文本）
    if (tools.has('write_plan') && !lastTool) {
      yield toolChunk('write_plan', {
        title: '登录改造计划',
        goal: '交付可用的登录能力',
        steps: [opts.planStep ?? { content: '实现登录接口', owner: 'backend', acceptance: '接口可用' }],
      })
      return
    }
    // 执行波：完成步骤
    if (tools.has('update_plan_step') && !lastTool) {
      yield toolChunk('update_plan_step', { step_id: 's1', status: 'done' })
      return
    }
    // 评审波：结构化判定
    if (tools.has('submit_review') && !lastTool) {
      yield toolChunk('submit_review', { target: 'plan:unknown', verdict: 'pass', findings: [] })
      return
    }
    yield textChunk('已完成。')
    yield doneChunk
  }
  return { requests }
}

describe('M88：PRS 意图决定首波范式', () => {
  it('needsPlan → 首波规划并挂起；用户消息落 mode + modeSource=router', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm', 'backend'], 'M88 PRS 规划')
    installScript(env, {
      intent: { needsPlan: true, needsReview: true, riskLevel: 'medium', confidence: 0.9, reasons: ['多环节交付'] },
    })
    const message = appendUserMessage(env, session.id, '做一个登录系统')
    const { runId } = env.engine.launch(session.id, message.id)

    const plan = await waitFor(() => env.planReviews.pendingOf(session.id)[0], '规划挂起')
    expect(plan.agentId).toBe('pm')
    const stored = env.sessions.messages(session.id).find((m) => m.id === message.id)!
    expect(stored.mode).toBe('plan')
    expect(stored.modeSource).toBe('router')
    expect(env.events.listByRun(runId).some((e) => e.type === 'intent:decided')).toBe(true)

    // 批准 → 执行到收口
    env.planReviews.resolve(plan.id, 'approve')
    await waitRunFinished(env.engine, runId)
    expect(env.plans.get(plan.id)?.status).toBe('done')
  })

  it('会话 never-plan：同一多环节需求直接执行（不挂起）', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm', 'backend'], 'M88 直接执行')
    env.sessions.setAutonomy(session.id, 'never-plan')
    const { requests } = installScript(env, {
      intent: { needsPlan: true, needsReview: false, riskLevel: 'low', confidence: 0.95, reasons: ['多环节'] },
    })
    const message = appendUserMessage(env, session.id, '做一个登录系统')
    const { runId } = env.engine.launch(session.id, message.id)
    await waitRunFinished(env.engine, runId)

    expect(env.planReviews.pendingOf(session.id)).toHaveLength(0)
    expect(env.plans.list(session.id)).toHaveLength(0)
    // 首波不是规划（策略优先于路由判定）
    expect(requests[0]?.meta.mode).toBeUndefined()
    expect(env.events.listByRun(runId).some((e) => e.type === 'intent:decided')).toBe(false)
  })

  it('显式「先出计划」：规则判定直接投首棒规划（不走 PRS，modeSource=user）', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm', 'backend'], 'M88 显式规划')
    const { requests } = installScript(env, {
      intent: { needsPlan: false, needsReview: false, riskLevel: 'low', confidence: 0.9 },
    })
    const message = appendUserMessage(env, session.id, '@pm 先出个登录改造计划再动手')
    const { runId } = env.engine.launch(session.id, message.id)

    const plan = await waitFor(() => env.planReviews.pendingOf(session.id)[0], '规划挂起')
    expect(plan.agentId).toBe('pm')
    const stored = env.sessions.messages(session.id).find((m) => m.id === message.id)!
    expect(stored.modeSource).toBe('user')
    // @ 直达不走 PRS
    expect(requests.some((r) => r.responseFormat)).toBe(false)
    env.planReviews.resolve(plan.id, 'approve')
    await waitRunFinished(env.engine, runId)
  })
})

describe('M88：收口评审门', () => {
  it('计划带验收标准 → 作者收口波以 review 范式发言', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm', 'backend'], 'M88 收口评审')
    const plan: Plan = env.plans.create({
      sessionId: session.id,
      agentId: 'pm',
      title: '登录改造计划',
      goal: '交付可用的登录能力',
      steps: [
        {
          content: '实现登录接口',
          ownerAgentId: 'backend',
          expectedOutput: '接口说明',
          acceptance: '评审通过',
        },
      ],
    })
    env.plans.setStatus(plan.id, 'approved')

    const requests: ChatRequest[] = []
    const provider = env.provider as unknown as {
      chatStream: (req: ChatRequest, signal: AbortSignal) => AsyncIterable<LlmChunk>
    }
    provider.chatStream = async function* (req) {
      requests.push(req)
      const tools = new Set((req.tools ?? []).map((t) => t.name))
      const lastTool = [...req.messages].reverse().find((m) => m.role === 'tool')
      if (tools.has('update_plan_step') && !lastTool) {
        yield toolChunk('update_plan_step', { step_id: 's1', status: 'done' })
        return
      }
      if (tools.has('submit_review') && !lastTool) {
        yield toolChunk('submit_review', { target: `plan:${plan.id}`, verdict: 'pass', findings: [] })
        return
      }
      yield textChunk('收口完成。')
      yield doneChunk
    }

    const { runId } = env.engine.launchPlanExecution(session.id, plan.id)
    await waitRunFinished(env.engine, runId)

    // 作者收口波以评审范式发言（工具白名单含 submit_review）
    const reviewTurns = requests.filter((r) => r.meta.agentId === 'pm' && r.meta.mode === 'review')
    expect(reviewTurns.length).toBeGreaterThan(0)
    const review = env.reviews.listBySession(session.id).find((r) => r.planId === plan.id)
    expect(review?.verdict).toBe('pass')
    expect(env.plans.get(plan.id)?.status).toBe('done')
    expect(env.plans.get(plan.id)?.steps[0]?.status).toBe('done')
  })
})

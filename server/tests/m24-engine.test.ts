/**
 * M24 P2：引擎编排 —— 范式全流程（测试替身 Provider 脚本化 write_plan / update_plan_step / submit_review）。
 *
 * 覆盖：
 * - 规划波挂起（awaiting_plan）→ 批准 → 派发执行 → 步骤完成 → 作者收口；
 * - 驳回 → 现场修订 v2（同 id 版本递增）→ 批准；
 * - 停止 → 计划保持 submitted → 稍后批准（launchPlanExecution）起执行 Run；
 * - 并行波多计划：批准其一 → 其余自动 superseded；
 * - 范式工具白名单（plan/review 无写类工具；execute 零差异）+ 协议违规提示 + planFirst 会话开关；
 * - 评审波（步骤 mode=review → review 范式）+ per-agent 任务清单并发回归。
 */
import { describe, expect, it } from 'vitest'
import type { Plan } from '@multi-agent/shared'
import { textOfContent } from '../src/llm/content.js'
import type { ChatRequest, ChatRequestMeta, LlmChunk } from '../src/llm/provider.js'
import { appendUserMessage, makeEnv, waitRunFinished } from './helpers.js'

type Env = ReturnType<typeof makeEnv>

// ---------- 轮询辅助 ----------

async function waitFor<T>(fn: () => T | undefined | false, what: string, timeoutMs = 8000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = fn()
    if (value) return value
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** 等待会话出现 ≥count 个挂起计划（可加过滤，如等 v2） */
async function waitPending(env: Env, sessionId: string, count = 1, predicate?: (p: Plan) => boolean): Promise<Plan[]> {
  return waitFor(() => {
    const pending = env.planReviews.pendingOf(sessionId)
    const hit = predicate ? pending.filter(predicate) : pending
    return hit.length >= count ? hit : undefined
  }, `会话 ${sessionId} 的挂起计划（≥${count} 个）`)
}

function agentMessages(env: Env, sessionId: string, agentId: string) {
  return env.sessions.messages(sessionId).filter((m) => m.role === 'agent' && m.agentId === agentId)
}

// ---------- 脚本化 Provider（替换 MockProvider.chatStream；按工具白名单区分波范式） ----------

interface ScriptOptions {
  /** 计划波允许提交的 write_plan 次数（0 = 从不提交，用于协议违规）；驳回后 ≤2 会触发 v2 修订 */
  maxPlans?: number
  /** 每次提交的计划步骤（attempt 从 1 起；meta 用于按成员区分） */
  steps?: (attempt: number, meta: ChatRequestMeta) => Array<Record<string, unknown>>
  /** 执行波完成的步骤 id（缺省 s1） */
  stepDone?: (meta: ChatRequestMeta) => string
  /** 评审波：产出 submit_review(pass) + 完成步骤 */
  review?: { target: string; doneStep: string }
  /** 其它回合（收口 / 默认执行）的文本 */
  text?: string
}

interface Script {
  /** 全部请求（按调用顺序；断言工具白名单 / meta.mode 用） */
  requests: ChatRequest[]
}

function installScript(env: Env, opts: ScriptOptions = {}): Script {
  const requests: ChatRequest[] = []
  let submissions = 0
  let callSeq = 0
  const nextId = () => `call_${++callSeq}`
  const provider = env.provider as unknown as {
    chatStream: (req: ChatRequest, signal: AbortSignal) => AsyncIterable<LlmChunk>
  }
  provider.chatStream = async function* (req, signal): AsyncIterable<LlmChunk> {
    if (signal.aborted) return
    requests.push(req)
    const tools = new Set((req.tools ?? []).map((t) => t.name))
    const toolResults = req.messages.filter((m) => m.role === 'tool')
    const lastTool = toolResults[toolResults.length - 1]

    // 规划波（plan 范式：白名单含 write_plan）
    if (tools.has('write_plan')) {
      const max = opts.maxPlans ?? 1
      // 驳回回灌优先 detail（「请按反馈修订计划后再次调用 write_plan…」）→ 触发 v2 修订
      const lastRejected = lastTool?.name === 'write_plan' && textOfContent(lastTool.content ?? '').includes('请按反馈修订')
      if (submissions < max && (!lastTool || lastRejected)) {
        submissions++
        const steps = opts.steps
          ? opts.steps(submissions, req.meta)
          : [{ content: '实现登录接口', owner: 'backend' }]
        yield {
          type: 'tool_calls',
          calls: [
            {
              id: nextId(),
              name: 'write_plan',
              arguments: JSON.stringify({
                title: `登录改造计划 v${submissions}`,
                goal: '交付可用的登录能力',
                steps,
              }),
            },
          ],
        }
        return
      }
      yield { type: 'text', text: '计划已定，等待批准与执行。' }
      return
    }

    // 评审波（review 范式：白名单含 submit_review）
    if (tools.has('submit_review')) {
      if (!lastTool && opts.review) {
        yield {
          type: 'tool_calls',
          calls: [
            {
              id: nextId(),
              name: 'submit_review',
              arguments: JSON.stringify({
                target: opts.review.target,
                verdict: 'pass',
                findings: [],
                evidence: ['评审纪要见上下文'],
              }),
            },
            {
              id: nextId(),
              name: 'update_plan_step',
              arguments: JSON.stringify({ step_id: opts.review.doneStep, status: 'done' }),
            },
          ],
        }
        return
      }
      yield { type: 'text', text: '评审完成，判定为通过。' }
      return
    }

    // 执行波（派发步骤：引擎动态授权 update_plan_step）
    if (tools.has('update_plan_step')) {
      if (!lastTool) {
        const stepId = opts.stepDone ? opts.stepDone(req.meta) : 's1'
        yield {
          type: 'tool_calls',
          calls: [
            {
              id: nextId(),
              name: 'update_plan_step',
              arguments: JSON.stringify({ step_id: stepId, status: 'done' }),
            },
          ],
        }
        return
      }
      yield { type: 'text', text: '负责的步骤已完成。' }
      return
    }

    // 其它（收口 / 默认执行 / 协议违规回退）
    yield { type: 'text', text: opts.text ?? '收到，按常规协作流程处理。' }
  }
  return { requests }
}

// ---------- 全流程 ----------

describe('M24：引擎计划全流程（挂起 → 批准 → 派发 → 收口）', () => {
  it('plan 波提交 → awaiting_plan 挂起 → 批准 → 派发执行 → 步骤完成 → 作者收口', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm', 'backend'], 'M24 全流程')
    const script = installScript(env, { text: '收口汇总完成。' })
    const message = appendUserMessage(env, session.id, '帮我做登录功能，先出计划')
    const { runId } = env.engine.launch(session.id, message.id, { mode: 'plan' })

    // 用户消息消息级范式已持久化
    expect(env.sessions.messages(session.id).find((m) => m.id === message.id)?.mode).toBe('plan')

    // 挂起：计划 submitted、Run awaiting_plan、首波消息带 mode
    const [pending] = await waitPending(env, session.id)
    expect(pending.status).toBe('submitted')
    expect(pending.version).toBe(1)
    expect(pending.agentId).toBe('pm')
    expect(pending.steps.map((s) => s.id)).toEqual(['s1'])
    expect(env.runs.get(runId)?.state).toBe('awaiting_plan')
    const pmFirst = agentMessages(env, session.id, 'pm')[0]
    expect(pmFirst.mode).toBe('plan')
    expect(script.requests[0].meta.mode).toBe('plan')
    expect(env.published.some((n) => n.type === 'notify:plan-submitted')).toBe(true)

    // 批准 → 完整收敛
    env.planReviews.resolve(pending.id, 'approve')
    await waitRunFinished(env.engine, runId)

    const plan = env.plans.get(pending.id)!
    expect(plan.status).toBe('done')
    expect(plan.steps[0].status).toBe('done')

    // trace：提交 → 派发（队列 = 步骤负责人）→ 收口；首波 wave:start 带 mode、执行波不带（零差异）
    const traces = env.events.listByRun(runId)
    expect(traces.some((e) => e.type === 'plan:submitted')).toBe(true)
    expect(traces.find((e) => e.type === 'plan:dispatched')?.payload.owners).toEqual(['backend'])
    expect(traces.some((e) => e.type === 'plan:done')).toBe(true)
    const waves = traces.filter((e) => e.type === 'wave:start')
    expect(waves[0].payload.mode).toBe('plan')
    expect(waves[1] && 'mode' in waves[1].payload).toBe(false)

    // 执行波：execute 范式（消息无 mode）、工具卡 ok
    const backendFirst = agentMessages(env, session.id, 'backend')[0]
    expect(backendFirst.mode).toBeUndefined()
    expect(backendFirst.toolCalls?.map((t) => `${t.name}:${t.status}`)).toEqual(['update_plan_step:ok'])

    // 作者收口波：pm 追加一次发言（先规划、后收口）
    const pmAll = agentMessages(env, session.id, 'pm')
    expect(pmAll.map((m) => m.toolCalls?.[0]?.name)).toEqual(['write_plan', undefined])
    expect(pmAll[1].content).toContain('收口汇总')
  })

  it('驳回 → 现场修订 v2（同 id 版本递增）→ 批准执行', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm', 'backend'], 'M24 驳回修订')
    installScript(env, { maxPlans: 2 })
    const message = appendUserMessage(env, session.id, '先规划')
    const { runId } = env.engine.launch(session.id, message.id, { mode: 'plan' })

    const [v1] = await waitPending(env, session.id)
    expect(v1.version).toBe(1)
    env.planReviews.resolve(v1.id, 'reject', '步骤粒度太粗，请拆细')

    // 作者当场修订 v2 并重新挂起
    const [v2] = await waitPending(env, session.id, 1, (p) => p.version === 2)
    expect(v2.id).toBe(v1.id)
    expect(v2.status).toBe('submitted')
    expect(v2.feedback).toBeUndefined()

    env.planReviews.resolve(v2.id, 'approve')
    await waitRunFinished(env.engine, runId)

    const plan = env.plans.get(v1.id)!
    expect(plan.status).toBe('done')
    expect(plan.version).toBe(2)

    // 同一条消息里的两次工具卡：v1 驳回（error）→ v2 通过（ok）
    const pmMsg = agentMessages(env, session.id, 'pm')[0]
    expect(pmMsg.toolCalls?.map((t) => `${t.name}:${t.status}`)).toEqual(['write_plan:error', 'write_plan:ok'])
    expect(pmMsg.toolCalls?.[0].summary).toContain('驳回')
  })

  it('停止 → 计划保持 submitted → 稍后批准（launchPlanExecution）起执行 Run', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm', 'backend'], 'M24 停止与稍后批准')
    installScript(env)
    const message = appendUserMessage(env, session.id, '先规划')
    const { runId } = env.engine.launch(session.id, message.id, { mode: 'plan' })

    const [pending] = await waitPending(env, session.id)
    env.engine.stop(runId)
    await waitRunFinished(env.engine, runId)

    // 计划保持「待批准」（可稍后处理）；挂起条目已取消；作者回合 stopped
    expect(env.plans.get(pending.id)?.status).toBe('submitted')
    expect(env.planReviews.pendingOf(session.id)).toHaveLength(0)
    expect(agentMessages(env, session.id, 'pm')[0].status).toBe('stopped')

    // 稍后批准：新起执行 Run（队列 = 步骤负责人），跑完收口
    const exec = env.engine.launchPlanExecution(session.id, pending.id)
    expect(exec.queue).toEqual(['backend'])
    await waitRunFinished(env.engine, exec.runId)

    const plan = env.plans.get(pending.id)!
    expect(plan.status).toBe('done')
    expect(plan.steps[0].status).toBe('done')
    // 收口波：pm 共 2 条（首条 stopped + 收口）
    expect(agentMessages(env, session.id, 'pm')).toHaveLength(2)
  })

  it('会话 planFirst 开关：无消息级范式时按会话默认进入 plan 波', async () => {
    const env = makeEnv()
    installScript(env, { steps: () => [{ content: '梳理方案' }] })
    const session = env.sessions.create(['pm'], 'M24 规划先行', { planFirst: true })
    const message = appendUserMessage(env, session.id, '规划先行开着，直接说需求')
    const { runId } = env.engine.launch(session.id, message.id) // 不传 mode

    expect(env.sessions.messages(session.id).find((m) => m.id === message.id)?.mode).toBe('plan')
    const [pending] = await waitPending(env, session.id)
    env.planReviews.resolve(pending.id, 'approve')
    await waitRunFinished(env.engine, runId)
    expect(env.plans.get(pending.id)?.status).toBe('done')
  })
})

// ---------- 并行多计划 / 范式门控 / 协议违规 ----------

describe('M24：并行多计划与范式门控', () => {
  it('并行波双计划：批准其一 → 另一自动 superseded（等待方以取代收敛）', async () => {
    const env = makeEnv()
    // M46-2：并行波双计划验证依赖同一波内两位成员 → 显式关闭串行
    const session = env.sessions.create(['pm', 'architect', 'backend'], 'M24 并行双计划', { serial: false })
    installScript(env, {
      maxPlans: 2,
      steps: (_attempt, meta) =>
        meta.agentId === 'pm'
          ? [{ content: '落地方案', owner: 'backend' }]
          : [{ content: '架构评审建议' }],
    })
    const message = appendUserMessage(env, session.id, '@pm @architect 一起出一版规划')
    const { runId } = env.engine.launch(session.id, message.id, { mode: 'plan' })

    const pending = await waitPending(env, session.id, 2)
    const pmPlan = pending.find((p) => p.agentId === 'pm')!
    const archPlan = pending.find((p) => p.agentId === 'architect')!
    expect(pmPlan.id).not.toBe(archPlan.id)

    env.planReviews.resolve(pmPlan.id, 'approve')
    await waitFor(() => env.plans.get(archPlan.id)?.status === 'superseded', '副计划 superseded')
    await waitRunFinished(env.engine, runId)

    expect(env.plans.get(pmPlan.id)?.status).toBe('done')
    // 被取代方的 write_plan 工具卡为 error（等待回合以「已被取代」收敛）
    const archMsg = agentMessages(env, session.id, 'architect')[0]
    expect(archMsg.toolCalls?.[0].status).toBe('error')
    expect(archMsg.toolCalls?.[0].summary).toContain('取代')
  })

  it('范式白名单：plan 波无写类工具；执行波恢复现状（含动态授权）；默认 execute 零差异', async () => {
    const env = makeEnv()
    const script = installScript(env, { steps: () => [{ content: '梳理方案' }] })

    // plan 波：write_plan 可见，写类工具全部不可见
    const sessionPlan = env.sessions.create(['pm'], 'M24 白名单（plan）')
    const msgPlan = appendUserMessage(env, sessionPlan.id, '先规划')
    const runPlan = env.engine.launch(sessionPlan.id, msgPlan.id, { mode: 'plan' })
    const [pending] = await waitPending(env, sessionPlan.id)
    env.planReviews.resolve(pending.id, 'approve')
    await waitRunFinished(env.engine, runPlan.runId)

    const planReq = script.requests[0]
    const planTools = new Set(planReq.tools?.map((t) => t.name))
    expect(planReq.meta.mode).toBe('plan')
    expect(planTools.has('write_plan')).toBe(true)
    for (const blocked of ['write_file', 'edit_file', 'apply_patch', 'write_todos', 'run_command']) {
      expect(planTools.has(blocked)).toBe(false)
    }

    // 执行波：execute 范式恢复现状（写工具在）+ 动态授权 update_plan_step；meta.mode 缺省
    const execReq = script.requests.find((r) => r.tools?.some((t) => t.name === 'update_plan_step') && r.meta.mode !== 'plan')!
    const execTools = new Set(execReq.tools?.map((t) => t.name))
    expect(execReq.meta.mode).toBeUndefined()
    expect(execTools.has('update_plan_step')).toBe(true)
    expect(execTools.has('write_file')).toBe(true)

    // 默认 execute 会话：普通对话不产生计划、事件形状零差异
    const sessionExec = env.sessions.create(['pm'], 'M24 白名单（execute）')
    const msgExec = appendUserMessage(env, sessionExec.id, '帮我看看登录功能')
    const runExec = env.engine.launch(sessionExec.id, msgExec.id)
    await waitRunFinished(env.engine, runExec.runId)

    expect(env.sessions.messages(sessionExec.id).find((m) => m.id === msgExec.id)?.mode).toBeUndefined()
    expect(agentMessages(env, sessionExec.id, 'pm')[0].mode).toBeUndefined()
    const execReq2 = script.requests.find((r) => r.meta.agentId === 'pm' && !r.tools?.some((t) => t.name === 'update_plan_step') && !r.tools?.some((t) => t.name === 'write_plan'))!
    const execTools2 = new Set(execReq2.tools?.map((t) => t.name))
    expect(execReq2.meta.mode).toBeUndefined()
    expect(execTools2.has('write_plan')).toBe(false)
    expect(execTools2.has('write_file')).toBe(true)
    expect(execTools2.has('write_todos')).toBe(true)
    const execWaves = env.events.listByRun(runExec.runId).filter((e) => e.type === 'wave:start')
    expect(execWaves.length).toBeGreaterThan(0)
    expect(execWaves.every((e) => !('mode' in e.payload))).toBe(true)
  })

  it('协议违规：plan 波未提交计划 → system 事件条 + trace + WS 提示', async () => {
    const env = makeEnv()
    installScript(env, { maxPlans: 0 })
    const session = env.sessions.create(['pm'], 'M24 协议违规')
    const message = appendUserMessage(env, session.id, '先规划')
    const { runId } = env.engine.launch(session.id, message.id, { mode: 'plan' })
    await waitRunFinished(env.engine, runId)

    const systemMsg = env.sessions.messages(session.id).find((m) => m.role === 'system')
    expect(systemMsg?.content).toContain('未提交任何计划')
    expect(env.events.listByRun(runId).some((e) => e.type === 'plan:protocol-violation')).toBe(true)
    expect(
      env.published.some((n) => n.type === 'notify:plan-updated' && Boolean((n.payload as { message?: unknown }).message)),
    ).toBe(true)
  })
})

// ---------- 评审波 / per-agent 清单 ----------

describe('M24：评审波与 per-agent 任务清单', () => {
  it('步骤 mode=review → 该成员走 review 范式（submit_review + 步骤推进 → 收口）', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm', 'backend', 'qa'], 'M24 评审波')
    const script = installScript(env, {
      steps: () => [
        { content: '实现登录接口', owner: 'backend' },
        { content: '评审实现结果', owner: 'qa', mode: 'review' },
      ],
      stepDone: (meta) => (meta.agentId === 'backend' ? 's1' : 's2'),
      review: { target: 'step:s2', doneStep: 's2' },
    })
    const message = appendUserMessage(env, session.id, '先规划')
    const { runId } = env.engine.launch(session.id, message.id, { mode: 'plan' })
    const [pending] = await waitPending(env, session.id)
    env.planReviews.resolve(pending.id, 'approve')
    await waitRunFinished(env.engine, runId)

    const plan = env.plans.get(pending.id)!
    expect(plan.status).toBe('done')
    expect(plan.steps.map((s) => s.status)).toEqual(['done', 'done'])

    // qa 的回合为 review 范式：白名单含 submit_review、无写类工具
    const qaReq = script.requests.find((r) => r.meta.agentId === 'qa')!
    expect(qaReq.meta.mode).toBe('review')
    const qaTools = new Set(qaReq.tools?.map((t) => t.name))
    expect(qaTools.has('submit_review')).toBe(true)
    expect(qaTools.has('write_file')).toBe(false)

    // 评审判定广播（notify:plan-updated 携带 review）
    const reviewNotify = env.published.find(
      (n) => n.type === 'notify:plan-updated' && 'review' in (n.payload as Record<string, unknown>),
    )
    expect(reviewNotify).toBeTruthy()
    expect(env.reviews.listByPlan(pending.id)[0].verdict).toBe('pass')

    const qaMsg = agentMessages(env, session.id, 'qa')[0]
    expect(qaMsg.toolCalls?.map((t) => `${t.name}:${t.status}`)).toEqual(['submit_review:ok', 'update_plan_step:ok'])
  })

  it('per-agent 任务清单：波内并行成员各自 write_todos 不互踩（回归 §29）', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm', 'qa'], 'M24 并发清单')
    let callSeq = 0
    const provider = env.provider as unknown as {
      chatStream: (req: ChatRequest, signal: AbortSignal) => AsyncIterable<LlmChunk>
    }
    provider.chatStream = async function* (req, signal): AsyncIterable<LlmChunk> {
      if (signal.aborted) return
      const tools = new Set((req.tools ?? []).map((t) => t.name))
      const hasToolResult = req.messages.some((m) => m.role === 'tool')
      if (tools.has('write_todos') && !hasToolResult) {
        const todos =
          req.meta.agentId === 'pm'
            ? [
                { content: 'pm-梳理需求', status: 'pending' },
                { content: 'pm-写需求文档', status: 'pending' },
              ]
            : [{ content: 'qa-补充边界用例', status: 'pending' }]
        yield {
          type: 'tool_calls',
          calls: [
            {
              id: `call_${++callSeq}`,
              name: 'write_todos',
              arguments: JSON.stringify({ todos }),
            },
          ],
        }
        return
      }
      yield { type: 'text', text: '收到。' }
    }

    const message = appendUserMessage(env, session.id, '@pm @qa 各自维护一份清单')
    const { runId } = env.engine.launch(session.id, message.id)
    await waitRunFinished(env.engine, runId)

    // 并行波两成员各自写清单：工具卡成功且条目数独立（per-agent 内存镜像不互踩）
    const pmMsg = agentMessages(env, session.id, 'pm')[0]
    const qaMsg = agentMessages(env, session.id, 'qa')[0]
    expect(pmMsg.toolCalls?.[0].name).toBe('write_todos')
    expect(pmMsg.toolCalls?.[0].status).toBe('ok')
    expect(pmMsg.toolCalls?.[0].summary).toContain('2 项')
    expect(qaMsg.toolCalls?.[0].name).toBe('write_todos')
    expect(qaMsg.toolCalls?.[0].status).toBe('ok')
    expect(qaMsg.toolCalls?.[0].summary).toContain('1 项')
    // 两次更新各广播一次（SSE + WS）；落库保持 M3 覆盖式语义（最终清单归属唯一成员）
    expect(env.published.filter((n) => n.type === 'notify:task-updated')).toHaveLength(2)
    const owners = new Set(env.tasks.list(session.id).map((t) => t.ownerAgentId))
    expect(owners.size).toBe(1)
  })
})

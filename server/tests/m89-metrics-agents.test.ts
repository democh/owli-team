/**
 * M89：角色级质量指标聚合（usage / tool_metrics / plans.steps / reviews）。
 * 纯 store 层验证：SQL 分组、owner 缺省回退、评审 fail 计数。
 */
import { describe, expect, it } from 'vitest'
import { makeEnv } from './helpers.js'

describe('M89：角色级指标聚合', () => {
  it('usage / tool / plan step / review 四源按 agent 聚合', () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm', 'backend'], 'M89 指标')

    env.usage.record({
      runId: 'r1',
      sessionId: session.id,
      agentId: 'pm',
      model: 'test-model',
      promptTokens: 100,
      completionTokens: 20,
      kind: 'turn',
    })
    env.usage.record({
      runId: 'r1',
      sessionId: session.id,
      agentId: 'backend',
      model: 'test-model',
      promptTokens: 300,
      completionTokens: 60,
      kind: 'turn',
    })
    // 系统级调用（无 agent）不计入角色指标
    env.usage.record({
      runId: 'r1',
      sessionId: session.id,
      model: 'test-model',
      promptTokens: 999,
      completionTokens: 0,
      kind: 'turn',
    })

    env.metrics.record({ toolName: 'read_file', ok: true, durationMs: 10, agentId: 'pm', sessionId: session.id })
    env.metrics.record({ toolName: 'write_file', ok: false, durationMs: 30, agentId: 'pm', sessionId: session.id })

    const plan = env.plans.create({
      sessionId: session.id,
      agentId: 'pm',
      title: '交付计划',
      goal: '交付',
      steps: [
        { content: '实现接口', ownerAgentId: 'backend', acceptance: '评审通过' },
        { content: '补充文档' },
      ],
    })
    env.plans.setStepStatus(plan.id, 's1', 'done')

    env.reviews.create({
      sessionId: session.id,
      agentId: 'backend',
      planId: plan.id,
      target: `plan:${plan.id}`,
      verdict: 'fail',
      findings: ['缺限流'],
      evidence: [],
    })

    const usage = env.usage.byAgent()
    const pmUsage = usage.find((row) => row.agentId === 'pm')!
    const backendUsage = usage.find((row) => row.agentId === 'backend')!
    expect(pmUsage).toMatchObject({ calls: 1, promptTokens: 100, completionTokens: 20 })
    expect(backendUsage).toMatchObject({ calls: 1, promptTokens: 300 })
    // 无 agent_id 的系统调用不计入
    expect(usage.find((row) => row.agentId === undefined)).toBeUndefined()

    const tools = env.metrics.agentSummary()
    expect(tools.find((row) => row.agentId === 'pm')).toMatchObject({ calls: 2, failures: 1 })

    const steps = env.plans.stepStatsByAgent()
    expect(steps.find((row) => row.agentId === 'backend')).toMatchObject({ done: 1, blocked: 0 })
    // 未指定 owner 的步骤回退到计划作者
    expect(steps.find((row) => row.agentId === 'pm')).toMatchObject({ done: 0, blocked: 0 })

    const reviews = env.reviews.statsByAgent()
    expect(reviews.find((row) => row.agentId === 'backend')).toMatchObject({ reviews: 1, fails: 1 })
  })
})

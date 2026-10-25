/**
 * M24 P1 单测：范式工具（write_plan / update_plan_step / submit_review）、
 * ToolRegistry 范式门控（forAgent）、PlanReviewService 挂起 / 批准 / 驳回 / 取消 / 超时。
 *
 * 运行时替身与 tools.test.ts 同构（手动建 db / 会话行）；submitPlan 替身模拟引擎挂起链路：
 * plans.create → planReviews.create → wait（测试在等待期间调 resolve / abort）。
 */
import path from 'node:path'
import type { Plan } from '@multi-agent/shared'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { PlanReviewService } from '../src/plan-review.js'
import { ArtifactStore } from '../src/store/artifacts.js'
import { openDatabase } from '../src/store/db.js'
import { MemoryStore } from '../src/store/memory.js'
import { PlanStore } from '../src/store/plans.js'
import { ReviewStore } from '../src/store/reviews.js'
import { SkillLibrary } from '../src/store/skills.js'
import { TaskStore } from '../src/store/tasks.js'
import { createToolRegistry } from '../src/tools/builtin.js'
import type { ToolRuntime } from '../src/tools/registry.js'
import { makeTmpDir } from './helpers.js'

const AGENT_ID = 'pm'
const SESSION_ID = 's1'

function makeEnv(): {
  registry: ReturnType<typeof createToolRegistry>
  db: ReturnType<typeof openDatabase>
  runtime: ToolRuntime
  sessionId: string
  plans: PlanStore
  reviews: ReviewStore
  planReviews: PlanReviewService
} {
  const cfg = loadConfig()
  const artifacts = new ArtifactStore(makeTmpDir('ma-art-'))
  const workspace = artifacts.ensureSessionDir(SESSION_ID)
  const skills = new SkillLibrary(cfg.skillsDir)
  const db = openDatabase(path.join(makeTmpDir('ma-db-'), 'app.db'))
  const now = new Date().toISOString()
  db.run(
    `INSERT INTO sessions (id, title, participant_ids, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    SESSION_ID,
    '测试会话',
    JSON.stringify([AGENT_ID, 'architect']),
    now,
    now,
  )
  const memory = new MemoryStore(db)
  const tasks = new TaskStore(db)
  const plans = new PlanStore(db)
  const reviews = new ReviewStore(db)
  const planReviews = new PlanReviewService({ plans, timeoutMs: 0 })
  const runtime: ToolRuntime = {
    sessionId: SESSION_ID,
    runId: 'r1',
    agentId: AGENT_ID,
    workspace,
    artifacts,
    skills,
    memory,
    tasks,
    participants: [
      { id: AGENT_ID, name: '费利' },
      { id: 'architect', name: '阿奇' },
    ],
    todos: [],
    allowRunCommand: false,
    allowedCommands: [],
    allowSensitive: false,
    webSearch: { apiKey: '', apiUrl: '', htmlUrl: '' },
    httpUserAgent: '',
    httpMinIntervalMs: 0,
    httpTimeoutMs: 15_000,
    loadSkill: (name) => {
      const skill = skills.get(name)
      return skill ? { ok: true, body: skill.body } : { ok: false, error: `技能「${name}」不存在` }
    },
    plans,
    reviews,
    submitPlan: async (input, signal) => {
      const plan = plans.create({
        sessionId: SESSION_ID,
        runId: 'r1',
        agentId: AGENT_ID,
        title: input.title,
        goal: input.goal,
        steps: input.steps,
        risks: input.risks,
      })
      // 模拟引擎：登记挂起 → 广播（此处略）→ 等待决定
      planReviews.create(plan)
      const outcome = await planReviews.wait(plan.id, signal)
      return {
        decision: outcome.decision,
        plan: plans.get(plan.id) ?? plan,
        feedback: outcome.feedback,
        cancelled: outcome.cancelled,
      }
    },
  }
  return { registry: createToolRegistry(cfg), db, runtime, sessionId: SESSION_ID, plans, reviews, planReviews }
}

async function tick(ms = 5): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

/** 轮询等待 submitPlan 替身创建计划并挂起 */
async function waitPlan(plans: PlanStore, sessionId: string): Promise<Plan> {
  for (let i = 0; i < 100; i++) {
    const list = plans.list(sessionId)
    if (list.length > 0) return list[0]
    await tick()
  }
  throw new Error('计划未创建（挂起链路未运行）')
}

function createPlan(plans: PlanStore, steps: Array<{ content: string }> = [{ content: '步骤 A' }]): Plan {
  return plans.create({ sessionId: SESSION_ID, runId: 'r1', agentId: AGENT_ID, title: 'T', goal: 'G', steps })
}

describe('M24 范式门控（registry.forAgent）', () => {
  it('plan 模式 = 只读工具 ∪ write_plan（不含任何写工具）', () => {
    const { registry } = makeEnv()
    const names = registry.forAgent({ tools: [] }, 'plan').map((t) => t.name)
    expect(names).toContain('write_plan')
    expect(names).toContain('read_file')
    expect(names).toContain('list_dir')
    expect(names).toContain('handoff')
    expect(names).not.toContain('write_file')
    expect(names).not.toContain('edit_file')
    expect(names).not.toContain('run_command')
    expect(names).not.toContain('write_todos')
    expect(names).not.toContain('submit_review')
  })

  it('review 模式 = 只读工具 ∪ submit_review', () => {
    const { registry } = makeEnv()
    const names = registry.forAgent({ tools: [] }, 'review').map((t) => t.name)
    expect(names).toContain('submit_review')
    expect(names).toContain('read_file')
    expect(names).not.toContain('write_plan')
    expect(names).not.toContain('write_file')
  })

  it('execute 模式：角色白名单原样；缺省 mode 行为不变', () => {
    const { registry } = makeEnv()
    const scoped = registry.forAgent({ tools: ['read_file', 'write_file'] }, 'execute').map((t) => t.name)
    expect(scoped).toEqual(['read_file', 'write_file'])
    expect(registry.forAgent({ tools: [] }).length).toBe(registry.list().length)
  })
})

describe('M24 write_plan', () => {
  it('未注入 submitPlan → 明确错误', async () => {
    const { registry, runtime } = makeEnv()
    const result = await registry.execute(
      'write_plan',
      { title: 'T', goal: 'G', steps: [{ content: 'x' }] },
      { ...runtime, submitPlan: undefined },
    )
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('未启用')
  })

  it('owner 不在场 → 拒绝并给出在场名单', async () => {
    const { registry, runtime } = makeEnv()
    const result = await registry.execute(
      'write_plan',
      { title: 'T', goal: 'G', steps: [{ content: 'x', owner: '幽灵' }] },
      runtime,
    )
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('不在场')
    expect(result.summary).toContain('费利')
    expect(result.summary).toContain('阿奇')
  })

  it('owner 解析（姓名/缺省=作者）+ 批准回灌', async () => {
    const { registry, runtime, plans, planReviews } = makeEnv()
    const call = registry.execute(
      'write_plan',
      {
        title: '发布计划',
        goal: '完成交付',
        steps: [{ content: '写文档' }, { content: '评审文档', owner: '阿奇', mode: 'review' }],
      },
      runtime,
    )
    const plan = await waitPlan(plans, runtime.sessionId)
    expect(plan.steps[0].ownerAgentId).toBeUndefined()
    expect(plan.steps[1].ownerAgentId).toBe('architect')
    expect(plan.steps[1].mode).toBe('review')
    planReviews.resolve(plan.id, 'approve')
    const result = await call
    expect(result.ok).toBe(true)
    expect(result.summary).toContain('已获批准')
    expect(result.plan?.status).toBe('approved')
    expect(result.detail).toContain('派发执行')
  })

  it('驳回 → 回灌反馈与 v+1 重提提示', async () => {
    const { registry, runtime, plans, planReviews } = makeEnv()
    const call = registry.execute('write_plan', { title: 'T', goal: 'G', steps: [{ content: 'x' }] }, runtime)
    const plan = await waitPlan(plans, runtime.sessionId)
    planReviews.resolve(plan.id, 'reject', '步骤太粗，请拆分到可交付粒度')
    const result = await call
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('步骤太粗')
    expect(result.plan?.status).toBe('rejected')
    expect(result.plan?.version).toBe(1)
    expect(result.detail).toContain('v2')
  })

  it('运行停止取消 → 计划保持待批准（可稍后处理）', async () => {
    const { registry, runtime, plans } = makeEnv()
    const fake = createPlan(plans)
    const outcomeRuntime: ToolRuntime = {
      ...runtime,
      submitPlan: async () => ({ decision: 'reject', plan: fake, cancelled: true }),
    }
    const result = await registry.execute('write_plan', { title: 'T', goal: 'G', steps: [{ content: 'x' }] }, outcomeRuntime)
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('取消')
    expect(result.detail).toContain('稍后批准')
    expect(plans.get(fake.id)?.status).toBe('submitted')
  })
})

describe('M24 update_plan_step', () => {
  it('步骤不在可更新范围 → 拒绝并列出可更新项', async () => {
    const { registry, runtime, plans } = makeEnv()
    const plan = createPlan(plans)
    const scoped: ToolRuntime = {
      ...runtime,
      planSteps: [{ planId: plan.id, stepId: 's1', content: '步骤 A' }],
    }
    const result = await registry.execute('update_plan_step', { step_id: 's9', status: 'done' }, scoped)
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('不可更新')
    expect(result.detail).toContain('s1')
  })

  it('blocked 必须带 note', async () => {
    const { registry, runtime, plans } = makeEnv()
    const plan = createPlan(plans)
    const scoped: ToolRuntime = { ...runtime, planSteps: [{ planId: plan.id, stepId: 's1', content: '步骤 A' }] }
    const result = await registry.execute('update_plan_step', { step_id: 's1', status: 'blocked' }, scoped)
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('note')
  })

  it('全步完成/跳过 → 计划自动收口为 done', async () => {
    const { registry, runtime, plans } = makeEnv()
    const plan = createPlan(plans, [{ content: 'a' }, { content: 'b' }])
    plans.setStatus(plan.id, 'approved')
    plans.setStatus(plan.id, 'executing')
    const scoped: ToolRuntime = {
      ...runtime,
      planSteps: [
        { planId: plan.id, stepId: 's1', content: 'a' },
        { planId: plan.id, stepId: 's2', content: 'b' },
      ],
    }
    const first = await registry.execute('update_plan_step', { step_id: 's1', status: 'done' }, scoped)
    expect(first.ok).toBe(true)
    expect(first.plan?.status).toBe('executing')
    const second = await registry.execute('update_plan_step', { step_id: 's2', status: 'skipped' }, scoped)
    expect(second.ok).toBe(true)
    expect(second.plan?.status).toBe('done')
    expect(second.summary).toContain('计划已完成')
  })

  it('计划 blocked 时推进步骤 → 自动恢复 executing', async () => {
    const { registry, runtime, plans } = makeEnv()
    const plan = createPlan(plans)
    plans.setStatus(plan.id, 'approved')
    plans.setStatus(plan.id, 'blocked', { feedback: '评审未通过' })
    const scoped: ToolRuntime = { ...runtime, planSteps: [{ planId: plan.id, stepId: 's1', content: '步骤 A' }] }
    const result = await registry.execute('update_plan_step', { step_id: 's1', status: 'in_progress' }, scoped)
    expect(result.ok).toBe(true)
    expect(result.plan?.status).toBe('executing')
  })
})

describe('M24 submit_review', () => {
  it('target 格式错误 → 拒绝', async () => {
    const { registry, runtime } = makeEnv()
    const result = await registry.execute('submit_review', { target: 'invalid_target', verdict: 'pass' }, runtime)
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('target 格式错误')
  })

  it('fail 无 findings → 拒绝', async () => {
    const { registry, runtime, plans } = makeEnv()
    const plan = createPlan(plans)
    const result = await registry.execute('submit_review', { target: `plan:${plan.id}`, verdict: 'fail' }, runtime)
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('findings')
  })

  it('step fail → 步骤 blocked + 记录落库', async () => {
    const { registry, runtime, plans, reviews } = makeEnv()
    const plan = createPlan(plans)
    plans.setStatus(plan.id, 'approved')
    plans.setStatus(plan.id, 'executing')
    const result = await registry.execute(
      'submit_review',
      { target: 'step:s1', verdict: 'fail', findings: ['口径不一致：验收标准未覆盖边界'], evidence: ['docs/spec.md'] },
      runtime,
    )
    expect(result.ok).toBe(true)
    expect(result.review?.verdict).toBe('fail')
    expect(result.review?.planId).toBe(plan.id)
    expect(result.review?.stepId).toBe('s1')
    expect(result.plan?.steps[0].status).toBe('blocked')
    expect(result.plan?.steps[0].note).toContain('口径不一致')
    expect(reviews.listBySession(SESSION_ID)).toHaveLength(1)
    expect(reviews.listByPlan(plan.id)).toHaveLength(1)
  })

  it('plan fail → 计划 blocked', async () => {
    const { registry, runtime, plans } = makeEnv()
    const plan = createPlan(plans)
    plans.setStatus(plan.id, 'approved')
    plans.setStatus(plan.id, 'executing')
    const result = await registry.execute(
      'submit_review',
      { target: `plan:${plan.id}`, verdict: 'fail', findings: ['整体交付不满足目标'] },
      runtime,
    )
    expect(result.ok).toBe(true)
    expect(result.plan?.status).toBe('blocked')
    expect(result.plan?.feedback).toContain('整体交付')
  })

  it('unknown step / artifact pass → 错误与仅留痕分支', async () => {
    const { registry, runtime, plans, reviews } = makeEnv()
    const missing = await registry.execute('submit_review', { target: 'step:s404', verdict: 'pass' }, runtime)
    expect(missing.ok).toBe(false)
    expect(missing.summary).toContain('步骤不存在')
    const plan = createPlan(plans)
    expect(plan).toBeDefined()
    const artifact = await registry.execute(
      'submit_review',
      { target: 'artifact:docs/需求.md', verdict: 'pass', findings: ['结构完整'], evidence: ['docs/需求.md'] },
      runtime,
    )
    expect(artifact.ok).toBe(true)
    expect(artifact.review?.planId).toBeUndefined()
    expect(artifact.plan).toBeUndefined()
    expect(reviews.listBySession(SESSION_ID)).toHaveLength(1)
  })

  it('多计划同名步骤使用复合键更新与评审，不串联到历史计划', async () => {
    const { registry, runtime, plans, reviews } = makeEnv()
    const historical = createPlan(plans, [{ content: '历史步骤' }])
    const current = createPlan(plans, [{ content: '当前步骤' }])
    plans.setStatus(historical.id, 'approved')
    plans.setStatus(historical.id, 'executing')
    plans.setStatus(current.id, 'approved')
    plans.setStatus(current.id, 'executing')
    const scoped: ToolRuntime = {
      ...runtime,
      planSteps: [
        { planId: historical.id, stepId: 's1', content: '历史步骤' },
        { planId: current.id, stepId: 's1', content: '当前步骤' },
      ],
    }
    const updated = await registry.execute(
      'update_plan_step',
      { step_id: 's1', plan_id: current.id, status: 'in_progress' },
      scoped,
    )
    expect(updated.ok).toBe(true)
    expect(plans.get(historical.id)?.steps[0].status).toBe('pending')
    expect(plans.get(current.id)?.steps[0].status).toBe('in_progress')
    const reviewed = await registry.execute(
      'submit_review',
      { target: `step:${current.id}/s1`, verdict: 'pass', findings: [] },
      scoped,
    )
    expect(reviewed.review?.planId).toBe(current.id)
    expect(reviews.latestByStep(SESSION_ID, 's1', historical.id)).toBeUndefined()
    expect(reviews.latestByStep(SESSION_ID, 's1', current.id)?.verdict).toBe('pass')
  })

  it('跨会话 Plan 与消息评审在写入前拒绝', async () => {
    const { registry, db, runtime, plans, reviews } = makeEnv()
    const now = new Date().toISOString()
    db.run(
      `INSERT INTO sessions (id, title, participant_ids, created_at, updated_at) VALUES ('s2', '其它会话', '["pm"]', ?, ?)`,
      now,
      now,
    )
    const foreign = plans.create({ sessionId: 's2', agentId: AGENT_ID, title: '外部计划', goal: 'G', steps: [{ content: '外部步骤' }] })
    const scoped: ToolRuntime = { ...runtime, reviewMessageExists: (id) => id === 'local-message' }
    const planResult = await registry.execute('submit_review', { target: `plan:${foreign.id}`, verdict: 'pass' }, scoped)
    const stepResult = await registry.execute('submit_review', { target: `step:${foreign.id}/s1`, verdict: 'pass' }, scoped)
    const messageResult = await registry.execute('submit_review', { target: 'message:foreign-message', verdict: 'pass' }, scoped)
    expect(planResult.ok).toBe(false)
    expect(stepResult.ok).toBe(false)
    expect(messageResult.ok).toBe(false)
    expect(reviews.listBySession(SESSION_ID)).toEqual([])
    expect(reviews.listBySession('s2')).toEqual([])
  })

  it('最新失败评审阻止完成，对应非失败复验后才允许 done', async () => {
    const { registry, runtime, plans } = makeEnv()
    const plan = createPlan(plans)
    plans.setStatus(plan.id, 'approved')
    plans.setStatus(plan.id, 'executing')
    const scoped: ToolRuntime = {
      ...runtime,
      planSteps: [{ planId: plan.id, stepId: 's1', content: '步骤 A' }],
    }
    await registry.execute(
      'submit_review',
      { target: `step:${plan.id}/s1`, verdict: 'fail', findings: ['需要修复'] },
      scoped,
    )
    const blocked = await registry.execute('update_plan_step', { step_id: 's1', status: 'done' }, scoped)
    expect(blocked.ok).toBe(false)
    expect(plans.get(plan.id)?.status).toBe('blocked')
    await registry.execute('submit_review', { target: `step:${plan.id}/s1`, verdict: 'conditional', findings: ['已修复并复核'] }, scoped)
    const completed = await registry.execute('update_plan_step', { step_id: 's1', status: 'done' }, scoped)
    expect(completed.ok).toBe(true)
    expect(plans.get(plan.id)?.status).toBe('done')
  })
})

describe('M24 PlanReviewService', () => {
  it('create → resolve(approve) → wait 回灌且计划 approved', async () => {
    const { plans, planReviews } = makeEnv()
    const plan = createPlan(plans)
    planReviews.create(plan)
    expect(planReviews.has(plan.id)).toBe(true)
    const waiting = planReviews.wait(plan.id)
    planReviews.resolve(plan.id, 'approve')
    const outcome = await waiting
    expect(outcome.decision).toBe('approve')
    expect(plans.get(plan.id)?.status).toBe('approved')
    expect(planReviews.has(plan.id)).toBe(false)
    expect(planReviews.resolve(plan.id, 'approve')).toBeNull()
  })

  it('reject 携带反馈 → 计划 rejected + feedback 落库', async () => {
    const { plans, planReviews } = makeEnv()
    const plan = createPlan(plans)
    planReviews.create(plan)
    const waiting = planReviews.wait(plan.id)
    planReviews.resolve(plan.id, 'reject', '  目标不清晰  ')
    const outcome = await waiting
    expect(outcome.decision).toBe('reject')
    expect(outcome.feedback).toBe('目标不清晰')
    const updated = plans.get(plan.id)
    expect(updated?.status).toBe('rejected')
    expect(updated?.feedback).toBe('目标不清晰')
  })

  it('无挂起 resolve → null（路由走稍后批准路径）', () => {
    const { plans, planReviews } = makeEnv()
    const plan = createPlan(plans)
    expect(planReviews.resolve(plan.id, 'approve')).toBeNull()
  })

  it('signal abort → cancelled + 计划保持 submitted', async () => {
    const { plans, planReviews } = makeEnv()
    const plan = createPlan(plans)
    planReviews.create(plan)
    const ac = new AbortController()
    const waiting = planReviews.wait(plan.id, ac.signal)
    ac.abort()
    const outcome = await waiting
    expect(outcome.cancelled).toBe(true)
    expect(outcome.decision).toBe('reject')
    expect(plans.get(plan.id)?.status).toBe('submitted')
  })

  it('cancelled 后再次 wait（稍后处理）→ 按计划状态回灌', async () => {
    const { plans, planReviews } = makeEnv()
    const plan = createPlan(plans)
    planReviews.create(plan)
    const ac = new AbortController()
    const waiting = planReviews.wait(plan.id, ac.signal)
    ac.abort()
    await waiting
    // 稍后批准：不经服务直接置状态（路径模拟）
    plans.setStatus(plan.id, 'approved')
    const replay = await planReviews.wait(plan.id)
    expect(replay.decision).toBe('approve')
  })

  it('超时（timeoutMs>0）→ 按驳回收敛 + timedOut', async () => {
    const { plans } = makeEnv()
    const planReviews = new PlanReviewService({ plans, timeoutMs: 30 })
    const plan = createPlan(plans)
    planReviews.create(plan)
    const outcome = await planReviews.wait(plan.id)
    expect(outcome.timedOut).toBe(true)
    expect(outcome.decision).toBe('reject')
    expect(plans.get(plan.id)?.status).toBe('rejected')
  })

  it('pendingOf / forRun 展示挂起集合', () => {
    const { plans, planReviews } = makeEnv()
    const plan = createPlan(plans)
    planReviews.create(plan)
    expect(planReviews.pendingOf(SESSION_ID).map((p) => p.id)).toEqual([plan.id])
    expect(planReviews.forRun('r1').map((p) => p.id)).toEqual([plan.id])
    expect(planReviews.pendingOf('other')).toEqual([])
    planReviews.resolve(plan.id, 'approve')
    expect(planReviews.pendingOf(SESSION_ID)).toEqual([])
  })
})

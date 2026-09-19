/**
 * M24 P0：协作范式数据层（plans / reviews 存储状态机、迁移 v5、会话 planFirst、消息 mode）。
 */
import { describe, expect, it } from 'vitest'
import { openDatabase } from '../src/store/db.js'
import { PlanStore } from '../src/store/plans.js'
import { ReviewStore } from '../src/store/reviews.js'
import { SessionStore } from '../src/store/sessions.js'

function makeStores(): {
  db: ReturnType<typeof openDatabase>
  sessions: SessionStore
  plans: PlanStore
  reviews: ReviewStore
} {
  const db = openDatabase(':memory:', { memory: true })
  return { db, sessions: new SessionStore(db), plans: new PlanStore(db), reviews: new ReviewStore(db) }
}

const STEP_INPUT = [
  { content: '梳理需求', ownerAgentId: 'pm', acceptance: '需求文档落盘' },
  { content: '实现接口', ownerAgentId: 'backend', expectedOutput: 'src/api.ts' },
]

describe('M24：PlanStore 生命周期', () => {
  it('create：分配 s1..sN 步骤 id、状态 submitted、版本 v1', () => {
    const { db, sessions, plans } = makeStores()
    const session = sessions.create(['pm', 'backend'], 'M24 数据层')
    const plan = plans.create({
      sessionId: session.id,
      runId: 'r_1',
      agentId: 'pm',
      title: '登录功能实施计划',
      goal: '交付可用的登录能力',
      steps: STEP_INPUT,
      risks: ['第三方短信网关不可用'],
    })
    expect(plan.id).toMatch(/^pl_/)
    expect(plan.steps.map((s) => s.id)).toEqual(['s1', 's2'])
    expect(plan.steps[0].status).toBe('pending')
    expect(plan.status).toBe('submitted')
    expect(plan.version).toBe(1)
    expect(plan.risks).toEqual(['第三方短信网关不可用'])

    // 落库可重读
    expect(plans.get(plan.id)?.steps).toHaveLength(2)
    expect(plans.byStatus(session.id, ['submitted'])).toHaveLength(1)
    db.close()
  })

  it('updateDraft：仅 submitted 可编辑（改负责人 / 调序 / 增删）；approve 后拒绝编辑', () => {
    const { db, sessions, plans } = makeStores()
    const session = sessions.create(['pm', 'backend', 'qa'])
    const plan = plans.create({ sessionId: session.id, agentId: 'pm', title: 't', goal: 'g', steps: STEP_INPUT })

    const edited = plans.updateDraft(plan.id, {
      steps: [
        { id: 's2', content: '实现接口', ownerAgentId: 'qa' },
        { id: 's1', content: '梳理需求', ownerAgentId: 'pm', acceptance: '需求文档落盘' },
        { content: '端到端验证', ownerAgentId: 'qa', mode: 'review' },
      ],
    })
    expect(edited?.steps.map((s) => s.id)).toEqual(['s2', 's1', 's3'])
    expect(edited?.steps[0].ownerAgentId).toBe('qa')
    expect(edited?.steps[2].mode).toBe('review')

    plans.setStatus(plan.id, 'approved', { approved: true })
    expect(plans.updateDraft(plan.id, { title: 'x' })).toBeUndefined()
    expect(plans.get(plan.id)?.title).toBe('t')
    db.close()
  })

  it('revise：驳回后修订重提 → 版本递增回 submitted、清空反馈、步骤重分配', () => {
    const { db, sessions, plans } = makeStores()
    const session = sessions.create(['pm'])
    const plan = plans.create({ sessionId: session.id, agentId: 'pm', title: 't', goal: 'g', steps: STEP_INPUT })

    plans.setStatus(plan.id, 'rejected', { feedback: '步骤粒度太粗' })
    expect(plans.get(plan.id)?.feedback).toBe('步骤粒度太粗')

    const revised = plans.revise(plan.id, { goal: 'g2', steps: [{ content: '重新拆解后的第一步' }] })
    expect(revised?.version).toBe(2)
    expect(revised?.status).toBe('submitted')
    expect(revised?.feedback).toBeUndefined()
    expect(revised?.goal).toBe('g2')
    expect(revised?.steps.map((s) => s.id)).toEqual(['s1'])
    expect(revised?.steps[0].status).toBe('pending')
    db.close()
  })

  it('setStepStatus：更新进度与备注；未知步骤 → undefined', () => {
    const { db, sessions, plans } = makeStores()
    const session = sessions.create(['pm', 'backend'])
    const plan = plans.create({ sessionId: session.id, agentId: 'pm', title: 't', goal: 'g', steps: STEP_INPUT })

    const updated = plans.setStepStatus(plan.id, 's2', 'in_progress')
    expect(updated?.steps[1].status).toBe('in_progress')

    const blocked = plans.setStepStatus(plan.id, 's2', 'blocked', '等待数据库账号')
    expect(blocked?.steps[1].status).toBe('blocked')
    expect(blocked?.steps[1].note).toBe('等待数据库账号')

    expect(plans.setStepStatus(plan.id, 's99', 'done')).toBeUndefined()
    db.close()
  })

  it('supersede：其余生命周期计划置 superseded（保留 keepPlanId）；latestRejected 供 v2 判定', () => {
    const { db, sessions, plans } = makeStores()
    const session = sessions.create(['pm', 'backend'])
    const first = plans.create({ sessionId: session.id, runId: 'r_1', agentId: 'pm', title: 'v1', goal: 'g', steps: STEP_INPUT })
    plans.setStatus(first.id, 'executing')
    const second = plans.create({ sessionId: session.id, runId: 'r_1', agentId: 'pm', title: '重规划', goal: 'g', steps: STEP_INPUT })

    const superseded = plans.supersede(session.id, second.id)
    expect(superseded.map((p) => p.id)).toEqual([first.id])
    expect(plans.get(first.id)?.status).toBe('superseded')
    expect(plans.get(second.id)?.status).toBe('submitted')

    plans.setStatus(second.id, 'rejected', { feedback: '再想想' })
    expect(plans.latestRejected('r_1', 'pm')?.id).toBe(second.id)
    db.close()
  })
})

describe('M24：ReviewStore', () => {
  it('create/listBySession/listByPlan/latestByStep：追加式留痕', () => {
    const { db, sessions, plans, reviews } = makeStores()
    const session = sessions.create(['qa'])
    const plan = plans.create({ sessionId: session.id, agentId: 'pm', title: 't', goal: 'g', steps: STEP_INPUT })

    reviews.create({
      sessionId: session.id,
      runId: 'r_1',
      agentId: 'qa',
      planId: plan.id,
      stepId: 's2',
      target: `step:s2`,
      verdict: 'fail',
      findings: ['缺少鉴权校验'],
      evidence: ['src/api.ts:42'],
    })
    reviews.create({
      sessionId: session.id,
      runId: 'r_1',
      agentId: 'qa',
      planId: plan.id,
      stepId: 's2',
      target: 'step:s2',
      verdict: 'pass',
      findings: [],
      evidence: ['复测通过'],
    })

    expect(reviews.listBySession(session.id)).toHaveLength(2)
    expect(reviews.listByPlan(plan.id)).toHaveLength(2)
    const latest = reviews.latestByStep(session.id, 's2')
    expect(latest?.verdict).toBe('pass')
    expect(reviews.listByPlan(plan.id)[0].findings).toEqual(['缺少鉴权校验'])
    db.close()
  })
})

describe('M24：会话与消息扩展字段', () => {
  it('planFirst：create 落库 + setPlanFirst 切换 + 重读一致', () => {
    const { db, sessions } = makeStores()
    const withFlag = sessions.create(['pm'], '规划先行', { planFirst: true })
    const without = sessions.create(['pm'], '默认')
    expect(withFlag.planFirst).toBe(true)
    expect(without.planFirst).toBeUndefined()

    sessions.setPlanFirst(without.id, true)
    expect(sessions.getSession(without.id)?.planFirst).toBe(true)
    sessions.setPlanFirst(withFlag.id, false)
    expect(sessions.getSession(withFlag.id)?.planFirst).toBeUndefined()
    db.close()
  })

  it('消息 mode：落库重读保留（缺省 = execute 不写列）', () => {
    const { db, sessions } = makeStores()
    const session = sessions.create(['pm'])
    sessions.appendMessage({ sessionId: session.id, role: 'user', content: '先规划', mentions: [], status: 'complete', mode: 'plan' })
    sessions.appendMessage({ sessionId: session.id, role: 'agent', agentId: 'pm', content: '计划见下', mentions: [], status: 'complete', mode: 'plan' })
    sessions.appendMessage({ sessionId: session.id, role: 'agent', agentId: 'pm', content: '执行结果', mentions: [], status: 'complete' })
    sessions.saveNow(session.id)

    const stored = sessions.get(session.id)!
    expect(stored.messages[0].mode).toBe('plan')
    expect(stored.messages[1].mode).toBe('plan')
    expect(stored.messages[2].mode).toBeUndefined()
    db.close()
  })
})

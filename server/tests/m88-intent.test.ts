/**
 * M88：意图判定（Intent & Risk Resolver）纯函数矩阵。
 * 覆盖 L0 规则、置信度阈值与 PRS 合并；不涉及引擎调度（集成链路见 m88-autonomy）。
 */
import { describe, expect, it } from 'vitest'
import {
  applyConfidencePolicy,
  coerceRouterIntent,
  legacyIntentOf,
  mergeRouterIntent,
  modeOfIntent,
  planExecutionIntent,
  resolveIntent,
  type IntentInput,
} from '../src/orchestration/intent.js'
import type { TurnIntent } from '@multi-agent/shared'

const base = (text: string, extra: Partial<IntentInput> = {}): TurnIntent => resolveIntent({ text, ...extra })

describe('M88：L0 规则判定', () => {
  it('用户显式 mode 永远优先（source=user）', () => {
    const plan = resolveIntent({ text: '随便聊聊', explicitMode: 'plan' })
    expect(plan).toMatchObject({ needsPlan: true, needsReview: false, source: 'user', confidence: 1 })
    const review = resolveIntent({ text: '随便聊聊', explicitMode: 'review' })
    expect(review).toMatchObject({ needsPlan: false, needsReview: true, source: 'user' })
  })

  it('显式「先出计划 / 先别动手」→ 规划；「帮我规划个活动」→ 直接执行（业务任务不误判）', () => {
    expect(base('先出个登录改造计划再动手')).toMatchObject({ needsPlan: true, source: 'user' })
    expect(base('先别动手，说说你的思路')).toMatchObject({ needsPlan: true })
    expect(base('帮我规划个活动')).toMatchObject({ needsPlan: false })
    expect(base('做个活动策划方案')).toMatchObject({ needsPlan: false })
  })

  it('高风险动作强制规划；开发语境的名词不误伤', () => {
    expect(base('把服务部署到生产环境')).toMatchObject({ needsPlan: true, risk: 'high' })
    expect(base('正式发布这版对外介绍')).toMatchObject({ needsPlan: true, risk: 'high' })
    // 开发需求（名词）不触发高风险
    expect(base('设计一个支付功能')).toMatchObject({ needsPlan: false, risk: 'low' })
    expect(base('把这个发布页做出来')).toMatchObject({ risk: 'low' })
    expect(base('删除接口要多加一个确认')).toMatchObject({ risk: 'low' })
  })

  it('评审 / 验收类请求 → 评审门', () => {
    const intent = base('帮我评审一下这份方案')
    expect(intent.needsReview).toBe(true)
    expect(modeOfIntent(intent)).toBe('review')
  })

  it('带附件且无明确动作 → 评审门（先核对内容）', () => {
    const intent = base('这是需求文档', { attachments: 1 })
    expect(intent.needsReview).toBe(true)
    expect(intent.reasons.join('')).toContain('附件')
  })

  it('会话策略：always-plan 强制；never-plan 放行（高风险仍强制）', () => {
    expect(base('随便聊聊', { autonomy: 'always-plan' })).toMatchObject({ needsPlan: true, source: 'policy' })
    expect(base('做个登录页', { autonomy: 'never-plan' })).toMatchObject({ needsPlan: false })
    expect(base('把服务部署到生产环境', { autonomy: 'never-plan' })).toMatchObject({ needsPlan: true, risk: 'high' })
    // 兼容旧 planFirst
    expect(base('随便聊聊', { planFirst: true })).toMatchObject({ needsPlan: true })
  })

  it('批准计划的执行意图不重复规划，但新消息独立判定', () => {
    expect(modeOfIntent(planExecutionIntent(true))).toBe('execute')
    expect(base('删除旧数据库').needsPlan).toBe(true)
  })

  it('多环节长需求 → 规划（低风险 + 中置信度）', () => {
    const text = '先把登录页做出来，然后接上后端接口，最后补测试并上线验证。需要覆盖设计、开发、测试三个环节。'
    const intent = base(text)
    expect(intent.needsPlan).toBe(true)
    expect(intent.confidence).toBeLessThan(0.75)
    expect(intent.reasons.join('')).toContain('多环节')
  })

  it('开发领域名词（后端 / 接口 / 测试）不是复杂度信号', () => {
    const intent = base('实现导出功能的后端接口说明，完成后交给测试。')
    expect(intent.needsPlan).toBe(false)
  })

  it('“先制定方案”是产出动作，不是“先看计划”', () => {
    expect(base('先制定照护方案与排班')).toMatchObject({ needsPlan: false })
    expect(base('先出个登录改造计划再动手')).toMatchObject({ needsPlan: true })
  })

  it('理由裁剪到 ≤3 条且不为空', () => {
    const intent = base('先把方案给我，然后部署到生产，最后帮我评审一下')
    expect(intent.reasons.length).toBeGreaterThan(0)
    expect(intent.reasons.length).toBeLessThanOrEqual(3)
  })
})

describe('M88：置信度策略（按风险不对称）', () => {
  const routerIntent = (over: Partial<TurnIntent>): TurnIntent => ({
    needsPlan: true,
    needsReview: false,
    risk: 'low',
    confidence: 0.6,
    reasons: ['平台判定'],
    source: 'router',
    ...over,
  })

  it('低风险低置信 → 关闭规划（避免无意义挂起）', () => {
    const gated = applyConfidencePolicy(routerIntent({ risk: 'low', confidence: 0.6 }))
    expect(gated.needsPlan).toBe(false)
    expect(gated.reasons.join('')).toContain('置信度不足')
  })

  it('低风险高置信 / 中风险达标 / 高风险强制 → 保留规划', () => {
    expect(applyConfidencePolicy(routerIntent({ risk: 'low', confidence: 0.9 })).needsPlan).toBe(true)
    expect(applyConfidencePolicy(routerIntent({ risk: 'medium', confidence: 0.6 })).needsPlan).toBe(true)
    expect(applyConfidencePolicy(routerIntent({ risk: 'high', confidence: 0.1 })).needsPlan).toBe(true)
  })

  it('用户显式 / 会话策略不参与阈值收敛', () => {
    const user = resolveIntent({ text: 'x', explicitMode: 'plan' })
    expect(applyConfidencePolicy(user).needsPlan).toBe(true)
    const policy = resolveIntent({ text: 'x', autonomy: 'always-plan' })
    expect(applyConfidencePolicy(policy).needsPlan).toBe(true)
  })
})

describe('M88：PRS 结构化判定合并', () => {
  it('coerceRouterIntent 容错：未知类型 / 缺字段 → undefined 或安全默认', () => {
    expect(coerceRouterIntent(undefined)).toBeUndefined()
    expect(coerceRouterIntent('nope')).toBeUndefined()
    expect(coerceRouterIntent({ needsPlan: false, needsReview: false, riskLevel: 'low', confidence: 0.9, reasons: [] })).toBeUndefined()
    const ok = coerceRouterIntent({ needsPlan: true, needsReview: true, riskLevel: 'medium', confidence: '0.8', reasons: ['多环节'] })
    expect(ok).toMatchObject({ needsPlan: true, needsReview: true, risk: 'medium', confidence: 0.8, source: 'router' })
    // 越界置信度收敛到 0-1
    expect(coerceRouterIntent({ needsPlan: true, riskLevel: 'high', confidence: 5 })?.confidence).toBe(1)
  })

  it('规则意图 + 路由意图合并：高风险取高、理由合并、来源为 router', () => {
    const rule = resolveIntent({ text: '做个活动页' })
    const merged = mergeRouterIntent(
      rule,
      coerceRouterIntent({ needsPlan: true, needsReview: true, riskLevel: 'high', confidence: 0.9, reasons: ['对外发布'] }),
    )
    expect(merged).toMatchObject({ needsPlan: true, needsReview: true, risk: 'high', source: 'router' })
    expect(merged.reasons.join('')).toContain('对外发布')
  })

  it('用户显式 / 会话策略不被路由覆盖', () => {
    const user = resolveIntent({ text: '直接做', explicitMode: 'execute' })
    expect(mergeRouterIntent(user, coerceRouterIntent({ needsPlan: true, riskLevel: 'high', confidence: 1 }))).toBe(user)
    const policy = resolveIntent({ text: '随便', autonomy: 'never-plan' })
    expect(mergeRouterIntent(policy, coerceRouterIntent({ needsPlan: true, confidence: 1 })).needsPlan).toBe(false)
  })
})

describe('意图优先级与动作范围回归', () => {
  it('never-plan 不被复杂度覆盖，文本先规划不被 PRS 覆盖', () => {
    const direct = base('首先调研，然后输出报告', { autonomy: 'never-plan' })
    expect(direct.needsPlan).toBe(false)
    expect(direct.reasons.join('')).not.toContain('先对齐方案')
    const planned = base('先出计划给我确认')
    const router = coerceRouterIntent({ needsPlan: false, riskLevel: 'low', confidence: 1, reasons: ['直接执行'] })
    expect(mergeRouterIntent(planned, router).needsPlan).toBe(true)
    expect(mergeRouterIntent(planned, router).reasons.join('')).not.toContain('直接执行')
  })

  it.each([
    ['不要删除数据，只检查配置', false],
    ['请不要删除 A 或清空 B', false],
    ['不要删除 A，但删除 B', true],
    ['不要删除 A，直接清空 B', true],
    ['只评审删除数据库的方案，不执行', false],
    ['评审删除方案，然后删除 B', true],
  ])('高风险只看肯定动作：%s', (text, high) => {
    expect(base(text).risk === 'high').toBe(high)
    expect(base(text).needsPlan).toBe(high)
  })

  it('只评审修改方案保持只读；修改方案并检查是执行后评审', () => {
    expect(modeOfIntent(base('只评审修改方案'))).toBe('review')
    expect(modeOfIntent(base('不要修改，只检查配置'))).toBe('review')
    expect(modeOfIntent(base('不要修改，只检查配置', { autonomy: 'always-plan' }))).toBe('plan')
    expect(base('修改方案并检查')).toMatchObject({ needsPlan: false, needsReview: true })
    expect(modeOfIntent(base('修改方案并检查'))).toBe('execute')
    expect(modeOfIntent(base('输出三套完整方案，并检查冲突'))).toBe('execute')
    expect(modeOfIntent(base('输出完整方案，最后检查冲突'))).toBe('execute')
    expect(modeOfIntent(base('请结合团队约定评审发布流程要求，产出部署流程约定交付件'))).toBe('execute')
    expect(modeOfIntent(base('请评审这份优化方案'))).toBe('review')
  })

  it('显式 review 在正常、legacy 与 PRS 合并后都保留首波评审', () => {
    for (const intent of [base('修改方案', { explicitMode: 'review' }), legacyIntentOf({ explicitMode: 'review' })]) {
      expect(modeOfIntent(intent)).toBe('review')
      expect(modeOfIntent(mergeRouterIntent(intent, coerceRouterIntent({ needsPlan: false, confidence: 1, reasons: ['执行'] })))).toBe('review')
    }
  })

  it('PRS 高风险即使低置信度且未请求计划也必须规划；不绕过 composer 与已批准步骤', () => {
    const high = coerceRouterIntent({ needsPlan: false, riskLevel: 'high', confidence: 0.1 })!
    expect(applyConfidencePolicy(high).needsPlan).toBe(true)
    expect(mergeRouterIntent(base('开始处理'), high).needsPlan).toBe(true)
    expect(mergeRouterIntent(base('开始处理', { autonomy: 'never-plan' }), high).needsPlan).toBe(true)
    // 文本直接执行是用户的明确约束，可关闭首波规划；Composer execute 同理。
    expect(mergeRouterIntent(base('直接执行'), high).needsPlan).toBe(false)
    expect(mergeRouterIntent(base('开始处理', { explicitMode: 'execute' }), high).needsPlan).toBe(false)
    expect(mergeRouterIntent(planExecutionIntent(true), high).needsPlan).toBe(false)
  })
})

describe('M88：派生与兼容', () => {
  it('modeOfIntent：plan 优先；首波评审看 reviewFirst（门不带首波）', () => {
    expect(modeOfIntent({ needsPlan: true, needsReview: true, risk: 'low', confidence: 1, reasons: [], source: 'rule' })).toBe('plan')
    expect(
      modeOfIntent({ needsPlan: false, needsReview: true, reviewFirst: true, risk: 'low', confidence: 1, reasons: [], source: 'rule' }),
    ).toBe('review')
    // 仅“交付后评审门”（reviewFirst 缺省）→ 首波仍执行
    expect(modeOfIntent({ needsPlan: false, needsReview: true, risk: 'low', confidence: 1, reasons: [], source: 'rule' })).toBe('execute')
    expect(modeOfIntent({ needsPlan: false, needsReview: false, risk: 'low', confidence: 1, reasons: [], source: 'rule' })).toBe('execute')
  })

  it('legacyIntentOf：关闭自动编排时回到旧语义（显式 / planFirst）', () => {
    expect(legacyIntentOf({ planFirst: true })).toMatchObject({ needsPlan: true, source: 'policy' })
    expect(legacyIntentOf({ autonomy: 'always-plan' })).toMatchObject({ needsPlan: true })
    expect(legacyIntentOf({ planFirst: false })).toMatchObject({ needsPlan: false, source: 'default' })
    expect(legacyIntentOf({ explicitMode: 'review' })).toMatchObject({ needsReview: true, source: 'user' })
  })

  it('planExecutionIntent：有验收标准才开评审门', () => {
    expect(planExecutionIntent(true)).toMatchObject({ needsPlan: false, needsReview: true })
    expect(planExecutionIntent(false)).toMatchObject({ needsPlan: false, needsReview: false })
  })
})

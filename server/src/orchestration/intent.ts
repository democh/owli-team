/**
 * M88：回合意图判定（Intent & Risk Resolver）。
 *
 * 编排层只回答两个问题：这一回合**需不需要先出计划**（needsPlan）、**交付后要不要过评审门**（needsReview）。
 * TurnMode 由两者派生（见 modeOfIntent），因此「规划 + 评审」可以组合，而不再是三选一。
 *
 * 三级流水：
 * - L0 规则（本文件 resolveIntent）：确定性、零 LLM 调用，覆盖显式指令 / 高风险动作 / 复杂度信号；
 * - L1 结构化判定（PRS，platform-router 的 intent 块）：只在"无 @ 消息"路径发生一次，不额外调用模型；
 * - L2 运行期纠偏（引擎侧）：写扩散 / 失败信号 → 只做"建议"，不强制改判。
 *
 * 原则：
 * - 用户显式 mode > 文本显式指令 > 会话策略 > 复杂度推断；
 * - 高风险动作始终强制规划（即便会话策略是 never-plan）；
 * - 低置信度默认直接执行（避免无意义挂起），由工具审批门兜底不可逆动作。
 */
import type { IntentRisk, IntentSource, SessionAutonomy, TurnIntent, TurnMode } from '@multi-agent/shared'

export interface IntentInput {
  /** 用户消息正文 */
  text: string
  /** 附件数（有附件且无明确动作 → 交付前先核对） */
  attachments?: number
  /** 会话自动编排策略（显式 > 旧 planFirst 兼容） */
  autonomy?: SessionAutonomy
  /** M24 兼容：会话「规划先行」开关 */
  planFirst?: boolean
  /** 是否已有进行中的计划（有 → 不重复进入规划） */
  hasActivePlan?: boolean
  /** 用户显式选择的范式（Composer；undefined = 未选择） */
  explicitMode?: TurnMode
}

/**
 * 显式要求「先看计划再动手」。
 * 必须是「计划 + 确认语义」或「先出计划再执行」；
 * 「先制定照护方案」是产出动作（要交付文档），不是要等批准。
 */
const PLAN_WORDS =
  /(先|出)(一?版|个)?(计划|方案).{0,4}(给我|看看|确认|过目)|先.{0,4}(看看|看下|给我看).{0,6}(计划|方案)|先出.{0,8}(计划|方案)|先规划|规划先行|先别(动手|执行|改)|不要(直接|先)?(动手|执行|改)/
/** 显式要求直接做 */
const DIRECT_WORDS = /(直接|马上|立刻)[^，。；\n]{0,3}(做|执行|开始|改)|不用(计划|规划)|别(规划|计划)|跳过(计划|规划)/
/** 验收 / 评审类请求（是否“纯验收”还要看有无产出动作，见 reviewFirst） */
const REVIEW_WORDS =
  /(评审|验收|复核|审阅|审核)[一下]?|帮我(看看|检查|评估)[^，。；\n]{0,8}(方案|文档|这份|这个|对不对)|有(没有)问题|挑(挑)?毛病/
/** 产出动作（与验收词共存时，先执行再评审，不进只读首波） */
const PRODUCE_WORDS = /(做|写|整理|制定|生成|实现|输出|产出|设计|搭建|改|优化|完成|准备|拟|起草|汇总|拆解)/
/**
 * 高风险动作（对外 / 不可逆 / 涉及资金与合规）。
 * 注意：必须是「动作」而不是名词——开发语境里的「支付功能」「发布页」「发布日历」「报税检查」不算高风险，
 * 否则会把正常的开发 / 业务需求误判为需要先审批。
 */
const HIGH_RISK_WORDS =
  /(正式发布|对外发布|上线发布|发布到|发布上线|部署到|部署上线|转账|汇款|发起退款|执行退款|付款(?!功能|接口|流程|模块)|删除(?!功能|接口|逻辑|按钮|字段)|清空|格式化|授权给|解绑|签署|签约|群发|发邮件|提交申报|代扣代缴|注销|解散|迁移数据)/
/** 多环节标记（顺序词：真正的阶段推进信号） */
const STEP_WORDS = /(然后|接着|之后|最后|同时|并且|再然后|第一步|第二步|首先|其次)/
/** 多交付物信号（文档类产出；与顺序词共同构成“多环节交付”） */
const DELIVERABLE_WORDS = /(文档|报告|方案|计划书|清单|纪要|演示稿|PPT|白皮书|设计稿)/g

/**
 * 复杂度信号：只有「顺序词 ≥2」或「长文本 + 顺序词 + 多交付物」才算多环节。
 * 注意：不能把“后端 / 接口 / 测试”这类开发领域名词当作复杂度——它们几乎出现在每条开发需求里，
 * 会把普通实现类需求误判为“需要先出计划”（eval handoff-receipts 的回归根因）。
 */
function looksComplex(text: string): boolean {
  const trimmed = text.trim()
  const stepHits = trimmed.match(new RegExp(STEP_WORDS.source, 'g'))?.length ?? 0
  if (stepHits >= 2) return true
  const deliverableHits = trimmed.match(DELIVERABLE_WORDS)?.length ?? 0
  const nonEmptyLines = trimmed.split('\n').filter((line) => line.trim().length > 0).length
  if (trimmed.length >= 300 && stepHits >= 1 && deliverableHits >= 2) return true
  if (nonEmptyLines >= 6 && deliverableHits >= 2) return true
  return false
}

function clampReasons(reasons: string[]): string[] {
  return [...new Set(reasons.filter(Boolean))].slice(0, 3)
}

function round2(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 100) / 100
}

/**
 * L0：确定性意图判定（纯函数，可单测）。
 * 输出的是「意图」而不是 mode —— 调用方用 modeOfIntent 派生 TurnMode。
 */
export function resolveIntent(input: IntentInput): TurnIntent {
  // ① 用户显式选择：最高优先级（用户已经替系统做完决定）
  if (input.explicitMode) {
    return {
      needsPlan: input.explicitMode === 'plan',
      needsReview: input.explicitMode === 'review',
      risk: 'low',
      confidence: 1,
      reasons: ['你在输入框显式选择了本回合范式'],
      source: 'user',
    }
  }

  const text = input.text.trim()
  const reasons: string[] = []
  let needsPlan = false
  let needsReview = false
  let reviewFirst = false
  let risk: IntentRisk = 'low'
  let confidence = 0.5
  let source: IntentSource = 'rule'

  // ② 高风险：无视会话策略强制规划（不可逆动作必须有一次拍板）
  if (HIGH_RISK_WORDS.test(text)) {
    risk = 'high'
    needsPlan = true
    confidence = Math.max(confidence, 0.9)
    reasons.push('涉及高风险动作（对外 / 不可逆）')
  }

  // ③ 文本显式指令（比会话策略更具体）
  const planAsked = PLAN_WORDS.test(text)
  const directAsked = DIRECT_WORDS.test(text)
  if (planAsked) {
    needsPlan = true
    confidence = Math.max(confidence, 0.9)
    reasons.push('你要求先看方案 / 计划')
  }
  if (directAsked && risk !== 'high') {
    needsPlan = false
    confidence = Math.max(confidence, 0.85)
    reasons.push('你要求直接执行')
  }
  if (REVIEW_WORDS.test(text)) {
    needsReview = true
    // M89：只有“纯验收”（无产出动作）才首波进评审；“整理方案并检查”先执行、交付后过评审门
    if (!PRODUCE_WORDS.test(text)) {
      reviewFirst = true
      reasons.push('这是一次验收 / 评审请求')
    } else {
      reasons.push('需求含验收要求，交付后过评审门')
    }
    confidence = Math.max(confidence, 0.85)
  }

  // ④ 会话策略（仅在文本没有显式要求时生效）
  if (!planAsked && !directAsked) {
    if (input.autonomy === 'always-plan' || (!input.autonomy && input.planFirst)) {
      needsPlan = true
      source = 'policy'
      reasons.push('会话已开启「规划先行」')
    } else if (input.autonomy === 'never-plan' && risk !== 'high') {
      needsPlan = false
      source = 'policy'
      reasons.push('会话策略为「直接执行」')
    }
  }

  // ⑤ 复杂度 / 交付核对
  if (!directAsked && looksComplex(text)) {
    needsPlan = true
    confidence = Math.max(confidence, 0.62)
    reasons.push('多环节需求，先对齐方案再动手')
    if (risk !== 'low') needsReview = true
  }
  if ((input.attachments ?? 0) > 0 && !planAsked && !directAsked) {
    needsReview = true
    confidence = Math.max(confidence, 0.7)
    reasons.push('带附件的交付，先核对内容')
  }

  // ⑥ 已有进行中的计划：不重复规划（执行其步骤）
  if (input.hasActivePlan && needsPlan) {
    needsPlan = false
    reasons.push('已有进行中的计划，按步骤推进')
  }

  return {
    needsPlan,
    needsReview,
    ...(reviewFirst ? { reviewFirst: true } : {}),
    risk,
    confidence: round2(confidence),
    reasons: clampReasons(reasons.length > 0 ? reasons : ['常规对话，直接执行']),
    source,
  }
}

/** 意图 → 回合范式（plan 优先于 review：先拍板方向，再执行） */
export function modeOfIntent(intent: TurnIntent): TurnMode {
  if (intent.needsPlan) return 'plan'
  if (intent.reviewFirst) return 'review'
  return 'execute'
}

/**
 * 关闭自动编排时的旧语义（零差异）：仅显式 mode / 会话 planFirst 生效。
 * 保留给 `AUTONOMY_ENABLED=false` 与断点继续（无新用户文本）两类路径。
 */
export function legacyIntentOf(input: {
  explicitMode?: TurnMode
  autonomy?: SessionAutonomy
  planFirst?: boolean
}): TurnIntent {
  if (input.explicitMode) {
    return {
      needsPlan: input.explicitMode === 'plan',
      needsReview: input.explicitMode === 'review',
      risk: 'low',
      confidence: 1,
      reasons: ['显式选择范式'],
      source: 'user',
    }
  }
  const forced = input.autonomy === 'always-plan' || (!input.autonomy && input.planFirst === true)
  return {
    needsPlan: forced || input.autonomy === 'always-plan',
    needsReview: false,
    risk: 'low',
    confidence: 1,
    reasons: forced ? ['会话已开启「规划先行」'] : [],
    source: forced ? 'policy' : 'default',
  }
}

/**
 * 计划执行 Run 的意图：needsPlan 已由“批准”满足；needsReview 由计划是否带验收标准决定
 * （有 acceptance / expectedOutput 才开评审门，避免对无验收物的计划强加评审）。
 */
export function planExecutionIntent(hasAcceptance: boolean): TurnIntent {
  return {
    needsPlan: false,
    needsReview: hasAcceptance,
    risk: 'low',
    confidence: 0.9,
    reasons: [hasAcceptance ? '计划含验收标准，收口过评审门' : '已批准计划，按步骤执行'],
    source: 'policy',
  }
}

/** PRS 输出的 intent 块容错（未知字段 / 越界值一律收敛到安全默认） */
export function coerceRouterIntent(raw: unknown): TurnIntent | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const obj = raw as Record<string, unknown>
  const needsPlan = obj.needsPlan === true
  const needsReview = obj.needsReview === true
  const risk: IntentRisk =
    obj.riskLevel === 'high' ? 'high' : obj.riskLevel === 'medium' ? 'medium' : obj.riskLevel === 'low' ? 'low' : 'low'
  const confidenceRaw = typeof obj.confidence === 'number' ? obj.confidence : Number(obj.confidence)
  const confidence = Number.isFinite(confidenceRaw) ? round2(confidenceRaw) : 0.6
  const reasons = Array.isArray(obj.reasons)
    ? clampReasons(obj.reasons.filter((r): r is string => typeof r === 'string').map((r) => r.trim().slice(0, 60)))
    : []
  if (!needsPlan && !needsReview && risk === 'low' && reasons.length === 0) return undefined
  return {
    needsPlan,
    needsReview,
    risk,
    confidence,
    reasons: reasons.length > 0 ? reasons : ['平台判定'],
    source: 'router',
  }
}

/**
 * 置信度策略（按风险不对称）：误挂起（FP）只是多点一次，误开写（FN）可能不可逆。
 * - high：不看置信度，强制规划；
 * - medium：≥ 0.55 才进入规划；
 * - low：≥ 0.75 才进入规划，否则直接执行。
 * 非 auto 策略（用户显式 / 会话策略）不参与阈值收敛。
 */
export function applyConfidencePolicy(intent: TurnIntent): TurnIntent {
  if (intent.source === 'user' || intent.source === 'policy') return intent
  if (intent.risk === 'high') return intent
  const threshold = intent.risk === 'medium' ? 0.55 : 0.75
  if (intent.needsPlan && intent.confidence < threshold) {
    return {
      ...intent,
      needsPlan: false,
      reasons: clampReasons([...intent.reasons, '判定置信度不足，按直接执行']),
    }
  }
  return intent
}

/**
 * L1 合并：路由模型的结构化判定覆盖规则推断（用户显式 / 会话策略除外）。
 * 合并后统一过一遍置信度策略。
 */
export function mergeRouterIntent(base: TurnIntent, router: TurnIntent | undefined): TurnIntent {
  if (!router) return applyConfidencePolicy(base)
  if (base.source === 'user' || base.source === 'policy') return base
  // 高风险以两者更高者为准（任一判高风险即高风险）
  const risk: IntentRisk =
    base.risk === 'high' || router.risk === 'high' ? 'high' : router.risk === 'medium' || base.risk === 'medium' ? 'medium' : 'low'
  const merged: TurnIntent = {
    needsPlan: router.needsPlan || (risk === 'high' && base.needsPlan),
    needsReview: router.needsReview || base.needsReview,
    // 首波评审只能由用户/规则判定（路由模型只表达“交付后需评审”），不因合并而变成只读首波
    ...(base.reviewFirst ? { reviewFirst: true } : {}),
    risk,
    confidence: Math.max(base.confidence, router.confidence),
    reasons: clampReasons([...router.reasons, ...base.reasons]),
    source: 'router',
  }
  return applyConfidencePolicy(merged)
}

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
 * - 判定只看肯定动作：被否定的危险动作不构成风险；
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
  /** @deprecated 已批准计划的执行入口使用 planExecutionIntent；仅保留兼容旧调用方 */
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
  /(评审|验收|复核|审阅|审核)[一下]?|帮我(看看|检查|评估)[^，。；\n]{0,8}(方案|文档|这份|这个|对不对)|只(?:检查|看看|核对)|有(没有)问题|挑(挑)?毛病/
/** 产出动作（与验收词共存时，先执行再评审，不进只读首波） */
const PRODUCE_WORDS = /(做|写|整理|制定|生成|实现|输出|产出|设计|搭建|改|优化|完成|准备|拟|起草|汇总|拆解)/
/**
 * 高风险动作（对外 / 不可逆 / 涉及资金与合规）。
 * 注意：必须是「动作」而不是名词——开发语境里的「支付功能」「发布页」「发布日历」「报税检查」不算高风险，
 * 否则会把正常的开发 / 业务需求误判为需要先审批。
 */
const HIGH_RISK_WORDS =
  /(正式发布|对外发布|上线发布|发布到|发布上线|部署到|部署上线|转账|汇款|发起退款|执行退款|付款(?!功能|接口|流程|模块)|删除(?!功能|接口|逻辑|按钮|字段)|清空|格式化|授权给|解绑|签署|签约|群发|发邮件|提交申报|代扣代缴|注销|解散|迁移数据)/
/** 否定词只作用于当前小句内的高风险动作（「不要删除 A，但删除 B」后半句仍然危险） */
const NEGATION_WORDS = /(不要|不得|不能|禁止|请勿|无需|没必要|只|先不|别|勿|未|不)/
const CLAUSE_SEPARATOR =
  /[。；;！!？?\n]|，(?=(?:但|不过|而是|只|先|然后|再|还是|改成|改为|直接|马上|立刻|仍然|依然))|,(?=(?:but|instead|only|then))/
const STEP_WORDS = /(然后|接着|之后|最后|同时|并且|再然后|第一步|第二步|首先|其次)/
/** 多交付物信号（文档类产出；与顺序词共同构成“多环节交付”） */
const DELIVERABLE_WORDS = /(文档|报告|方案|计划书|清单|纪要|演示稿|PPT|白皮书|设计稿)/g

/** 按小句切分，保留动作与否定词的作用范围 */
function clausesOf(text: string): string[] {
  return text.split(CLAUSE_SEPARATOR).map((clause) => clause.trim()).filter(Boolean)
}

/**
 * 只认肯定动作：逐个危险动作检查同句中「前一个逗号/句号到现在」的否定辖域。
 * 「不要删除 A，但删除 B」与「不要删除 A，直接清空 B」的后者都是肯定动作。
 */
function hasAffirmedHighRisk(text: string): boolean {
  const pattern = new RegExp(HIGH_RISK_WORDS.source, 'g')
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0
    const start = Math.max(text.lastIndexOf('。', index), text.lastIndexOf('；', index), text.lastIndexOf('\n', index), text.lastIndexOf('，', index)) + 1
    if (!NEGATION_WORDS.test(text.slice(start, index))) return true
  }
  return false
}

/** 纯评审对象里的动作名不构成执行授权（「只评审修改方案」） */
function isReviewOnly(text: string): boolean {
  if (!REVIEW_WORDS.test(text)) return false
  const clauses = clausesOf(text)
  if (clauses.some((clause) => DIRECT_WORDS.test(clause) && !NEGATION_WORDS.test(clause))) return false
  // 逐小句剥离评审动词及其对象，避免把「评审修改方案」里的修改当成产出授权；
  // 产出与验收可以相距很远或分句书写，不能用固定字符窗口判断二者关系。
  return !clauses.some((clause) => {
    if (NEGATION_WORDS.test(clause)) return false
    const withoutReviewObjects = clause.replace(/(?:评审|验收|复核|审阅|审核|检查|核对|评估)(?:一下)?[^，。；]{0,12}/g, '')
    return PRODUCE_WORDS.test(withoutReviewObjects)
  })
}

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

/** 显式 Composer 范式：首波评审同样由 reviewFirst 表达，避免 PRS 合并后退回 execute。 */
export function explicitIntentOf(mode: TurnMode): TurnIntent {
  return {
    needsPlan: mode === 'plan',
    needsReview: mode === 'review',
    ...(mode === 'review' ? { reviewFirst: true } : {}),
    risk: 'low',
    confidence: 1,
    reasons: ['你在输入框显式选择了本回合范式'],
    source: 'user',
  }
}

/**
 * L0：确定性意图判定（纯函数，可单测）。
 * 输出的是「意图」而不是 mode —— 调用方用 modeOfIntent 派生 TurnMode。
 */
export function resolveIntent(input: IntentInput): TurnIntent {
  // ① 用户显式选择：最高优先级（用户已经替系统做完决定）
  if (input.explicitMode) return explicitIntentOf(input.explicitMode)

  const text = input.text.trim()
  const reasons: string[] = []
  let needsPlan = false
  let needsReview = false
  let reviewFirst = false
  let risk: IntentRisk = 'low'
  let confidence = 0.5
  let source: IntentSource = 'rule'

  // ② 高风险：无视会话策略强制规划（不可逆动作必须有一次拍板）
  const highRisk = hasAffirmedHighRisk(text)
  if (highRisk) {
    risk = 'high'
    needsPlan = true
    confidence = Math.max(confidence, 0.9)
    reasons.push('涉及高风险动作（对外 / 不可逆）')
  }

  // ③ 文本显式指令（比会话策略更具体，来源固定为 user，不能被 PRS 覆盖）
  // 「先别动手 / 不要执行」是禁止型，不能当成「直接执行」授权
  const planAsked = PLAN_WORDS.test(text)
  // 「先别动手 / 不要执行」是禁止型；「直接执行」仍受高风险强制规划约束
  const directAsked = DIRECT_WORDS.test(text) && !NEGATION_WORDS.test(text)
  if (planAsked) {
    needsPlan = true
    confidence = Math.max(confidence, 0.9)
    source = 'user'
    reasons.push('你要求先看方案 / 计划')
  }
  if (directAsked && risk !== 'high') {
    needsPlan = false
    confidence = Math.max(confidence, 0.85)
    // 「先出计划」的明确要求优先于「不用规划」这类弱信号
    if (!planAsked) source = 'user'
    reasons.push('你要求直接执行')
  }
  const reviewWord = /检查|核对/.test(text) && !/(并|和|或|再|然后|最后)[^，。；\s]{0,4}(检查|核对)/.test(text)
  if (REVIEW_WORDS.test(text) || reviewWord || /(?:并|再|然后|最后)[^，。；\s]{0,4}(?:检查|核对)/.test(text)) {
    needsReview = true
    if (isReviewOnly(text)) {
      reviewFirst = true
      reasons.push('这是一次验收 / 评审请求')
    } else {
      reasons.push('需求含验收要求，交付后过评审门')
    }
    confidence = Math.max(confidence, 0.85)
  }

  // ④ 会话策略（仅在文本没有显式要求时生效；never-plan 不被复杂度覆盖）
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

  // ⑤ 复杂度 / 交付核对（会话显式 never-plan 不被规则推断覆盖）
  const complexity = !directAsked && input.autonomy !== 'never-plan' && looksComplex(text)
  if (complexity) {
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
  if (input.explicitMode) return explicitIntentOf(input.explicitMode)
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
    approvedPlan: true,
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
  if (intent.risk === 'high') {
    return intent.needsPlan
      ? intent
      : {
          ...intent,
          needsPlan: true,
          reasons: clampReasons([...intent.reasons, '高风险动作先确认方案']),
        }
  }
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
 * L1 合并：路由模型只补充规则未识别的需求，不推翻用户显式要求。
 * - 用户显式 Composer / 文本明确要求：原样保留；
 * - 会话策略：仅高风险可强制规划，其余保留策略；
 * - 其余：合并计划、评审与高风险，并统一过置信度策略。
 */
export function mergeRouterIntent(base: TurnIntent, router: TurnIntent | undefined): TurnIntent {
  if (!router) return applyConfidencePolicy(base)
  // 文本明确先规划 / 未显式点名执行时，路由不能把核心高风险需求降为直接执行
  if (base.source === 'user') {
    if (!router.needsPlan && base.needsPlan && base.confidence >= 0.9) return base
    if (base.risk === 'high' && !base.needsPlan && router.needsPlan) {
      return applyConfidencePolicy({ ...base, needsPlan: true, reasons: clampReasons([...base.reasons, '风险动作先确认方案']) })
    }
    return base
  }
  const highRisk = base.risk === 'high' || router.risk === 'high'
  // 已批准计划的执行步骤：needsPlan 已由「批准」满足，路由不能重新要求规划。
  if (base.approvedPlan) return base
  if (base.source === 'policy') {
    if (!highRisk || base.needsPlan) return base
    return {
      ...base,
      needsPlan: true,
      risk: 'high',
      reasons: clampReasons(['会话策略放行，但发现高风险动作']),
    }
  }
  const risk: IntentRisk = highRisk ? 'high' : router.risk === 'medium' || base.risk === 'medium' ? 'medium' : 'low'
  // 规则已识别的高风险同样属于强制规划，不能因路由低置信度而退回直接执行。
  const forcedPlan = base.risk === 'high' || router.risk === 'high'
  const merged: TurnIntent = {
    needsPlan: router.needsPlan || base.needsPlan || forcedPlan,
    needsReview: router.needsReview || base.needsReview,
    // 首波评审只能由用户 / 规则判定（路由模型只表达“交付后需评审”）。
    ...(base.reviewFirst ? { reviewFirst: true } : {}),
    risk,
    confidence: Math.max(base.confidence, router.confidence),
    reasons: clampReasons([...router.reasons, ...base.reasons]),
    source: 'router',
  }
  return applyConfidencePolicy(merged)
}

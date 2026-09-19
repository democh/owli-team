/**
 * M24 范式工具（规划 / 评审）：write_plan / update_plan_step / submit_review。
 *
 * 可见性由 ToolRegistry.forAgent(agent, mode) 门控——execute 范式下模型看不到这些工具；
 * plan 范式 = 只读工具 ∪ {write_plan,…}；review 范式 = 只读工具 ∪ {submit_review,…}。
 * 工具内部不再做范式判定（门控是唯一入口），只做业务校验：
 * - write_plan：owner 必须在场（缺省 = 作者）；经 ctx.submitPlan 挂起等待批准，批准/驳回/取消三类结论回灌；
 * - update_plan_step：仅限 ctx.planSteps（引擎按「步骤负责人或计划作者」计算）；
 * - submit_review：target 统一寻址 plan:/step:/artifact:/message:；fail → 步骤/计划 blocked。
 */
import { z } from 'zod'
import type { Plan, PlanStep } from '@multi-agent/shared'
import type { AgentTool, PlanSubmitInput, ToolRuntime, ToolResult } from './registry.js'

const STEP_ICON = { pending: '☐', in_progress: '◐', done: '☑', blocked: '⛔', skipped: '⇥' } as const

/** 在场成员解析（id 或姓名；去 @ 前缀） */
function resolveMember(ctx: ToolRuntime, raw: string): { id: string; name: string } | undefined {
  const key = raw.trim().replace(/^@/, '')
  if (!key) return undefined
  return ctx.participants.find((p) => p.id === key) ?? ctx.participants.find((p) => p.name === key)
}

function rosterText(ctx: ToolRuntime): string {
  return ctx.participants.map((p) => `${p.name}(${p.id})`).join('、')
}

interface WritePlanArgs {
  title: string
  goal: string
  steps: Array<{
    content: string
    owner?: string
    mode: 'execute' | 'review'
    expected_output?: string
    acceptance?: string
  }>
  risks?: string[]
}

const writePlanTool = {
  name: 'write_plan',
  description:
    '提交协作计划（规划范式的核心产出）：标题、目标、步骤（含负责人 / 期望产出 / 验收标准）、风险。提交后本回合挂起等待用户批准；被驳回时按反馈修订后重新提交；批准后引擎按步骤负责人派发执行。',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '计划标题（一句话概括）' },
      goal: { type: 'string', description: '总体目标与完成定义' },
      steps: {
        type: 'array',
        description: '执行步骤（1-12 项，按执行顺序）',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: '步骤内容（可执行的动作描述）' },
            owner: { type: 'string', description: '负责人（在场成员 id 或姓名；缺省 = 你自己）' },
            mode: {
              type: 'string',
              enum: ['execute', 'review'],
              description: '步骤范式：execute 正常执行（默认）；review 评审',
            },
            expected_output: { type: 'string', description: '期望产出（交付件路径 / 结论描述）' },
            acceptance: { type: 'string', description: '验收标准（可核对的完成条件）' },
          },
          required: ['content'],
        },
      },
      risks: { type: 'array', items: { type: 'string' }, description: '风险与依赖（≤6 条，可空）' },
    },
    required: ['title', 'goal', 'steps'],
  },
  schema: z.object({
    title: z.string().min(1).max(80),
    goal: z.string().min(1).max(300),
    steps: z
      .array(
        z.object({
          content: z.string().min(1).max(200),
          owner: z.string().min(1).max(40).optional(),
          mode: z.enum(['execute', 'review']).default('execute'),
          expected_output: z.string().max(200).optional(),
          acceptance: z.string().max(200).optional(),
        }),
      )
      .min(1)
      .max(12),
    risks: z.array(z.string().min(1).max(200)).max(6).optional(),
  }),
  async execute(args: WritePlanArgs, ctx: ToolRuntime): Promise<ToolResult> {
    if (!ctx.submitPlan) {
      return { ok: false, summary: '计划通道未启用（当前回合不支持 write_plan）' }
    }
    const steps: PlanSubmitInput['steps'] = []
    for (const step of args.steps) {
      let ownerAgentId: string | undefined
      if (step.owner) {
        const hit = resolveMember(ctx, step.owner)
        if (!hit) {
          return {
            ok: false,
            summary: `步骤负责人「${step.owner}」不在场：可指派 ${rosterText(ctx)}；或省略 owner 由你（${ctx.agentId}）负责`,
          }
        }
        ownerAgentId = hit.id
      }
      steps.push({
        content: step.content,
        ownerAgentId,
        mode: step.mode === 'review' ? 'review' : undefined,
        expectedOutput: step.expected_output,
        acceptance: step.acceptance,
      })
    }
    const outcome = await ctx.submitPlan({ title: args.title, goal: args.goal, steps, risks: args.risks }, ctx.signal)
    if (outcome.cancelled) {
      return {
        ok: false,
        summary: `计划已提交（${outcome.plan.title}，待批准），审批因运行停止而取消`,
        detail: '计划保持「待批准」状态，可在任务面板稍后批准或驳回。本回合到此为止。',
        plan: outcome.plan,
      }
    }
    if (outcome.superseded) {
      return {
        ok: false,
        summary: `计划「${outcome.plan.title}」已被并行批准的其它计划取代（superseded）`,
        detail: '用户批准了本波的另一个计划，本计划不再执行。如需继续，请等待当前计划完成后再重新规划。本回合到此为止。',
        plan: outcome.plan,
      }
    }
    if (outcome.decision === 'reject') {
      const feedback = outcome.feedback?.trim()
      return {
        ok: false,
        summary: feedback ? `计划被驳回：${feedback}` : '计划被驳回（未附反馈，等同「重新规划」）',
        detail: `请按反馈修订计划后再次调用 write_plan（将作为 v${outcome.plan.version + 1} 重新提交并再次等待批准）。`,
        plan: outcome.plan,
      }
    }
    const ownerSeq = [...new Set(outcome.plan.steps.map((s) => s.ownerAgentId ?? outcome.plan.agentId))].join(' → ')
    return {
      ok: true,
      summary: `计划「${outcome.plan.title}」已获批准（v${outcome.plan.version}），进入执行`,
      detail: [
        `引擎将按步骤负责人派发执行（队列：${ownerSeq}）。`,
        '负责人可用 update_plan_step 汇报进度（in_progress / done / blocked / skipped）。',
        '全部步骤完成或跳过后，你将获得一次收口回合汇总结果。',
      ].join('\n'),
      plan: outcome.plan,
    }
  },
}

interface UpdateStepArgs {
  step_id: string
  status: 'in_progress' | 'done' | 'blocked' | 'skipped'
  note?: string
}

const updatePlanStepTool = {
  name: 'update_plan_step',
  description:
    '更新你负责的计划步骤状态：in_progress 开始执行 / done 完成 / blocked 阻塞（必须给 note 原因）/ skipped 跳过。所有步骤完成或跳过后计划自动收口；计划因评审 fail 被置 blocked 时，推进步骤会自动恢复执行。',
  parameters: {
    type: 'object',
    properties: {
      step_id: { type: 'string', description: '步骤 id（见回合指令「你负责的计划步骤」或系统提示 <active_plans>）' },
      status: { type: 'string', enum: ['in_progress', 'done', 'blocked', 'skipped'] },
      note: { type: 'string', description: '进度备注（blocked 必填：阻塞原因）' },
    },
    required: ['step_id', 'status'],
  },
  schema: z.object({
    step_id: z.string().min(1).max(40),
    status: z.enum(['in_progress', 'done', 'blocked', 'skipped']),
    note: z.string().max(300).optional(),
  }),
  async execute(args: UpdateStepArgs, ctx: ToolRuntime): Promise<ToolResult> {
    if (!ctx.plans) return { ok: false, summary: '计划存储未启用' }
    const scope = ctx.planSteps ?? []
    const target = scope.find((s) => s.stepId === args.step_id)
    if (!target) {
      const list = scope.length > 0 ? scope.map((s) => `${s.stepId}（${s.content}）`).join('；') : '（无）'
      return {
        ok: false,
        summary: `步骤 ${args.step_id} 不可更新：仅限你负责或你提交的计划步骤`,
        detail: `当前可更新：${list}`,
      }
    }
    const note = args.note?.trim()
    if (args.status === 'blocked' && !note) {
      return { ok: false, summary: 'blocked 必须提供 note 说明阻塞原因（后续恢复依据）' }
    }
    let plan = ctx.plans.setStepStatus(target.planId, args.step_id, args.status, note)
    if (!plan) return { ok: false, summary: `更新失败：计划或步骤不存在（${target.planId}/${args.step_id}）` }
    // 步骤推进（非 blocked）自动解除计划 blocked（评审 fail 后的修复路径）
    if (plan.status === 'blocked' && args.status !== 'blocked') {
      plan = ctx.plans.setStatus(plan.id, 'executing') ?? plan
    }
    // 全步完成（done|skipped）→ 计划收口
    const finished = plan.steps.every((s) => s.status === 'done' || s.status === 'skipped')
    if (finished && (plan.status === 'executing' || plan.status === 'approved')) {
      plan = ctx.plans.setStatus(plan.id, 'done') ?? plan
    }
    const doneCount = plan.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length
    return {
      ok: true,
      summary: `步骤 ${args.step_id} → ${args.status}（进度 ${doneCount}/${plan.steps.length}${plan.status === 'done' ? '，计划已完成' : ''}）`,
      detail: plan.steps
        .map((s: PlanStep) => `${STEP_ICON[s.status]} ${s.id} ${s.content}${s.note ? `（${s.note}）` : ''}`)
        .join('\n'),
      plan,
    }
  },
}

interface SubmitReviewArgs {
  target: string
  verdict: 'pass' | 'conditional' | 'fail'
  findings: string[]
  evidence: string[]
}

const submitReviewTool = {
  name: 'submit_review',
  description:
    '提交结构化评审判定（评审范式的核心产出）：对计划 / 步骤 / 交付件 / 消息给出 pass / conditional / fail 判定与发现清单、证据。fail 会阻塞对应步骤或计划，修复后可复审。',
  parameters: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        description: '评审目标：plan:<计划id> / step:<步骤id> / artifact:<工作区路径> / message:<消息id>',
      },
      verdict: { type: 'string', enum: ['pass', 'conditional', 'fail'], description: '判定：通过 / 有条件通过 / 不通过' },
      findings: { type: 'array', items: { type: 'string' }, description: '发现清单（fail / conditional 必填；pass 可空）' },
      evidence: { type: 'array', items: { type: 'string' }, description: '证据（文件路径 / 命令输出摘要等）' },
    },
    required: ['target', 'verdict'],
  },
  schema: z.object({
    target: z.string().min(4).max(300),
    verdict: z.enum(['pass', 'conditional', 'fail']),
    findings: z.array(z.string().min(1).max(300)).max(10).default([]),
    evidence: z.array(z.string().min(1).max(300)).max(10).default([]),
  }),
  async execute(args: SubmitReviewArgs, ctx: ToolRuntime): Promise<ToolResult> {
    if (!ctx.reviews || !ctx.plans) return { ok: false, summary: '评审通道未启用' }
    const matched = /^(plan|step|artifact|message):(.+)$/.exec(args.target.trim())
    if (!matched) {
      return { ok: false, summary: 'target 格式错误：应为 plan:<id> / step:<id> / artifact:<path> / message:<id>' }
    }
    const kind = matched[1] as 'plan' | 'step' | 'artifact' | 'message'
    const ref = matched[2].trim()
    if (!ref) return { ok: false, summary: 'target 引用为空' }
    if (args.verdict !== 'pass' && args.findings.length === 0) {
      return { ok: false, summary: `${args.verdict} 判定必须给出 findings（发现清单）` }
    }
    // 计划 / 步骤目标解析归属；artifact / message 仅留痕（不做结构性后果）
    let plan: Plan | undefined
    let step: PlanStep | undefined
    if (kind === 'plan') {
      plan = ctx.plans.get(ref)
      if (!plan) return { ok: false, summary: `计划不存在：${ref}` }
    } else if (kind === 'step') {
      const hit = ctx.plans.findByStepId(ctx.sessionId, ref)
      if (!hit) return { ok: false, summary: `步骤不存在：${ref}（step:<id> 需为会话内某计划的步骤）` }
      plan = hit.plan
      step = hit.step
    }
    const record = ctx.reviews.create({
      sessionId: ctx.sessionId,
      runId: ctx.runId,
      agentId: ctx.agentId,
      planId: plan?.id,
      stepId: step?.id,
      target: args.target.trim(),
      verdict: args.verdict,
      findings: args.findings,
      evidence: args.evidence,
    })
    // fail 的结构性后果：命中步骤 → 该步 blocked；命中计划 → 计划 blocked（待修复后恢复）
    let updated: Plan | undefined
    if (args.verdict === 'fail' && plan) {
      updated = step
        ? ctx.plans.setStepStatus(plan.id, step.id, 'blocked', args.findings[0])
        : ctx.plans.setStatus(plan.id, 'blocked', { feedback: args.findings[0] })
    }
    const label = { pass: '通过', conditional: '有条件通过', fail: '不通过' }[args.verdict]
    const suffix = args.verdict === 'fail' && plan ? (step ? '（步骤已置 blocked）' : '（计划已置 blocked）') : ''
    return {
      ok: true,
      summary: `评审已提交：${args.target} → ${label}${suffix}`,
      detail: [
        `判定：${label}`,
        ...args.findings.map((f) => `- 发现：${f}`),
        ...args.evidence.map((e) => `- 证据：${e}`),
      ].join('\n'),
      review: record,
      plan: updated,
    }
  },
}

/** M24 范式工具集（plan / review 可见性由 registry.forAgent(mode) 门控） */
export function createPlanTools(): AgentTool[] {
  return [writePlanTool, updatePlanStepTool, submitReviewTool]
}

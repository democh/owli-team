/**
 * request_approval 工具（M7）：模型在动高风险操作前显式请求用户批准。
 *
 * 与引擎的强制审批拦截（APPROVAL_MODE）互补：
 * - 强制拦截：git_commit / git_restore / run_command / 覆盖写等，由引擎在工具执行前插入审批（模型无需知情）；
 * - 主动请求：模型遇到方案分歧、破坏性意图、需要用户拍板的决策时主动调用本工具。
 *
 * 工具不产生文件副作用；用户拒绝 / 超时 → 返回 ok:false 并附可修正反馈（模型据此改方案）。
 */
import { z } from 'zod'
import type { AgentTool, ToolResult } from './registry.js'

const schema = z.object({
  action: z.string().min(1, '请说明要做什么').max(200, 'action 过长'),
  detail: z.string().min(1, '请给出背景与影响面').max(4000, 'detail 过长'),
  options: z.array(z.string().min(1)).max(6).optional(),
})

export function createApprovalTools(): AgentTool[] {
  return [
    {
      name: 'request_approval',
      description:
        '在执行高风险或不可逆操作前（删除、覆盖关键文件、改依赖版本、推分支等），或需要用户在多个方案间拍板时，请求用户批准。调用后本轮暂停等待用户决定；批准返回批准（可能带修改意见），拒绝返回原因，请根据反馈调整方案再继续。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: '一句话描述要做的动作（如：在 main 上执行 npm install lodash）' },
          detail: { type: 'string', description: '细节与影响面：命令原文 / 文件 diff 摘要 / 备选方案对比' },
          options: { type: 'array', items: { type: 'string' }, description: '可选项文案（缺省为 批准 / 拒绝）' },
        },
        required: ['action', 'detail'],
        additionalProperties: false,
      },
      schema,
      execute: async (args, ctx): Promise<ToolResult> => {
        if (!ctx.requestApproval) {
          return { ok: false, summary: '当前环境未启用审批通道（APPROVAL_MODE=off），请直接说明风险并继续' }
        }
        const outcome = await ctx.requestApproval(args.action, args.detail, args.options)
        const feedback = outcome.feedback ? `\n用户反馈：${outcome.feedback}` : ''
        if (outcome.decision === 'approve') {
          return { ok: true, summary: '用户已批准', detail: `用户已批准「${args.action}」。${feedback}` }
        }
        if (outcome.decision === 'custom') {
          return {
            ok: true,
            summary: '用户批准并附修改意见',
            detail: `用户批准「${args.action}」，但要求按以下意见执行：${outcome.feedback ?? '（无详情）'}`,
          }
        }
        if (outcome.cancelled) {
          return { ok: false, summary: '审批已取消（运行停止）', detail: '运行已被停止，审批取消，本次操作未执行。' }
        }
        if (outcome.timedOut) {
          return {
            ok: false,
            summary: '等待用户响应超时',
            detail: '用户未在时限内响应，视为拒绝。请改换无争议的方案继续，或在本轮结束时交还用户确认。',
          }
        }
        return {
          ok: false,
          summary: '用户已拒绝',
          detail: `用户拒绝「${args.action}」。${outcome.feedback ? `拒绝原因：${outcome.feedback}` : '（未给出原因）'}\n请根据反馈调整方案，不要重试同样的动作。`,
        }
      },
    },
  ]
}

export type RequestApprovalFn = (
  action: string,
  detail: string,
  options?: string[],
) => Promise<import('../approval.js').ApprovalOutcome>

/**
 * M35：定时任务工具集（schedule_task / list_schedules / manage_schedule）。
 *
 * 三个工具均为 tier=deferred（经 tool_search 检索激活，Run 级生命周期）：
 * - schedule_task：建任务（run = 到点让目标成员开工 / remind = 到点提醒）；
 * - list_schedules：看本会话任务清单（状态 / 规则 / 下次触发）；
 * - manage_schedule：暂停 / 恢复 / 删除 / 立即运行。
 *
 * 纪律：
 * - 只能管理本会话的任务（跨会话操作一律拒绝）；
 * - run 类型必须指定会话内成员（id 或显示名皆可）；cron 走 shared 内核解析，
 *   最小间隔护栏由服务层统一执行（防高频失控）；
 * - 创建/变更/触发都发 notify:schedule-changed，用户面板实时可见（透明可审计）。
 */
import { z } from 'zod'
import type { ScheduleSpec, ScheduledTask } from '@multi-agent/shared'
import { describeScheduleSpec, formatWallTime } from '@multi-agent/shared'
import type { AgentTool, ToolResult, ToolRuntime } from './registry.js'

/** 会话成员解析：接受 id 或显示名（agents 资产里的中文名） */
function resolveParticipant(ctx: ToolRuntime, raw?: string): { id: string; name: string } | undefined {
  const key = raw?.trim()
  if (!key) return undefined
  const lowered = key.toLowerCase()
  return ctx.participants.find((p) => p.id.toLowerCase() === lowered || p.name === key)
}

/** 任务状态人话标签（列表与回执共用） */
function statusLabel(task: ScheduledTask): string {
  if (!task.enabled) return task.lastStatus === 'paused' ? '已暂停' : '已停用'
  switch (task.lastStatus) {
    case 'ok':
      return '正常'
    case 'skipped-busy':
      return '上次跳过（会话忙）'
    case 'skipped-missed':
      return '上次跳过（错过窗口）'
    case 'error':
      return `上次失败：${task.lastError ?? '未知原因'}`
    default:
      return '待触发'
  }
}

/** 任务单行摘要（工具回执 / detail 共用） */
function taskLine(task: ScheduledTask): string {
  const rule = describeScheduleSpec(task.spec, { tz: task.timezone })
  const next = task.nextRunAt ? formatWallTime(new Date(task.nextRunAt), task.timezone) : '无（已终结）'
  const target = task.kind === 'run' ? ` → @${task.targetAgentId ?? '?'}` : ''
  return `${task.id}｜${task.title}｜${task.kind === 'run' ? '触发运行' : '提醒'}${target}｜${rule}｜状态 ${statusLabel(task)}｜下次 ${next}`
}

const scheduleTaskArgs = z.object({
  title: z.string().min(1).max(80),
  kind: z.enum(['run', 'remind']),
  instruction: z.string().min(1).max(2_000),
  target_agent: z.string().min(1).optional(),
  spec_kind: z.enum(['once', 'cron']),
  at: z.string().optional(),
  expr: z.string().optional(),
  tz: z.string().optional(),
})

const scheduleTaskTool: AgentTool = {
  name: 'schedule_task',
  tier: 'deferred',
  readOnly: false,
  description:
    '创建定时任务（本会话内调度）：到点自动让某位成员开工（kind=run，如「每天 09:00 让 @pm 巡检进度」），或只发提醒不耗 token（kind=remind）。时间规则二选一：一次性（spec_kind=once + at ISO 时刻）；循环（spec_kind=cron + 5 段表达式「分 时 日 月 周」，如 "0 9 * * 1-5" = 工作日 09:00、"*/30 * * * *" = 每 30 分钟；最小间隔 5 分钟）。定时、周期、提醒、每天早上、每周、cron 等需求均用本工具。',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '任务标题（≤80 字，展示用）' },
      kind: { type: 'string', enum: ['run', 'remind'], description: 'run = 到点触发目标成员协作运行；remind = 仅提醒（零 token）' },
      instruction: { type: 'string', description: 'run：注入给目标成员的指令正文；remind：提醒正文' },
      target_agent: { type: 'string', description: 'kind=run 必填：目标成员（会话内成员 id 或显示名）' },
      spec_kind: { type: 'string', enum: ['once', 'cron'], description: 'once = 一次性时刻；cron = 5 段循环表达式' },
      at: { type: 'string', description: 'spec_kind=once：ISO 触发时刻（含时区偏移，如 2026-10-01T09:00:00+08:00；须为未来）' },
      expr: { type: 'string', description: 'spec_kind=cron：分 时 日 月 周（如 "0 9 * * 1-5"）' },
      tz: { type: 'string', description: '可选 IANA 时区（如 Asia/Shanghai；缺省 = 服务器默认时区）' },
    },
    required: ['title', 'kind', 'instruction', 'spec_kind'],
  },
  schema: scheduleTaskArgs,
  async execute(args: z.infer<typeof scheduleTaskArgs>, ctx: ToolRuntime): Promise<ToolResult> {
    if (!ctx.scheduleRuntime) return { ok: false, summary: '定时任务未启用（服务端未装配调度服务）' }
    const spec: ScheduleSpec =
      args.spec_kind === 'once'
        ? { kind: 'once', at: args.at, tz: args.tz }
        : { kind: 'cron', expr: args.expr, tz: args.tz }

    let targetId: string | undefined
    if (args.kind === 'run') {
      const target = resolveParticipant(ctx, args.target_agent)
      if (!target) {
        const candidates = ctx.participants.map((p) => `${p.id}（${p.name}）`).join('、')
        return {
          ok: false,
          summary: args.target_agent
            ? `目标成员「${args.target_agent}」不在会话中。候选：${candidates}`
            : `kind=run 必须指定 target_agent。候选：${candidates}`,
        }
      }
      targetId = target.id
    }

    const result = ctx.scheduleRuntime.create({
      sessionId: ctx.sessionId,
      title: args.title,
      kind: args.kind,
      instruction: args.instruction,
      targetAgentId: targetId,
      spec,
      createdBy: ctx.agentId,
    })
    if (!result.ok || !result.task) return { ok: false, summary: result.error ?? '创建失败' }
    const task = result.task
    return {
      ok: true,
      summary: `已创建定时任务「${task.title}」（${describeScheduleSpec(task.spec, { tz: task.timezone })}，下次 ${task.nextRunAt ? formatWallTime(new Date(task.nextRunAt), task.timezone) : '待定'}；id=${task.id}）`,
      detail: `任务 id：${task.id}\n类型：${task.kind === 'run' ? `触发运行（@${task.targetAgentId}）` : '纯提醒'}\n规则：${describeScheduleSpec(task.spec, { tz: task.timezone })}（时区 ${task.timezone}）\n下次触发：${task.nextRunAt ?? '待定'}\n可用 manage_schedule 暂停 / 调整，list_schedules 查看清单。`,
    }
  },
}

const listSchedulesTool: AgentTool = {
  name: 'list_schedules',
  tier: 'deferred',
  readOnly: true,
  description:
    '列出本会话的定时任务清单：标题、类型（触发运行 / 提醒）、cron 规则、状态（正常 / 已暂停 / 上次跳过原因）、下次触发时刻。用户问「有哪些定时任务」「提醒安排」或要调整前先查看现状时使用。',
  parameters: { type: 'object', properties: {} },
  schema: z.object({}),
  async execute(_args: Record<string, never>, ctx: ToolRuntime): Promise<ToolResult> {
    if (!ctx.scheduleRuntime) return { ok: false, summary: '定时任务未启用（服务端未装配调度服务）' }
    const tasks = ctx.scheduleRuntime.list(ctx.sessionId)
    if (tasks.length === 0) return { ok: true, summary: '本会话暂无定时任务。可用 schedule_task 创建。' }
    const lines = tasks.map(taskLine)
    const enabled = tasks.filter((t) => t.enabled).length
    return {
      ok: true,
      summary: `本会话共 ${tasks.length} 个定时任务（启用 ${enabled} 个）`,
      detail: lines.join('\n'),
    }
  },
}

const manageScheduleArgs = z.object({
  action: z.enum(['pause', 'resume', 'remove', 'run_now']),
  task_id: z.string().min(1),
})

const manageScheduleTool: AgentTool = {
  name: 'manage_schedule',
  tier: 'deferred',
  readOnly: false,
  description:
    '管理本会话已有的定时任务：pause 暂停（保留配置可恢复）/ resume 恢复 / remove 删除 / run_now 立即执行一次（不改变原定节奏）。用户要「暂停/取消/改期(先删再建)/现在就跑一次」时使用；任务 id 从 list_schedules 获取。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['pause', 'resume', 'remove', 'run_now'], description: '操作类型' },
      task_id: { type: 'string', description: '任务 id（list_schedules 结果中的 sch_xxx）' },
    },
    required: ['action', 'task_id'],
  },
  schema: manageScheduleArgs,
  async execute(args: z.infer<typeof manageScheduleArgs>, ctx: ToolRuntime): Promise<ToolResult> {
    if (!ctx.scheduleRuntime) return { ok: false, summary: '定时任务未启用（服务端未装配调度服务）' }
    const task = ctx.scheduleRuntime.get(args.task_id)
    if (!task || task.sessionId !== ctx.sessionId) {
      return { ok: false, summary: `任务「${args.task_id}」不存在（只能管理本会话的任务；可先用 list_schedules 查看）` }
    }
    switch (args.action) {
      case 'pause': {
        const result = ctx.scheduleRuntime.setEnabled(task.id, false)
        return result.ok
          ? { ok: true, summary: `已暂停「${task.title}」（保留配置，可随时 resume 恢复）` }
          : { ok: false, summary: result.error ?? '暂停失败' }
      }
      case 'resume': {
        const result = ctx.scheduleRuntime.setEnabled(task.id, true)
        if (!result.ok || !result.task) return { ok: false, summary: result.error ?? '恢复失败' }
        return {
          ok: true,
          summary: `已恢复「${task.title}」，下次触发 ${result.task.nextRunAt ? formatWallTime(new Date(result.task.nextRunAt), result.task.timezone) : '待定'}`,
        }
      }
      case 'remove': {
        const result = ctx.scheduleRuntime.remove(task.id)
        return result.ok ? { ok: true, summary: `已删除「${task.title}」` } : { ok: false, summary: result.error ?? '删除失败' }
      }
      case 'run_now': {
        const result = ctx.scheduleRuntime.runNow(task.id)
        if (!result.ok) return { ok: false, summary: result.error ?? '执行失败' }
        if (result.skipped === 'busy') return { ok: false, summary: '会话正忙，本次手动触发未执行' }
        return {
          ok: true,
          summary:
            task.kind === 'run'
              ? `已手动触发「${task.title}」（运行 ${result.runId ?? ''} 已启动，原定节奏不变）`
              : `已手动发送提醒「${task.title}」`,
        }
      }
    }
  },
}

/** 导出工具集（注册进 createToolRegistry；依赖由引擎运行期注入 ctx.scheduleRuntime） */
export function createScheduleTools(): AgentTool[] {
  return [scheduleTaskTool, listSchedulesTool, manageScheduleTool]
}

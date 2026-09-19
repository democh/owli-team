/**
 * M35 测试：定时任务工具集（schedule_task / list_schedules / manage_schedule）。
 *
 * 用真实 registry + ScheduleService（launch / isBusy 假件）走通：注册与分类、未装配降级、
 * 目标成员解析（id / 显示名 / 候选提示）、创建 / 列表 / 暂停恢复删除立即运行的闭环、
 * 跨会话越权拒绝。
 */
import { describe, expect, it } from 'vitest'
import { ScheduleService } from '../src/schedule/service.js'
import { ScheduleStore } from '../src/store/schedules.js'
import { createToolRegistry } from '../src/tools/builtin.js'
import { toolCategory } from '../src/tools/categories.js'
import type { ToolRuntime } from '../src/tools/registry.js'
import { makeEnv } from './helpers.js'

function setup() {
  const env = makeEnv({ scheduleEnabled: true, scheduleTimezone: 'UTC' })
  const schedules = new ScheduleStore(env.db)
  const session = env.sessions.create(['pm', 'qa'], '工具测试')
  const launches: string[] = []
  const service = new ScheduleService({
    cfg: env.cfg,
    schedules,
    sessions: env.sessions,
    notify: env.notify,
    launch: (_sid, mid) => {
      launches.push(mid)
      return { runId: 'run_tool' }
    },
    isBusy: () => false,
  })
  const registry = createToolRegistry(env.cfg)
  const runtime: ToolRuntime = {
    sessionId: session.id,
    runId: 'r1',
    agentId: 'pm',
    workspace: env.artifacts.ensureSessionDir(session.id),
    artifacts: env.artifacts,
    skills: env.skills,
    memory: env.memory,
    tasks: env.tasks,
    participants: [
      { id: 'pm', name: '费利' },
      { id: 'qa', name: '曲奇' },
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
      const skill = env.skills.get(name)
      return skill ? { ok: true, body: skill.body } : { ok: false, error: `技能「${name}」不存在` }
    },
    scheduleRuntime: service,
  }
  return { env, schedules, service, registry, runtime, session, launches }
}

describe('M35 工具：注册与分类', () => {
  it('三个工具注册为 deferred，分类为「自动化」', () => {
    const { registry } = setup()
    for (const name of ['schedule_task', 'list_schedules', 'manage_schedule']) {
      const tool = registry.list().find((t) => t.name === name)
      expect(tool, `${name} 应已注册`).toBeDefined()
      expect(tool?.tier).toBe('deferred')
      expect(toolCategory(name)).toBe('自动化')
    }
    expect(registry.list().find((t) => t.name === 'list_schedules')?.readOnly).toBe(true)
    expect(registry.list().find((t) => t.name === 'schedule_task')?.readOnly).toBe(false)
  })

  it('未装配调度服务时返回未启用提示（不抛错）', async () => {
    const { registry, runtime } = setup()
    const bare: ToolRuntime = { ...runtime, scheduleRuntime: undefined }
    const create = await registry.execute(
      'schedule_task',
      { title: 'x', kind: 'remind', instruction: 'x', spec_kind: 'cron', expr: '*/5 * * * *' },
      bare,
    )
    expect(create.ok).toBe(false)
    expect(create.summary).toContain('未启用')
    expect((await registry.execute('list_schedules', {}, bare)).ok).toBe(false)
    expect((await registry.execute('manage_schedule', { action: 'remove', task_id: 'sch_x' }, bare)).ok).toBe(false)
  })
})

describe('M35 工具：schedule_task', () => {
  it('创建 remind 任务：回执含标题 / 规则 / 下次触发 / id', async () => {
    const { registry, runtime, schedules } = setup()
    const result = await registry.execute(
      'schedule_task',
      {
        title: '喝水提醒',
        kind: 'remind',
        instruction: '起身活动两分钟',
        spec_kind: 'cron',
        expr: '0 9 * * 1-5',
      },
      runtime,
    )
    expect(result.ok).toBe(true)
    expect(result.summary).toContain('喝水提醒')
    expect(result.summary).toContain('工作日 09:00')
    const tasks = schedules.listBySession(runtime.sessionId)
    expect(tasks).toHaveLength(1)
    expect(tasks[0].createdBy).toBe('pm')
  })

  it('创建 run 任务：target_agent 支持显示名，createdBy 为调用者', async () => {
    const { registry, runtime, schedules } = setup()
    const result = await registry.execute(
      'schedule_task',
      {
        title: '每日进度巡检',
        kind: 'run',
        instruction: '巡检进度并产出简报',
        target_agent: '曲奇',
        spec_kind: 'cron',
        expr: '0 9 * * *',
      },
      runtime,
    )
    expect(result.ok).toBe(true)
    const task = schedules.listBySession(runtime.sessionId)[0]
    expect(task.kind).toBe('run')
    expect(task.targetAgentId).toBe('qa')
    expect(task.createdBy).toBe('pm')
  })

  it('目标缺失 / 不存在时给出候选提示；非法表达式透传原因', async () => {
    const { registry, runtime } = setup()
    const missing = await registry.execute(
      'schedule_task',
      { title: 'x', kind: 'run', instruction: 'x', spec_kind: 'cron', expr: '0 9 * * *' },
      runtime,
    )
    expect(missing.ok).toBe(false)
    expect(missing.summary).toContain('pm')

    const ghost = await registry.execute(
      'schedule_task',
      { title: 'x', kind: 'run', instruction: 'x', target_agent: 'ghost', spec_kind: 'cron', expr: '0 9 * * *' },
      runtime,
    )
    expect(ghost.ok).toBe(false)
    expect(ghost.summary).toContain('不在会话中')

    const badExpr = await registry.execute(
      'schedule_task',
      { title: 'x', kind: 'remind', instruction: 'x', spec_kind: 'cron', expr: '99 * * * *' },
      runtime,
    )
    expect(badExpr.ok).toBe(false)
    expect(badExpr.summary).toContain('cron')
  })
})

describe('M35 工具：list_schedules 与 manage_schedule', () => {
  it('空清单提示；有任务时给出单行摘要', async () => {
    const { registry, runtime } = setup()
    const empty = await registry.execute('list_schedules', {}, runtime)
    expect(empty.ok).toBe(true)
    expect(empty.summary).toContain('暂无')

    await registry.execute(
      'schedule_task',
      { title: '站会提醒', kind: 'remind', instruction: 'x', spec_kind: 'cron', expr: '0 9 * * *' },
      runtime,
    )
    const listed = await registry.execute('list_schedules', {}, runtime)
    expect(listed.ok).toBe(true)
    expect(listed.summary).toContain('1 个')
    expect(listed.detail).toContain('站会提醒')
    expect(listed.detail).toContain('sch_')
  })

  it('pause / resume / run_now / remove 全链路', async () => {
    const { registry, runtime, schedules, launches } = setup()
    await registry.execute(
      'schedule_task',
      {
        title: '巡检',
        kind: 'run',
        instruction: '巡检',
        target_agent: 'pm',
        spec_kind: 'cron',
        expr: '0 9 * * *',
      },
      runtime,
    )
    const taskId = schedules.listBySession(runtime.sessionId)[0].id

    const paused = await registry.execute('manage_schedule', { action: 'pause', task_id: taskId }, runtime)
    expect(paused.ok).toBe(true)
    expect(schedules.get(taskId)?.enabled).toBe(false)

    const resumed = await registry.execute('manage_schedule', { action: 'resume', task_id: taskId }, runtime)
    expect(resumed.ok).toBe(true)
    expect(schedules.get(taskId)?.enabled).toBe(true)

    const ran = await registry.execute('manage_schedule', { action: 'run_now', task_id: taskId }, runtime)
    expect(ran.ok).toBe(true)
    expect(launches).toHaveLength(1)
    expect(schedules.get(taskId)?.lastStatus).toBe('ok')

    const removed = await registry.execute('manage_schedule', { action: 'remove', task_id: taskId }, runtime)
    expect(removed.ok).toBe(true)
    expect(schedules.get(taskId)).toBeUndefined()
  })

  it('跨会话任务不可管理（越权拒绝）', async () => {
    const { env, registry, runtime, service } = setup()
    const other = env.sessions.create(['pm'], '另一个会话')
    const foreign = service.create({
      sessionId: other.id,
      title: '别的会话任务',
      kind: 'remind',
      instruction: 'x',
      spec: { kind: 'cron', expr: '0 9 * * *' },
      createdBy: 'user',
    }).task!

    const denied = await registry.execute('manage_schedule', { action: 'remove', task_id: foreign.id }, runtime)
    expect(denied.ok).toBe(false)
    expect(denied.summary).toContain('不存在')
    expect(service.get(foreign.id)).toBeDefined()
  })
})

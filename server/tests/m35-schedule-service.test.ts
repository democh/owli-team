/**
 * M35 测试：定时任务服务（ScheduleService）——触发 / 跳过 / 补跑窗口 / 失败护栏 / CRUD 校验。
 *
 * 用真实 ScheduleStore + SessionStore + 注入的 notify / launch / isBusy 假件，
 * 覆盖 tick 一个完整调度轮的各分支（run / remind / busy / missed / error / paused）。
 */
import { describe, expect, it } from 'vitest'
import { ScheduleService } from '../src/schedule/service.js'
import { ScheduleStore } from '../src/store/schedules.js'
import { makeEnv } from './helpers.js'

const CRON = { kind: 'cron' as const, expr: '*/5 * * * *' }

function setup(overrides: Record<string, unknown> = {}) {
  const env = makeEnv({ scheduleEnabled: true, scheduleTimezone: 'UTC', ...overrides })
  const schedules = new ScheduleStore(env.db)
  const launches: Array<{ sessionId: string; messageId: string }> = []
  let busy = false
  let launchError: string | undefined
  const service = new ScheduleService({
    cfg: env.cfg,
    schedules,
    sessions: env.sessions,
    notify: env.notify,
    launch: (sessionId, messageId) => {
      if (launchError) throw new Error(launchError)
      launches.push({ sessionId, messageId })
      return { runId: 'run_fake' }
    },
    isBusy: () => busy,
  })
  const session = env.sessions.create(['pm', 'qa'], '定时测试')
  return {
    env,
    schedules,
    service,
    session,
    launches,
    setBusy: (v: boolean) => {
      busy = v
    },
    setLaunchError: (v: string | undefined) => {
      launchError = v
    },
  }
}

function makeDue(store: ScheduleStore, id: string, iso: string): void {
  store.update(id, { nextRunAt: iso })
}

/** 已过触发时刻（默认 1 分钟前；在默认补跑窗口内，tick 会补跑） */
function pastIso(offsetMs = -60_000): string {
  return new Date(Date.now() + offsetMs).toISOString()
}

describe('M35 服务：创建与校验', () => {
  it('run 任务创建成功：next 落位 + created 通知', () => {
    const { env, service, session } = setup()
    const result = service.create({
      sessionId: session.id,
      title: '每日进度巡检',
      kind: 'run',
      instruction: '巡检当前进度并简报',
      targetAgentId: 'pm',
      spec: CRON,
      createdBy: 'user',
    })
    expect(result.ok).toBe(true)
    expect(result.task?.targetAgentId).toBe('pm')
    expect(result.task?.timezone).toBe('UTC')
    expect(result.task?.nextRunAt).toBeTruthy()
    const notice = env.published.find((n) => n.type === 'notify:schedule-changed')
    expect(notice?.payload.action).toBe('created')
  })

  it('remind 任务：target 不要求，且被清空', () => {
    const { service, session } = setup()
    const result = service.create({
      sessionId: session.id,
      title: '喝水提醒',
      kind: 'remind',
      instruction: '起身活动一下',
      targetAgentId: 'pm',
      spec: CRON,
      createdBy: 'user',
    })
    expect(result.ok).toBe(true)
    expect(result.task?.targetAgentId).toBeUndefined()
  })

  it('拒绝非法输入（标题 / 指令 / 目标 / 表达式 / 会话）', () => {
    const { service, session } = setup()
    const base = { sessionId: session.id, kind: 'run' as const, spec: CRON, createdBy: 'user' }
    expect(service.create({ ...base, title: '  ', instruction: 'x', targetAgentId: 'pm' }).ok).toBe(false)
    expect(service.create({ ...base, title: 'x', instruction: ' ', targetAgentId: 'pm' }).ok).toBe(false)
    expect(service.create({ ...base, title: 'x', instruction: 'x', targetAgentId: 'ghost' }).ok).toBe(false)
    expect(service.create({ ...base, title: 'x', instruction: 'x', targetAgentId: 'pm', spec: { kind: 'cron', expr: 'bad' } }).ok).toBe(false)
    expect(service.create({ ...base, sessionId: 'sess_missing', title: 'x', instruction: 'x', targetAgentId: 'pm' }).ok).toBe(false)
  })

  it('单会话配额上限生效', () => {
    const { service, session } = setup({ scheduleMaxPerSession: 2 })
    const make = (n: number) =>
      service.create({
        sessionId: session.id,
        title: `任务${n}`,
        kind: 'remind',
        instruction: '提醒内容',
        spec: CRON,
        createdBy: 'user',
      })
    expect(make(1).ok).toBe(true)
    expect(make(2).ok).toBe(true)
    const third = make(3)
    expect(third.ok).toBe(false)
    expect(third.error).toContain('上限')
  })

  it('总开关关闭时拒绝创建', () => {
    const env = makeEnv({ scheduleEnabled: false })
    const service = new ScheduleService({
      cfg: env.cfg,
      schedules: new ScheduleStore(env.db),
      sessions: env.sessions,
      notify: env.notify,
      launch: () => ({ runId: 'run_x' }),
      isBusy: () => false,
    })
    const session = env.sessions.create(['pm'], 'x')
    const result = service.create({
      sessionId: session.id,
      title: 'x',
      kind: 'remind',
      instruction: 'x',
      spec: CRON,
      createdBy: 'user',
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('未启用')
  })
})

describe('M35 服务：tick 触发路径', () => {
  it('run 到期：注入带 scheduleId 的用户消息 + launch + 结算推进', async () => {
    const { env, service, schedules, session, launches } = setup()
    const created = service.create({
      sessionId: session.id,
      title: '进度巡检',
      kind: 'run',
      instruction: '巡检并简报',
      targetAgentId: 'qa',
      spec: CRON,
      createdBy: 'user',
    })
    const task = created.task!
    makeDue(schedules, task.id, pastIso())
    await service.tick()

    expect(launches).toHaveLength(1)
    expect(launches[0].sessionId).toBe(session.id)
    const msg = env.sessions.messages(session.id).find((m) => m.id === launches[0].messageId)
    expect(msg?.role).toBe('user')
    expect(msg?.content).toBe('@qa 巡检并简报')
    expect(msg?.scheduleId).toBe(task.id)

    const after = schedules.get(task.id)!
    expect(after.lastStatus).toBe('ok')
    expect(after.runCount).toBe(1)
    expect(after.nextRunAt).toBeTruthy()
    expect(Date.parse(after.nextRunAt!)).toBeGreaterThan(Date.now())
    expect(env.published.some((n) => n.type === 'notify:schedule-changed' && n.payload.action === 'fired')).toBe(true)
  })

  it('忙时跳过：不注入不 launch，留痕 skipped-busy 并推进 next', async () => {
    const { env, service, schedules, session, launches, setBusy } = setup()
    const task = service.create({
      sessionId: session.id,
      title: '巡检',
      kind: 'run',
      instruction: 'x',
      targetAgentId: 'pm',
      spec: CRON,
      createdBy: 'user',
    }).task!
    makeDue(schedules, task.id, pastIso())
    setBusy(true)
    await service.tick()

    expect(launches).toHaveLength(0)
    expect(env.sessions.messages(session.id)).toHaveLength(0)
    const after = schedules.get(task.id)!
    expect(after.lastStatus).toBe('skipped-busy')
    expect(after.runCount).toBe(0)
    expect(after.failStreak).toBe(0)
    expect(env.published.some((n) => n.payload.action === 'skipped-busy')).toBe(true)
  })

  it('超出补跑窗口：skipped-missed 且不注入', async () => {
    const { env, service, schedules, session, launches } = setup({ scheduleCatchupMs: 60_000 })
    const task = service.create({
      sessionId: session.id,
      title: '巡检',
      kind: 'run',
      instruction: 'x',
      targetAgentId: 'pm',
      spec: CRON,
      createdBy: 'user',
    }).task!
    // 延迟 1 小时，远超窗口
    makeDue(schedules, task.id, pastIso(-3_600_000))
    await service.tick()

    expect(launches).toHaveLength(0)
    const after = schedules.get(task.id)!
    expect(after.lastStatus).toBe('skipped-missed')
    expect(after.lastError).toContain('补跑窗口')
    expect(env.published.some((n) => n.payload.action === 'skipped-missed')).toBe(true)
  })

  it('remind 到期：落系统事件条 + 提醒通知，不发起运行', async () => {
    const { env, service, schedules, session, launches } = setup()
    const task = service.create({
      sessionId: session.id,
      title: '站会提醒',
      kind: 'remind',
      instruction: '今天 09:00 站会',
      spec: CRON,
      createdBy: 'user',
    }).task!
    makeDue(schedules, task.id, pastIso())
    await service.tick()

    expect(launches).toHaveLength(0)
    const messages = env.sessions.messages(session.id)
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe('system')
    expect(messages[0].content).toContain('站会提醒')
    expect(messages[0].scheduleId).toBe(task.id)
    const reminder = env.published.find((n) => n.type === 'notify:schedule-reminder')
    expect(reminder?.payload.messageId).toBe(messages[0].id)
    const after = schedules.get(task.id)!
    expect(after.lastStatus).toBe('ok')
    expect(after.runCount).toBe(1)
  })

  it('once 任务触发后 next 清空，不再重复触发', async () => {
    const { service, schedules, session, launches } = setup()
    const task = service.create({
      sessionId: session.id,
      title: '一次性',
      kind: 'run',
      instruction: 'x',
      targetAgentId: 'pm',
      spec: { kind: 'once', at: new Date(Date.now() + 3_600_000).toISOString() },
      createdBy: 'user',
    }).task!
    makeDue(schedules, task.id, pastIso())
    await service.tick()
    expect(launches).toHaveLength(1)
    expect(schedules.get(task.id)!.nextRunAt).toBeUndefined()

    await service.tick()
    expect(launches).toHaveLength(1)
  })
})

describe('M35 服务：手动运行与失败护栏', () => {
  it('runNow：会话忙时明确报错；正常时注入且不改 next', async () => {
    const { service, schedules, session, launches, setBusy } = setup()
    const task = service.create({
      sessionId: session.id,
      title: '巡检',
      kind: 'run',
      instruction: 'x',
      targetAgentId: 'pm',
      spec: CRON,
      createdBy: 'user',
    }).task!
    const nextBefore = schedules.get(task.id)!.nextRunAt

    setBusy(true)
    const blocked = service.runNow(task.id)
    expect(blocked.ok).toBe(false)
    expect(blocked.error).toContain('运行中的任务')

    setBusy(false)
    const ok = service.runNow(task.id)
    expect(ok.ok).toBe(true)
    expect(launches).toHaveLength(1)
    expect(schedules.get(task.id)!.nextRunAt).toBe(nextBefore)
    expect(schedules.get(task.id)!.lastStatus).toBe('ok')
  })

  it('启动失败：回收孤立消息 + error 计数；连续 3 次自动暂停', async () => {
    const { env, service, schedules, session, setLaunchError } = setup({ scheduleFailLimit: 3 })
    const task = service.create({
      sessionId: session.id,
      title: '巡检',
      kind: 'run',
      instruction: 'x',
      targetAgentId: 'pm',
      spec: CRON,
      createdBy: 'user',
    }).task!
    setLaunchError('会话已有运行中的任务')
    makeDue(schedules, task.id, pastIso())

    await service.tick()
    expect(schedules.get(task.id)!.failStreak).toBe(1)
    expect(schedules.get(task.id)!.lastStatus).toBe('error')
    // 注入的消息被回收（会话不留孤条）
    expect(env.sessions.messages(session.id)).toHaveLength(0)

    makeDue(schedules, task.id, pastIso())
    await service.tick()
    expect(schedules.get(task.id)!.failStreak).toBe(2)

    makeDue(schedules, task.id, pastIso())
    await service.tick()
    const paused = schedules.get(task.id)!
    expect(paused.failStreak).toBe(3)
    expect(paused.enabled).toBe(false)
    expect(paused.lastStatus).toBe('paused')
    expect(env.published.some((n) => n.payload.action === 'paused')).toBe(true)

    // 暂停后不再被 due 命中
    await service.tick()
    expect(schedules.get(task.id)!.failStreak).toBe(3)
  })

  it('目标成员被移出会话：error 留痕（不注入）', async () => {
    const { service, schedules, session, launches } = setup()
    const task = service.create({
      sessionId: session.id,
      title: '巡检',
      kind: 'run',
      instruction: 'x',
      targetAgentId: 'qa',
      spec: CRON,
      createdBy: 'user',
    }).task!
    // 模拟成员被移出：直接改会话成员表
    const sessionRow = session
    sessionRow.participantIds = ['pm']
    makeDue(schedules, task.id, pastIso())
    await service.tick()

    expect(launches).toHaveLength(0)
    const after = schedules.get(task.id)!
    expect(after.lastStatus).toBe('error')
    expect(after.lastError).toContain('不在会话成员中')
  })
})

describe('M35 服务：更新 / 启停 / 删除', () => {
  it('update：仅改文案保留节奏；改 spec 重算 next', () => {
    const { service, schedules, session } = setup()
    const task = service.create({
      sessionId: session.id,
      title: '巡检',
      kind: 'run',
      instruction: 'x',
      targetAgentId: 'pm',
      spec: CRON,
      createdBy: 'user',
    }).task!
    const nextBefore = schedules.get(task.id)!.nextRunAt

    const renamed = service.update(task.id, { title: '巡检（新）' })
    expect(renamed.ok).toBe(true)
    expect(schedules.get(task.id)!.nextRunAt).toBe(nextBefore)

    const respec = service.update(task.id, { spec: { kind: 'cron', expr: '0 9 * * *' } })
    expect(respec.ok).toBe(true)
    expect(schedules.get(task.id)!.nextRunAt).not.toBe(nextBefore)

    expect(service.update(task.id, { spec: { kind: 'cron', expr: 'bad expr' } }).ok).toBe(false)
    expect(service.update(task.id, { targetAgentId: 'ghost' }).ok).toBe(false)
    expect(service.update('sch_missing', { title: 'x' }).ok).toBe(false)
  })

  it('setEnabled(false) 停用；setEnabled(true) 恢复并重置失败计数', () => {
    const { service, schedules, session } = setup()
    const task = service.create({
      sessionId: session.id,
      title: '巡检',
      kind: 'run',
      instruction: 'x',
      targetAgentId: 'pm',
      spec: CRON,
      createdBy: 'user',
    }).task!
    schedules.settle(task.id, { status: 'error', error: 'x', nextRunAt: null })

    const off = service.setEnabled(task.id, false)
    expect(off.ok).toBe(true)
    expect(off.task?.enabled).toBe(false)

    const on = service.setEnabled(task.id, true)
    expect(on.ok).toBe(true)
    expect(on.task?.enabled).toBe(true)
    expect(on.task?.failStreak).toBe(0)
    expect(on.task?.nextRunAt).toBeTruthy()
  })

  it('remove：删除后查询为空 + deleted 通知', () => {
    const { env, service, schedules, session } = setup()
    const task = service.create({
      sessionId: session.id,
      title: '巡检',
      kind: 'remind',
      instruction: 'x',
      spec: CRON,
      createdBy: 'user',
    }).task!
    const removed = service.remove(task.id)
    expect(removed.ok).toBe(true)
    expect(schedules.get(task.id)).toBeUndefined()
    expect(env.published.some((n) => n.payload.action === 'deleted')).toBe(true)
    expect(service.remove(task.id).ok).toBe(false)
  })
})

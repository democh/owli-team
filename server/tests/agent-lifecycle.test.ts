/**
 * 下线资产（历史兼容）：编制含已下线角色的历史会话只可读。
 *
 * 覆盖：
 * - 判定口径（含分身成员键 / 场景名去重 / 有效角色不受影响）；
 * - 执行入口拒绝：发送启动、派发、断点继续、重写、重生成；
 * - 后台触发拒绝：定时任务不注入孤立消息、仪式订阅不生成会话；
 * - 读写边界：读取与改名不受限，只有执行被拦。
 */
import { describe, expect, it } from 'vitest'
import { RETIRED_SESSION_HINT, isRetiredAgentId, retiredMembersOf, retiredScenesOf } from '@multi-agent/shared'
import { AccessService } from '../src/auth/access.js'
import { ScheduleService } from '../src/schedule/service.js'
import { RitualStore } from '../src/store/rituals.js'
import { ScheduleStore } from '../src/store/schedules.js'
import { appendUserMessage, makeEnv } from './helpers.js'

type Env = ReturnType<typeof makeEnv>

/** 历史会话：编制里带一位下线角色（模拟删除前的存量数据） */
function legacySession(participants: string[] = ['chief', 'home']): { env: Env; sessionId: string } {
  const env = makeEnv()
  const session = env.sessions.create(participants, '历史会话')
  return { env, sessionId: session.id }
}

function scheduleService(env: Env, overrides: Partial<ConstructorParameters<typeof ScheduleService>[0]> = {}): ScheduleService {
  return new ScheduleService({
    cfg: env.cfg,
    schedules: new ScheduleStore(env.db),
    sessions: env.sessions,
    notify: env.notify,
    launch: () => ({ runId: 'run_fake' }),
    isBusy: () => false,
    ...overrides,
  })
}

describe('下线资产：判定口径', () => {
  it('角色 id 与分身成员键同样判定为下线；有效角色不受影响', () => {
    expect(isRetiredAgentId('sales')).toBe(true)
    expect(isRetiredAgentId('sales~closer')).toBe(true)
    expect(isRetiredAgentId('reno-designer')).toBe(true)
    expect(isRetiredAgentId('chief')).toBe(false)
    expect(isRetiredAgentId('insight')).toBe(false)
  })

  it('编制去重并给出涉及的下线场景名（提示文案用）', () => {
    expect(retiredMembersOf(['chief', 'home', 'home', 'wealth~s1'])).toEqual(['home', 'wealth~s1'])
    expect(retiredScenesOf(['chief', 'home', 'wealth~s1'])).toEqual(['家庭生活', '财富管理'])
    expect(retiredScenesOf(['chief', 'finance'])).toEqual([])
  })
})

describe('下线资产：执行入口拒绝', () => {
  it('发送启动 / 派发 / 断点继续 / 重写 / 重生成一律报错，且不替换角色', () => {
    const { env, sessionId } = legacySession()
    const message = appendUserMessage(env, sessionId, '继续上周的账')

    expect(() => env.engine.launch(sessionId, message.id)).toThrow(RETIRED_SESSION_HINT)
    expect(() => env.engine.dispatchTo(sessionId, 'chief')).toThrow(/已下线角色/)
    expect(() => env.engine.resume(sessionId)).toThrow(/已下线角色/)
    expect(() => env.engine.resumeMessage(sessionId, message.id)).toThrow(/已下线角色/)
    expect(() => env.engine.regenerateMessage(sessionId, message.id)).toThrow(/已下线角色/)
    // 编制保持不变：不静默移除或替换下线成员
    expect(env.sessions.getSession(sessionId)!.participantIds).toEqual(['chief', 'home'])
  })

  it('有效会话不受影响（守卫放行）', () => {
    const { env, sessionId } = legacySession(['chief', 'insight'])
    const access = env.access
    expect(() => access.assertSessionExecutable(undefined, sessionId)).not.toThrow()
  })

  it('历史会话仍可读取与改名，只有执行被拦（409 语义）', () => {
    const { env, sessionId } = legacySession()
    expect(env.sessions.messages(sessionId)).toBeDefined()
    env.sessions.rename(sessionId, '历史会话（已归档）')
    expect(env.sessions.getSession(sessionId)!.title).toBe('历史会话（已归档）')
    expect(() => env.access.assertSessionExecutable(undefined, sessionId)).toThrow(/已下线角色/)
  })

  it('AccessService 统一抛出 409 并带场景名', () => {
    const { env, sessionId } = legacySession()
    const access = new AccessService({
      isMultiUser: () => false,
      sessions: env.sessions,
      projects: env.projects,
      members: env.members,
    })
    try {
      access.assertSessionExecutable(undefined, sessionId)
      expect.unreachable('应当拒绝执行')
    } catch (err) {
      expect((err as { status?: number }).status).toBe(409)
      expect((err as Error).message).toContain('家庭生活')
    }
  })
})

describe('下线资产：后台触发拒绝', () => {
  it('定时任务到期不注入孤立消息，并以错误结算', () => {
    const { env, sessionId } = legacySession()
    const schedules = new ScheduleStore(env.db)
    const service = scheduleService(env, { schedules })
    const before = env.sessions.messages(sessionId).length
    const task = schedules.create({
      sessionId,
      title: '每周复盘',
      kind: 'run',
      instruction: '复盘上周',
      targetAgentId: 'home',
      spec: { kind: 'cron', expr: '0 9 * * 1' },
      timezone: 'UTC',
      createdBy: 'user',
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    })

    const fired = service.runNow(task.id)
    expect(fired.ok).toBe(false)
    expect(fired.error).toContain('已下线角色')
    // 不注入孤立用户消息
    expect(env.sessions.messages(sessionId)).toHaveLength(before)
  })

  it('新建 / 修改定时任务直接拒绝', () => {
    const { env, sessionId } = legacySession()
    const schedules = new ScheduleStore(env.db)
    const service = scheduleService(env, { schedules })
    const created = service.create({
      sessionId,
      title: '巡检',
      kind: 'remind',
      instruction: '看一眼',
      spec: { kind: 'cron', expr: '0 9 * * 1' },
      createdBy: 'user',
    })
    expect(created.ok).toBe(false)
    expect(created.error).toContain('已下线角色')

    // 存量任务（下线前创建）改期同样被拒
    const legacy = schedules.create({
      sessionId,
      title: '存量任务',
      kind: 'remind',
      instruction: '看一眼',
      spec: { kind: 'cron', expr: '0 9 * * 1' },
      timezone: 'UTC',
      createdBy: 'user',
      nextRunAt: new Date(Date.now() + 3_600_000).toISOString(),
    })
    expect(service.update(legacy.id, { title: '改个名' }).ok).toBe(false)
  })

  it('仪式订阅：成员含下线角色 → 拒绝订阅；到期也不生成会话', async () => {
    const { env } = legacySession()
    const rituals = new RitualStore(env.db)
    const service = scheduleService(env, {
      rituals,
      resolveRitual: (sceneId) =>
        sceneId === 'legacy'
          ? { declaration: { title: '下班复盘', cron: '0 20 * * *', opener: '复盘' }, chain: ['home'], sceneId }
          : undefined,
    })
    expect(service.subscribeRitual('u1', 'legacy').ok).toBe(false)

    // 存量订阅（下线前创建）：到期不触发、不建会话
    const sub = rituals.create({
      userId: 'u1',
      sceneId: 'home',
      title: '存量订阅',
      cron: '0 20 * * *',
      timezone: 'UTC',
      opener: '复盘',
      members: ['home'],
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    })
    let spawned = 0
    const ticked = new ScheduleService({
      cfg: { ...env.cfg, scheduleEnabled: true },
      schedules: new ScheduleStore(env.db),
      sessions: env.sessions,
      notify: env.notify,
      launch: () => ({ runId: 'run_fake' }),
      isBusy: () => false,
      rituals,
      spawnRitualSession: () => {
        spawned += 1
        return { sessionId: 's-new', messageId: 'm-new' }
      },
    })
    await ticked.tick()
    expect(spawned).toBe(0)
    expect(rituals.get(sub.id)?.lastError).toContain('已下线角色')
  })
})

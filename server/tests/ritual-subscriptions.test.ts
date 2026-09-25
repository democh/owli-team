/**
 * P4 测试：仪式订阅（订阅 → 到点触发建会话 + 注入 opener + 退订）。
 *
 * 用真实 RitualStore + SessionStore + 注入的 resolveRitual / spawnRitualSession 假件，
 * 覆盖：订阅校验（声明缺失 / cron 非法 / members 快照缺省 chain / 幂等 / 上限）、
 * 归属隔离（list / 退订仅本人）、tick 到期触发（spawn 生成会话 + launch + 结算留痕）
 * 与补跑窗口跳过。
 */
import { describe, expect, it } from 'vitest'
import { validateScheduleSpec } from '@multi-agent/shared'
import { ScheduleService } from '../src/schedule/service.js'
import { ScheduleStore } from '../src/store/schedules.js'
import { RitualStore } from '../src/store/rituals.js'
import { SYSTEM_RITUALS } from '../src/schedule/system-rituals.js'
import { makeEnv } from './helpers.js'

const TAROT = {
  declaration: { title: '每日塔罗', cron: '0 22 * * *', opener: '抽今天的每日一牌', description: '每晚 22:00' },
  chain: ['tarot-reader', 'symbol-narrator'],
  sceneId: 'tarot',
}

function setup(overrides: Record<string, unknown> = {}) {
  const env = makeEnv({ scheduleEnabled: true, scheduleTimezone: 'UTC', scheduleCatchupMs: 600_000, ...overrides })
  const rituals = new RitualStore(env.db)
  const launches: Array<{ sessionId: string; messageId: string }> = []
  const spawned: string[] = []
  const service = new ScheduleService({
    cfg: env.cfg,
    schedules: new ScheduleStore(env.db),
    sessions: env.sessions,
    notify: env.notify,
    launch: (sessionId, messageId) => {
      launches.push({ sessionId, messageId })
      return { runId: 'run_fake' }
    },
    isBusy: () => false,
    rituals,
    resolveRitual: (sceneId) => {
      if (sceneId === 'tarot') return TAROT
      if (sceneId === 'bad-cron') {
        return { declaration: { title: '坏仪式', cron: 'not a cron', opener: 'x' }, chain: [], sceneId }
      }
      if (sceneId.startsWith('multi-')) {
        return { declaration: { title: `多订阅 ${sceneId}`, cron: '0 9 * * *', opener: 'x' }, chain: [], sceneId }
      }
      return undefined
    },
    resolveSystemRitual: (ritualId) =>
      ritualId === 'daily-review'
        ? {
            declaration: { title: '每日复盘', cron: '0 21 * * 1-5', opener: '复盘今天' },
            chain: ['coach', 'life-admin'],
            sceneId: 'personal',
          }
        : undefined,
    spawnRitualSession: (sub) => {
      const session = env.sessions.create(sub.members, sub.title)
      const message = env.sessions.appendMessage({
        sessionId: session.id,
        role: 'user',
        content: sub.opener,
        mentions: [],
        status: 'complete',
      })
      spawned.push(session.id)
      return { sessionId: session.id, messageId: message.id! }
    },
  })
  return { env, rituals, service, launches, spawned }
}

/** 把订阅的 next_run_at 拨到过去（模拟到期） */
function makeDue(rituals: RitualStore, id: string, agoMs = 60_000): void {
  rituals.settle(id, { lastRunAt: new Date().toISOString(), nextRunAt: new Date(Date.now() - agoMs).toISOString() })
}

describe('P4 仪式订阅：订阅与校验', () => {
  it('订阅成功：members 快照缺省 chain + next 落位；重复订阅幂等返回既有', () => {
    const { service } = setup()
    const first = service.subscribeRitual('u1', 'tarot')
    expect(first.ok).toBe(true)
    expect(first.subscription?.members).toEqual(['tarot-reader', 'symbol-narrator'])
    expect(first.subscription?.timezone).toBe('UTC')
    expect(first.subscription?.nextRunAt).toBeTruthy()
    expect(first.subscription?.spaceId).toBeUndefined() // default 空间不落字段

    const again = service.subscribeRitual('u1', 'tarot')
    expect(again.ok).toBe(true)
    expect(again.subscription?.id).toBe(first.subscription?.id)
  })

  it('声明缺失 / cron 非法 / 超上限一律拒绝', () => {
    const { service } = setup()
    expect(service.subscribeRitual('u1', 'nonexistent').ok).toBe(false)
    expect(service.subscribeRitual('u1', 'bad-cron').ok).toBe(false)
    for (let i = 0; i < 10; i++) {
      expect(service.subscribeRitual('u1', `multi-${i}`).ok, `第 ${i + 1} 个`).toBe(true)
    }
    const overflow = service.subscribeRitual('u1', 'tarot')
    expect(overflow.ok).toBe(false)
    expect(overflow.error).toContain('上限')
  })

  it('空间归属随行：非 default 空间落字段', () => {
    const { service } = setup()
    const sub = service.subscribeRitual('u1', 'tarot', { spaceId: 'life' })
    expect(sub.subscription?.spaceId).toBe('life')
  })

  it('系统仪式订阅（daily-review）：落 ritualId / 场景归属 / 编制链；与场景键命名空间独立', () => {
    const { service } = setup()
    const sys = service.subscribeRitual('u1', 'daily-review', { source: 'system' })
    expect(sys.ok).toBe(true)
    expect(sys.subscription?.ritualId).toBe('daily-review')
    expect(sys.subscription?.sceneId).toBe('personal')
    expect(sys.subscription?.members).toEqual(['coach', 'life-admin'])
    // 幂等（同 ritualId）
    const again = service.subscribeRitual('u1', 'daily-review', { source: 'system' })
    expect(again.subscription?.id).toBe(sys.subscription?.id)
    // 场景声明订阅不冲突（tarot 场景键与系统键并存）
    const scene = service.subscribeRitual('u1', 'tarot')
    expect(scene.ok).toBe(true)
    expect(scene.subscription?.id).not.toBe(sys.subscription?.id)
    // 不存在的系统仪式
    const missing = service.subscribeRitual('u1', 'nope', { source: 'system' })
    expect(missing.ok).toBe(false)
    expect(missing.error).toContain('系统仪式')
  })
})

describe('P4 仪式订阅：归属隔离与退订', () => {
  it('list 仅本人可见；跨用户退订视为不存在', () => {
    const { service } = setup()
    const sub = service.subscribeRitual('u1', 'tarot').subscription!
    expect(service.listRituals('u1')).toHaveLength(1)
    expect(service.listRituals('u2')).toHaveLength(0)
    expect(service.unsubscribeRitual('u2', sub.id).ok).toBe(false)
    expect(service.listRituals('u1')).toHaveLength(1)
    expect(service.unsubscribeRitual('u1', sub.id).ok).toBe(true)
    expect(service.listRituals('u1')).toHaveLength(0)
  })
})

describe('P4 仪式订阅：tick 触发', () => {
  it('到期 → 生成会话（编制 = 快照 members）+ 注入 opener + 启动协作 + 结算推进', async () => {
    const { env, rituals, service, launches, spawned } = setup()
    const sub = service.subscribeRitual('u1', 'tarot', { spaceId: 'life' }).subscription!
    makeDue(rituals, sub.id)

    await service.tick()

    // 生成会话：标题以订阅 title 前缀（日期后缀由组装层拼装）+ 编制 = 快照 members
    expect(spawned).toHaveLength(1)
    const generated = env.sessions.getSession(spawned[0]!)!
    expect(generated.title.startsWith('每日塔罗')).toBe(true)
    expect(generated.participantIds).toEqual(['tarot-reader', 'symbol-narrator'])
    // opener 以用户消息落库
    const messages = env.sessions.messages(generated.id)
    expect(messages.some((m) => m.role === 'user' && m.content === '抽今天的每日一牌')).toBe(true)
    // 启动协作 + 结算留痕
    expect(launches).toHaveLength(1)
    const settled = rituals.get(sub.id)!
    expect(settled.lastSessionId).toBe(generated.id)
    expect(Date.parse(settled.nextRunAt!)).toBeGreaterThan(Date.now())
    expect(settled.lastError).toBeUndefined()
  })

  it('补跑窗口外的延迟：只推进 next 不引爆（留痕）', async () => {
    const { rituals, service, launches } = setup()
    const sub = service.subscribeRitual('u1', 'tarot').subscription!
    makeDue(rituals, sub.id, 2 * 60 * 60 * 1000) // 2 小时前（超出 catchup 10 分钟窗口）

    await service.tick()

    expect(launches).toHaveLength(0)
    const settled = rituals.get(sub.id)!
    expect(settled.lastError).toContain('错过触发')
    expect(Date.parse(settled.nextRunAt!)).toBeGreaterThan(Date.now())
  })

  it('未到期不触发', async () => {
    const { service, launches } = setup()
    service.subscribeRitual('u1', 'tarot') // next 为未来
    await service.tick()
    expect(launches).toHaveLength(0)
  })
})

describe('P4 仪式订阅：编辑（启停 / 改 cron）', () => {
  it('暂停：enabled=false 且 listDue 不再命中；恢复重算 next（不引爆历史时刻）', () => {
    const { rituals, service } = setup()
    const sub = service.subscribeRitual('u1', 'tarot').subscription!
    const paused = service.updateRitual('u1', sub.id, { enabled: false })
    expect(paused.ok).toBe(true)
    expect(paused.subscription?.enabled).toBe(false)
    makeDue(rituals, sub.id) // 即使拨到到期
    expect(rituals.listDue(new Date().toISOString())).toHaveLength(0) // enabled=0 过滤

    const resumed = service.updateRitual('u1', sub.id, { enabled: true })
    expect(resumed.ok).toBe(true)
    expect(Date.parse(resumed.subscription!.nextRunAt!)).toBeGreaterThan(Date.now())
  })

  it('改 cron：重校验并重算 next；非法 cron / 跨用户 / 空 patch 一律拒绝', () => {
    const { service } = setup()
    const sub = service.subscribeRitual('u1', 'tarot').subscription!
    const changed = service.updateRitual('u1', sub.id, { cron: '30 21 * * *' })
    expect(changed.ok).toBe(true)
    expect(changed.subscription?.cron).toBe('30 21 * * *')
    expect(service.updateRitual('u1', sub.id, { cron: 'not a cron' }).ok).toBe(false)
    expect(service.updateRitual('u2', sub.id, { enabled: false }).ok).toBe(false)
    expect(service.updateRitual('u1', sub.id, {}).ok).toBe(false)
  })
})

describe('P5 系统仪式清单', () => {
  it('常量表：id / title / cron 齐备且 cron 可通过规格校验（morning-brief + daily-review）', () => {
    expect(SYSTEM_RITUALS.map((r) => r.id)).toEqual(['morning-brief', 'daily-review'])
    for (const item of SYSTEM_RITUALS) {
      expect(item.declaration.title).toBeTruthy()
      expect(item.declaration.opener).toBeTruthy()
      const check = validateScheduleSpec(
        { kind: 'cron', expr: item.declaration.cron },
        { defaultTz: 'UTC', minGapMs: 0 },
      )
      expect(check.ok, `${item.id} cron 非法：${check.error ?? ''}`).toBe(true)
    }
  })
})

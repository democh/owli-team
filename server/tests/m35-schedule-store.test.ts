/**
 * M35 测试：定时任务存储（ScheduleStore）——迁移 v11 / CRUD / 到期查询 / 状态迁移 / 级联。
 *
 * 守护点：
 * ① 迁移 v11 建表 + 索引 + messages.schedule_id 列（旧库 convergence）；
 * ② 到期语义（enabled=1 AND next_run_at <= now，含边界等于）；
 * ③ 状态迁移四路径（settle / skip / pause / resume）各自的计数与留痕规则；
 * ④ 数据健壮性：spec 损坏不炸、会话删除级联清理、消息 scheduleId 往返。
 */
import { describe, expect, it } from 'vitest'
import type { ScheduleSpec } from '@multi-agent/shared'
import { openDatabase } from '../src/store/db.js'
import { ScheduleStore } from '../src/store/schedules.js'
import { SessionStore } from '../src/store/sessions.js'

const CRON: ScheduleSpec = { kind: 'cron', expr: '0 9 * * *' }

function setup() {
  const db = openDatabase(':memory:', { memory: true, noExtensions: true })
  const sessions = new SessionStore(db)
  const session = sessions.create(['pm'], '定时任务测试')
  const store = new ScheduleStore(db)
  return { db, sessions, store, sessionId: session.id }
}

function createTask(store: ScheduleStore, sessionId: string, nextRunAt = '2026-09-19T01:00:00.000Z') {
  return store.create({
    sessionId,
    title: '每日站会提醒',
    kind: 'remind',
    instruction: '提醒：今天 09:00 开站会',
    spec: CRON,
    timezone: 'Asia/Shanghai',
    createdBy: 'user',
    nextRunAt,
  })
}

describe('M35 存储：迁移 v11', () => {
  it('schema 版本含 11，scheduled_tasks 表 / 索引 / messages.schedule_id 就位', () => {
    const db = openDatabase(':memory:', { memory: true, noExtensions: true })
    const versions = db.all<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version')
    expect(versions.map((v) => Number(v.version))).toContain(11)

    const tables = db
      .all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .map((t) => t.name)
    expect(tables).toContain('scheduled_tasks')

    const indexes = db
      .all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'scheduled_tasks'`)
      .map((r) => r.name)
    expect(indexes).toContain('idx_scheduled_due')
    expect(indexes).toContain('idx_scheduled_session')

    const cols = db.all<{ name: string }>(`PRAGMA table_info(messages)`).map((c) => c.name)
    expect(cols).toContain('schedule_id')
    db.close()
  })
})

describe('M35 存储：CRUD 与到期查询', () => {
  it('create 默认值完整（enabled / 计数 / 时间戳 / spec 往返）', () => {
    const { db, store, sessionId } = setup()
    const task = createTask(store, sessionId)
    expect(task.id.startsWith('sch_')).toBe(true)
    expect(task.enabled).toBe(true)
    expect(task.runCount).toBe(0)
    expect(task.failStreak).toBe(0)
    expect(task.lastStatus).toBeUndefined()
    expect(task.spec).toEqual(CRON)
    expect(task.timezone).toBe('Asia/Shanghai')
    expect(Number.isNaN(Date.parse(task.createdAt))).toBe(false)
    db.close()
  })

  it('按会话查询 / 计数 / 全局列表', () => {
    const { db, store, sessions, sessionId } = setup()
    const other = sessions.create(['qa'], '另一个会话')
    createTask(store, sessionId)
    createTask(store, sessionId, '2026-09-20T01:00:00.000Z')
    store.create({
      sessionId: other.id,
      title: '周报',
      kind: 'run',
      instruction: '汇总本周进度',
      targetAgentId: 'qa',
      spec: CRON,
      timezone: 'Asia/Shanghai',
      createdBy: 'pm',
    })
    expect(store.listBySession(sessionId)).toHaveLength(2)
    expect(store.countBySession(sessionId)).toBe(2)
    expect(store.listBySession(other.id)).toHaveLength(1)
    expect(store.all()).toHaveLength(3)
    db.close()
  })

  it('due：仅 enabled 且 next_run_at <= now（含边界），按时间升序', () => {
    const { db, store, sessionId } = setup()
    const a = createTask(store, sessionId, '2026-09-19T01:00:00.000Z')
    const b = createTask(store, sessionId, '2026-09-19T02:00:00.000Z')
    const c = createTask(store, sessionId, '2026-09-19T03:00:00.000Z')
    store.update(c.id, { enabled: false })

    const due = store.due('2026-09-19T02:00:00.000Z')
    expect(due.map((t) => t.id)).toEqual([a.id, b.id])
    expect(store.due('2026-09-19T00:00:00.000Z')).toHaveLength(0)
    db.close()
  })

  it('update：部分字段 / 清空 targetAgentId 与 nextRunAt / 关闭启用', () => {
    const { db, store, sessionId } = setup()
    const task = store.create({
      sessionId,
      title: '周报',
      kind: 'run',
      instruction: '汇总本周进度',
      targetAgentId: 'pm',
      spec: CRON,
      timezone: 'Asia/Shanghai',
      createdBy: 'user',
      nextRunAt: '2026-09-19T01:00:00.000Z',
    })
    const renamed = store.update(task.id, { title: '周报（改）' })
    expect(renamed?.title).toBe('周报（改）')
    expect(renamed?.instruction).toBe('汇总本周进度')

    const cleared = store.update(task.id, { targetAgentId: null, nextRunAt: null })
    expect(cleared?.targetAgentId).toBeUndefined()
    expect(cleared?.nextRunAt).toBeUndefined()

    const off = store.update(task.id, { enabled: false })
    expect(off?.enabled).toBe(false)
    expect(store.update('sch_missing', { title: 'x' })).toBeUndefined()
    db.close()
  })

  it('remove：删除后不可见', () => {
    const { db, store, sessionId } = setup()
    const task = createTask(store, sessionId)
    expect(store.remove(task.id)).toBe(true)
    expect(store.get(task.id)).toBeUndefined()
    expect(store.remove(task.id)).toBe(false)
    db.close()
  })
})

describe('M35 存储：触发结算与状态迁移', () => {
  it('settle ok：runCount+1、failStreak 归零、last* 与 nextRunAt 落位', () => {
    const { db, store, sessionId } = setup()
    const task = createTask(store, sessionId)
    const settled = store.settle(task.id, {
      status: 'ok',
      runId: 'run_1',
      nextRunAt: '2026-09-20T01:00:00.000Z',
    })
    expect(settled?.runCount).toBe(1)
    expect(settled?.failStreak).toBe(0)
    expect(settled?.lastStatus).toBe('ok')
    expect(settled?.lastRunId).toBe('run_1')
    expect(settled?.lastRunAt).toBeTruthy()
    expect(settled?.nextRunAt).toBe('2026-09-20T01:00:00.000Z')
    db.close()
  })

  it('settle error：failStreak 累加、runCount 不变、lastError 留痕', () => {
    const { db, store, sessionId } = setup()
    const task = createTask(store, sessionId)
    const first = store.settle(task.id, { status: 'error', error: '目标成员已不在会话', nextRunAt: null })
    expect(first?.failStreak).toBe(1)
    expect(first?.runCount).toBe(0)
    expect(first?.lastStatus).toBe('error')
    expect(first?.lastError).toBe('目标成员已不在会话')
    const second = store.settle(task.id, { status: 'error', error: '仍失败', nextRunAt: null })
    expect(second?.failStreak).toBe(2)
    // 成功一次即归零
    const ok = store.settle(task.id, { status: 'ok', runId: 'run_x', nextRunAt: '2026-09-21T01:00:00.000Z' })
    expect(ok?.failStreak).toBe(0)
    expect(ok?.runCount).toBe(1)
    db.close()
  })

  it('skip：只推进 next_run_at 与留痕，不计 runCount / failStreak / lastRunAt', () => {
    const { db, store, sessionId } = setup()
    const task = createTask(store, sessionId)
    const skipped = store.skip(task.id, {
      status: 'skipped-busy',
      note: '会话正忙，本次跳过',
      nextRunAt: '2026-09-20T01:00:00.000Z',
    })
    expect(skipped?.lastStatus).toBe('skipped-busy')
    expect(skipped?.lastError).toBe('会话正忙，本次跳过')
    expect(skipped?.runCount).toBe(0)
    expect(skipped?.failStreak).toBe(0)
    expect(skipped?.lastRunAt).toBeUndefined()
    expect(skipped?.nextRunAt).toBe('2026-09-20T01:00:00.000Z')

    const missed = store.skip(task.id, { status: 'skipped-missed', note: '超出补跑窗口', nextRunAt: null })
    expect(missed?.lastStatus).toBe('skipped-missed')
    expect(missed?.nextRunAt).toBeUndefined()
    db.close()
  })

  it('pause / resume：暂停保留任务并停用；恢复重置失败计数与下次触发', () => {
    const { db, store, sessionId } = setup()
    const task = createTask(store, sessionId)
    store.settle(task.id, { status: 'error', error: '注入失败', nextRunAt: '2026-09-20T01:00:00.000Z' })
    const paused = store.pause(task.id, '连续 3 次失败，已自动暂停')
    expect(paused?.enabled).toBe(false)
    expect(paused?.lastStatus).toBe('paused')
    expect(paused?.lastError).toContain('暂停')

    const resumed = store.resume(task.id, '2026-09-21T01:00:00.000Z')
    expect(resumed?.enabled).toBe(true)
    expect(resumed?.failStreak).toBe(0)
    expect(resumed?.nextRunAt).toBe('2026-09-21T01:00:00.000Z')
    db.close()
  })
})

describe('M35 存储：健壮性与级联', () => {
  it('spec 损坏回退为不可触发态（不抛错）', () => {
    const { db, store, sessionId } = setup()
    const task = createTask(store, sessionId)
    db.run(`UPDATE scheduled_tasks SET spec = 'not-json' WHERE id = ?`, task.id)
    const loaded = store.get(task.id)
    expect(loaded).toBeDefined()
    expect(loaded?.spec.kind).toBe('once')
    expect(loaded?.spec.at).toBe('')
    db.close()
  })

  it('会话删除级联清理任务（FK ON DELETE CASCADE）', () => {
    const { db, sessions, store, sessionId } = setup()
    createTask(store, sessionId)
    expect(store.all()).toHaveLength(1)
    sessions.remove(sessionId)
    expect(store.all()).toHaveLength(0)
    db.close()
  })

  it('消息 scheduleId：appendMessage 落库与读回（含 patch 后保持）', () => {
    const { db, sessions, store, sessionId } = setup()
    const task = createTask(store, sessionId)
    const msg = sessions.appendMessage({
      sessionId,
      role: 'user',
      content: '@pm 执行每日站会',
      mentions: ['pm'],
      status: 'complete',
      scheduleId: task.id,
    })
    expect(msg.scheduleId).toBe(task.id)
    sessions.patchMessage(sessionId, msg.id!, { status: 'complete' })
    sessions.saveNow(sessionId)
    const row = db.get<{ schedule_id: string | null }>('SELECT schedule_id FROM messages WHERE id = ?', msg.id!)
    expect(row?.schedule_id).toBe(task.id)
    db.close()
  })
})

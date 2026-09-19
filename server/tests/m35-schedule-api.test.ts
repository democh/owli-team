/**
 * M35 测试：/api 定时任务路由（createSchedulesRouter）——清单 / 创建 / 更新 / 删除 / 立即触发 / 启停。
 * 未装配 ScheduleService 时 503；业务校验失败 400；资源缺失 404。
 *
 * 环境：makeEnv 全量装配（sessions/notify 真实）+ ScheduleService（launch / isBusy 假件）
 * + express listen(0) 真实 HTTP 往返。
 */
import type { AddressInfo } from 'node:net'
import express from 'express'
import { afterEach, describe, expect, it } from 'vitest'
import type { ApiDeps } from '../src/routes/index.js'
import { createSchedulesRouter } from '../src/routes/schedules.js'
import { ScheduleService } from '../src/schedule/service.js'
import { ScheduleStore } from '../src/store/schedules.js'
import { makeEnv } from './helpers.js'

const JSON_HEADERS = { 'content-type': 'application/json' }
const CRON = { kind: 'cron' as const, expr: '*/5 * * * *' }

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const fn of cleanups.splice(0)) {
    await fn().catch(() => undefined)
  }
})

/** 挂 router 到临时端口；返回 base url（/api 前缀由调用方处理） */
async function listenRouter(router: express.Router): Promise<string> {
  const app = express()
  app.use(express.json())
  app.use('/api', router)
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const { port } = server.address() as AddressInfo
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  )
  return `http://127.0.0.1:${port}`
}

async function makeApi(overrides: Record<string, unknown> = {}) {
  const env = makeEnv({ scheduleEnabled: true, scheduleTimezone: 'UTC', ...overrides })
  const schedules = new ScheduleStore(env.db)
  const launches: Array<{ sessionId: string; messageId: string }> = []
  let busy = false
  const service = new ScheduleService({
    cfg: env.cfg,
    schedules,
    sessions: env.sessions,
    notify: env.notify,
    launch: (sessionId, messageId) => {
      launches.push({ sessionId, messageId })
      return { runId: 'run_fake' }
    },
    isBusy: () => busy,
  })
  const session = env.sessions.create(['pm', 'qa'], '定时路由测试')
  const deps = {
    cfg: env.cfg,
    sessions: env.sessions,
    schedules: service,
    engine: env.engine,
    notify: env.notify,
    // M57：路由守卫依赖（测试无账号 → 单用户兼容模式）
    access: env.access,
  } as unknown as ApiDeps
  const url = await listenRouter(createSchedulesRouter(deps))
  return {
    env,
    session,
    schedules,
    service,
    launches,
    url,
    setBusy: (v: boolean) => {
      busy = v
    },
  }
}

function createTaskBody(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    title: '每日巡检',
    kind: 'run',
    instruction: '巡检进度并简报',
    targetAgentId: 'pm',
    spec: CRON,
    ...extra,
  })
}

describe('M35 路由：未装配与清单', () => {
  it('缺省 ScheduleService 时统一 503', async () => {
    const env = makeEnv()
    const deps = { cfg: env.cfg, sessions: env.sessions } as unknown as ApiDeps
    const url = await listenRouter(createSchedulesRouter(deps))
    const res = await fetch(`${url}/api/sessions/sess_x/schedules`)
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: string }).error).toContain('未装配')
  })

  it('GET 清单：按会话返回；会话不存在 404', async () => {
    const { url, session, service } = await makeApi()
    service.create({
      sessionId: session.id,
      title: 'A',
      kind: 'remind',
      instruction: '提醒一',
      spec: CRON,
      createdBy: 'user',
    })
    service.create({
      sessionId: session.id,
      title: 'B',
      kind: 'run',
      instruction: '巡检',
      targetAgentId: 'pm',
      spec: { kind: 'once', at: new Date(Date.now() + 3_600_000).toISOString() },
      createdBy: 'user',
    })
    const ok = await fetch(`${url}/api/sessions/${session.id}/schedules`)
    expect(ok.status).toBe(200)
    const body = (await ok.json()) as { schedules: Array<{ title: string }> }
    expect(body.schedules.map((t) => t.title).sort()).toEqual(['A', 'B'])

    const missing = await fetch(`${url}/api/sessions/sess_ghost/schedules`)
    expect(missing.status).toBe(404)
  })
})

describe('M35 路由：创建与更新', () => {
  it('POST 创建成功：next 落位 + created 广播', async () => {
    const { url, session, env } = await makeApi()
    const res = await fetch(`${url}/api/sessions/${session.id}/schedules`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: createTaskBody(),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { task: { id: string; nextRunAt: string; targetAgentId: string } }
    expect(body.task.id).toBeTruthy()
    expect(body.task.nextRunAt).toBeTruthy()
    expect(body.task.targetAgentId).toBe('pm')
    const notice = env.published.find((n) => n.type === 'notify:schedule-changed' && n.payload.action === 'created')
    expect(notice?.sessionId).toBe(session.id)
  })

  it('POST 非法参数 400（缺字段 / 坏表达式 / 目标成员不存在）；会话不存在 404', async () => {
    const { url, session } = await makeApi()
    const bad = await fetch(`${url}/api/sessions/${session.id}/schedules`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ kind: 'run' }),
    })
    expect(bad.status).toBe(400)
    const badExpr = await fetch(`${url}/api/sessions/${session.id}/schedules`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: createTaskBody({ spec: { kind: 'cron', expr: 'bad' } }),
    })
    expect(badExpr.status).toBe(400)
    const badTarget = await fetch(`${url}/api/sessions/${session.id}/schedules`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: createTaskBody({ targetAgentId: 'ghost' }),
    })
    expect(badTarget.status).toBe(400)
    const missingSession = await fetch(`${url}/api/sessions/sess_ghost/schedules`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: createTaskBody(),
    })
    expect(missingSession.status).toBe(404)
  })

  it('PATCH 更新：文案变更保留 next；spec 变更重算 next；缺失 404', async () => {
    const { url, session, service } = await makeApi()
    const created = service.create({
      sessionId: session.id,
      title: '旧标题',
      kind: 'remind',
      instruction: '旧内容',
      spec: CRON,
      createdBy: 'user',
    })
    const id = created.task!.id
    const before = created.task!.nextRunAt

    const rename = await fetch(`${url}/api/schedules/${id}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: '新标题' }),
    })
    expect(rename.status).toBe(200)
    const renamed = (await rename.json()) as { task: { title: string; nextRunAt: string } }
    expect(renamed.task.title).toBe('新标题')
    expect(renamed.task.nextRunAt).toBe(before)

    const respec = await fetch(`${url}/api/schedules/${id}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ spec: { kind: 'once', at: new Date(Date.now() + 7_200_000).toISOString() } }),
    })
    expect(respec.status).toBe(200)
    const respeced = (await respec.json()) as { task: { nextRunAt: string } }
    expect(respeced.task.nextRunAt).not.toBe(before)

    const missing = await fetch(`${url}/api/schedules/sched_ghost`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: 'x' }),
    })
    expect(missing.status).toBe(404)
  })
})

describe('M35 路由：删除 / 立即触发 / 启停', () => {
  it('DELETE 删除后清单为空；不存在 404', async () => {
    const { url, session, service } = await makeApi()
    const created = service.create({
      sessionId: session.id,
      title: '待删',
      kind: 'remind',
      instruction: '提醒',
      spec: CRON,
      createdBy: 'user',
    })
    const res = await fetch(`${url}/api/schedules/${created.task!.id}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true)
    expect(service.list(session.id)).toHaveLength(0)

    const again = await fetch(`${url}/api/schedules/${created.task!.id}`, { method: 'DELETE' })
    expect(again.status).toBe(404)
  })

  it('POST run：注入 @ 目标消息并返回 runId；忙时 400', async () => {
    const { url, session, service, env, setBusy } = await makeApi()
    const created = service.create({
      sessionId: session.id,
      title: '立刻执行',
      kind: 'run',
      instruction: '汇总今日进度',
      targetAgentId: 'qa',
      spec: CRON,
      createdBy: 'user',
    })
    const res = await fetch(`${url}/api/schedules/${created.task!.id}/run`, { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { runId: string; messageId: string }
    expect(body.runId).toBe('run_fake')
    const injected = env.sessions.messages(session.id).find((m) => m.id === body.messageId)
    expect(injected?.content).toBe('@qa 汇总今日进度')
    expect(injected?.scheduleId).toBe(created.task!.id)

    setBusy(true)
    const busy = await fetch(`${url}/api/schedules/${created.task!.id}/run`, { method: 'POST' })
    expect(busy.status).toBe(400)
    expect(((await busy.json()) as { error: string }).error).toContain('运行中的任务')
  })

  it('pause / resume：启停切换；resume 重算 next 并重置失败计数', async () => {
    const { url, session, service } = await makeApi()
    const created = service.create({
      sessionId: session.id,
      title: '启停',
      kind: 'remind',
      instruction: '提醒',
      spec: CRON,
      createdBy: 'user',
    })
    const id = created.task!.id

    const paused = await fetch(`${url}/api/schedules/${id}/pause`, { method: 'POST' })
    expect(paused.status).toBe(200)
    expect(((await paused.json()) as { task: { enabled: boolean } }).task.enabled).toBe(false)

    const resumed = await fetch(`${url}/api/schedules/${id}/resume`, { method: 'POST' })
    expect(resumed.status).toBe(200)
    const task = ((await resumed.json()) as { task: { enabled: boolean; nextRunAt: string; failStreak: number } }).task
    expect(task.enabled).toBe(true)
    expect(task.nextRunAt).toBeTruthy()
    expect(task.failStreak).toBe(0)

    const missing = await fetch(`${url}/api/schedules/sched_ghost/pause`, { method: 'POST' })
    expect(missing.status).toBe(404)
  })
})

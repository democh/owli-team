/**
 * M79-AF 测试：操作权限收口 —— viewer 写闸门补全（browser / schedules / media）+ 审批定向口径。
 *
 * 背景：browser / schedules / media 的资源级端点此前用「读校验」（canAccessSession），
 * viewer（只读共享）可人工接管浏览器 / 改删触发定时任务 / 取消重试媒体任务；media 另有
 * `!guardJob(req)` 恒假判定导致守卫整体失效。审批面：推送已定向触发者，但决定 / 读面仍是
 * 「任何 editor」。本批统一为 ——
 * - viewer 写操作 403（与 /sessions 写闸门口径一致）；跨用户/非成员 404 不泄漏；
 * - 审批 = 本 Run 触发者 ∪ 会话属主（admin 经 sessionRole=owner 兜底）；否则决定 403、读面空。
 *
 * 挂载方式与生产一致：x-test-user 头注入身份 + 真实 /sessions/:id 与 /runs/:runId 守卫。
 */
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { describe, expect, it } from 'vitest'
import type { AuthUser } from '../src/auth/service.js'
import { assertRunAccess, createSessionAccessGuard } from '../src/auth/guards.js'
import { StreamTokenService } from '../src/browser/stream-token.js'
import { createBrowserRouter } from '../src/routes/browser.js'
import { createFeedbackRouter } from '../src/routes/feedback.js'
import type { ApiDeps } from '../src/routes/index.js'
import { createLibraryRouter } from '../src/routes/library.js'
import { createMediaRouter } from '../src/routes/media.js'
import { createRunsRouter } from '../src/routes/runs.js'
import { createSchedulesRouter } from '../src/routes/schedules.js'
import { ScheduleService } from '../src/schedule/service.js'
import { AuditStore } from '../src/store/audit.js'
import { ScheduleStore } from '../src/store/schedules.js'
import { makeEnv } from './helpers.js'

type Env = ReturnType<typeof makeEnv>

const CRON = { kind: 'cron' as const, expr: '*/5 * * * *' }

/** 账号（owner / editor / viewer / 触发者 editor / admin / 非成员）+ 归属会话 */
function seed(env: Env) {
  const mk = (username: string, role: 'member' | 'admin' = 'member') =>
    env.users.create({ username, displayName: username, passwordHash: 'x', role })
  const alice = mk('alice')
  const bob = mk('bob')
  const cara = mk('cara')
  const dave = mk('dave')
  const root = mk('root', 'admin')
  const eve = mk('eve') // 非成员
  const session = env.sessions.create(['pm', 'qa'], '权限测试会话', { ownerId: alice.id })
  env.members.upsert(session.id, bob.id, 'editor', alice.id)
  env.members.upsert(session.id, cara.id, 'viewer', alice.id)
  env.members.upsert(session.id, dave.id, 'editor', alice.id)
  return { alice, bob, cara, dave, root, eve, session }
}

type Seed = ReturnType<typeof seed>

const asUser = (uid: string): Record<string, string> => ({ 'x-test-user': uid, 'content-type': 'application/json' })

interface AfApp {
  url: string
  close: () => Promise<void>
  schedules: ScheduleStore
  service: ScheduleService
}

async function mountAf(env: Env, s: Seed): Promise<AfApp> {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    const uid = String(req.header('x-test-user') ?? '')
    if (uid) (req as unknown as { user?: AuthUser }).user = env.auth.getUser(uid) as unknown as AuthUser
    next()
  })
  const audit = new AuditStore(env.db)
  const schedules = new ScheduleStore(env.db)
  const service = new ScheduleService({
    cfg: env.cfg,
    schedules,
    sessions: env.sessions,
    notify: env.notify,
    launch: () => ({ runId: 'run_sched' }),
    isBusy: () => false,
  })
  // 审批面引擎替身：run_1 归属 seed 会话，触发者 = dave（editor）
  const engineStub = {
    hasRun: (id: string) => id === 'run_1',
    triggerUserIdOf: (id: string) => (id === 'run_1' ? s.dave.id : undefined),
    listActiveRuns: () => (env.sessions.getSession(s.session.id) ? [{ runId: 'run_1', sessionId: s.session.id, state: 'running', queue: [] }] : []),
    attach: () => null,
    stop: () => false,
    reorderQueue: () => ({ queue: [] }),
  }
  const mediaJob = { id: 'job_1', sessionId: s.session.id, status: 'running' }
  const mediaStub = {
    get: (id: string) => (id === 'job_1' ? mediaJob : undefined),
    cancel: (id: string) => ({ job: { ...mediaJob, id, status: 'canceled' } }),
    retry: (id: string) => ({ job: { ...mediaJob, id, status: 'queued' } }),
    providersOf: () => [],
    list: () => [mediaJob],
  }
  const browserSession = {
    id: 'bs_1',
    sessionId: s.session.id,
    isClosed: () => false,
    takeover: async () => undefined,
    release: async () => undefined,
    info: () => ({ id: 'bs_1', sessionId: s.session.id, state: 'ready', controller: 'human' }),
  }
  const browserStub = {
    get: (id: string) => (id === 'bs_1' ? browserSession : undefined),
    close: async () => true,
    ownerOf: () => undefined,
  }
  // M79-AF：素材入仓（写闸门在路由层断言；service stub 仅模拟成功路径）
  const libraryStub = {
    toSession: (_ownerId: string, id: string, _sessionId: string) =>
      id === 'mat_1' ? { path: 'library/ref-x.png', kind: 'image' } : { error: '素材不存在' },
  }
  const deps = {
    cfg: env.cfg,
    sessions: env.sessions,
    access: env.access,
    audit,
    schedules: service,
    engine: engineStub,
    approvals: env.approvals,
    runs: env.runs,
    usage: env.usage,
    events: env.events,
    media: mediaStub,
    browser: browserStub,
    library: libraryStub,
    feedback: env.feedback,
    streamTokens: new StreamTokenService(60_000),
  } as unknown as ApiDeps

  // 与生产一致的守卫挂载：会话子路由（schedules 的 /sessions/:id 分支） + 运行守卫
  app.use('/api/sessions/:id', createSessionAccessGuard(env.access))
  app.use('/api/runs/:runId', (req, _res, next) => {
    try {
      const runId = req.params.runId
      const sessionId =
        engineStub.listActiveRuns().find((r) => r.runId === runId)?.sessionId ?? env.runs.get(runId)?.sessionId
      assertRunAccess(env.access, (req as unknown as { user?: AuthUser }).user, sessionId, req.method)
      next()
    } catch (err) {
      next(err)
    }
  })
  app.use('/api', createSchedulesRouter(deps))
  app.use('/api', createMediaRouter(deps))
  app.use('/api', createBrowserRouter(deps))
  app.use('/api', createRunsRouter(deps))
  app.use('/api', createLibraryRouter(deps))
  app.use('/api', createFeedbackRouter(deps))
  app.use((err: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(typeof err.status === 'number' ? err.status : 500).json({ error: err.message })
  })
  const server: Server = await new Promise((resolve) => {
    const inst = app.listen(0, () => resolve(inst))
  })
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
    schedules,
    service,
  }
}

describe('M79-AF：定时任务写闸门（viewer 只读）', () => {
  it('viewer 改 / 触发 / 暂停 / 删除一律 403；editor 放行；非成员 404', async () => {
    const env = makeEnv()
    const s = seed(env)
    const api = await mountAf(env, s)
    const created = api.service.create({
      sessionId: s.session.id,
      title: '巡检',
      kind: 'run',
      instruction: '巡检',
      targetAgentId: 'pm',
      spec: CRON,
      createdBy: 'user',
    })
    expect(created.ok).toBe(true)
    const taskId = created.ok ? created.task!.id : ''
    try {
      // viewer：全部写操作 403
      for (const [method, path, body] of [
        ['PATCH', `/api/schedules/${taskId}`, JSON.stringify({ title: '改名' })],
        ['DELETE', `/api/schedules/${taskId}`, undefined],
        ['POST', `/api/schedules/${taskId}/run`, undefined],
        ['POST', `/api/schedules/${taskId}/pause`, undefined],
        ['POST', `/api/schedules/${taskId}/resume`, undefined],
      ] as const) {
        const res = await fetch(`${api.url}${path}`, { method, headers: asUser(s.cara.id), ...(body ? { body } : {}) })
        expect(res.status, `${method} ${path}`).toBe(403)
        expect(((await res.json()) as { error: string }).error).toContain('只读共享')
      }
      // editor：改名与暂停放行
      const rename = await fetch(`${api.url}/api/schedules/${taskId}`, {
        method: 'PATCH',
        headers: asUser(s.bob.id),
        body: JSON.stringify({ title: 'editor 改名' }),
      })
      expect(rename.status).toBe(200)
      const pause = await fetch(`${api.url}/api/schedules/${taskId}/pause`, { method: 'POST', headers: asUser(s.bob.id) })
      expect(pause.status).toBe(200)
      // 非成员：404 不泄漏
      const outsider = await fetch(`${api.url}/api/schedules/${taskId}`, {
        method: 'PATCH',
        headers: asUser(s.eve.id),
        body: JSON.stringify({ title: 'x' }),
      })
      expect(outsider.status).toBe(404)
    } finally {
      await api.close()
      env.db.close()
    }
  })
})

describe('M79-AF：媒体任务写闸门（viewer 只读）', () => {
  it('viewer 取消 / 重试 403，读仍 200；editor 重试放行；非成员 404', async () => {
    const env = makeEnv()
    const s = seed(env)
    const api = await mountAf(env, s)
    try {
      const cancel = await fetch(`${api.url}/api/media/jobs/job_1/cancel`, { method: 'POST', headers: asUser(s.cara.id) })
      expect(cancel.status).toBe(403)
      const retry = await fetch(`${api.url}/api/media/jobs/job_1/retry`, { method: 'POST', headers: asUser(s.cara.id) })
      expect(retry.status).toBe(403)
      // 读面保持：viewer 可看任务详情
      const read = await fetch(`${api.url}/api/media/jobs/job_1`, { headers: asUser(s.cara.id) })
      expect(read.status).toBe(200)
      // editor 放行
      const retryOk = await fetch(`${api.url}/api/media/jobs/job_1/retry`, { method: 'POST', headers: asUser(s.bob.id) })
      expect(retryOk.status).toBe(200)
      // 非成员 404（守卫修复后不再恒放行）
      const outsider = await fetch(`${api.url}/api/media/jobs/job_1`, { headers: asUser(s.eve.id) })
      expect(outsider.status).toBe(404)
      const outsiderWrite = await fetch(`${api.url}/api/media/jobs/job_1/cancel`, {
        method: 'POST',
        headers: asUser(s.eve.id),
      })
      expect(outsiderWrite.status).toBe(404)
    } finally {
      await api.close()
      env.db.close()
    }
  })
})

describe('M79-AF：浏览器接管写闸门（viewer 只读）', () => {
  it('viewer：takeover token / 接管 / 归还 / 关闭一律 403；watch token 仍 200；editor 接管放行', async () => {
    const env = makeEnv()
    const s = seed(env)
    const api = await mountAf(env, s)
    try {
      const token = await fetch(`${api.url}/api/browser/sessions/bs_1/stream-token?mode=takeover`, {
        headers: asUser(s.cara.id),
      })
      expect(token.status).toBe(403)
      const takeover = await fetch(`${api.url}/api/browser/sessions/bs_1/takeover`, {
        method: 'POST',
        headers: asUser(s.cara.id),
      })
      expect(takeover.status).toBe(403)
      const release = await fetch(`${api.url}/api/browser/sessions/bs_1/release`, {
        method: 'POST',
        headers: asUser(s.cara.id),
      })
      expect(release.status).toBe(403)
      const close = await fetch(`${api.url}/api/browser/sessions/bs_1/close`, {
        method: 'POST',
        headers: asUser(s.cara.id),
      })
      expect(close.status).toBe(403)
      // watch token（只读观察）不设写闸门
      const watch = await fetch(`${api.url}/api/browser/sessions/bs_1/stream-token?mode=watch`, {
        headers: asUser(s.cara.id),
      })
      expect(watch.status).toBe(200)
      // editor 放行
      const takeoverOk = await fetch(`${api.url}/api/browser/sessions/bs_1/takeover`, {
        method: 'POST',
        headers: asUser(s.bob.id),
      })
      expect(takeoverOk.status).toBe(200)
      // 非成员 404
      const outsider = await fetch(`${api.url}/api/browser/sessions/bs_1/takeover`, {
        method: 'POST',
        headers: asUser(s.eve.id),
      })
      expect(outsider.status).toBe(404)
    } finally {
      await api.close()
      env.db.close()
    }
  })
})

describe('M79-AF：审批决定口径（触发者 ∪ 属主）', () => {
  it('触发者 / 属主放行；其他 editor 403；viewer / admin(无归属旁路) / 非成员按守卫拒绝', async () => {
    const env = makeEnv()
    const s = seed(env)
    const api = await mountAf(env, s)
    const mk = (): { id: string } =>
      env.approvals.create({ runId: 'run_1', sessionId: s.session.id, agentId: 'pm', action: 'rm -rf', detail: 'x' })
    try {
      const a1 = mk()
      const byTrigger = await fetch(`${api.url}/api/runs/run_1/approvals/${a1.id}`, {
        method: 'POST',
        headers: asUser(s.dave.id),
        body: JSON.stringify({ decision: 'approve' }),
      })
      expect(byTrigger.status).toBe(200)

      const a2 = mk()
      const byOwner = await fetch(`${api.url}/api/runs/run_1/approvals/${a2.id}`, {
        method: 'POST',
        headers: asUser(s.alice.id),
        body: JSON.stringify({ decision: 'reject' }),
      })
      expect(byOwner.status).toBe(200)

      const a3 = mk()
      // admin 对本会话无归属旁路（M79-G 隐私语义）→ 守卫 404（与 m79-privacy 一致）
      const byAdmin = await fetch(`${api.url}/api/runs/run_1/approvals/${a3.id}`, {
        method: 'POST',
        headers: asUser(s.root.id),
        body: JSON.stringify({ decision: 'approve' }),
      })
      expect(byAdmin.status).toBe(404)

      const a4 = mk()
      const byOtherEditor = await fetch(`${api.url}/api/runs/run_1/approvals/${a4.id}`, {
        method: 'POST',
        headers: asUser(s.bob.id),
        body: JSON.stringify({ decision: 'approve' }),
      })
      expect(byOtherEditor.status).toBe(403)
      expect(((await byOtherEditor.json()) as { error: string }).error).toContain('发起本轮的成员或会话属主')

      const a5 = mk()
      const byViewer = await fetch(`${api.url}/api/runs/run_1/approvals/${a5.id}`, {
        method: 'POST',
        headers: asUser(s.cara.id),
        body: JSON.stringify({ decision: 'approve' }),
      })
      expect(byViewer.status).toBe(403)
      expect(((await byViewer.json()) as { error: string }).error).toContain('无操作权限')

      const a6 = mk()
      const byOutsider = await fetch(`${api.url}/api/runs/run_1/approvals/${a6.id}`, {
        method: 'POST',
        headers: asUser(s.eve.id),
        body: JSON.stringify({ decision: 'approve' }),
      })
      expect(byOutsider.status).toBe(404)
    } finally {
      await api.close()
      env.db.close()
    }
  })

  it('读面：非触发者 / 非属主返回空列表；触发者与属主可见', async () => {
    const env = makeEnv()
    const s = seed(env)
    const api = await mountAf(env, s)
    env.approvals.create({ runId: 'run_1', sessionId: s.session.id, agentId: 'pm', action: 'op', detail: 'x' })
    try {
      const asTrigger = await fetch(`${api.url}/api/runs/run_1/approvals`, { headers: asUser(s.dave.id) })
      expect(((await asTrigger.json()) as { approvals: unknown[] }).approvals).toHaveLength(1)
      const asOwner = await fetch(`${api.url}/api/runs/run_1/approvals`, { headers: asUser(s.alice.id) })
      expect(((await asOwner.json()) as { approvals: unknown[] }).approvals).toHaveLength(1)
      const asOther = await fetch(`${api.url}/api/runs/run_1/approvals`, { headers: asUser(s.bob.id) })
      expect(((await asOther.json()) as { approvals: unknown[] }).approvals).toHaveLength(0)
    } finally {
      await api.close()
      env.db.close()
    }
  })
})

describe('M79-AF：素材入仓与反馈查询的会话域口径', () => {
  it('to-canvas：viewer 403；editor 放行；非成员 404', async () => {
    const env = makeEnv()
    const s = seed(env)
    const api = await mountAf(env, s)
    try {
      const body = JSON.stringify({ sessionId: s.session.id })
      const viewer = await fetch(`${api.url}/api/library/items/mat_1/to-canvas`, {
        method: 'POST',
        headers: asUser(s.cara.id),
        body,
      })
      expect(viewer.status).toBe(403)
      expect(((await viewer.json()) as { error: string }).error).toContain('只读共享')
      const editor = await fetch(`${api.url}/api/library/items/mat_1/to-canvas`, {
        method: 'POST',
        headers: asUser(s.bob.id),
        body,
      })
      expect(editor.status).toBe(200)
      // 非成员：404 不泄漏（admin 无归属旁路）
      const outsider = await fetch(`${api.url}/api/library/items/mat_1/to-canvas`, {
        method: 'POST',
        headers: asUser(s.eve.id),
        body,
      })
      expect(outsider.status).toBe(404)
    } finally {
      await api.close()
      env.db.close()
    }
  })

  it('feedback 单条查询：非成员视同未反馈（item null）；会话成员可见', async () => {
    const env = makeEnv()
    const s = seed(env)
    const api = await mountAf(env, s)
    try {
      // 触发者 dave（editor）提交反馈（POST 走读校验=可读即可评）
      const post = await fetch(`${api.url}/api/feedback`, {
        method: 'POST',
        headers: asUser(s.dave.id),
        body: JSON.stringify({ sessionId: s.session.id, messageId: 'm_x', rating: 1, reason: '不错' }),
      })
      expect(post.status).toBe(201)
      // 非成员查询：视同未反馈（不泄漏反馈存在性），客户端语义零变化
      const asEve = await fetch(`${api.url}/api/feedback?messageId=m_x`, { headers: asUser(s.eve.id) })
      expect(((await asEve.json()) as { item: unknown }).item).toBeNull()
      // 会话成员查询：可见
      const asBob = await fetch(`${api.url}/api/feedback?messageId=m_x`, { headers: asUser(s.bob.id) })
      expect(((await asBob.json()) as { item: { rating: number } | null }).item?.rating).toBe(1)
    } finally {
      await api.close()
      env.db.close()
    }
  })
})

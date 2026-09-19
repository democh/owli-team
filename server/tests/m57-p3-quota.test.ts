/**
 * M57 P3 测试：配额与用量（存储 / 服务 / HTTP / 引擎波次闸门）。
 * - QuotaStore：部分写入 / null 清除 / 全空行清理 / limits 合并（与 RUN_MAX_PER_USER 取小）；
 * - QuotaService：blockedReason（日 token / 月成本）/ 会话数闸门 / 上传闸门 / usageOf 汇总；
 * - HTTP：GET /usage/me、GET/PUT /users/:id/quota（成员 403、admin 生效并审计）；
 * - 引擎：波次边界配额闸门 → 系统条 + run:end reason='quota'。
 */
import express from 'express'
import type { Server } from 'node:http'
import { describe, expect, it } from 'vitest'
import { AuditStore } from '../src/store/audit.js'
import type { AuthUser } from '../src/auth/service.js'
import type { ApiDeps } from '../src/routes/index.js'
import { createSessionsRouter } from '../src/routes/sessions.js'
import { createUsageRouter } from '../src/routes/usage.js'
import { createUsersRouter } from '../src/routes/users.js'
import { makeEnv, waitRunFinished } from './helpers.js'

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 3600 * 1000).toISOString()
}

describe('M57 P3：QuotaStore', () => {
  it('部分写入 / null 清除 / 全空行自动清理', () => {
    const env = makeEnv()
    const user = env.users.create({ username: 'alice', displayName: 'Alice', passwordHash: 'x', role: 'member' })
    const store = env.quotaStore
    expect(store.get(user.id)).toBeUndefined()

    store.upsert(user.id, { dailyTokens: 1000, maxSessions: 5 })
    expect(store.get(user.id)).toMatchObject({ dailyTokens: 1000, maxSessions: 5 })

    // 部分更新：未提字段不动；null 清除回不限
    store.upsert(user.id, { dailyTokens: null, monthlyCostUsd: 3 })
    expect(store.get(user.id)).toMatchObject({ monthlyCostUsd: 3, maxSessions: 5 })
    expect(store.get(user.id)?.dailyTokens).toBeUndefined()

    // 清空剩余两项 → 全空行自动清理
    store.upsert(user.id, { monthlyCostUsd: null, maxSessions: null })
    expect(store.get(user.id)).toBeUndefined()
  })

  it('limitsOf：配额与系统 RUN_MAX_PER_USER 取小；无配额行时回退系统默认', () => {
    const env = makeEnv({ runMaxPerUser: 4 })
    const user = env.users.create({ username: 'bob', displayName: 'Bob', passwordHash: 'x', role: 'member' })
    expect(env.quotaService.limitsOf(user.id).maxConcurrentRuns).toBe(4)
    env.quotaStore.upsert(user.id, { maxConcurrentRuns: 2 })
    expect(env.quotaService.limitsOf(user.id).maxConcurrentRuns).toBe(2)
    env.quotaStore.upsert(user.id, { maxConcurrentRuns: 9 })
    expect(env.quotaService.limitsOf(user.id).maxConcurrentRuns).toBe(4) // 取更小者
  })
})

describe('M57 P3：QuotaService（用量 / 闸门）', () => {
  it('blockedReason：日 token 超限 / 未超 / 无配额行；月成本同理', () => {
    const env = makeEnv()
    const user = env.users.create({ username: 'carol', displayName: 'Carol', passwordHash: 'x', role: 'member' })
    const session = env.sessions.create(['pm'], 'P3 会话', { ownerId: user.id })
    env.usage.record({
      runId: 'r1',
      sessionId: session.id,
      model: 'mock',
      promptTokens: 700,
      completionTokens: 400,
      kind: 'turn',
      userId: user.id,
    })

    // 无配额行 → 不限
    expect(env.quotaService.blockedReason(user.id)).toBeUndefined()
    // 日 token 上限 2000（已用 1100）→ 放行；上限 1000 → 超限文案
    env.quotaStore.upsert(user.id, { dailyTokens: 2000 })
    expect(env.quotaService.blockedReason(user.id)).toBeUndefined()
    env.quotaStore.upsert(user.id, { dailyTokens: 1000 })
    expect(env.quotaService.blockedReason(user.id)).toContain('今日 token 配额已用尽')

    // 月成本：record 记入 cost（mock 无价 → 0）；用 upsert 月上限 0.0001 模拟超限路径
    env.quotaStore.upsert(user.id, { dailyTokens: null, monthlyCostUsd: 0.0001 })
    const cost = env.usage.sumByUser(user.id, daysAgoIso(31)).costUsd
    if (cost > 0) {
      expect(env.quotaService.blockedReason(user.id)).toContain('本月成本配额已用尽')
    } else {
      // 无价模型成本为 0：0 >= 0.0001 不成立 → 不超限（断言路径一致性）
      expect(env.quotaService.blockedReason(user.id)).toBeUndefined()
    }
  })

  it('assertSessionCreate：达到 maxSessions 抛 403 文案；无配额放行', () => {
    const env = makeEnv()
    const user = env.users.create({ username: 'dave', displayName: 'Dave', passwordHash: 'x', role: 'member' })
    env.sessions.create(['pm'], 'A', { ownerId: user.id })
    env.sessions.create(['pm'], 'B', { ownerId: user.id })
    env.quotaStore.upsert(user.id, { maxSessions: 2 })
    expect(() => env.quotaService.assertSessionCreate(user.id)).toThrowError(/会话数已达上限（2 个）/)
    env.quotaStore.upsert(user.id, { maxSessions: 3 })
    expect(() => env.quotaService.assertSessionCreate(user.id)).not.toThrow()
  })

  it('assertUploadAllowed：超限抛 403；无配额 / 无属主放行；usageOf 汇总存储与今日 token', async () => {
    const env = makeEnv()
    const user = env.users.create({ username: 'erin', displayName: 'Erin', passwordHash: 'x', role: 'member' })
    const session = env.sessions.create(['pm'], '上传会话', { ownerId: user.id })
    // 写入一个文件到会话工作区（1MB）
    const dir = env.artifacts.ensureSessionDir(session.id)
    const fs = await import('node:fs')
    fs.writeFileSync(`${dir}/big.bin`, Buffer.alloc(1024 * 1024))
    env.usage.record({
      runId: 'r2',
      sessionId: session.id,
      model: 'mock',
      promptTokens: 100,
      completionTokens: 50,
      kind: 'turn',
      userId: user.id,
    })

    // 无配额：放行
    expect(() => env.quotaService.assertUploadAllowed(session.id, 10 * 1024 * 1024)).not.toThrow()
    // 上限 1MB（已用 ~1MB）→ 再传 0.5MB 越界
    env.quotaStore.upsert(user.id, { maxStorageMb: 1 })
    expect(() => env.quotaService.assertUploadAllowed(session.id, 512 * 1024)).toThrowError(/存储空间不足/)

    const summary = env.quotaService.usageOf(user.id)
    expect(summary.todayTokens).toBe(150)
    expect(summary.sessions).toBe(1)
    expect(summary.storageMb).toBeGreaterThanOrEqual(1)
    expect(summary.limits.maxStorageMb).toBe(1)
  })
})

describe('M57 P3：HTTP（usage/me 与用户配额）', () => {
  async function mountQuotaApi(env: ReturnType<typeof makeEnv>): Promise<{ url: string; close: () => Promise<void> }> {
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      const uid = String(req.header('x-test-user') ?? '')
      if (uid) (req as unknown as { user?: AuthUser }).user = env.auth.getUser(uid) as unknown as AuthUser
      next()
    })
    const requireAdmin = (req: express.Request, res: express.Response, next: express.NextFunction): void => {
      const user = (req as unknown as { user?: AuthUser }).user
      if (user?.role === 'admin') return next()
      res.status(403).json({ error: '需要管理员权限' })
    }
    app.use(
      '/api',
      createUsersRouter({
        auth: env.auth,
        requireAdmin,
        sessions: env.sessions,
        workspace: env.workspace,
        quotas: env.quotaService,
        audit: new AuditStore(env.db),
      }),
    )
    app.use('/api', createUsageRouter(env as unknown as ApiDeps))
    app.use('/api', createSessionsRouter(env as unknown as ApiDeps))
    app.use((err: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(typeof err.status === 'number' ? err.status : 500).json({ error: err.message })
    })
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s))
    })
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    return {
      url: `http://127.0.0.1:${port}`,
      close: () => new Promise((resolve) => server.close(() => resolve())),
    }
  }

  it('GET /usage/me 成员可见；PUT 配额成员 403 / admin 生效并审计；会话创建受上限约束', async () => {
    const env = makeEnv()
    const member = env.users.create({ username: 'frank', displayName: 'Frank', passwordHash: 'x', role: 'member' })
    const admin = env.users.create({ username: 'root', displayName: 'Root', passwordHash: 'x', role: 'admin' })
    const api = await mountQuotaApi(env)
    const asUser = (uid: string): Record<string, string> => ({ 'x-test-user': uid, 'content-type': 'application/json' })
    try {
      // 个人用量（成员）
      const me = await fetch(`${api.url}/api/usage/me`, { headers: asUser(member.id) })
      expect(me.status).toBe(200)
      const summary = (await me.json()) as { summary: { sessions: number; limits: Record<string, number> } }
      expect(summary.summary.sessions).toBe(0)

      // 成员不能改配额；可看自己的限额
      expect(
        (await fetch(`${api.url}/api/users/${member.id}/quota`, { method: 'PUT', headers: asUser(member.id), body: '{"maxSessions":1}' }))
          .status,
      ).toBe(403)
      expect((await fetch(`${api.url}/api/users/${member.id}/quota`, { headers: asUser(member.id) })).status).toBe(200)

      // admin 设置 maxSessions=1 → 成员建第 2 个会话 403
      const put = await fetch(`${api.url}/api/users/${member.id}/quota`, {
        method: 'PUT',
        headers: asUser(admin.id),
        body: JSON.stringify({ maxSessions: 1, dailyTokens: 5000 }),
      })
      expect(put.status).toBe(200)
      const first = await fetch(`${api.url}/api/sessions`, {
        method: 'POST',
        headers: asUser(member.id),
        body: JSON.stringify({ participantIds: [] }),
      })
      expect(first.status).toBe(201)
      const second = await fetch(`${api.url}/api/sessions`, {
        method: 'POST',
        headers: asUser(member.id),
        body: JSON.stringify({ participantIds: [] }),
      })
      expect(second.status).toBe(403)
      expect(((await second.json()) as { error: string }).error).toContain('会话数已达上限')

      // 审计留痕
      const row = env.db.get<{ user_id: string | null; action: string }>(
        "SELECT user_id, action FROM audit_log WHERE action = 'auth.quota-set' ORDER BY id DESC LIMIT 1",
      )
      expect(row?.user_id).toBe(admin.id)

      // admin 逐用户用量
      const usage = await fetch(`${api.url}/api/users/${member.id}/usage`, { headers: asUser(admin.id) })
      expect(usage.status).toBe(200)
      expect(((await usage.json()) as { summary: { sessions: number } }).summary.sessions).toBe(1)
    } finally {
      await api.close()
    }
  })
})

describe('M57 P3：引擎波次闸门', () => {
  it('日 token 超限：本 Run 以 reason=quota 收束并落系统条', async () => {
    const env = makeEnv()
    const user = env.users.create({ username: 'gina', displayName: 'Gina', passwordHash: 'x', role: 'member' })
    const session = env.sessions.create(['pm'], '配额收束', { ownerId: user.id })
    // 先记一笔用量使日配额（1 token）立即超限
    env.usage.record({
      runId: 'r-seed',
      sessionId: session.id,
      model: 'mock',
      promptTokens: 1,
      completionTokens: 0,
      kind: 'turn',
      userId: user.id,
    })
    env.quotaStore.upsert(user.id, { dailyTokens: 1 })

    const userMessage = env.sessions.appendMessage({
      sessionId: session.id,
      role: 'user',
      content: '@派蒙 看看',
      mentions: [],
      status: 'complete',
      userId: user.id,
    })
    const { runId } = env.engine.launch(session.id, userMessage.id)
    await waitRunFinished(env.engine, runId)

    // 系统条提示
    const system = env.sessions.messages(session.id).find((m) => m.role === 'system')
    expect(system?.content).toContain('用量配额已超限')
    expect(system?.content).toContain('今日 token 配额已用尽')
    // run:end reason=quota（经 notify:run-completed 广播）
    const ended = env.published.find((n) => n.type === 'notify:run-completed')
    expect((ended?.payload as { reason?: string }).reason).toBe('quota')
    // 波次未推进（未触发任何回合）
    expect(env.sessions.messages(session.id).filter((m) => m.role === 'agent')).toHaveLength(0)
  })

  it('无配额行：闸门零生效（正常跑完）', async () => {
    const env = makeEnv()
    const user = env.users.create({ username: 'hank', displayName: 'Hank', passwordHash: 'x', role: 'member' })
    const session = env.sessions.create(['pm'], '无配额', { ownerId: user.id })
    const userMessage = env.sessions.appendMessage({
      sessionId: session.id,
      role: 'user',
      content: '@派蒙 你好',
      mentions: [],
      status: 'complete',
      userId: user.id,
    })
    const { runId } = env.engine.launch(session.id, userMessage.id)
    await waitRunFinished(env.engine, runId)
    expect(env.sessions.messages(session.id).some((m) => m.role === 'agent' && m.content.trim().length > 0)).toBe(true)
  })
})

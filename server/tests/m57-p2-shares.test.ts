/**
 * M57 P2 测试：会话共享协作（HTTP 级 + 存储级）。
 *
 * 挂载真实 `createSessionAccessGuard` + `createSharesRouter` + `createSessionsRouter`，
 * 以 `x-test-user` 头注入用户身份（绕过认证中间件，直测「守卫 + 属主校验 + 角色矩阵」）。
 * 覆盖：邀请→可见→插话令牌（写闸门）→ 改角色 → viewer 只读 / 自助退出 → 移出后 404；
 *       跨用户 404 不泄漏；属主专属操作 403；列表 role 标注 / 搜索 / WS 可见集；审计留痕；兼容模式。
 */
import express from 'express'
import type { Server } from 'node:http'
import { describe, expect, it } from 'vitest'
import { AuditStore as AuditStoreClass } from '../src/store/audit.js'
import { createSessionAccessGuard } from '../src/auth/guards.js'
import type { AuthUser } from '../src/auth/service.js'
import type { ApiDeps } from '../src/routes/index.js'
import { createSessionsRouter } from '../src/routes/sessions.js'
import { createSharesRouter } from '../src/routes/shares.js'
import { makeEnv } from './helpers.js'

type Env = ReturnType<typeof makeEnv>

/** 挂载 P2 相关路由（用户注入 → 会话守卫 → 共享路由 → 会话路由） */
async function mountP2(env: Env): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    const uid = String(req.header('x-test-user') ?? '')
    if (uid) (req as unknown as { user?: AuthUser }).user = env.auth.getUser(uid) as unknown as AuthUser
    next()
  })
  const audit = new AuditStoreClass(env.db)
  // 与生产一致的挂载点：`/sessions/:id`（守卫依赖 req.params.id）
  app.use('/api/sessions/:id', createSessionAccessGuard(env.access))
  app.use(
    '/api',
    createSharesRouter({
      access: env.access,
      auth: env.auth,
      members: env.members,
      audit,
    }),
  )
  app.use('/api', createSessionsRouter(env as unknown as ApiDeps))
  // 错误映射（HttpError → status；与生产全局处理一致）
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
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
      }),
  }
}

/** 造 3 个账号（owner / editor / viewer 后续赋权）+ 一份归属会话 */
function seed(env: Env) {
  const a = env.users.create({ username: 'alice', displayName: 'Alice', passwordHash: 'x', role: 'member' })
  const b = env.users.create({ username: 'bob', displayName: 'Bob', passwordHash: 'x', role: 'member' })
  const c = env.users.create({ username: 'cara', displayName: 'Cara', passwordHash: 'x', role: 'member' })
  const session = env.sessions.create(['pm'], '共享测试会话', { ownerId: a.id })
  return { a, b, c, session }
}

const asUser = (uid: string): Record<string, string> => ({ 'x-test-user': uid, 'content-type': 'application/json' })

describe('M57 P2：共享生命周期（HTTP）', () => {
  it('邀请 → editor 可读写 → 改 viewer 后写 403 → 自助退出 → 404', async () => {
    const env = makeEnv()
    const { a, b, session } = seed(env)
    const api = await mountP2(env)
    try {
      // 未共享：跨用户一律 404（不泄漏存在性）
      expect((await fetch(`${api.url}/api/sessions/${session.id}`, { headers: asUser(b.id) })).status).toBe(404)

      // 属主邀请 B 为 editor
      const invite = await fetch(`${api.url}/api/sessions/${session.id}/shares`, {
        method: 'POST',
        headers: asUser(a.id),
        body: JSON.stringify({ username: 'bob', role: 'editor' }),
      })
      expect(invite.status).toBe(201)
      const invited = (await invite.json()) as { owner?: { userId: string }; members: Array<{ userId: string; role: string }> }
      expect(invited.owner?.userId).toBe(a.id)
      expect(invited.members).toHaveLength(1)
      expect(invited.members[0]).toMatchObject({ userId: b.id, role: 'editor' })

      // B 可见：详情 200
      expect((await fetch(`${api.url}/api/sessions/${session.id}`, { headers: asUser(b.id) })).status).toBe(200)
      // M79-J（§16 矩阵）：成员编制管理对 team 收紧为 owner-only → editor 一律 403（守卫放行后由编制权限拦截）
      const lineupAsEditor = await fetch(`${api.url}/api/sessions/${session.id}/members`, {
        method: 'POST',
        headers: asUser(b.id),
        body: JSON.stringify({ agentIds: ['__nonexistent__'] }),
      })
      expect(lineupAsEditor.status).toBe(403)
      expect(((await lineupAsEditor.json()) as { error: string }).error).toContain('仅会话属主')
      // M79-AE：治理字段（改名 / 触发策略）统一收敛为属主——editor 改名一律 403
      const renameAsEditor = await fetch(`${api.url}/api/sessions/${session.id}`, {
        method: 'PATCH',
        headers: asUser(b.id),
        body: JSON.stringify({ title: 'editor 改名探针' }),
      })
      expect(renameAsEditor.status).toBe(403)
      // editor 常规写权限仍有效：以「发送消息」（内容协作写）为探针（201）
      const writeAsEditor = await fetch(`${api.url}/api/sessions/${session.id}/messages`, {
        method: 'POST',
        headers: asUser(b.id),
        body: JSON.stringify({ content: 'editor 写探针' }),
      })
      expect(writeAsEditor.status).toBe(201)

      // 属主改 B 为 viewer → 写 403（守卫），读仍 200
      const patch = await fetch(`${api.url}/api/sessions/${session.id}/shares/${b.id}`, {
        method: 'PATCH',
        headers: asUser(a.id),
        body: JSON.stringify({ role: 'viewer' }),
      })
      expect(patch.status).toBe(200)
      const writeAsViewer = await fetch(`${api.url}/api/sessions/${session.id}/messages`, {
        method: 'POST',
        headers: asUser(b.id),
        body: JSON.stringify({ content: 'viewer 写探针' }),
      })
      expect(writeAsViewer.status).toBe(403)
      expect((await fetch(`${api.url}/api/sessions/${session.id}`, { headers: asUser(b.id) })).status).toBe(200)

      // viewer 可自助退出（/leave 为唯一写例外）→ 之后 404
      const leave = await fetch(`${api.url}/api/sessions/${session.id}/leave`, {
        method: 'POST',
        headers: asUser(b.id),
      })
      expect(leave.status).toBe(200)
      expect((await fetch(`${api.url}/api/sessions/${session.id}`, { headers: asUser(b.id) })).status).toBe(404)
    } finally {
      await api.close()
    }
  })

  it('属主专属：编辑者管理共享 403；邀请校验（不存在 404 / 自己 400 / 重复 409）；删除会话 owner 专属', async () => {
    const env = makeEnv()
    const { a, b, c, session } = seed(env)
    const api = await mountP2(env)
    try {
      await fetch(`${api.url}/api/sessions/${session.id}/shares`, {
        method: 'POST',
        headers: asUser(a.id),
        body: JSON.stringify({ username: 'bob', role: 'editor' }),
      })
      // editor 不能管理共享
      expect(
        (
          await fetch(`${api.url}/api/sessions/${session.id}/shares`, {
            method: 'POST',
            headers: asUser(b.id),
            body: JSON.stringify({ username: 'cara', role: 'viewer' }),
          })
        ).status,
      ).toBe(403)
      expect(
        (await fetch(`${api.url}/api/sessions/${session.id}/shares/${b.id}`, { method: 'PATCH', headers: asUser(b.id), body: '{"role":"viewer"}' }))
          .status,
      ).toBe(403)
      // 邀请校验
      expect(
        (
          await fetch(`${api.url}/api/sessions/${session.id}/shares`, {
            method: 'POST',
            headers: asUser(a.id),
            body: JSON.stringify({ username: 'ghost' }),
          })
        ).status,
      ).toBe(404)
      expect(
        (
          await fetch(`${api.url}/api/sessions/${session.id}/shares`, {
            method: 'POST',
            headers: asUser(a.id),
            body: JSON.stringify({ username: 'alice' }),
          })
        ).status,
      ).toBe(400)
      expect(
        (
          await fetch(`${api.url}/api/sessions/${session.id}/shares`, {
            method: 'POST',
            headers: asUser(a.id),
            body: JSON.stringify({ username: 'cara' }),
          })
        ).status,
      ).toBe(201)
      expect(
        (
          await fetch(`${api.url}/api/sessions/${session.id}/shares`, {
            method: 'POST',
            headers: asUser(a.id),
            body: JSON.stringify({ username: 'cara' }),
          })
        ).status,
      ).toBe(409)
      // 删除会话：editor 403 → 属主可删（deleteWorkspace=false 跳过磁盘）
      expect(
        (await fetch(`${api.url}/api/sessions/${session.id}?deleteWorkspace=false`, { method: 'DELETE', headers: asUser(b.id) })).status,
      ).toBe(403)
      const deleted = await fetch(`${api.url}/api/sessions/${session.id}?deleteWorkspace=false`, {
        method: 'DELETE',
        headers: asUser(a.id),
      })
      expect(deleted.status).toBe(200)
      // 级联：共享成员随会话删除清理
      expect(env.members.list(session.id)).toHaveLength(0)
      void c
    } finally {
      await api.close()
    }
  })
})

describe('M57 P2：共享会话人类消息署名（上下文装配）', () => {
  it('独占会话沿用【用户】；加入共享成员后改署昵称', async () => {
    const env = makeEnv()
    const a = env.users.create({ username: 'alice', displayName: 'Alice', passwordHash: 'x', role: 'member' })
    const b = env.users.create({ username: 'bob', displayName: 'Bob', passwordHash: 'x', role: 'member' })
    const session = env.sessions.create(['pm'], '署名会话', { ownerId: a.id })
    env.sessions.appendMessage({ sessionId: session.id, role: 'user', content: '先看登录', mentions: [], status: 'complete', userId: a.id })
    const contentOf = (m: { content: unknown }): string => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))

    // 独占（无共享成员）：行为不变 → 【用户】
    const solo = await env.context.prepareTurn({ sessionId: session.id, agentId: 'pm', runId: 'r-solo', queue: [] })
    const soloText = solo.messages.filter((m) => m.role === 'user').map(contentOf).join('\n')
    expect(soloText).toContain('【用户】先看登录')

    // 共享（B 加入）→ 双方均署昵称
    env.members.upsert(session.id, b.id, 'editor', a.id)
    env.sessions.appendMessage({ sessionId: session.id, role: 'user', content: '补充：先跑回归', mentions: [], status: 'complete', userId: b.id })
    const shared = await env.context.prepareTurn({ sessionId: session.id, agentId: 'pm', runId: 'r-shared', queue: [] })
    const sharedText = shared.messages.filter((m) => m.role === 'user').map(contentOf).join('\n')
    expect(sharedText).toContain('【Alice】先看登录')
    expect(sharedText).toContain('【Bob】补充：先跑回归')
  })

  it('压缩摘要 / 记忆沉淀输入文本同样署昵称；列表预览带作者（M57 P2/P3 收口）', async () => {
    const env = makeEnv()
    const a = env.users.create({ username: 'alice', displayName: 'Alice', passwordHash: 'x', role: 'member' })
    const b = env.users.create({ username: 'bob', displayName: 'Bob', passwordHash: 'x', role: 'member' })
    const session = env.sessions.create(['pm'], '署名收口', { ownerId: a.id })
    const { renderForSummary } = await import('../src/context/compressor.js')
    const { renderForDigest } = await import('../src/memory/digest.js')
    const { createUserLabelResolver } = await import('../src/context/user-label.js')
    const msgA = env.sessions.appendMessage({ sessionId: session.id, role: 'user', content: '先看登录', mentions: [], status: 'complete', userId: a.id })
    const msgB = env.sessions.appendMessage({ sessionId: session.id, role: 'user', content: '补充回归', mentions: [], status: 'complete', userId: b.id })

    // 未共享：无 labeler → 仍为「用户」
    expect(renderForSummary([msgA, msgB])).toContain('[用户] 先看登录')
    expect(renderForDigest([msgA, msgB])).toContain('[用户] 先看登录')

    // 共享（B 加入）→ 摘要 / 沉淀输入文本署昵称
    env.members.upsert(session.id, b.id, 'editor', a.id)
    const labeler = createUserLabelResolver({ members: env.members, users: env.users })(session.id)
    expect(labeler).toBeDefined()
    const summaryText = renderForSummary([msgA, msgB], labeler)
    expect(summaryText).toContain('[Alice] 先看登录')
    expect(summaryText).toContain('[Bob] 补充回归')
    const digestText = renderForDigest([msgA, msgB], labeler)
    expect(digestText).toContain('[Alice] 先看登录')
    expect(digestText).toContain('[Bob] 补充回归')

    // 列表预览：最后一条人类消息带作者（昵称解析入 lastMessage）
    const item = env.sessions.listForUser(a.id).find((s) => s.id === session.id)
    expect(item?.lastMessage).toMatchObject({ role: 'user', userId: b.id, userName: 'Bob' })
    // 兼容模式（无属主 / 无账号）：不带作者字段
    const compat = env.sessions.create(['pm'], '兼容预览')
    env.sessions.appendMessage({ sessionId: compat.id, role: 'user', content: 'hi', mentions: [], status: 'complete' })
    const compatItem = env.sessions.list(null).find((s) => s.id === compat.id)
    expect(compatItem?.lastMessage?.userId).toBeUndefined()
  })
})

describe('M57 P2：可见性、归因与兼容模式', () => {
  it('listForUser 标注 role；搜索覆盖共享会话；visibleSessionIds 含共享；审计留痕', async () => {
    const env = makeEnv()
    const { a, b, session } = seed(env)
    env.sessions.appendMessage({ sessionId: session.id, role: 'user', content: '共享会话里的独特关键词 zebra', mentions: [], status: 'complete', userId: a.id })
    const api = await mountP2(env)
    try {
      await fetch(`${api.url}/api/sessions/${session.id}/shares`, {
        method: 'POST',
        headers: asUser(a.id),
        body: JSON.stringify({ username: 'bob', role: 'editor' }),
      })
      // 列表：B 看到共享会话并带 role=editor；A 为 owner
      const listB = env.sessions.listForUser(b.id)
      expect(listB.map((s) => s.id)).toContain(session.id)
      expect(listB.find((s) => s.id === session.id)?.role).toBe('editor')
      expect(env.sessions.listForUser(a.id).find((s) => s.id === session.id)?.role).toBe('owner')
      // HTTP 列表同样携带 role
      const httpList = (await (await fetch(`${api.url}/api/sessions`, { headers: asUser(b.id) })).json()) as {
        sessions: Array<{ id: string; role?: string }>
      }
      expect(httpList.sessions.find((s) => s.id === session.id)?.role).toBe('editor')
      // 会话详情：人类署名表（owner + 共享成员；客户端消息气泡署名用）
      const detail = (await (await fetch(`${api.url}/api/sessions/${session.id}`, { headers: asUser(b.id) })).json()) as {
        humanNames?: Record<string, string>
      }
      expect(detail.humanNames?.[a.id]).toBe('Alice')
      expect(detail.humanNames?.[b.id]).toBe('Bob')
      // 搜索：命中共享会话消息（旧口径仅属主可搜）
      expect(env.sessions.search('zebra', 10, b.id).some((r) => r.sessionId === session.id)).toBe(true)
      expect(env.sessions.search('zebra', 10, 'u_nonexistent').some((r) => r.sessionId === session.id)).toBe(false)
      // WS / 通知可见集
      const visible = env.access.visibleSessionIds(env.auth.getUser(b.id) as unknown as AuthUser)
      expect(visible?.has(session.id)).toBe(true)
      // 审计留痕
      const actions = env.db.all<{ action: string }>('SELECT action FROM audit_log ORDER BY id').map((r) => r.action)
      expect(actions).toContain('session.share-add')
    } finally {
      await api.close()
    }
  })

  it('兼容模式（无账号）：读放行；共享写操作 400 拒绝', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm'], '兼容模式会话')
    const api = await mountP2(env)
    try {
      expect((await fetch(`${api.url}/api/sessions/${session.id}`)).status).toBe(200)
      const res = await fetch(`${api.url}/api/sessions/${session.id}/shares`, {
        method: 'POST',
        body: JSON.stringify({ username: 'whoever' }),
      })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toContain('多用户未启用')
      // 查看共享列表：兼容模式放行（空成员 + 无属主）
      expect((await fetch(`${api.url}/api/sessions/${session.id}/shares`)).status).toBe(200)
    } finally {
      await api.close()
    }
  })
})

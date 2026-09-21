/**
 * M79-G 测试：隐私语义固化（设计 §22 注记修订）。
 *
 * 覆盖：
 * 1) presence 可见域（createPresenceRecipients）：好友 ∪ 同会话人类成员（团队 / 群 / 私聊一致）；
 *    去重、排除本人与无关用户（隐私最小面）；
 * 2) admin 无会话内容旁路：admin 读取成员私有会话（team 与 direct）一律 404；
 *    列表 / 搜索 / WS 可见集均不含（owner ∪ 共享成员为唯一事实源——不提供 DM_ADMIN_VISIBLE 类开关）。
 */
import express from 'express'
import type { Server } from 'node:http'
import { describe, expect, it } from 'vitest'
import { createSessionAccessGuard } from '../src/auth/guards.js'
import type { AuthUser } from '../src/auth/service.js'
import type { ApiDeps } from '../src/routes/index.js'
import { createSessionsRouter } from '../src/routes/sessions.js'
import { dmKeyOf } from '../src/routes/chats.js'
import { createPresenceRecipients } from '../src/realtime/presence-recipients.js'
import { FriendStore } from '../src/store/friends.js'
import { makeEnv } from './helpers.js'

type Env = ReturnType<typeof makeEnv>

/** 挂载「用户注入 → 会话守卫 → 会话路由」（与生产一致；x-test-user 直测访问矩阵） */
async function mount(env: Env): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    const uid = String(req.header('x-test-user') ?? '')
    if (uid) (req as unknown as { user?: AuthUser }).user = env.auth.getUser(uid) as unknown as AuthUser
    next()
  })
  app.use('/api/sessions/:id', createSessionAccessGuard(env.access))
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
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
      }),
  }
}

const asUser = (uid: string): Record<string, string> => ({ 'x-test-user': uid, 'content-type': 'application/json' })

describe('M79-G：presence 可见域（好友 ∪ 同会话人类成员）', () => {
  it('好友 / 同会话成员（团队、群、私聊）均可见；本人与无关用户不在收件人', () => {
    const env = makeEnv()
    try {
      const alice = env.users.create({ username: 'alice', displayName: 'Alice', passwordHash: 'x', role: 'member' })
      const bob = env.users.create({ username: 'bob', displayName: 'Bob', passwordHash: 'x', role: 'member' })
      const cara = env.users.create({ username: 'cara', displayName: 'Cara', passwordHash: 'x', role: 'member' })
      const dave = env.users.create({ username: 'dave', displayName: 'Dave', passwordHash: 'x', role: 'member' })
      const eve = env.users.create({ username: 'eve', displayName: 'Eve', passwordHash: 'x', role: 'member' })

      // alice ↔ dave 好友（dave 发起 → alice 接受）
      const friends = new FriendStore(env.db)
      const link = friends.request(dave.id, alice.id)
      friends.accept(link.id)
      expect(friends.areFriends(alice.id, dave.id)).toBe(true)

      // 群（cara 属主，alice 为共享成员）——非好友关系
      const group = env.sessions.create([], '协作群', { ownerId: cara.id, kind: 'group' })
      env.members.upsert(group.id, alice.id, 'editor')
      // 私聊（bob 属主，alice 为另一成员）——非好友关系
      const dm = env.sessions.create([], '私聊', { ownerId: bob.id, kind: 'direct', dmKey: dmKeyOf(alice.id, bob.id) })
      env.members.upsert(dm.id, alice.id, 'editor')
      // 团队（alice 属主，bob 共享成员）
      const team = env.sessions.create(['pm'], 'Alice 团队', { ownerId: alice.id })
      env.members.upsert(team.id, bob.id, 'editor')

      const recipients = createPresenceRecipients({ friends, sessions: env.sessions, members: env.members })

      // alice：好友 dave + 群主 cara + 私聊对端 bob + 团队成员 bob（去重）
      expect([...recipients(alice.id)].sort()).toEqual([bob.id, cara.id, dave.id].sort())
      // cara：仅同群成员 alice（非好友）
      expect([...recipients(cara.id)]).toEqual([alice.id])
      // eve：无任何关系 → 空集（隐私最小面）
      expect([...recipients(eve.id)]).toEqual([])
    } finally {
      env.sessions.close()
      env.db.close()
    }
  })
})

describe('M79-G：admin 无会话内容旁路（owner ∪ 成员为唯一事实源）', () => {
  it('admin 读取成员私有会话（team / direct）→ 404；列表 / 搜索 / 可见集均不含', async () => {
    const env = makeEnv()
    const api = await mount(env)
    try {
      const admin = env.users.create({ username: 'root', displayName: 'Root', passwordHash: 'x', role: 'admin' })
      const bob = env.users.create({ username: 'bob', displayName: 'Bob', passwordHash: 'x', role: 'member' })
      const own = env.sessions.create(['pm'], 'Admin 自有会话', { ownerId: admin.id })
      const sTeam = env.sessions.create(['pm'], 'Bob 的团队', { ownerId: bob.id })
      const sDm = env.sessions.create([], 'Bob 的私聊', { ownerId: bob.id, kind: 'direct', dmKey: dmKeyOf(bob.id, 'u_ghost') })
      env.sessions.appendMessage({
        sessionId: sTeam.id,
        role: 'user',
        userId: bob.id,
        content: '绝密关键字zzz仅bob可见',
        mentions: [],
        status: 'complete',
      })

      // 详情：一律 404（不泄漏存在性；team 与 direct 同规）
      expect((await fetch(`${api.url}/api/sessions/${sTeam.id}`, { headers: asUser(admin.id) })).status).toBe(404)
      expect((await fetch(`${api.url}/api/sessions/${sDm.id}`, { headers: asUser(admin.id) })).status).toBe(404)
      // 写操作同规（守卫先读后写）
      const post = await fetch(`${api.url}/api/sessions/${sTeam.id}/messages`, {
        method: 'POST',
        headers: asUser(admin.id),
        body: JSON.stringify({ content: '越权试探' }),
      })
      expect(post.status).toBe(404)

      // 列表：admin 仅见自有会话
      const list = (await (await fetch(`${api.url}/api/sessions`, { headers: asUser(admin.id) })).json()) as {
        sessions: Array<{ id: string }>
      }
      expect(list.sessions.map((s) => s.id)).toEqual([own.id])

      // 搜索：admin 无命中（M57 检索按用户作用域）
      const hits = (await (
        await fetch(`${api.url}/api/search?q=${encodeURIComponent('绝密关键字zzz')}`, { headers: asUser(admin.id) })
      ).json()) as { results: Array<{ sessionId: string }> }
      expect(hits.results.map((h) => h.sessionId)).not.toContain(sTeam.id)

      // WS 可见集 + AccessService 直判
      const adminUser = { id: admin.id, username: 'root', displayName: 'Root', role: 'admin' as const }
      const visible = env.access.visibleSessionIds(adminUser)!
      expect(visible.has(sTeam.id)).toBe(false)
      expect(visible.has(sDm.id)).toBe(false)
      expect(env.access.canAccessSession(adminUser, sTeam.id)).toBe(false)
      expect(env.access.canAccessSession(adminUser, own.id)).toBe(true)

      // 反向对照：bob 对自己的会话完全可用（404 仅因「非成员」而非降级）
      expect((await fetch(`${api.url}/api/sessions/${sTeam.id}`, { headers: asUser(bob.id) })).status).toBe(200)
    } finally {
      await api.close()
      env.sessions.close()
      env.db.close()
    }
  })
})

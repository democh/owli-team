/**
 * M79-C 测试：好友体系（状态机 / HTTP 全链 / 通知联动 / 隐私与限流）。
 *
 * 覆盖：
 * - FriendStore：视角状态机（pending-in/out、accepted、blocked）/ 拉黑覆盖 pending / 解除；
 * - HTTP：发起（username / userId 寻址）→ 接受 → 双向好友；重复 / 反向并存 / 拒绝后重发 / 撤回；
 * - 通知联动：inbox 投递（friend-request / friend-accepted）+ notify:friends-changed 广播；
 * - 拉黑：四面切断（请求 / 搜索双向 / 好友列表）；解除拉黑恢复；
 * - 日限流（429）；搜索隐私（searchable=false 仅精确用户名）；兼容模式（400 / 空集）。
 */
import express from 'express'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { createAuthMiddleware } from '../src/middleware.js'
import { createFriendsRouter } from '../src/routes/friends.js'
import type { InboxAddInput } from '../src/store/inbox.js'
import { FriendStore } from '../src/store/friends.js'
import { UserStore } from '../src/store/users.js'
import { makeEnv } from './helpers.js'

interface Fixture {
  env: ReturnType<typeof makeEnv>
  users: UserStore
  friends: FriendStore
  base: string
  adminId: string
  bobId: string
  staffId: string
  carolId: string
  cookie: (userId: string) => string
  tokens: Map<string, string>
  delivered: InboxAddInput[]
  changed: Array<{ userId: string; counterpartId: string; action: string }>
  close: () => Promise<void>
}

async function makeFixture(overrides: Parameters<typeof makeEnv>[0] = {}): Promise<Fixture> {
  const env = makeEnv(overrides)
  const users = env.users
  const friends = new FriendStore(env.db)
  await env.auth.setup({ username: 'admin', password: 'Str0ngPass!x' })
  const adminLogin = await env.auth.login({ username: 'admin', password: 'Str0ngPass!x' })
  const bob = await env.auth.createUser({ username: 'bob', role: 'member' })
  const staff = await env.auth.createUser({ username: 'staff', role: 'member' })
  const carol = await env.auth.createUser({ username: 'carol', role: 'member' })
  const tokens = new Map<string, string>([[adminLogin.user.id, adminLogin.rawToken]])
  for (const [created, password] of [
    [bob, bob.initialPassword!],
    [staff, staff.initialPassword!],
    [carol, carol.initialPassword!],
  ] as const) {
    const login = await env.auth.login({ username: created.user.username, password })
    // 首登强制改密：测试需越过 403 闸门（保留当前会话令牌）
    await env.auth.changePassword({
      userId: created.user.id,
      currentPassword: password,
      newPassword: 'Str0ngPass!x2',
      keepSessionToken: login.rawToken,
    })
    tokens.set(created.user.id, login.rawToken)
  }

  const delivered: InboxAddInput[] = []
  const changed: Array<{ userId: string; counterpartId: string; action: string }> = []
  const app = express()
  app.use(express.json())
  app.use('/api', createAuthMiddleware(env.cfg, env.auth))
  app.use(
    '/api',
    createFriendsRouter({
      cfg: env.cfg,
      access: env.access,
      auth: env.auth,
      users,
      friends,
      deliver: (input) => delivered.push(input),
      publishFriendsChanged: (userId, counterpartId, action) => changed.push({ userId, counterpartId, action }),
    }),
  )
  const server = app.listen(0)
  await new Promise<void>((r) => server.once('listening', r))
  const port = (server.address() as AddressInfo).port
  return {
    env,
    users,
    friends,
    base: `http://127.0.0.1:${port}`,
    adminId: adminLogin.user.id,
    bobId: bob.user.id,
    staffId: staff.user.id,
    carolId: carol.user.id,
    cookie: (userId: string) => `sid=${tokens.get(userId)}`,
    tokens,
    delivered,
    changed,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()))
      env.sessions.close()
      env.db.close()
    },
  }
}

function post(url: string, cookie: string, body?: unknown): Promise<globalThis.Response> {
  return fetch(url, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
}

describe('M79-C：好友状态机（FriendStore）', () => {
  it('请求 / 接受 / 拒绝 / 解除 / 拉黑 的视角状态与方向', () => {
    const env = makeEnv()
    try {
      const users = new UserStore(env.db)
      const a = users.create({ username: 'user_a', displayName: 'A', passwordHash: 'x', role: 'member' })
      const b = users.create({ username: 'user_b', displayName: 'B', passwordHash: 'x', role: 'member' })
      const friends = new FriendStore(env.db)

      expect(friends.relation(a.id, b.id)).toBe('none')
      const record = friends.request(a.id, b.id, '你好')
      expect(friends.relation(a.id, b.id)).toBe('pending-out')
      expect(friends.relation(b.id, a.id)).toBe('pending-in')
      expect(friends.listPending(b.id).incoming).toHaveLength(1)
      expect(friends.listPending(a.id).outgoing).toHaveLength(1)
      expect(friends.countRequestsSince(a.id, '2000-01-01T00:00:00.000Z')).toBe(1)

      friends.accept(record.id)
      expect(friends.areFriends(a.id, b.id)).toBe(true)
      expect(friends.listFriends(a.id).map((f) => f.userId)).toEqual([b.id])

      // 解除
      expect(friends.removePair(a.id, b.id)).toBe(true)
      expect(friends.relation(a.id, b.id)).toBe('none')

      // 拉黑覆盖：先请求再拉黑 → blocked；仅拉黑方可解除
      const again = friends.request(a.id, b.id)
      expect(friends.block(b.id, a.id).state).toBe('blocked')
      expect(friends.relation(a.id, b.id)).toBe('blocked')
      expect(friends.hasBlockedPair(a.id, b.id)).toBe(true)
      expect(friends.unblock(a.id, b.id)).toBe(false) // 非拉黑方
      expect(friends.unblock(b.id, a.id)).toBe(true)
      expect(friends.relation(a.id, b.id)).toBe('none')
      void again
    } finally {
      env.sessions.close()
      env.db.close()
    }
  })
})

describe('M79-C：好友 HTTP 全链', () => {
  it('发起 → 接受 → 双向好友；inbox 投递与关系广播就位；重复 / 反向并存 / 撤回', async () => {
    const fx = await makeFixture()
    try {
      // A(admin) 按 username 向 bob 发起
      const req = await post(`${fx.base}/api/friends/requests`, fx.cookie(fx.adminId), {
        username: 'bob',
        message: '一起协作',
      })
      expect(req.status).toBe(201)
      expect(fx.delivered).toHaveLength(1)
      expect(fx.delivered[0]).toMatchObject({ userId: fx.bobId, type: 'friend-request', actorId: fx.adminId })
      expect(fx.changed).toContainEqual({ userId: fx.bobId, counterpartId: fx.adminId, action: 'request' })

      // 重复请求 → 409；bob 反向请求 → 409（提示可接受）
      expect((await post(`${fx.base}/api/friends/requests`, fx.cookie(fx.adminId), { userId: fx.bobId })).status).toBe(409)
      expect((await post(`${fx.base}/api/friends/requests`, fx.cookie(fx.bobId), { userId: fx.adminId })).status).toBe(409)

      // bob 视角：incoming 1 条（direction in）
      const requests = (await (await fetch(`${fx.base}/api/friends/requests`, { headers: { cookie: fx.cookie(fx.bobId) } })).json()) as {
        incoming: Array<{ id: string; direction: string; user: { userId: string } }>
        outgoing: unknown[]
      }
      expect(requests.incoming).toHaveLength(1)
      expect(requests.incoming[0]!.direction).toBe('in')
      expect(requests.incoming[0]!.user.userId).toBe(fx.adminId)

      // bob 接受
      const accept = await post(`${fx.base}/api/friends/requests/${requests.incoming[0]!.id}/accept`, fx.cookie(fx.bobId))
      expect(accept.status).toBe(200)
      expect(fx.delivered.some((d) => d.userId === fx.adminId && d.type === 'friend-accepted')).toBe(true)
      expect(fx.changed).toContainEqual({ userId: fx.adminId, counterpartId: fx.bobId, action: 'accepted' })

      // 双向好友列表
      const adminFriends = (await (await fetch(`${fx.base}/api/friends`, { headers: { cookie: fx.cookie(fx.adminId) } })).json()) as {
        friends: Array<{ userId: string }>
      }
      expect(adminFriends.friends.map((f) => f.userId)).toEqual([fx.bobId])

      // 解除 + 广播
      const del = await fetch(`${fx.base}/api/friends/${fx.bobId}`, { method: 'DELETE', headers: { cookie: fx.cookie(fx.adminId) } })
      expect(del.status).toBe(200)
      expect(fx.changed).toContainEqual({ userId: fx.bobId, counterpartId: fx.adminId, action: 'removed' })

      // 再请求 → 拒绝 → 可重发（行删除）；发出方撤回
      const req2 = await post(`${fx.base}/api/friends/requests`, fx.cookie(fx.adminId), { username: 'bob' })
      const req2Body = (await req2.json()) as { request: { id: string } }
      expect((await post(`${fx.base}/api/friends/requests/${req2Body.request.id}/reject`, fx.cookie(fx.bobId))).status).toBe(200)
      const req3 = await post(`${fx.base}/api/friends/requests`, fx.cookie(fx.adminId), { username: 'bob' })
      expect(req3.status).toBe(201)
      const req3Body = (await req3.json()) as { request: { id: string } }
      const withdraw = (await (await post(`${fx.base}/api/friends/requests/${req3Body.request.id}/reject`, fx.cookie(fx.adminId))).json()) as { action: string }
      expect(withdraw.action).toBe('withdrawn')
    } finally {
      await fx.close()
    }
  })

  it('拉黑四面切断（请求 / 搜索双向 / 好友列表）；解除后恢复', async () => {
    const fx = await makeFixture()
    try {
      // 拉黑前双方可互相搜索
      const before = (await (await fetch(`${fx.base}/api/users/search?q=bob`, { headers: { cookie: fx.cookie(fx.staffId) } })).json()) as {
        users: Array<{ userId: string }>
      }
      expect(before.users.map((u) => u.userId)).toContain(fx.bobId)

      // staff 拉黑 bob（隐含解除任何既有关系）
      expect((await post(`${fx.base}/api/friends/${fx.bobId}/block`, fx.cookie(fx.staffId))).status).toBe(200)

      // 请求被拒（被拉黑方不暴露事实）
      const blockedReq = await post(`${fx.base}/api/friends/requests`, fx.cookie(fx.bobId), { userId: fx.staffId })
      expect(blockedReq.status).toBe(400)
      expect(((await blockedReq.json()) as { error: string }).error).toContain('隐私限制')

      // 搜索双向排除
      const staffSearch = (await (await fetch(`${fx.base}/api/users/search?q=bob`, { headers: { cookie: fx.cookie(fx.staffId) } })).json()) as {
        users: unknown[]
      }
      expect(staffSearch.users).toHaveLength(0)
      const bobSearch = (await (await fetch(`${fx.base}/api/users/search?q=staff`, { headers: { cookie: fx.cookie(fx.bobId) } })).json()) as {
        users: unknown[]
      }
      expect(bobSearch.users).toHaveLength(0)

      // 解除拉黑 → 恢复可搜索
      expect((await post(`${fx.base}/api/friends/${fx.bobId}/unblock`, fx.cookie(fx.staffId))).status).toBe(200)
      const after = (await (await fetch(`${fx.base}/api/users/search?q=bob`, { headers: { cookie: fx.cookie(fx.staffId) } })).json()) as {
        users: Array<{ userId: string }>
      }
      expect(after.users.map((u) => u.userId)).toContain(fx.bobId)
    } finally {
      await fx.close()
    }
  })

  it('日限流（friendRequestDailyLimit=2 → 第三发 429）；搜索隐私（searchable=false 仅精确用户名）', async () => {
    const fx = await makeFixture({ friendRequestDailyLimit: 2 })
    try {
      expect((await post(`${fx.base}/api/friends/requests`, fx.cookie(fx.adminId), { username: 'bob' })).status).toBe(201)
      expect((await post(`${fx.base}/api/friends/requests`, fx.cookie(fx.adminId), { username: 'staff' })).status).toBe(201)
      const third = await post(`${fx.base}/api/friends/requests`, fx.cookie(fx.adminId), { username: 'carol' })
      expect(third.status).toBe(429)
      expect(((await third.json()) as { error: string }).error).toContain('上限')

      // carol 关闭可搜索 → 模糊搜索不可见；精确用户名命中
      fx.users.setPrefs(fx.carolId, { searchable: false })
      const fuzzy = (await (await fetch(`${fx.base}/api/users/search?q=car`, { headers: { cookie: fx.cookie(fx.adminId) } })).json()) as {
        users: Array<{ userId: string }>
      }
      expect(fuzzy.users.some((u) => u.userId === fx.carolId)).toBe(false)
      const exact = (await (await fetch(`${fx.base}/api/users/search?q=carol`, { headers: { cookie: fx.cookie(fx.adminId) } })).json()) as {
        users: Array<{ userId: string; relation: string }>
      }
      expect(exact.users.some((u) => u.userId === fx.carolId)).toBe(true)
      // 关系态随行：与 staff 已有 pending-out
      const staffHit = (await (await fetch(`${fx.base}/api/users/search?q=staff`, { headers: { cookie: fx.cookie(fx.adminId) } })).json()) as {
        users: Array<{ userId: string; relation: string }>
      }
      expect(staffHit.users.find((u) => u.userId === fx.staffId)?.relation).toBe('pending-out')
      // 自己不出现在搜索
      const self = (await (await fetch(`${fx.base}/api/users/search?q=admin`, { headers: { cookie: fx.cookie(fx.adminId) } })).json()) as {
        users: unknown[]
      }
      expect(self.users).toHaveLength(0)
    } finally {
      await fx.close()
    }
  })

  it('兼容模式（无账号）：未登录写 401、读空集', async () => {
    const env = makeEnv()
    try {
      const app = express()
      app.use(express.json())
      app.use(
        '/api',
        createFriendsRouter({
          cfg: env.cfg,
          access: env.access,
          auth: env.auth,
          users: env.users,
          friends: new FriendStore(env.db),
        }),
      )
      const server = app.listen(0)
      await new Promise<void>((r) => server.once('listening', r))
      const port = (server.address() as AddressInfo).port
      const base = `http://127.0.0.1:${port}`
      const list = (await (await fetch(`${base}/api/friends`)).json()) as { friends: unknown[] }
      expect(list.friends).toHaveLength(0)
      const write = await fetch(`${base}/api/friends/requests`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'nobody' }),
      })
      expect(write.status).toBe(401) // 无登录态优先拦截
      await new Promise<void>((r) => server.close(() => r()))
    } finally {
      env.sessions.close()
      env.db.close()
    }
  })
})

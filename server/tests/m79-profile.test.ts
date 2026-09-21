/**
 * M79-B 测试：用户画像（存储 / 路由 / 会话投影）。
 *
 * 覆盖：
 * - UserStore.updateProfile：设置 / 清除（null）/ 缺省不动 / avatar JSON round-trip / 坏 JSON 安全降级；
 * - PATCH /api/auth/profile：保存与校验（色值格式 / emoji 单字符 / 头衔长度 / 显示名非空）/ 清除；
 * - 兼容模式（无账号）→ 400 明确提示；
 * - GET /sessions/:id：humanProfiles 随行投影（owner + 成员；humanNames 保留兼容）。
 */
import express from 'express'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { createAuthMiddleware } from '../src/middleware.js'
import { createAuthRouter } from '../src/routes/auth.js'
import { createSessionsRouter } from '../src/routes/sessions.js'
import type { ApiDeps } from '../src/routes/index.js'
import { UserStore } from '../src/store/users.js'
import { makeEnv } from './helpers.js'

describe('M79-B：画像存储（UserStore.updateProfile）', () => {
  it('设置 / 清除 / 缺省不动 / avatar 回读与坏 JSON 降级', () => {
    const env = makeEnv()
    try {
      const users = new UserStore(env.db)
      const u = users.create({ username: 'alice', displayName: 'Alice', passwordHash: 'x', role: 'member' })
      const updated = users.updateProfile(u.id, {
        headline: '产品经理',
        bio: '专注体验',
        avatar: { kind: 'color', value: '#6366f1' },
      })!
      expect(updated.headline).toBe('产品经理')
      expect(updated.bio).toBe('专注体验')
      expect(users.get(u.id)!.avatar).toEqual({ kind: 'color', value: '#6366f1' }) // JSON round-trip

      const cleared = users.updateProfile(u.id, { headline: null, avatar: null })!
      expect(cleared.headline).toBeUndefined()
      expect(cleared.avatar).toBeUndefined()
      expect(cleared.bio).toBe('专注体验') // 缺省项不动

      // 坏 JSON：安全降级为 undefined（不抛错）
      env.db.run("UPDATE users SET avatar = '{bad' WHERE id = ?", u.id)
      expect(users.get(u.id)!.avatar).toBeUndefined()
      // 未知字段名 / 非法 kind 也降级
      env.db.run('UPDATE users SET avatar = ? WHERE id = ?', JSON.stringify({ kind: 'image', value: 'x' }), u.id)
      expect(users.get(u.id)!.avatar).toBeUndefined()
    } finally {
      env.sessions.close()
      env.db.close()
    }
  })
})

describe('M79-B：画像 HTTP（PATCH /api/auth/profile）', () => {
  async function makeHttp(): Promise<{
    env: ReturnType<typeof makeEnv>
    base: string
    cookie: string
    close: () => Promise<void>
  }> {
    const env = makeEnv()
    await env.auth.setup({ username: 'admin', password: 'Str0ngPass!x' })
    const login = await env.auth.login({ username: 'admin', password: 'Str0ngPass!x' })
    const app = express()
    app.use(express.json())
    app.use('/api', createAuthMiddleware(env.cfg, env.auth))
    app.use(
      '/api',
      createAuthRouter({ cfg: env.cfg, auth: env.auth, users: env.users, loginLimiter: (_req, _res, next) => next() }),
    )
    const server = app.listen(0)
    await new Promise<void>((r) => server.once('listening', r))
    const port = (server.address() as AddressInfo).port
    return {
      env,
      base: `http://127.0.0.1:${port}`,
      cookie: `sid=${login.rawToken}`,
      close: async () => {
        await new Promise<void>((r) => server.close(() => r()))
        env.sessions.close()
        env.db.close()
      },
    }
  }

  it('保存画像 → /auth/me 携带；校验矩阵；清除（null）', async () => {
    const h = await makeHttp()
    try {
      const patch = (body: unknown): Promise<globalThis.Response> =>
        fetch(`${h.base}/api/auth/profile`, {
          method: 'PATCH',
          headers: { cookie: h.cookie, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })

      const ok = await patch({
        displayName: '版主',
        headline: '架构师',
        bio: '负责架构与评审',
        avatar: { kind: 'color', value: '#10b981' },
      })
      expect(ok.status).toBe(200)
      const body = (await ok.json()) as { user: { displayName: string; headline: string; avatar: { value: string } } }
      expect(body.user.displayName).toBe('版主')
      expect(body.user.headline).toBe('架构师')
      expect(body.user.avatar.value).toBe('#10b981')

      const me = (await (await fetch(`${h.base}/api/auth/me`, { headers: { cookie: h.cookie } })).json()) as {
        user: { headline?: string }
      }
      expect(me.user.headline).toBe('架构师')

      // 校验：色值格式 / emoji 单字符 / 头衔长度 / 显示名非空
      expect((await patch({ avatar: { kind: 'color', value: 'red' } })).status).toBe(400)
      expect((await patch({ avatar: { kind: 'emoji', value: '🐼🐼🐼' } })).status).toBe(400)
      expect((await patch({ headline: 'x'.repeat(31) })).status).toBe(400)
      expect((await patch({ displayName: '' })).status).toBe(400)

      // emoji 头像合法
      const emoji = (await (await patch({ avatar: { kind: 'emoji', value: '🐼' } })).json()) as {
        user: { avatar: { kind: string; value: string } }
      }
      expect(emoji.user.avatar).toEqual({ kind: 'emoji', value: '🐼' })

      // 清除（null）
      const cleared = (await (await patch({ headline: null, avatar: null })).json()) as {
        user: { headline?: string; avatar?: unknown }
      }
      expect(cleared.user.headline).toBeUndefined()
      expect(cleared.user.avatar).toBeUndefined()
    } finally {
      await h.close()
    }
  })

  it('兼容模式（无账号）：400 明确提示', async () => {
    const env = makeEnv()
    try {
      const app = express()
      app.use(express.json())
      app.use(
        '/api',
        createAuthRouter({ cfg: env.cfg, auth: env.auth, users: env.users, loginLimiter: (_req, _res, next) => next() }),
      )
      const server = app.listen(0)
      await new Promise<void>((r) => server.once('listening', r))
      const port = (server.address() as AddressInfo).port
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/profile`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toContain('兼容模式')
      await new Promise<void>((r) => server.close(() => r()))
    } finally {
      env.sessions.close()
      env.db.close()
    }
  })
})

describe('M79-B：会话详情画像投影（humanProfiles）', () => {
  it('owner 与成员画像随行返回；humanNames 保留兼容', async () => {
    const env = makeEnv()
    try {
      const admin = env.users.create({ username: 'admin', displayName: '管理员', passwordHash: 'x', role: 'admin' })
      const bob = env.users.create({ username: 'bob', displayName: 'Bob', passwordHash: 'x', role: 'member' })
      env.users.updateProfile(admin.id, { headline: '总负责', avatar: { kind: 'emoji', value: '🛠' } })
      env.users.updateProfile(bob.id, { headline: '工程' })
      const session = env.sessions.create(['pm'], '画像投影', { ownerId: admin.id })
      env.members.upsert(session.id, bob.id, 'editor', admin.id)

      const app = express()
      app.use(express.json())
      app.use('/api', createSessionsRouter(env as unknown as ApiDeps))
      const server = app.listen(0)
      await new Promise<void>((r) => server.once('listening', r))
      const port = (server.address() as AddressInfo).port
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${session.id}`)
        expect(res.status).toBe(200)
        const body = (await res.json()) as {
          humanNames: Record<string, string>
          humanProfiles: Record<string, { name: string; headline?: string; avatar?: { value: string } }>
        }
        expect(body.humanNames[admin.id]).toBe('管理员') // 兼容字段保留
        expect(body.humanProfiles[admin.id]!.headline).toBe('总负责')
        expect(body.humanProfiles[admin.id]!.avatar?.value).toBe('🛠')
        expect(body.humanProfiles[bob.id]!.headline).toBe('工程')
        expect(body.humanProfiles[bob.id]!.avatar).toBeUndefined()
      } finally {
        await new Promise<void>((r) => server.close(() => r()))
      }
    } finally {
      env.sessions.close()
      env.db.close()
    }
  })
})

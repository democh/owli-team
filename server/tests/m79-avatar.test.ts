/**
 * M79-Q 测试：真人图片头像（上传 / 安全校验 / 投影 / 清理）。
 *
 * 覆盖：
 * - POST /api/auth/avatar：PNG 上传 201（落盘 + avatar 投影为公开 URL + immutable 读取 200）；
 *   伪造（非图片正文）400；超限 400；空体 400；替换上传删旧文件；PATCH 显式设色块删旧文件；
 * - GET /api/avatars/:file：白名单（非法名 / 穿越 / 不存在 → 404）；
 * - 账号删除级联清理头像文件；兼容模式（无账号）400。
 */
import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { createAuthMiddleware } from '../src/middleware.js'
import { createAuthRouter } from '../src/routes/auth.js'
import { UserStore } from '../src/store/users.js'
import { makeEnv } from './helpers.js'

/** 1×1 透明 PNG（67B；真实魔数，服务端可嗅探） */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
/** 非图片正文（文本伪装） */
const FAKE_IMAGE = Buffer.from('this is not an image, just plain text content', 'utf8')

interface Fixture {
  env: ReturnType<typeof makeEnv>
  base: string
  cookie: string
  adminId: string
  close: () => Promise<void>
}

async function makeHttp(): Promise<Fixture> {
  const env = makeEnv()
  await env.auth.setup({ username: 'admin', password: 'Str0ngPass!x' })
  const login = await env.auth.login({ username: 'admin', password: 'Str0ngPass!x' })
  const app = express()
  app.use('/api/auth/avatar', express.raw({ type: () => true, limit: '4mb' }))
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
    adminId: login.user.id,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()))
      env.sessions.close()
      env.db.close()
    },
  }
}

const upload = (fx: Fixture, body: Buffer, type = 'application/octet-stream'): Promise<globalThis.Response> =>
  fetch(`${fx.base}/api/auth/avatar`, {
    method: 'POST',
    headers: { cookie: fx.cookie, 'content-type': type },
    body: new Uint8Array(body),
  })

const avatarsDir = (fx: Fixture): string => path.join(fx.env.cfg.dataDir, 'avatars')

describe('M79-Q：头像上传（POST /api/auth/avatar）', () => {
  it('PNG 上传落盘 + 投影公开 URL + immutable 读取；替换上传删旧文件', async () => {
    const fx = await makeHttp()
    try {
      const first = await upload(fx, PNG_1PX, 'image/png')
      expect(first.status).toBe(201)
      const firstUser = ((await first.json()) as { user: { avatar?: { kind: string; value: string } } }).user
      expect(firstUser.avatar?.kind).toBe('image')
      expect(firstUser.avatar?.value).toMatch(/^\/api\/avatars\/.+-\d+\.png$/)

      // 落盘验证
      const firstName = firstUser.avatar!.value.split('/').pop()!
      expect(fs.existsSync(path.join(avatarsDir(fx), firstName))).toBe(true)

      // 读取：200 + content-type + immutable 缓存
      const get = await fetch(`${fx.base}${firstUser.avatar!.value}`, { headers: { cookie: fx.cookie } })
      expect(get.status).toBe(200)
      expect(get.headers.get('content-type')).toContain('image/png')
      expect(get.headers.get('cache-control')).toContain('immutable')

      // 替换上传：新 URL（含新时间戳）→ 旧文件被清理
      const second = await upload(fx, PNG_1PX, 'image/png')
      expect(second.status).toBe(201)
      const secondUser = ((await second.json()) as { user: { avatar?: { value: string } } }).user
      expect(secondUser.avatar?.value).not.toBe(firstUser.avatar!.value)
      expect(fs.existsSync(path.join(avatarsDir(fx), firstName))).toBe(false)
    } finally {
      await fx.close()
    }
  })

  it('伪造图片 400；超限 400；空体 400（服务端按魔数重算，不信 content-type）', async () => {
    const fx = await makeHttp()
    try {
      // 文本伪装 image/png → 魔数嗅探拒绝
      const fake = await upload(fx, FAKE_IMAGE, 'image/png')
      expect(fake.status).toBe(400)
      expect(((await fake.json()) as { error: string }).error).toContain('仅支持 PNG / JPEG / WebP')

      // 超限（2MB+；合法 PNG 头 + 填充）
      const oversized = Buffer.concat([PNG_1PX, Buffer.alloc(2 * 1024 * 1024, 0)])
      const tooBig = await upload(fx, oversized)
      expect(tooBig.status).toBe(400)
      expect(((await tooBig.json()) as { error: string }).error).toContain('过大')

      // 空体
      const empty = await upload(fx, Buffer.alloc(0))
      expect(empty.status).toBe(400)
      expect(((await empty.json()) as { error: string }).error).toContain('请求体为空')
    } finally {
      await fx.close()
    }
  })

  it('PATCH 显式设置色块 → 清理图片文件；GET 白名单（非法名 / 穿越 → 404）', async () => {
    const fx = await makeHttp()
    try {
      const up = await upload(fx, PNG_1PX)
      const user = ((await up.json()) as { user: { avatar: { value: string } } }).user
      const fileName = user.avatar.value.split('/').pop()!
      expect(fs.existsSync(path.join(avatarsDir(fx), fileName))).toBe(true)

      // 切回色块 → 图片文件清理
      const patch = await fetch(`${fx.base}/api/auth/profile`, {
        method: 'PATCH',
        headers: { cookie: fx.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ avatar: { kind: 'color', value: '#6366f1' } }),
      })
      expect(patch.status).toBe(200)
      expect(((await patch.json()) as { user: { avatar: { kind: string } } }).user.avatar.kind).toBe('color')
      expect(fs.existsSync(path.join(avatarsDir(fx), fileName))).toBe(false)

      // 读取白名单：不存在合法名 404；穿越形态 404
      expect((await fetch(`${fx.base}/api/avatars/u_x-1.png`, { headers: { cookie: fx.cookie } })).status).toBe(404)
      expect(
        (await fetch(`${fx.base}/api/avatars/${encodeURIComponent('../app.db')}`, { headers: { cookie: fx.cookie } }))
          .status,
      ).toBe(404)
    } finally {
      await fx.close()
    }
  })

  it('账号删除级联清理头像文件；兼容模式（无账号）→ 400', async () => {
    const fx = await makeHttp()
    try {
      const carol = await fx.env.auth.createUser({ username: 'carol', role: 'member' })
      const login = await fx.env.auth.login({ username: 'carol', password: carol.initialPassword! })
      // 首登强制改密闸门（M57）：改密后方可访问非白名单端点
      await fx.env.auth.changePassword({
        userId: carol.user.id,
        currentPassword: carol.initialPassword!,
        newPassword: 'Str0ngPass!x2',
        keepSessionToken: login.rawToken,
      })
      const up = await fetch(`${fx.base}/api/auth/avatar`, {
        method: 'POST',
        headers: { cookie: `sid=${login.rawToken}` },
        body: new Uint8Array(PNG_1PX),
      })
      expect(up.status).toBe(201)
      const fileName = (((await up.json()) as { user: { avatar: { value: string } } }).user.avatar.value.split('/').pop())!
      expect(fs.existsSync(path.join(avatarsDir(fx), fileName))).toBe(true)

      fx.env.auth.deleteUser(carol.user.id)
      expect(fs.existsSync(path.join(avatarsDir(fx), fileName))).toBe(false)
    } finally {
      await fx.close()
    }

    // 兼容模式：无账号 → 400（鉴权放行、无 user）
    const bare = makeEnv()
    try {
      const users = new UserStore(bare.db)
      void users
      const app = express()
      app.use('/api/auth/avatar', express.raw({ type: () => true, limit: '4mb' }))
      app.use(express.json())
      app.use('/api', createAuthMiddleware(bare.cfg, bare.auth))
      app.use(
        '/api',
        createAuthRouter({ cfg: bare.cfg, auth: bare.auth, users: bare.users, loginLimiter: (_req, _res, next) => next() }),
      )
      const server = app.listen(0)
      await new Promise<void>((r) => server.once('listening', r))
      const port = (server.address() as AddressInfo).port
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/avatar`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: new Uint8Array(PNG_1PX),
      })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toContain('单用户兼容模式')
      await new Promise<void>((r) => server.close(() => r()))
    } finally {
      bare.sessions.close()
      bare.db.close()
    }
  })
})

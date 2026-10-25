/**
 * 认证接口（M57 多用户 P1）：状态 / 首启 / 登录 / 登出 / 当前用户 / 改密 / 个人偏好。
 *
 * 安全要点：
 * - 登录走 IP 限流（createLoginLimiter）+ 账号锁定（AuthService，落库）；
 * - 会话令牌只经 HttpOnly cookie（sid）下发；`AUTH_COOKIE_SECURE=true` 时加 Secure（nginx HTTPS 网关后必开）；
 * - 失败文案统一（用户名错误与密码错误不可区分），首登强制改密由 mustChangePassword 透出。
 */
import fs from 'node:fs'
import path from 'node:path'
import { Router } from 'express'
import type { Request, RequestHandler, Response } from 'express'
import { z } from 'zod'
import { AVATAR_MAX_BYTES, avatarFileWellFormed, imagesDirOf, isImageAvatar, mimeOfAvatarFile, removeAvatarFile, saveAvatarFile, sniffImage } from '../auth/avatar.js'
import type { AppConfig } from '../config.js'
import type { AuthService } from '../auth/service.js'
import type { UserStore } from '../store/users.js'
import { toUserInfo } from '../store/users.js'
import { AUTH_COOKIE, SESSION_COOKIE } from '../middleware.js'
import { firstIssue } from './schemas.js'

const setupSchema = z.object({
  username: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9_.-]{3,32}$/, '用户名需为 3–32 位字母 / 数字 / _. -'),
  password: z.string().min(10, '密码至少 10 位').max(200),
  displayName: z.string().trim().max(60).optional(),
})

const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(200),
})

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(10, '密码至少 10 位').max(200),
})

const prefsSchema = z
  .object({
    notifyPollMs: z.number().int().min(500).max(60_000).optional(),
    // M79：隐私（可被搜索 / 接收好友申请）——M79 期间由好友路由直接落库，此处补齐白名单
    searchable: z.boolean().optional(),
    allowFriendRequests: z.boolean().optional(),
    // M80-C：向他人展示我的已读状态（对等原则；缺省 = true）
    showReadReceipts: z.boolean().optional(),
  })
  .strict()

/** M79-B：画像维护（本人；null = 清除该字段） */
const profileSchema = z.object({
  displayName: z.string().trim().min(1, '显示名不能为空').max(60).optional(),
  headline: z.string().trim().max(30, '头衔最长 30 字').nullable().optional(),
  bio: z.string().trim().max(120, '简介最长 120 字').nullable().optional(),
  avatar: z
    .object({ kind: z.enum(['color', 'emoji']), value: z.string().trim().min(1).max(8) })
    .nullable()
    .optional(),
})

export interface AuthRouterDeps {
  cfg: AppConfig
  auth: AuthService
  users: UserStore
  loginLimiter: RequestHandler
  /** M79-Y：资料（昵称 / 头像）变更回调（装配层向好友广播 friends-changed；缺省 = 不广播） */
  onProfileChanged?: (userId: string) => void
}

/** 会话 cookie 写入（滑动 TTL 由服务端令牌控制；cookie Max-Age 仅浏览器保留期） */
function setSessionCookie(cfg: AppConfig, res: Response, rawToken: string): void {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(rawToken)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${cfg.sessionTtlDays * 24 * 3600}`,
  ]
  if (cfg.authCookieSecure) parts.push('Secure')
  res.append('Set-Cookie', parts.join('; '))
}

function clearSessionCookie(cfg: AppConfig, res: Response): void {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']
  if (cfg.authCookieSecure) parts.push('Secure')
  res.append('Set-Cookie', parts.join('; '))
}

/**
 * legacy 授权 cookie 清除（AUTH_TOKEN 通道）。
 * 登出必须一并清除：否则 `/api/auth/me` 仍会经该 cookie 解析为最早创建的管理员，
 * 客户端 reload 后直接回到应用内，表现为「退出登录无效」。
 */
function clearLegacyCookie(cfg: AppConfig, res: Response): void {
  const parts = [`${AUTH_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']
  if (cfg.authCookieSecure) parts.push('Secure')
  res.append('Set-Cookie', parts.join('; '))
}

function parseRawCookie(cookieHeader: string | undefined, name: string): string {
  for (const part of (cookieHeader ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return ''
}

/** 当前请求的会话令牌（sid cookie 或 Bearer sa_*；登出 / 改密保留当前会话用） */
function currentSessionToken(req: Request): string {
  const cookieToken = parseRawCookie(req.headers.cookie, SESSION_COOKIE)
  if (cookieToken) return cookieToken
  const header = req.headers.authorization ?? ''
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : ''
  return bearer.startsWith('sa_') ? bearer : ''
}

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next)
  }

export function createAuthRouter(deps: AuthRouterDeps): Router {
  const router = Router()
  const { cfg, auth } = deps

  /** 启动路由决策（公开）：needsSetup 渲染首启向导；未登录渲染登录页 */
  router.get('/auth/status', (_req, res) => {
    res.json(auth.status())
  })

  /** 首启：创建首个管理员（仅无账号时可用；成功后自动登录并回填存量归属） */
  router.post(
    '/auth/setup',
    wrap(async (req, res) => {
      const parsed = setupSchema.safeParse(req.body ?? {})
      if (!parsed.success) {
        res.status(400).json({ error: firstIssue(parsed.error) })
        return
      }
      const result = await auth.setup({
        username: parsed.data.username,
        password: parsed.data.password,
        displayName: parsed.data.displayName,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      })
      setSessionCookie(cfg, res, result.rawToken)
      res.status(201).json({ user: result.user, mustChangePassword: false })
    }),
  )

  /** 登录（IP 限流 + 账号锁定）：成功签发 sid cookie */
  router.post('/auth/login', deps.loginLimiter, wrap(async (req, res) => {
    const parsed = loginSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: firstIssue(parsed.error) })
      return
    }
    const result = await auth.login({
      username: parsed.data.username,
      password: parsed.data.password,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    })
    setSessionCookie(cfg, res, result.rawToken)
    res.json({ user: result.user, mustChangePassword: result.mustChangePassword })
  }))

  /** 登出：撤销当前会话令牌并清 cookie（sid + legacy auth_token；幂等） */
  router.post('/auth/logout', (req, res) => {
    auth.logout(currentSessionToken(req))
    clearSessionCookie(cfg, res)
    clearLegacyCookie(cfg, res)
    res.json({ ok: true })
  })

  /** 当前用户（客户端启动 / 权限显隐依据；单用户兼容模式返回合成管理员） */
  router.get('/auth/me', (req, res) => {
    const user = (req as Request & { user?: { id: string; username: string; displayName: string; role: string; mustChangePassword?: boolean; legacy?: boolean } }).user
    const status = auth.status()
    if (!user) {
      // 单用户兼容模式（无账号且本机开放）：合成管理员，与旧版行为一致
      res.json({
        user: { id: '', username: 'local', displayName: '本地管理员', role: 'admin', legacy: true },
        isAdmin: true,
        ...status,
      })
      return
    }
    res.json({ user, isAdmin: user.role === 'admin', ...status })
  })

  /** 自助改密：校验原密码 → 更新 → 吊销其它会话（当前会话保留） */
  router.post('/auth/password', wrap(async (req, res) => {
    const user = (req as Request & { user?: { id: string } }).user
    if (!user?.id) {
      res.status(400).json({ error: '单用户兼容模式无需修改密码；请在完成管理员初始化后使用账号体系' })
      return
    }
    const parsed = changePasswordSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: firstIssue(parsed.error) })
      return
    }
    await auth.changePassword({
      userId: user.id,
      currentPassword: parsed.data.currentPassword,
      newPassword: parsed.data.newPassword,
      keepSessionToken: currentSessionToken(req),
    })
    res.json({ ok: true })
  }))

  /** 个人偏好（user_prefs；与系统级 settings.json 分离） */
  router.get('/auth/preferences', (req, res) => {
    const user = (req as Request & { user?: { id: string } }).user
    if (!user?.id) {
      res.json({ preferences: {} })
      return
    }
    res.json({ preferences: deps.users.getPrefs(user.id) })
  })

  router.put('/auth/preferences', (req, res) => {
    const user = (req as Request & { user?: { id: string } }).user
    if (!user?.id) {
      res.status(400).json({ error: '单用户兼容模式无个人偏好存储；请先完成管理员初始化' })
      return
    }
    const parsed = prefsSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: firstIssue(parsed.error) })
      return
    }
    res.json({ preferences: deps.users.setPrefs(user.id, parsed.data) })
  })

  /** M79-B：画像维护（本人自助：显示名 / 头衔 / 简介 / 头像；null = 清除） */
  router.patch('/auth/profile', (req, res) => {
    const user = (req as Request & { user?: { id: string } }).user
    if (!user?.id) {
      res.status(400).json({ error: '单用户兼容模式无画像存储；请先完成管理员初始化' })
      return
    }
    const parsed = profileSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: firstIssue(parsed.error) })
      return
    }
    const avatar = parsed.data.avatar
    if (avatar?.kind === 'color' && !/^#[0-9a-fA-F]{6}$/.test(avatar.value)) {
      res.status(400).json({ error: '头像色需为 #rrggbb 格式' })
      return
    }
    if (avatar?.kind === 'emoji' && [...avatar.value].length > 2) {
      res.status(400).json({ error: '头像 emoji 仅支持单个字符' })
      return
    }
    try {
      // M79-Q：显式设置头像（color / emoji / null）时，清理遗留的图片头像文件
      const previous = deps.users.get(user.id)
      const updated = deps.users.updateProfile(user.id, parsed.data)
      if (parsed.data.avatar !== undefined && isImageAvatar(previous?.avatar)) {
        removeAvatarFile(deps.cfg.dataDir, previous.avatar.value)
      }
      // M79-Y：资料变更 → 好友侧列表实时更新（头像 / 昵称）
      deps.onProfileChanged?.(user.id)
      res.json({ user: updated ? toUserInfo(updated) : undefined })
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  /**
   * M79-Q：头像图片上传（raw 二进制；客户端已裁 256²）。
   * 安全：服务端以魔数重算格式（仅 PNG / JPEG / WebP，拒绝 SVG）——不信 content-type；文件名服务端生成。
   */
  router.post('/auth/avatar', (req, res) => {
    const user = (req as Request & { user?: { id: string } }).user
    if (!user?.id) {
      res.status(400).json({ error: '单用户兼容模式无个人头像存储；请先完成管理员初始化' })
      return
    }
    const body: unknown = req.body
    if (!Buffer.isBuffer(body) || body.length === 0) {
      res.status(400).json({ error: '请求体为空：请以 raw 二进制上传图片内容' })
      return
    }
    if (body.length > AVATAR_MAX_BYTES) {
      res.status(400).json({ error: `头像图片过大（上限 ${Math.round(AVATAR_MAX_BYTES / 1024 / 1024)}MB）` })
      return
    }
    const sniffed = sniffImage(body)
    if (!sniffed) {
      res.status(400).json({ error: '仅支持 PNG / JPEG / WebP 图片' })
      return
    }
    try {
      const previous = deps.users.get(user.id)
      const fileName = saveAvatarFile(deps.cfg.dataDir, user.id, body, sniffed.ext)
      const updated = deps.users.updateProfile(user.id, { avatar: { kind: 'image', value: fileName } })
      // M79-Y：头像变更 → 好友侧列表实时更新
      if (isImageAvatar(previous?.avatar)) removeAvatarFile(deps.cfg.dataDir, previous.avatar.value)
      deps.onProfileChanged?.(user.id)
      res.status(201).json({ user: updated ? toUserInfo(updated) : undefined })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  /**
   * M79-Q：头像文件读取（已鉴权域内——多用户模式需登录；文件名白名单防穿越）。
   * 文件名含时间戳 → 内容不变，`immutable` 长缓存；换头像即换名，天然击穿。
   */
  router.get('/avatars/:file', (req, res) => {
    const name = req.params.file ?? ''
    if (!avatarFileWellFormed(name)) {
      res.status(404).json({ error: '头像不存在' })
      return
    }
    const full = path.resolve(imagesDirOf(deps.cfg.dataDir), name)
    if (!fs.existsSync(full)) {
      res.status(404).json({ error: '头像不存在' })
      return
    }
    res.setHeader('Content-Type', mimeOfAvatarFile(name))
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
    res.sendFile(full)
  })

  return router
}

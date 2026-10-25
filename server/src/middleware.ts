/**
 * 安全中间件（M7 鉴权 / M57 多用户扩展）：认证解析、CORS 收窄、Origin 校验、限流与管理面守卫。
 *
 * 认证模型（M57）：
 * - 主通道：`sid` cookie（登录会话令牌，服务端可撤销）；CLI 用 `Authorization: Bearer mk_*`（API Key）；
 * - 兼容通道：legacy `AUTH_TOKEN`（Bearer 或 cookie `auth_token`）→ 映射最早管理员；
 * - 单用户兼容模式（users 为空且未配置 AUTH_TOKEN）：直接放行，行为与旧版一致；
 * - 公开路由白名单：/auth/status、/auth/setup、/auth/login（其余 /api 一律需登录态）。
 *
 * 安全基线（团队部署）：
 * - 登录双维度防爆破：IP 限流（createLoginLimiter）+ 账号锁定（AuthService，落库）；
 * - 非 GET 请求校验 Origin（SameSite=Lax 之外的第二道 CSRF 防线）；
 * - 消息接口按用户维度限流（MESSAGE_RATE_LIMIT）。
 */
import crypto from 'node:crypto'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import cors from 'cors'
import type { AppConfig } from './config.js'
import type { AuthService, AuthUser } from './auth/service.js'

/** legacy 鉴权 cookie 名（AUTH_TOKEN 通道） */
export const AUTH_COOKIE = 'auth_token'
/** M57：登录会话 cookie 名 */
export const SESSION_COOKIE = 'sid'

/** 携带认证上下文的请求（各路由经此读取 req.user） */
export interface AuthedRequest extends Request {
  user?: AuthUser
}

/** 公开路由白名单（挂在 /api 之下；前缀匹配） */
const PUBLIC_PATHS = ['/auth/status', '/auth/setup', '/auth/login']

/** 首登强制改密期间仍可访问的自救接口（其余 /api 一律 403，防初始密码长期有效） */
const PASSWORD_CHANGE_ALLOW = ['/health', '/auth/me', '/auth/password', '/auth/logout', '/auth/preferences']

export function parseCookie(cookie: string, name: string): string {
  for (const part of cookie.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return ''
}

/** 恒定时间字符串比较（防时序侧信道） */
export function safeEqual(a: string, b: string): boolean {
  if (!a || !b) return false
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return crypto.timingSafeEqual(left, right)
}

/**
 * 解析登录态（HTTP 与 WS 握手共用）：
 * 1) sid cookie → 登录会话；2) Bearer：mk_* API Key / legacy AUTH_TOKEN / sa_* 会话令牌；
 * 3) ?token= 查询参数（WS 握手通道）与 legacy cookie。
 */
export function resolveUserFromHeaders(
  auth: AuthService,
  cfg: AppConfig,
  headers: { cookie?: string; authorization?: string },
  urlToken = '',
): AuthUser | undefined {
  const cookie = headers.cookie ?? ''
  const sessionCookie = parseCookie(cookie, SESSION_COOKIE)
  if (sessionCookie) {
    const user = auth.verifySessionToken(sessionCookie)
    if (user) return user
  }
  const header = headers.authorization ?? ''
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (bearer) {
    if (bearer.startsWith('mk_')) {
      const user = auth.verifyApiKey(bearer)
      if (user) return user
    } else {
      const legacy = auth.verifyLegacyToken(bearer)
      if (legacy) return legacy
      const user = auth.verifySessionToken(bearer)
      if (user) return user
    }
  }
  if (urlToken) {
    const legacy = auth.verifyLegacyToken(urlToken)
    if (legacy) return legacy
  }
  const legacyCookie = parseCookie(cookie, AUTH_COOKIE)
  if (legacyCookie) {
    const legacy = auth.verifyLegacyToken(legacyCookie)
    if (legacy) return legacy
  }
  return undefined
}

/** 登录态解析中间件（挂载于 /api；公开路由白名单直接放行） */
export function createAuthMiddleware(cfg: AppConfig, auth: AuthService): RequestHandler {
  return (req, res, next) => {
    const path = req.path ?? ''
    if (PUBLIC_PATHS.some((p) => path === p || path.startsWith(`${p}/`))) return next()
    const authed = req as AuthedRequest
    const user = resolveUserFromHeaders(auth, cfg, req.headers)
    if (user) {
      // M57：管理员下发初始密码后，未改密前仅开放自救接口（客户端首登强制改密页配套）
      if (
        user.mustChangePassword &&
        !PASSWORD_CHANGE_ALLOW.some((p) => path === p || path.startsWith(`${p}/`))
      ) {
        res.status(403).json({ error: '首次登录需先修改密码：请调用 POST /api/auth/password 完成改密后再使用其他功能' })
        return
      }
      authed.user = user
      return next()
    }
    // 单用户兼容模式（无账号且未配置 AUTH_TOKEN）：本机开放，行为与旧版一致
    if (!auth.multiUser && !cfg.authToken) return next()
    res.status(401).json({
      error: auth.multiUser
        ? '未登录或登录已失效：请登录后重试'
        : '未授权：浏览器请访问 http://<主机>:<端口>/?token=<AUTH_TOKEN> 完成授权（种 cookie）；CLI 请携带 Authorization: Bearer <AUTH_TOKEN>',
    })
  }
}

/**
 * 浏览器 legacy 授权入口（M10，兼容期保留）：
 * `GET /?token=<AUTH_TOKEN>` → 校验通过后种 HttpOnly cookie 并 302 跳回 `/`。
 * M57 起推荐账号登录；本通道仅在配置了 AUTH_TOKEN 时生效。
 */
export function createTokenEntryMiddleware(cfg: AppConfig): RequestHandler {
  return (req, res, next) => {
    if (!cfg.authToken) return next()
    const token = typeof req.query.token === 'string' ? req.query.token : ''
    if (!token) return next()
    if (!safeEqual(token, cfg.authToken)) {
      res.status(401).send('AUTH_TOKEN 不正确：请使用 http://<主机>:<端口>/?token=<AUTH_TOKEN> 访问')
      return
    }
    res.setHeader(
      'Set-Cookie',
      `${AUTH_COOKIE}=${encodeURIComponent(cfg.authToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}`,
    )
    res.redirect(302, '/')
  }
}

/** 本机来源（localhost / 127.0.0.1 / [::1]，任意端口；http / https 均可） */
const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/

function isLocalOrigin(origin: string): boolean {
  return LOCAL_ORIGIN_RE.test(origin)
}

/** CORS 收窄：白名单优先；未配置时仅本机来源 + 无 Origin（本地默认安全） */
export function createCorsOptions(cfg: AppConfig): cors.CorsOptions {
  return {
    origin(origin, callback) {
      if (!origin) return callback(null, true)
      if (cfg.allowedOrigins.length > 0) return callback(null, cfg.allowedOrigins.includes(origin))
      return callback(null, isLocalOrigin(origin))
    },
  }
}

/**
 * Origin 判定：同源始终放行（Host 与 Origin 主机一致，兼容 nginx 反代域名）；
 * 跨域依次回退白名单（已配置）→ 本机来源（未配置白名单时，与 CORS 口径一致）。
 */
function originAllowed(cfg: AppConfig, origin: string, host: string | undefined): boolean {
  try {
    if (new URL(origin).host === host) return true
  } catch {
    return false
  }
  if (cfg.allowedOrigins.length > 0) return cfg.allowedOrigins.includes(origin)
  // 开发模式：Vite 代理（changeOrigin 改写 Host 为 8787）下浏览器 Origin 仍为 5173 → 按本机来源放行
  return isLocalOrigin(origin)
}

/**
 * 非 GET 请求的 Origin 校验（CSRF 第二道防线；无 Origin 的 CLI / 测试请求放行）。
 * 与 SameSite=Lax 组合：跨站页面发起的写请求无法携带 cookie，且 Origin 不一致会被拒绝。
 */
export function createOriginGuard(cfg: AppConfig): RequestHandler {
  return (req, res, next) => {
    const method = req.method.toUpperCase()
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next()
    const origin = req.headers.origin
    if (!origin) return next()
    if (originAllowed(cfg, origin, req.headers.host)) return next()
    res.status(403).json({ error: `请求来源不被允许：${origin}（如需跨域访问请配置 ALLOWED_ORIGINS）` })
  }
}

/** 管理面守卫（连接 / MCP / 资产控制台 / 用户管理 / 审计 / 指标 / 系统设置写）：admin 或单用户兼容模式 */
export function createRequireAdmin(auth: AuthService): RequestHandler {
  return (req, res, next) => {
    if (!auth.multiUser) return next()
    const user = (req as AuthedRequest).user
    if (!user) return res.status(401).json({ error: '未登录或登录已失效：请登录后重试' })
    if (user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' })
    next()
  }
}

/** 消息接口限流（M57：按用户维度；未登录 / 兼容模式回退 IP（IPv6 按子网归一，见 ipKeyGenerator）；每分钟上限） */
export function createMessageLimiter(cfg: AppConfig): RequestHandler {
  return rateLimit({
    windowMs: 60_000,
    limit: cfg.messageRateLimit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req: Request) => {
      const user = (req as AuthedRequest).user
      return user?.id || ipKeyGenerator(req.ip ?? '')
    },
    message: { error: `发送过于频繁（上限 ${cfg.messageRateLimit} 条/分钟），请稍后再试` },
  })
}

/** 登录接口 IP 限流（每 IP 每分钟上限；账号维度锁定见 AuthService） */
export function createLoginLimiter(cfg: AppConfig): RequestHandler {
  return rateLimit({
    windowMs: 60_000,
    limit: cfg.loginRateLimit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: `登录尝试过于频繁（上限 ${cfg.loginRateLimit} 次/分钟），请稍后再试` },
  })
}

/**
 * 上传通道限流（IP 维度；上传路由在登录态解析之前，拿不到 req.user）。
 * 默认 120 次/分钟：正常批量上传绰绰有余，同时封住「反复发 200MB 请求」的磁盘/内存耗尽路径。
 */
export function createUploadLimiter(): RequestHandler {
  return rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: '上传过于频繁（上限 120 次/分钟），请稍后再试' },
  })
}

/** 统一 404/401 语义的守卫包装（Express 同步 next(err) 语义） */
export function guard(handler: (req: Request, res: Response) => void): RequestHandler {
  return (req, res, next: NextFunction) => {
    try {
      handler(req, res)
      next()
    } catch (err) {
      next(err)
    }
  }
}

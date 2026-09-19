/**
 * 安全中间件（M7）：鉴权、CORS 收窄、消息接口限流。
 *
 * - 鉴权：配置了 AUTH_TOKEN 即校验（BIND_ALL=true 时 config 层强制配置）；
 *   支持 `Authorization: Bearer <token>` 与 cookie `auth_token=<token>`；恒定时间比较；
 * - 浏览器入口（M10/Docker）：`GET /?token=<AUTH_TOKEN>` 种 cookie 后跳回 /，后续请求自动携带；
 * - CORS：ALLOWED_ORIGINS 白名单；未配置时仅允许本机来源（含任意端口）与无 Origin 请求（CLI / 测试）；
 * - 限流：POST /api/sessions/:id/messages 每分钟 MESSAGE_RATE_LIMIT 次（默认 30）。
 */
import crypto from 'node:crypto'
import type { RequestHandler } from 'express'
import cors from 'cors'
import rateLimit from 'express-rate-limit'
import type { AppConfig } from './config.js'

/** 鉴权 cookie 名（前端 fetch 与 WS 握手均自动携带） */
export const AUTH_COOKIE = 'auth_token'

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

/** AUTH_TOKEN 校验中间件（未配置 token 时放行：仅本机监听场景） */
export function createAuthMiddleware(cfg: AppConfig): RequestHandler {
  return (req, res, next) => {
    if (!cfg.authToken) return next()
    const header = req.headers.authorization ?? ''
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : ''
    const cookieToken = parseCookie(req.headers.cookie ?? '', AUTH_COOKIE)
    if (safeEqual(bearer, cfg.authToken) || safeEqual(cookieToken, cfg.authToken)) return next()
    res.status(401).json({
      error:
        '未授权：浏览器请访问 http://<主机>:<端口>/?token=<AUTH_TOKEN> 完成授权（种 cookie）；' +
        'CLI 请携带 Authorization: Bearer <AUTH_TOKEN>',
    })
  }
}

/**
 * 浏览器授权入口（M10，配合 Docker/局域网部署）：
 * `GET /?token=<AUTH_TOKEN>` → 校验通过后种 HttpOnly cookie 并 302 跳回 `/`；
 * 之后页面内 fetch（同源默认带 cookie）与 WS 握手均自动通过鉴权，无需在 URL 里反复携带 token。
 * 未配置 AUTH_TOKEN 或未携带 token 查询参数时直接放行到后续路由。
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

/** CORS 收窄：白名单优先；未配置时仅本机来源 + 无 Origin（本地默认安全） */
export function createCorsOptions(cfg: AppConfig): cors.CorsOptions {
  return {
    origin(origin, callback) {
      if (!origin) return callback(null, true)
      if (cfg.allowedOrigins.length > 0) return callback(null, cfg.allowedOrigins.includes(origin))
      const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)
      return callback(null, isLocal)
    },
  }
}

/** 消息接口限流（每个 IP 每分钟上限；429 语义） */
export function createMessageLimiter(cfg: AppConfig): RequestHandler {
  return rateLimit({
    windowMs: 60_000,
    limit: cfg.messageRateLimit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: `发送过于频繁（上限 ${cfg.messageRateLimit} 条/分钟），请稍后再试` },
  })
}

/**
 * M57 P2：会话 / 运行访问守卫（从 routes/index.ts 聚合守卫抽离，可被测试直接挂载）。
 *
 * 规则：
 * - 读取（GET / HEAD / OPTIONS）= owner ∪ 共享成员；无权限一律 404（不泄漏存在性）；
 * - 写入（其余方法）= owner / editor；viewer → 403；
 * - 例外：`POST /sessions/:id/leave`（自助退出共享）允许 viewer 执行；
 * - 单用户兼容模式（无账号体系）全部放行（行为与旧版一致）。
 */
import type { Request, RequestHandler } from 'express'
import { HttpError } from '../util/http-error.js'
import type { AccessService } from './access.js'
import type { AuthUser } from './service.js'

interface GuardRequest extends Request {
  user?: AuthUser
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** 会话子路由守卫（挂载于 `/sessions/:id` 及其全部子路径之前） */
export function createSessionAccessGuard(access: AccessService): RequestHandler {
  return (req, _res, next) => {
    try {
      const user = (req as GuardRequest).user
      const session = access.assertSession(user, req.params.id)
      const writing = !READ_METHODS.has(req.method.toUpperCase())
      // /leave：viewer 亦可自助退出（唯一写例外）
      if (writing && !req.path.endsWith('/leave') && !access.canWriteSession(user, session.id)) {
        throw new HttpError(403, '当前为只读共享（viewer）：无写权限')
      }
      next()
    } catch (err) {
      next(err)
    }
  }
}

/**
 * 运行守卫的访问断言（routes/index.ts 的 `/runs/:runId` 守卫调用）：
 * run → session 解析后按方法施加读 / 写校验（无权限 → 404 不泄漏）。
 */
export function assertRunAccess(
  access: AccessService,
  user: AuthUser | undefined,
  sessionId: string | undefined,
  method: string,
): void {
  if (!sessionId || !access.multiUser) return
  if (!access.canAccessSession(user, sessionId)) throw new HttpError(404, '运行不存在或已结束')
  if (!READ_METHODS.has(method.toUpperCase()) && !access.canWriteSession(user, sessionId)) {
    throw new HttpError(403, '当前为只读共享（viewer）：无操作权限')
  }
}

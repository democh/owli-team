/**
 * HTTP 语义错误（M57 多用户）：守卫 / 服务层抛出，由统一错误中间件映射为状态码。
 *
 * 约定：
 * - 跨用户访问资源一律 404（不泄漏存在性）；
 * - 角色越权（member 访问 admin 面）用 403（资源本身可见，只是无权限）；
 * - 鉴权缺失（未登录 / 会话失效）用 401。
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export const notFound = (message = '资源不存在'): HttpError => new HttpError(404, message)
export const forbidden = (message = '无权访问'): HttpError => new HttpError(403, message)
export const unauthorized = (message = '未登录或登录已失效'): HttpError => new HttpError(401, message)

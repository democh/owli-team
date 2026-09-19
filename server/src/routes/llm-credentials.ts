/**
 * M57 P3：用户 LLM 凭据（BYOK）自助接口。
 *
 * - GET    /api/auth/llm-credentials → { status }（绝不含密钥；兼容模式 configured=false）；
 * - PUT    → 保存 / 覆盖（apiKey 必填 ≥8；baseUrl / model 留空 = 系统默认）；审计 auth.llm-credential-set；
 * - DELETE → 清除（恢复系统默认）；审计 auth.llm-credential-clear；
 * 变更后经 onChange 失效 BYOK provider 缓存（下次调用按新凭据重建）。
 */
import { Router } from 'express'
import type { Request } from 'express'
import { z } from 'zod'
import type { AuthUser } from '../auth/service.js'
import type { AuditStore } from '../store/audit.js'
import type { LlmCredentialStore } from '../store/llm-credentials.js'
import { firstIssue } from './schemas.js'

const putSchema = z.object({
  apiKey: z.string().trim().min(8, 'API Key 至少 8 位').max(512),
  baseUrl: z.string().trim().max(300).optional(),
  model: z.string().trim().max(120).optional(),
})

export interface LlmCredsRouterDeps {
  /** 多用户模式判定（精确复用 AccessService.multiUser；兼容模式 PUT/DELETE 400） */
  multiUser: () => boolean
  credentials: LlmCredentialStore
  audit?: AuditStore
  /** 凭据变更回调（失效 BYOK provider 缓存；测试可缺省） */
  onChange?: (userId: string) => void
}

export function createLlmCredsRouter(deps: LlmCredsRouterDeps): Router {
  const router = Router()
  const userOf = (req: Request): AuthUser | undefined => (req as Request & { user?: AuthUser }).user
  const actorOf = (req: Request): { userId?: string; ip?: string } => ({ userId: userOf(req)?.id, ip: req.ip })

  router.get('/auth/llm-credentials', (req, res) => {
    const user = userOf(req)
    if (!user) return res.json({ status: { configured: false } })
    res.json({ status: deps.credentials.status(user.id) })
  })

  router.put('/auth/llm-credentials', (req, res) => {
    if (!deps.multiUser()) {
      return res.status(400).json({ error: '多用户未启用：BYOK 需先完成管理员设置' })
    }
    const user = userOf(req)
    if (!user) return res.status(401).json({ error: '未登录或登录已失效：请登录后重试' })
    const parsed = putSchema.safeParse(req.body ?? {})
    if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) })
    const baseUrl = parsed.data.baseUrl?.trim()
    if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
      return res.status(400).json({ error: 'baseUrl 需为 http(s) 开头的合法地址' })
    }
    const status = deps.credentials.upsert(user.id, {
      apiKey: parsed.data.apiKey,
      baseUrl: baseUrl || undefined,
      model: parsed.data.model?.trim() || undefined,
    })
    deps.audit?.record({
      actor: 'user',
      ...actorOf(req),
      action: 'auth.llm-credential-set',
      resourceType: 'user',
      resourceId: user.id,
      detail: { baseUrl: status.baseUrl, model: status.model },
    })
    deps.onChange?.(user.id)
    res.json({ status })
  })

  router.delete('/auth/llm-credentials', (req, res) => {
    if (!deps.multiUser()) {
      return res.status(400).json({ error: '多用户未启用：无可清除的用户凭据' })
    }
    const user = userOf(req)
    if (!user) return res.status(401).json({ error: '未登录或登录已失效：请登录后重试' })
    const removed = deps.credentials.clear(user.id)
    if (removed) {
      deps.audit?.record({
        actor: 'user',
        ...actorOf(req),
        action: 'auth.llm-credential-clear',
        resourceType: 'user',
        resourceId: user.id,
      })
      deps.onChange?.(user.id)
    }
    res.json({ status: deps.credentials.status(user.id) })
  })

  return router
}

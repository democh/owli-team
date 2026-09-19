/**
 * 账号管理接口（M57 多用户 P1，admin）：
 * - 邀请制：管理员创建账号（可下发初始密码，首登强制改密）、禁用 / 启用、改角色、重置密码、删除；
 * - 内置护栏：不能移除 / 删除最后一个管理员；不能对自己禁用 / 改角色 / 删除；
 * - API Key 自助 + 管理：admin 或本人可管理「本人」的 Key（CLI / 脚本访问通道）。
 */
import { Router } from 'express'
import type { Request, RequestHandler } from 'express'
import { z } from 'zod'
import type { AuthService, AuthUser } from '../auth/service.js'
import type { BrowserRuntime } from '../browser/runtime.js'
import type { AuditStore } from '../store/audit.js'
import type { ConnectionStore } from '../store/connections.js'
import type { McpServerStore } from '../store/mcp-servers.js'
import type { SessionStore } from '../store/sessions.js'
import type { QuotaService } from '../quota/service.js'
import type { WorkspaceService } from '../workspace.js'
import { firstIssue } from './schemas.js'

interface AuthedRequest extends Request {
  user?: AuthUser
}

const createUserSchema = z.object({
  username: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9_.-]{3,32}$/, '用户名需为 3–32 位字母 / 数字 / _. -'),
  displayName: z.string().trim().max(60).optional(),
  role: z.enum(['admin', 'member']).optional(),
  /** 缺省 = 服务端生成随机初始密码（响应返回一次） */
  password: z.string().min(10, '密码至少 10 位').max(200).optional(),
})

const patchUserSchema = z.object({
  displayName: z.string().trim().min(1).max(60).optional(),
  role: z.enum(['admin', 'member']).optional(),
  status: z.enum(['active', 'disabled']).optional(),
})

const apiKeySchema = z.object({
  name: z.string().trim().min(1).max(60),
  expiresAt: z.string().datetime({ offset: true }).optional(),
})

/** M57 P3：配额写入（null = 清除该项回不限；缺省 = 不改动） */
const quotaSchema = z.object({
  maxConcurrentRuns: z.number().int().min(1).max(64).nullable().optional(),
  dailyTokens: z.number().int().min(1).max(1_000_000_000).nullable().optional(),
  monthlyCostUsd: z.number().min(0.01).max(1_000_000).nullable().optional(),
  maxSessions: z.number().int().min(1).max(10_000).nullable().optional(),
  maxStorageMb: z.number().int().min(1).max(10_485_760).nullable().optional(),
})

export interface UsersRouterDeps {
  auth: AuthService
  /** admin 守卫（单用户兼容模式放行；member → 403） */
  requireAdmin: RequestHandler
  /** M62：浏览器运行时（删除账号前关闭其全部实例；缺省 = 跳过） */
  browser?: BrowserRuntime
  /** M57：会话存储（删除账号前枚举其会话，用于磁盘清理） */
  sessions: SessionStore
  /** M57：工作区服务（purgeUser：删除账号时清理 u_<uid> 目录树 / worktree / 画布） */
  workspace: WorkspaceService
  /** M57 P3：配额服务（配额编辑与逐用户用量；缺省 = 503） */
  quotas?: QuotaService
  /** M57 P3：审计（配额设置留痕；缺省 = 跳过） */
  audit?: AuditStore
  /** M57 P3：连接中心（删除账号时清理其 personal 连接；缺省 = 跳过） */
  connections?: ConnectionStore
  /** M57 P3：MCP 存储（删除账号时清理其 personal 服务器行） */
  mcpServers?: McpServerStore
  /** M57 P3：MCP 运行时（删除前断连注销工具 / 回收子进程；缺省 = 跳过） */
  mcpRuntime?: { disconnect: (serverId: string) => Promise<void> }
  /** M68：用户素材库（删除账号时清理 materials 行 + _library/u_<uid>/；缺省 = 跳过） */
  library?: import('../library/service.js').LibraryService
}

export function createUsersRouter(deps: UsersRouterDeps): Router {
  const router = Router()
  const { auth, requireAdmin } = deps

  /** admin 或本人（API Key 自助管理） */
  const adminOrSelf: RequestHandler = (req, res, next) => {
    const user = (req as AuthedRequest).user
    if (!auth.multiUser) return next()
    if (!user) return res.status(401).json({ error: '未登录或登录已失效：请登录后重试' })
    if (user.role === 'admin' || user.id === req.params.id) return next()
    res.status(403).json({ error: '需要管理员权限或本人操作' })
  }

  const actorOf = (req: Request): { userId?: string; ip?: string } => ({
    userId: (req as AuthedRequest).user?.id,
    ip: req.ip,
  })

  /** 账号清单（admin） */
  router.get('/users', requireAdmin, (_req, res) => {
    res.json({ users: auth.listUsers() })
  })

  /** 创建账号（admin；邀请制） */
  router.post('/users', requireAdmin, (req, res, next) => {
    const parsed = createUserSchema.safeParse(req.body ?? {})
    if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) })
    auth
      .createUser(parsed.data, actorOf(req))
      .then((result) => res.status(201).json(result))
      .catch(next)
  })

  /** 更新账号（admin）：显示名 / 角色 / 状态（禁用即时吊销全部会话） */
  router.patch('/users/:id', requireAdmin, (req, res) => {
    const parsed = patchUserSchema.safeParse(req.body ?? {})
    if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) })
    const me = (req as AuthedRequest).user
    if (me?.id === req.params.id) {
      if (parsed.data.role && parsed.data.role !== me.role) {
        return res.status(400).json({ error: '不能修改自己的角色' })
      }
      if (parsed.data.status === 'disabled') {
        return res.status(400).json({ error: '不能禁用当前登录账号' })
      }
    }
    try {
      res.json({ user: auth.updateUser(req.params.id, parsed.data, actorOf(req)) })
    } catch (err) {
      const status = typeof (err as { status?: number }).status === 'number' ? (err as { status: number }).status : 500
      res.status(status).json({ error: (err as Error).message })
    }
  })

  /** 重置密码（admin）：生成初始密码（仅返回一次）+ 强制首登改密 + 吊销全部会话 */
  router.post('/users/:id/password', requireAdmin, (req, res, next) => {
    auth
      .resetPassword(req.params.id, actorOf(req))
      .then((result) => res.json(result))
      .catch(next)
  })

  /**
   * 删除账号（admin）：不能删除自己。
   * 顺序：先关浏览器实例（M62）→ 磁盘清理（M57：worktree 解除注册 + u_<uid> 目录树 / 画布）→ 删库（级联）。
   * 磁盘清理必须在删库之前（worktree 解除注册需要会话行）；清理失败不阻断删除，回传 warnings。
   */
  router.delete('/users/:id', requireAdmin, async (req, res) => {
    const me = (req as AuthedRequest).user
    if (me?.id === req.params.id) return res.status(400).json({ error: '不能删除当前登录账号' })
    try {
      // M62：先关该账号的全部浏览器实例（best-effort；否则被删账号的浏览器进程会残留）
      await deps.browser?.closeForUser(req.params.id, 'user').catch(() => undefined)
      // M57 P3：清理其 personal 连接（connections.owner_id 无 FK 级联；绑定行随 connection FK 自动清理）
      try {
        deps.connections?.removePersonalOf(req.params.id)
      } catch {
        // best-effort：不阻断账号删除
      }
      // M57 P3：清理其 personal MCP 服务器（先断连注销工具 / 回收子进程，再删行；绑定行随 FK 级联）
      try {
        const personalIds = (deps.mcpServers?.listForUser(req.params.id) ?? [])
          .filter((server) => (server.scope ?? 'system') === 'personal' && server.ownerId === req.params.id)
          .map((server) => server.id)
        for (const serverId of personalIds) {
          await deps.mcpRuntime?.disconnect(serverId).catch(() => undefined)
        }
        if (personalIds.length > 0) deps.mcpServers?.removePersonalOf(req.params.id)
      } catch {
        // best-effort：不阻断账号删除
      }
      // M68：清理其素材库（materials 行 + _library/u_<uid>/ 整目录；owner_id 无 FK）
      try {
        deps.library?.removeOf(req.params.id)
      } catch {
        // best-effort：不阻断账号删除
      }
      // M57：枚举会话并清理磁盘（新布局 u_<uid> 整树 + 旧布局逐会话；失败记录不阻断）
      const sessionIds = deps.sessions.list(req.params.id).map((s) => s.id)
      let warnings: string[] = []
      try {
        warnings = await deps.workspace.purgeUser(req.params.id, sessionIds)
      } catch (err) {
        warnings = [`磁盘清理失败（账号已删除，可手动清理）：${(err as Error).message}`]
      }
      auth.deleteUser(req.params.id, actorOf(req))
      res.json({ ok: true, removedSessions: sessionIds.length, ...(warnings.length > 0 ? { warnings } : {}) })
    } catch (err) {
      const status = typeof (err as { status?: number }).status === 'number' ? (err as { status: number }).status : 500
      res.status(status).json({ error: (err as Error).message })
    }
  })

  // ---------- M57 P3：配额与用量（管理侧；GET 允许本人查看自己的限额） ----------

  /** 读取限额（admin 或本人；返回生效限额——含系统默认合并） */
  router.get('/users/:id/quota', adminOrSelf, (req, res) => {
    if (!deps.quotas) return res.status(503).json({ error: '配额服务未装配' })
    if (!auth.getUser(req.params.id)) return res.status(404).json({ error: '账号不存在' })
    res.json({ quota: deps.quotas.limitsOf(req.params.id) })
  })

  /** 设置配额（admin；null = 清除该项回不限；审计 auth.quota-set） */
  router.put('/users/:id/quota', requireAdmin, (req, res) => {
    if (!deps.quotas) return res.status(503).json({ error: '配额服务未装配' })
    const parsed = quotaSchema.safeParse(req.body ?? {})
    if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) })
    if (!auth.getUser(req.params.id)) return res.status(404).json({ error: '账号不存在' })
    deps.quotas.setQuota(req.params.id, parsed.data)
    deps.audit?.record({
      actor: 'user',
      ...actorOf(req),
      action: 'auth.quota-set',
      resourceType: 'user',
      resourceId: req.params.id,
      detail: { quota: deps.quotas.quotaOf(req.params.id) ?? {} },
    })
    res.json({ quota: deps.quotas.limitsOf(req.params.id) })
  })

  /** 逐用户用量汇总（admin；本人视角走 GET /api/usage/me） */
  router.get('/users/:id/usage', requireAdmin, (req, res) => {
    if (!deps.quotas) return res.status(503).json({ error: '配额服务未装配' })
    if (!auth.getUser(req.params.id)) return res.status(404).json({ error: '账号不存在' })
    res.json({ summary: deps.quotas.usageOf(req.params.id) })
  })

  // ---------- API Key（admin 或本人） ----------

  router.get('/users/:id/api-keys', adminOrSelf, (req, res) => {
    if (!auth.getUser(req.params.id)) return res.status(404).json({ error: '账号不存在' })
    res.json({ keys: auth.listApiKeys(req.params.id) })
  })

  router.post('/users/:id/api-keys', adminOrSelf, (req, res, next) => {
    const parsed = apiKeySchema.safeParse(req.body ?? {})
    if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) })
    try {
      res.status(201).json(auth.createApiKey(req.params.id, parsed.data.name, parsed.data.expiresAt, actorOf(req)))
    } catch (err) {
      next(err)
    }
  })

  router.delete('/users/:id/api-keys/:keyId', adminOrSelf, (req, res, next) => {
    try {
      auth.revokeApiKey(req.params.id, req.params.keyId, actorOf(req))
      res.json({ ok: true })
    } catch (err) {
      next(err)
    }
  })

  return router
}

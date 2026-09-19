/**
 * 项目 CRUD（M6）：真实仓库挂载的实体层接口。
 *
 * - `rootPath` 必须在 `ALLOWED_ROOTS` 白名单内，否则 400（校验在 ProjectStore）；
 * - `workspaceMode: sandbox | repo | worktree`（创建后 rootPath 不可改，模式可 PATCH）；
 * - 删除项目不删除仓库目录（外部资产），关联会话由外键置空并回退 sandbox 语义。
 */
import { Router } from 'express'
import type { Request } from 'express'
import type { AuthUser } from '../auth/service.js'
import { createProjectSchema, firstIssue, patchProjectSchema } from './schemas.js'
import type { ApiDeps } from './index.js'

export function createProjectsRouter(deps: ApiDeps): Router {
  const router = Router()

  const userOf = (req: Request): AuthUser | undefined => (req as Request & { user?: AuthUser }).user

  router.get('/projects', (req, res) => {
    // M57：仅返回本人项目（单用户兼容模式不过滤）
    const user = userOf(req)
    res.json({ projects: deps.projects.list(user?.id ? user.id : null), allowedRoots: deps.cfg.allowedRoots })
  })

  router.get('/projects/:id', (req, res) => {
    try {
      const project = deps.access.assertProject(userOf(req), req.params.id)
      res.json({ project, sessionCount: deps.projects.sessionCount(project.id) })
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500
      res.status(status).json({ error: (err as Error).message })
    }
  })

  router.post('/projects', (req, res) => {
    const parsed = createProjectSchema.safeParse(req.body ?? {})
    if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) })
    try {
      const project = deps.projects.create({
        name: parsed.data.name,
        rootPath: parsed.data.rootPath,
        workspaceMode: parsed.data.workspaceMode,
        baseBranch: parsed.data.baseBranch,
        // M57：项目属主
        ownerId: userOf(req)?.id || undefined,
      })
      res.status(201).json({ project })
    } catch (err) {
      // ALLOWED_ROOTS 校验失败 / 目录不存在 / 模式非法 → 400（可修正的用户错误）
      res.status(400).json({ error: (err as Error).message })
    }
  })

  router.patch('/projects/:id', (req, res) => {
    try {
      deps.access.assertProject(userOf(req), req.params.id)
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500
      return res.status(status).json({ error: (err as Error).message })
    }
    const parsed = patchProjectSchema.safeParse(req.body ?? {})
    if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) })
    try {
      const project = deps.projects.update(req.params.id, {
        name: parsed.data.name,
        workspaceMode: parsed.data.workspaceMode,
        baseBranch: parsed.data.baseBranch,
      })
      if (!project) return res.status(404).json({ error: '项目不存在' })
      res.json({ project })
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  router.delete('/projects/:id', (req, res) => {
    try {
      deps.access.assertProject(userOf(req), req.params.id)
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500
      return res.status(status).json({ error: (err as Error).message })
    }
    const sessionCount = deps.projects.sessionCount(req.params.id)
    deps.projects.remove(req.params.id)
    // 不删除仓库目录（外部资产）；关联会话保留并回退 sandbox 工作区语义
    res.json({ ok: true, sessionsDetached: sessionCount })
  })

  return router
}

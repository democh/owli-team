/**
 * 运行期设置接口（M8）：`data/settings.json` 覆盖层的前端入口。
 * - GET：返回当前生效的运行期设置（admin / 单用户兼容模式）；
 *   M57：成员仅返回安全子集（系统级参数不向成员暴露；个人偏好在 /api/auth/preferences）；
 * - PUT：zod 校验 → 合并写入 settings.json（原子替换）→ 就地更新 AppConfig（无需重启）；仅 admin。
 */
import { Router } from 'express'
import type { Request, RequestHandler } from 'express'
import type { AppConfig } from '../config.js'
import type { AuthUser } from '../auth/service.js'
import { applySettingsToConfig, RuntimeSettingsSchema, SETTINGS_FIELDS, writeSettingsFile } from '../settings.js'

export interface SettingsRouterDeps {
  cfg: AppConfig
  /** M57：系统设置写入仅限 admin（单用户兼容模式放行；成员读取子集、写入 403） */
  requireAdmin?: RequestHandler
  /** M57：多用户判定（成员读取子集的依据；缺省 = 单用户兼容模式全量返回） */
  access?: { multiUser: boolean }
}

export function createSettingsRouter(deps: SettingsRouterDeps): Router {
  const router = Router()

  router.get('/settings', (req, res) => {
    const user = (req as Request & { user?: AuthUser }).user
    // M57：多用户下成员只拿安全子集（系统级参数仅 admin 可见）
    if (deps.access?.multiUser && user?.role !== 'admin') {
      res.json({ settings: {}, fields: [] })
      return
    }
    const settings: Record<string, unknown> = {}
    for (const key of SETTINGS_FIELDS) settings[key] = deps.cfg[key]
    res.json({ settings, fields: SETTINGS_FIELDS })
  })

  const writeGuards: RequestHandler[] = deps.requireAdmin ? [deps.requireAdmin] : []
  router.put('/settings', ...writeGuards, (req, res) => {
    const parsed = RuntimeSettingsSchema.partial().strict().safeParse(req.body ?? {})
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      const field = issue.path.join('.') || '参数'
      return res.status(400).json({ error: `设置校验失败：${field} ${issue.message}` })
    }
    try {
      const persisted = writeSettingsFile(deps.cfg.settingsFile, parsed.data)
      applySettingsToConfig(deps.cfg, persisted)
      res.json({ settings: persisted, applied: true })
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  return router
}

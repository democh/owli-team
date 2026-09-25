/**
 * 运行期设置接口（M8）：`data/settings.json` 覆盖层的前端入口。
 * - GET：返回当前生效的运行期设置（admin / 单用户兼容模式）；
 *   M57：成员仅返回安全子集（系统级参数不向成员暴露；个人偏好在 /api/auth/preferences）；
 * - PUT：zod 校验 → 合并写入 settings.json（原子替换）→ 就地更新 AppConfig（无需重启）；仅 admin。
 *   M82：出口相关字段变更即失效出口层（连接池 / 绑定缓存重建）；设置变更落审计（仅字段清单）。
 */
import { Router } from 'express'
import type { Request, RequestHandler } from 'express'
import type { AppConfig } from '../config.js'
import type { AuthUser } from '../auth/service.js'
import type { AuditStore } from '../store/audit.js'
import type { EgressRuntime } from '../net/egress.js'
import { applySettingsToConfig, RuntimeSettingsSchema, SETTINGS_FIELDS, writeSettingsFile } from '../settings.js'

export interface SettingsRouterDeps {
  cfg: AppConfig
  /** M57：系统设置写入仅限 admin（单用户兼容模式放行；成员读取子集、写入 403） */
  requireAdmin?: RequestHandler
  /** M57：多用户判定（成员读取子集的依据；缺省 = 单用户兼容模式全量返回） */
  access?: { multiUser: boolean }
  /** M82：出口层（出口字段变更后重建；缺省 = 未装配，跳过失效） */
  egress?: EgressRuntime
  /** M82：设置变更审计（缺省 = 不审计，测试夹具零影响） */
  audit?: AuditStore
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

  /** M82：出口状态（面板展示：模式 / 绑定 / 通道 / 降级冷却 / 最近探测；admin / 单用户兼容模式） */
  router.get('/egress/status', (req, res) => {
    const user = (req as Request & { user?: AuthUser }).user
    if (deps.access?.multiUser && user?.role !== 'admin') {
      res.json({ status: null })
      return
    }
    res.json({ status: deps.egress?.status() ?? null })
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
      const fields = Object.keys(parsed.data)
      // M82：出口相关字段变更 → 同步失效出口层（连接池 / 绑定缓存 / 降级状态复位）
      if (fields.some((key) => key.startsWith('egress'))) {
        void deps.egress?.invalidate()
      }
      // M82：设置变更审计（仅字段清单；不落值，避免凭据类字段外泄）
      if (deps.audit && fields.length > 0) {
        const user = (req as Request & { user?: AuthUser }).user
        deps.audit.record({
          actor: 'user',
          userId: user?.id,
          ip: req.ip,
          action: 'settings.update',
          resourceType: 'settings',
          resourceId: 'runtime',
          detail: { fields },
        })
      }
      res.json({ settings: persisted, applied: true })
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  return router
}

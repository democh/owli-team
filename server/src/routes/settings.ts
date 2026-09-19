/**
 * 运行期设置接口（M8）：`data/settings.json` 覆盖层的前端入口。
 * - GET：返回当前生效的运行期设置（字段与 RuntimeSettingsSchema 对齐）；
 * - PUT：zod 校验 → 合并写入 settings.json（原子替换）→ 就地更新 AppConfig（无需重启）。
 */
import { Router } from 'express'
import type { AppConfig } from '../config.js'
import { applySettingsToConfig, RuntimeSettingsSchema, SETTINGS_FIELDS, writeSettingsFile } from '../settings.js'

export interface SettingsRouterDeps {
  cfg: AppConfig
}

export function createSettingsRouter(deps: SettingsRouterDeps): Router {
  const router = Router()

  router.get('/settings', (_req, res) => {
    const settings: Record<string, unknown> = {}
    for (const key of SETTINGS_FIELDS) settings[key] = deps.cfg[key]
    res.json({ settings, fields: SETTINGS_FIELDS })
  })

  router.put('/settings', (req, res) => {
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

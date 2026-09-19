/**
 * M57 P3：用量与配额接口（个人视角）。
 *
 * - GET /api/usage/me：当前登录用户的用量汇总 + 生效限额（「我的用量」数据源）；
 *   单用户兼容模式（无账号体系）→ 返回空上限 + 全量聚合（无 user_id 归因的历史数据不计入）。
 * 管理侧（逐用户查看 / 配额编辑）见 routes/users.ts（admin）。
 */
import { Router } from 'express'
import type { Request } from 'express'
import type { UsageSummary } from '@multi-agent/shared'
import type { AuthUser } from '../auth/service.js'
import type { ApiDeps } from './index.js'

export function createUsageRouter(deps: ApiDeps): Router {
  const router = Router()

  const userOf = (req: Request): AuthUser | undefined => (req as Request & { user?: AuthUser }).user

  router.get('/usage/me', (req, res) => {
    const user = userOf(req)
    // 兼容模式（无账号 / 无配额服务）：空数据 + 无上限（前端「我的用量」自然隐藏或显示零）
    if (!deps.quotas || !user) {
      const summary: UsageSummary = {
        userId: '',
        todayTokens: 0,
        monthCostUsd: 0,
        sessions: 0,
        storageMb: 0,
        limits: {},
      }
      res.json({ summary })
      return
    }
    res.json({ summary: deps.quotas.usageOf(user.id) })
  })

  return router
}

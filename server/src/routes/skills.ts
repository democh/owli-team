import { Router } from 'express'
import type { ApiDeps } from './index.js'

/** GET /api/skills：技能库列表（右栏档案浮层展示） */
export function createSkillsRouter(deps: ApiDeps): Router {
  const router = Router()
  router.get('/skills', (_req, res) => {
    res.json({ skills: deps.skills.list() })
  })
  return router
}

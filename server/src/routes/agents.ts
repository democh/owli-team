/**
 * M15：Agent 资产接口。
 * - GET /api/agents：角色定义 + 场景元数据 + 快速组队预设（PromptLibrary 投影；agents 附 group / souls / defaultSoul）
 * - GET /api/agents/:id/avatar：角色形象照（agents/<场景>/<id>/avatar.png；ETag 缓存 + 404 兜底）
 */
import fs from 'node:fs'
import { Router } from 'express'
import type { ApiDeps } from './index.js'

export function createAgentsRouter(deps: ApiDeps): Router {
  const router = Router()

  router.get('/agents', (_req, res) => {
    res.json({ agents: deps.prompts.list(), groups: deps.prompts.groups(), presets: deps.prompts.presets() })
  })

  router.get('/agents/:id/avatar', (req, res) => {
    const file = deps.prompts.avatarFile(req.params.id)
    if (!file) {
      res.status(404).json({ error: `角色 "${req.params.id}" 未配置头像` })
      return
    }
    let stat: fs.Stats
    try {
      stat = fs.statSync(file)
    } catch {
      res.status(404).json({ error: `角色 "${req.params.id}" 未配置头像` })
      return
    }
    const etag = `W/"${stat.size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}"`
    res.setHeader('ETag', etag)
    res.setHeader('Cache-Control', 'public, max-age=300')
    res.setHeader('Content-Type', 'image/png')
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end()
      return
    }
    fs.createReadStream(file).pipe(res)
  })

  return router
}

/**
 * M26：资产控制台接口（/api/console，挂载于 /api 之下）。
 * - Agent：清单 / 详情 / 新建 / 更新 / 复制 / 软删除（有引用时 409 + 清单，?force=1 强制）/
 *   头像上传（base64 PNG）与删除 / 灵魂写入与删除；
 * - Skill：清单 / 详情 / 新建 / 更新 / 软删除（同上）；
 * - 场景：清单 + 新建（供新建向导使用；完整管理为二期）；
 * - 工具：注册表元数据 + 服务端分类映射 + 各角色白名单使用情况；
 * - POST /validate：资产校验聚合（页头徽章 / 校验中心）。
 * 全部写操作成功后发布 notify:assets-changed（保留主题 __assets__，多标签同步）。
 */
import { Router } from 'express'
import type { Response } from 'express'
import { z } from 'zod'
import type { ZodIssue } from 'zod'
import type { ConsoleToolInfo } from '@multi-agent/shared'
import { ASSETS_TOPIC } from '@multi-agent/shared'
import type { ApiDeps } from './index.js'
import { AssetConflictError, AssetNotFoundError, AssetValidationError } from '../assets/manager.js'
import { mcpSlugOf } from '../mcp/naming.js'
import { toolCategory } from '../tools/categories.js'

const AgentAvatarSchema = z.object({
  icon: z.string().optional(),
  gradient: z.tuple([z.string(), z.string()]).optional(),
  image: z.string().optional(),
})

const AgentWriteSchema = z.object({
  name: z.string().min(1, 'name 不能为空'),
  role: z.string().min(1, 'role 不能为空'),
  title: z.string().optional(),
  description: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  avatar: AgentAvatarSchema.optional(),
  soul: z.string().optional(),
  handoff: z.array(z.string()).optional(),
  tools: z.array(z.string()).nullable().optional(),
  skills: z.array(z.string()).nullable().optional(),
  model: z.string().nullable().optional(),
  temperature: z.number().min(0).max(2).nullable().optional(),
  body: z.string(),
})

const GroupWriteSchema = z.object({
  id: z.string().min(1, 'id 不能为空'),
  name: z.string().min(1, 'name 不能为空'),
  description: z.string().optional(),
  icon: z.string().optional(),
  theme: z.tuple([z.string(), z.string()]).optional(),
  objective: z.string().optional(),
})

const AgentCreateSchema = AgentWriteSchema.extend({
  id: z.string().min(1, 'id 不能为空'),
  group: z.string().min(1, 'group 不能为空'),
  newGroup: GroupWriteSchema.optional(),
})

const SkillWriteSchema = z.object({
  description: z.string().min(1, 'description 不能为空（说明何时使用）'),
  tags: z.array(z.string()).optional(),
  body: z.string(),
})

const SkillCreateSchema = SkillWriteSchema.extend({ name: z.string().min(1, 'name 不能为空') })

const SoulWriteSchema = z.object({
  name: z.string().min(1, 'name 不能为空'),
  tagline: z.string().optional(),
  icon: z.string().optional(),
  traits: z.array(z.string()).optional(),
  tone: z.string().optional(),
  quirks: z.array(z.string()).optional(),
  body: z.string(),
  setDefault: z.boolean().optional(),
})

/** 参数项数（JSON Schema properties 计数） */
function countParams(parameters: Record<string, unknown>): number {
  const properties = parameters.properties
  if (properties && typeof properties === 'object') return Object.keys(properties as Record<string, unknown>).length
  return 0
}

/** 资产错误 → 状态码（404 / 409+引用清单 / 400）；非资产错误返回 false 交由上层中间件 */
function sendAssetError(res: Response, err: unknown): boolean {
  if (err instanceof AssetNotFoundError) {
    res.status(404).json({ error: err.message })
    return true
  }
  if (err instanceof AssetConflictError) {
    res.status(409).json({ error: err.message, refs: err.refs })
    return true
  }
  if (err instanceof AssetValidationError) {
    res.status(400).json({ error: err.message })
    return true
  }
  return false
}

function sendParseError(res: Response, issue: ZodIssue): void {
  res.status(400).json({ error: `参数校验失败：${issue.path.join('.') || '参数'} ${issue.message}` })
}

/** 同步处理包装：资产错误转响应，其它错误上抛给统一错误中间件 */
function handle(res: Response, fn: () => void): void {
  try {
    fn()
  } catch (err) {
    if (!sendAssetError(res, err)) throw err
  }
}

export function createConsoleRouter(deps: ApiDeps): Router {
  const router = Router()
  const assets = deps.assets

  /** 写操作成功后的全局广播（保留主题 __assets__；多标签页同步，不进未读计数） */
  const announce = (kind: 'agent' | 'skill' | 'group', id: string, action: string): void => {
    deps.notify.publish({
      type: 'notify:assets-changed',
      sessionId: ASSETS_TOPIC,
      payload: { kind, id, action },
    })
  }

  // ---------- Agent ----------

  router.get('/console/agents', (_req, res) => {
    res.json({ agents: assets.listAgents() })
  })

  router.post('/console/agents', (req, res) => {
    const parsed = AgentCreateSchema.safeParse(req.body ?? {})
    if (!parsed.success) return sendParseError(res, parsed.error.issues[0])
    handle(res, () => {
      const agent = assets.createAgent(parsed.data)
      announce('agent', agent.id, 'created')
      res.json({ agent })
    })
  })

  router.get('/console/agents/:id', (req, res) => {
    handle(res, () => res.json({ agent: assets.getAgent(req.params.id) }))
  })

  router.put('/console/agents/:id', (req, res) => {
    const parsed = AgentWriteSchema.safeParse(req.body ?? {})
    if (!parsed.success) return sendParseError(res, parsed.error.issues[0])
    handle(res, () => {
      const agent = assets.updateAgent(req.params.id, parsed.data)
      announce('agent', req.params.id, 'updated')
      res.json({ agent })
    })
  })

  router.delete('/console/agents/:id', (req, res) => {
    const force = req.query.force === '1' || req.query.force === 'true'
    handle(res, () => {
      const result = assets.deleteAgent(req.params.id, force)
      announce('agent', req.params.id, result.deletedGroup ? 'group-deleted' : 'deleted')
      res.json({ ok: true, deletedGroup: result.deletedGroup })
    })
  })

  router.post('/console/agents/:id/duplicate', (req, res) => {
    handle(res, () => {
      const agent = assets.duplicateAgent(req.params.id)
      announce('agent', agent.id, 'created')
      res.json({ agent })
    })
  })

  router.put('/console/agents/:id/avatar', (req, res) => {
    const data = (req.body ?? {}).data
    if (typeof data !== 'string' || data.length === 0) {
      return sendParseError(res, { code: 'custom', path: ['data'], message: '需为 PNG 的 base64 字符串' })
    }
    handle(res, () => {
      const agent = assets.writeAvatar(req.params.id, data)
      announce('agent', req.params.id, 'avatar-updated')
      res.json({ agent })
    })
  })

  router.delete('/console/agents/:id/avatar', (req, res) => {
    handle(res, () => {
      const agent = assets.deleteAvatar(req.params.id)
      announce('agent', req.params.id, 'avatar-deleted')
      res.json({ agent })
    })
  })

  router.put('/console/agents/:id/souls/:soulId', (req, res) => {
    const parsed = SoulWriteSchema.safeParse(req.body ?? {})
    if (!parsed.success) return sendParseError(res, parsed.error.issues[0])
    handle(res, () => {
      const agent = assets.writeSoul(req.params.id, req.params.soulId, parsed.data)
      announce('agent', req.params.id, 'soul-written')
      res.json({ agent })
    })
  })

  router.delete('/console/agents/:id/souls/:soulId', (req, res) => {
    handle(res, () => {
      const agent = assets.deleteSoul(req.params.id, req.params.soulId)
      announce('agent', req.params.id, 'soul-deleted')
      res.json({ agent })
    })
  })

  // ---------- Skill ----------

  router.get('/console/skills', (_req, res) => {
    res.json({ skills: assets.listSkills() })
  })

  router.post('/console/skills', (req, res) => {
    const parsed = SkillCreateSchema.safeParse(req.body ?? {})
    if (!parsed.success) return sendParseError(res, parsed.error.issues[0])
    handle(res, () => {
      const skill = assets.createSkill(parsed.data.name, parsed.data)
      announce('skill', parsed.data.name, 'created')
      res.json({ skill })
    })
  })

  router.get('/console/skills/:name', (req, res) => {
    handle(res, () => res.json({ skill: assets.getSkill(req.params.name) }))
  })

  router.put('/console/skills/:name', (req, res) => {
    const parsed = SkillWriteSchema.safeParse(req.body ?? {})
    if (!parsed.success) return sendParseError(res, parsed.error.issues[0])
    handle(res, () => {
      const skill = assets.updateSkill(req.params.name, parsed.data)
      announce('skill', req.params.name, 'updated')
      res.json({ skill })
    })
  })

  router.delete('/console/skills/:name', (req, res) => {
    const force = req.query.force === '1' || req.query.force === 'true'
    handle(res, () => {
      assets.deleteSkill(req.params.name, force)
      announce('skill', req.params.name, 'deleted')
      res.json({ ok: true })
    })
  })

  // ---------- 场景 ----------

  router.get('/console/groups', (_req, res) => {
    res.json({ groups: deps.prompts.groups() })
  })

  router.post('/console/groups', (req, res) => {
    const parsed = GroupWriteSchema.safeParse(req.body ?? {})
    if (!parsed.success) return sendParseError(res, parsed.error.issues[0])
    handle(res, () => {
      const group = assets.createGroup(parsed.data)
      announce('group', group.id, 'created')
      res.json({ group })
    })
  })

  // ---------- 工具中心（读：清单 / 分类 / 授权情况） ----------

  router.get('/console/tools', (_req, res) => {
    const usage = assets.toolUsage()
    const tools: ConsoleToolInfo[] = deps.tools.list().map((tool) => {
      const server = mcpSlugOf(tool.name)
      return {
        name: tool.name,
        description: tool.description,
        readOnly: tool.readOnly === true,
        paramCount: countParams(tool.parameters),
        category: toolCategory(tool.name),
        usedByAgents: usage.get(tool.name) ?? [],
        // M27：外部 MCP 工具标注来源（控制台展示徽章与按服务器分组）
        origin: server ? 'mcp' : 'builtin',
        server,
        // M28：加载层级（deferred = 经 tool_search 按需激活）
        tier: tool.tier === 'deferred' ? 'deferred' : 'core',
      }
    })
    res.json({ tools })
  })

  // ---------- Agent Studio：AI 生成（草稿不落盘，落盘走既有创建链路；未装配 503） ----------

  const GenerateAgentSchema = z.object({
    description: z.string().min(1).max(2000),
    sceneHint: z.string().max(40).optional(),
  })
  const GenerateSkillSchema = z.object({ requirement: z.string().min(1).max(2000) })

  router.post('/console/generate/agent', (req, res) => {
    if (!deps.assetGen) return res.status(503).json({ error: '资产生成器未装配' })
    const parsed = GenerateAgentSchema.safeParse(req.body ?? {})
    if (!parsed.success) return sendParseError(res, parsed.error.issues[0])
    void deps.assetGen
      .generateAgent(parsed.data.description, { sceneHint: parsed.data.sceneHint })
      .then((result) => res.json(result))
      .catch((err) => res.status(502).json({ error: `生成失败：${(err as Error).message}` }))
  })

  router.post('/console/generate/skill', (req, res) => {
    if (!deps.assetGen) return res.status(503).json({ error: '资产生成器未装配' })
    const parsed = GenerateSkillSchema.safeParse(req.body ?? {})
    if (!parsed.success) return sendParseError(res, parsed.error.issues[0])
    void deps.assetGen
      .generateSkill(parsed.data.requirement)
      .then((result) => res.json(result))
      .catch((err) => res.status(502).json({ error: `生成失败：${(err as Error).message}` }))
  })

  // ---------- 校验聚合 ----------

  router.post('/console/validate', (_req, res) => {
    res.json({ issues: assets.validate() })
  })

  return router
}

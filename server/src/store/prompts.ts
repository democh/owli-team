/**
 * Agent 资产库（M15）：agents/<场景>/<agent>/ 单包目录 + mtime 热更新。
 *
 * 目录规范（详见 agents/README.md）：
 *   agents/_protocol.md                全局协作协议（L0 首段）
 *   agents/_presets.yaml               快速组队预设（可选；缺失时前端隐藏该区块）
 *   agents/<场景>/_group.yaml          场景元数据（必填；目录即分组）
 *   agents/<场景>/_protocol.md         场景协议（可选，追加在全局协议之后）
 *   agents/<场景>/<agent>/AGENT.md     角色定义（front-matter + 人设正文；目录即 id）
 *   agents/<场景>/<agent>/souls/*.md   灵魂变体（可选；无 = 无灵魂，行为同经典模式）
 *   agents/<场景>/<agent>/avatar.png   形象照（自动发现 → /api/agents/<id>/avatar）
 *
 * 兼容回退：agents/ 不存在而 prompts/ 存在时，按旧版平铺逻辑加载（启动告警
 * 提示迁移，`npm run migrate:agents`）；回退模式下 group 固定为 development、
 * 无灵魂、头像沿用 front-matter 的 image 路径。DEFAULT_CHAIN 仅在此回退模式与
 * 旧测试中使用。
 */
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { z } from 'zod'
import type { AgentDefinition, AgentGroup, RosterPreset, SoulMeta, StageLayout, StagePanel } from '@multi-agent/shared'
import { DEFAULT_CHAIN, STAGE_LAYOUTS, STAGE_PANELS, baseAgentId, soulIdOfMember, validateScheduleSpec } from '@multi-agent/shared'

/** 角色 front-matter 校验（§13.1 / §25）：失败时给出精确报错 */
export const AgentFrontMatterSchema = z.object({
  id: z.string().min(1, 'id 不能为空'),
  name: z.string().min(1, 'name 不能为空'),
  role: z.string().min(1, 'role 不能为空'),
  title: z.string().default(''),
  description: z.string().default(''),
  capabilities: z.array(z.string()).default([]),
  avatar: z
    .object({
      icon: z.string().optional(),
      gradient: z.tuple([z.string(), z.string()], { invalid_type_error: 'avatar.gradient 需为两个颜色' }).optional(),
      image: z.string().optional(),
    })
    .default({}),
  /** 默认灵魂 id（souls/ 下对应文件；未写时取 souls/default.md；都没有 = 无灵魂） */
  soul: z.string().optional(),
  handoff: z.array(z.string()).default([]),
  tools: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
})

/** 灵魂 front-matter 校验（§26）：id 缺省取文件名（两者不一致时报错） */
export const SoulFrontMatterSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1, 'name 不能为空'),
  tagline: z.string().default(''),
  icon: z.string().optional(),
  traits: z.array(z.string()).default([]),
  tone: z.string().default(''),
  quirks: z.array(z.string()).default([]),
})

/** M52：场景工作区声明（可选；布局 / 面板值域与 shared 常量同源，形态注册表见 client/src/components/scene） */
const StageSchema = z.object({
  layout: z.enum([...STAGE_LAYOUTS] as [StageLayout, ...StageLayout[]]),
  panel: z.enum([...STAGE_PANELS] as [StagePanel, ...StagePanel[]]).optional(),
  seats: z
    .object({
      left: z.array(z.string()).optional(),
      right: z.array(z.string()).optional(),
      center: z.array(z.string()).optional(),
    })
    .optional(),
  parts: z.array(z.string()).optional(),
})

/** 场景元数据校验（_group.yaml，§25） */
export const AgentGroupSchema = z.object({
  id: z.string().min(1, 'id 不能为空'),
  name: z.string().min(1, 'name 不能为空'),
  description: z.string().default(''),
  icon: z.string().default('user'),
  theme: z.tuple([z.string(), z.string()]).default(['#64748b', '#94a3b8'] as [string, string]),
  objective: z.string().default(''),
  /** 默认接力链（有序编制；建会话时按此排序落库） */
  chain: z.array(z.string()).default([]),
  /** 场景默认技能（agent 未显式配置 skills 时生效） */
  defaultSkills: z.array(z.string()).default([]),
  /** 场景内允许自动成波并行（默认 false） */
  parallel: z.boolean().default(false),
  /** 允许多人多轮交替（放宽循环检测阈值，默认 false） */
  rounds: z.boolean().default(false),
  /** 场景并行上限（覆盖全局 PARALLEL_MAX） */
  parallelMax: z.number().int().min(1).max(8).optional(),
  /** M37：空态引导标题（缺省回退前端内置文案） */
  guide: z.string().default(''),
  /** M37：空态议程 chips（点击预填 Composer 草稿；label 短标签 + prompt 草稿文案） */
  agenda: z
    .array(z.object({ label: z.string().min(1), prompt: z.string().min(1) }))
    .default([]),
  /** 展示排序（越小越靠前，默认 100） */
  order: z.number().default(100),
  /** M52：场景工作区形态（可选；未声明即 stream，向后兼容） */
  stage: StageSchema.optional(),
  /** P4：仪式化订阅声明（可选；cron 合法性在订阅时由调度层 validateScheduleSpec 终验） */
  ritual: z
    .object({
      title: z.string().min(1, 'ritual.title 不能为空').max(80),
      cron: z.string().min(1, 'ritual.cron 不能为空'),
      timezone: z.string().optional(),
      opener: z.string().min(1, 'ritual.opener 不能为空').max(2000),
      members: z.array(z.string().min(1)).optional(),
      description: z.string().max(200).optional(),
    })
    .optional(),
})

/** 快速组队预设校验（_presets.yaml 单条；成员存在性由 validate() 跨引用检查） */
export const PresetSchema = z.object({
  id: z.string().min(1, 'id 不能为空'),
  name: z.string().min(1, 'name 不能为空'),
  description: z.string().default(''),
  icon: z.string().default('users'),
  theme: z.tuple([z.string(), z.string()]).default(['#6366f1', '#818cf8'] as [string, string]),
  members: z.array(z.string().min(1)).min(1, 'members 不能为空'),
  prompt: z.string().default(''),
  order: z.number().default(100),
})

/** _presets.yaml 文件结构（顶层 presets 数组；文件缺失时整体为 []） */
export const PresetFileSchema = z.object({ presets: z.array(PresetSchema).default([]) })

export interface ParsedDoc {
  data: unknown
  body: string
}

export function parseFrontMatter(raw: string): ParsedDoc {
  if (!raw.startsWith('---')) {
    throw new Error('缺少 front-matter（文件需以 --- 开头）')
  }
  const end = raw.indexOf('\n---', 3)
  if (end === -1) {
    throw new Error('front-matter 未闭合（缺少结束的 --- 行）')
  }
  const fmText = raw.slice(3, end)
  const body = raw.slice(end + 4).replace(/^\r?\n/, '')
  return { data: YAML.parse(fmText), body }
}

/** 灵魂文档（装配用：元数据 + 正文；quirks 不进公开元数据） */
export interface SoulDoc {
  meta: SoulMeta
  quirks: string[]
  body: string
}

/**
 * 声纹文档（P1 去 AI 化；agents/<场景>/<角色>/voice.md，可选）。
 * soul 管人格，voice 管文风：段落优先 / 句式偏好 / 禁用词表 / 正反例。
 * examples / banned 从正文结构化提取（供回合指令轮换注入与校验）。
 */
export interface VoiceDoc {
  body: string
  /** 正文中的示例（`> ` 引用行，去引用符） */
  examples: string[]
  /** 禁用词表（「禁用词表」行内词，按 / 、，分隔） */
  banned: string[]
}

/** 从 voice.md 正文提取声纹结构化字段（容错：缺段 = 空数组） */
export function parseVoiceDoc(body: string): VoiceDoc {
  const examples = body
    .split('\n')
    .filter((l) => l.trim().startsWith('>'))
    .map((l) => l.trim().replace(/^>\s*/, '').trim())
    .filter((l) => l.length > 0)
  const banned: string[] = []
  const bannedLine = body.split('\n').find((l) => l.includes('禁用词表'))
  if (bannedLine) {
    const rest = bannedLine.split(/禁用词表[：:]/)[1] ?? ''
    for (const w of rest.split(/[\/、，,；;]/)) {
      const word = w.trim().replace(/[。\s].*$/, '')
      if (word) banned.push(word)
    }
  }
  return { body, examples, banned }
}

export interface PromptLibraryOptions {
  /** 规范位置：agents/<场景>/<agent>/ 包目录 */
  agentsDir: string
  /** 兼容回退：旧版平铺目录（agents/ 缺失时使用） */
  promptsDir: string
  /** 告警输出（默认 console.warn；测试可注入静音） */
  onWarn?: (message: string) => void
}

/** 旧 prompts/ 回退模式下的合成场景（DEFAULT_CHAIN 仅用于此处与旧测试） */
const LEGACY_GROUP: AgentGroup = {
  id: 'development',
  name: '研发团队',
  description: '（兼容模式：加载自旧版 prompts/ 平铺目录，建议运行 npm run migrate:agents 迁移）',
  icon: 'code',
  theme: ['#3b82f6', '#60a5fa'],
  objective: '',
  chain: [...DEFAULT_CHAIN],
  defaultSkills: [],
  parallel: false,
  rounds: false,
  order: 10,
}

/** 列出子目录（跳过隐藏目录与 `_` 前缀目录；排序保证扫描确定性） */
function listDirs(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_'))
    .map((d) => d.name)
    .sort()
}

/** Agent 资产库：mtime 热更新，改完即生效（§7 / §13.1 / §25） */
export class PromptLibrary {
  private readonly agentsDir: string
  private readonly promptsDir: string
  private readonly warn: (message: string) => void

  private mode: 'agents' | 'legacy' = 'legacy'
  private agents = new Map<string, AgentDefinition>()
  private bodies = new Map<string, string>()
  /** agentId → (soulId → 灵魂文档) */
  private soulDocs = new Map<string, Map<string, SoulDoc>>()
  /** agentId → 声纹文档（voice.md；P1 去 AI 化，可选） */
  private voiceDocs = new Map<string, VoiceDoc>()
  /** agentId → avatar.png 绝对路径（自动发现） */
  private avatarPaths = new Map<string, string>()
  private groupList: AgentGroup[] = []
  private groupProtocols = new Map<string, string>()
  /** 快速组队预设（agents/_presets.yaml；缺省为空数组 → 前端隐藏该区块） */
  private presetList: RosterPreset[] = []
  private protocol = ''
  /** 变更签名：参与加载的全部文件（路径 → mtime；avatar.png 记 0，仅存在性） */
  private files = new Map<string, number>()

  constructor(opts: PromptLibraryOptions) {
    this.agentsDir = opts.agentsDir
    this.promptsDir = opts.promptsDir
    this.warn = opts.onWarn ?? ((message: string) => console.warn(message))
    this.reload()
  }

  /** 全局协作协议（L0 首段） */
  get protocolText(): string {
    this.maybeReload()
    return this.protocol
  }

  /** 场景协议（追加在全局协议之后；无场景协议时为空串） */
  groupProtocol(groupId: string): string {
    this.maybeReload()
    return this.groupProtocols.get(groupId) ?? ''
  }

  /** 场景元数据（按 order 升序；回退模式为合成的 development 场景） */
  groups(): AgentGroup[] {
    this.maybeReload()
    return [...this.groupList]
  }

  /** 快速组队预设（按 order 升序；无 _presets.yaml 时为空数组） */
  presets(): RosterPreset[] {
    this.maybeReload()
    return [...this.presetList]
  }

  /** 全部角色：按「场景排序 → 场景内编制链序 → id」排序 */
  list(): AgentDefinition[] {
    this.maybeReload()
    const groupIndex = new Map(this.groupList.map((g, i) => [g.id, i]))
    const chainIndex = new Map<string, number>()
    for (const g of this.groupList) g.chain.forEach((id, i) => chainIndex.set(`${g.id}:${id}`, i))
    const rank = (a: AgentDefinition) => {
      const gi = groupIndex.get(a.group) ?? 999
      const ci = chainIndex.get(`${a.group}:${a.id}`) ?? 999
      return gi * 10_000 + ci
    }
    return [...this.agents.values()].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))
  }

  get(id: string): AgentDefinition | undefined {
    this.maybeReload()
    // M77：容忍成员键（分身 `agentId~soulId` → 返回基础角色定义；经典键等于 agentId）
    return this.agents.get(baseAgentId(id))
  }

  body(id: string): string {
    this.maybeReload()
    return this.bodies.get(baseAgentId(id)) ?? ''
  }

  /** 声纹（P1）：voice.md 文档；无文件 = undefined（行为与现状零差异） */
  voice(id: string): VoiceDoc | undefined {
    this.maybeReload()
    return this.voiceDocs.get(baseAgentId(id))
  }

  /**
   * 解析灵魂：显式 soulId（须归属该角色）> 成员键内嵌（分身 `agentId~soulId`）> 角色默认 > 无。
   * 语法上调用方需先用返回值校验归属（`doc.meta.id === soulId`）。
   */
  soul(agentId: string, soulId?: string | null): SoulDoc | undefined {
    this.maybeReload()
    const base = baseAgentId(agentId)
    const souls = this.soulDocs.get(base)
    if (!souls) return undefined
    const id = soulId ?? soulIdOfMember(agentId) ?? this.agents.get(base)?.defaultSoul
    if (!id) return undefined
    return souls.get(id)
  }

  /** avatar.png 绝对路径（不存在时 undefined → API 404） */
  avatarFile(id: string): string | undefined {
    this.maybeReload()
    return this.avatarPaths.get(baseAgentId(id))
  }

  /** 当前加载模式（agents = 包目录；legacy = 旧 prompts/ 回退） */
  currentMode(): 'agents' | 'legacy' {
    return this.mode
  }

  reload(): void {
    if (fs.existsSync(this.agentsDir)) this.reloadAgents()
    else this.reloadLegacy()
    this.files = this.collectFiles()
  }

  /** 校验模式：直接抛出结构性错误，返回语义问题列表（check:agents 脚本使用） */
  validate(): string[] {
    this.reload()
    const problems: string[] = []
    for (const agent of this.agents.values()) {
      for (const target of agent.handoff) {
        if (!this.agents.has(target)) {
          problems.push(`角色 ${agent.group}/${agent.id} 的 handoff 指向不存在的角色 "${target}"`)
        }
      }
    }
    for (const group of this.groupList) {
      // 回退模式的 chain 为合成 DEFAULT_CHAIN（仅用于排序），不做链校验
      if (this.mode === 'agents') {
        for (const target of group.chain) {
          if (!this.agents.has(target)) {
            problems.push(`场景 ${group.id} 的 chain 指向不存在的角色 "${target}"`)
          }
        }
        if (![...this.agents.values()].some((a) => a.group === group.id)) {
          problems.push(`场景 ${group.id} 下没有任何 Agent（目录即分组，请检查 AGENT.md 是否就位）`)
        }
        // M52：stage 席位校验（seats 引用角色须存在；§7.8）
        const seats = group.stage?.seats
        for (const ids of [seats?.left, seats?.right, seats?.center]) {
          for (const id of ids ?? []) {
            if (!this.agents.has(id)) {
              problems.push(`场景 ${group.id} 的 stage.seats 指向不存在的角色 "${id}"`)
            }
          }
        }
        // P4：ritual 声明校验（cron 合法性 + 成员跨引用；声明存在时才检查）
        if (group.ritual) {
          const ritualCheck = validateScheduleSpec(
            { kind: 'cron', expr: group.ritual.cron, tz: group.ritual.timezone },
            { defaultTz: 'UTC', minGapMs: 0 },
          )
          if (!ritualCheck.ok) {
            problems.push(`场景 ${group.id} 的 ritual.cron 非法：${ritualCheck.error ?? '无法解析'}`)
          }
          for (const member of group.ritual.members ?? []) {
            if (!this.agents.has(member)) {
              problems.push(`场景 ${group.id} 的 ritual.members 指向不存在的角色 "${member}"`)
            }
          }
        }
      }
    }
    for (const preset of this.presetList) {
      for (const member of preset.members) {
        if (!this.agents.has(member)) {
          problems.push(`预设 ${preset.id} 的成员 "${member}" 不存在（members 需引用已有角色 id）`)
        }
      }
    }
    if (this.mode === 'agents' && this.protocol.trim() === '') {
      problems.push('agents/_protocol.md 缺失或为空（全局协作协议）')
    }
    return problems
  }

  // ---------- 加载：新包目录模式 ----------

  private reloadAgents(): void {
    this.mode = 'agents'
    const agents = new Map<string, AgentDefinition>()
    const bodies = new Map<string, string>()
    const soulDocs = new Map<string, Map<string, SoulDoc>>()
    const voiceDocs = new Map<string, VoiceDoc>()
    const avatarPaths = new Map<string, string>()
    const groupList: AgentGroup[] = []
    const groupProtocols = new Map<string, string>()

    const protoFile = path.join(this.agentsDir, '_protocol.md')
    const protocol = fs.existsSync(protoFile) ? fs.readFileSync(protoFile, 'utf8') : ''

    for (const groupId of listDirs(this.agentsDir)) {
      const groupDir = path.join(this.agentsDir, groupId)

      // 场景元数据（必填）
      const groupYaml = path.join(groupDir, '_group.yaml')
      if (!fs.existsSync(groupYaml)) {
        throw new Error(`agents/${groupId}/_group.yaml：场景元数据缺失（每个场景目录必须包含 _group.yaml）`)
      }
      let groupData: unknown
      try {
        groupData = YAML.parse(fs.readFileSync(groupYaml, 'utf8'))
      } catch (err) {
        throw new Error(`agents/${groupId}/_group.yaml：YAML 解析失败 ${(err as Error).message}`)
      }
      const groupResult = AgentGroupSchema.safeParse(groupData)
      if (!groupResult.success) {
        const issue = groupResult.error.issues[0]
        throw new Error(`agents/${groupId}/_group.yaml: ${issue.path.join('.') || '内容'} ${issue.message}`)
      }
      const group = groupResult.data as AgentGroup
      if (group.id !== groupId) {
        throw new Error(`agents/${groupId}/_group.yaml：id "${group.id}" 与目录名不一致（目录即分组）`)
      }
      groupList.push(group)

      // 场景协议（可选）
      const groupProto = path.join(groupDir, '_protocol.md')
      if (fs.existsSync(groupProto)) groupProtocols.set(groupId, fs.readFileSync(groupProto, 'utf8'))

      for (const agentId of listDirs(groupDir)) {
        const agentDir = path.join(groupDir, agentId)
        const agentFile = path.join(agentDir, 'AGENT.md')
        if (!fs.existsSync(agentFile)) {
          throw new Error(`agents/${groupId}/${agentId}/AGENT.md：缺少角色定义文件（目录即 id，文件名必须为 AGENT.md）`)
        }
        const raw = fs.readFileSync(agentFile, 'utf8')
        const { data, body } = parseFrontMatter(raw)
        if (data !== null && typeof data === 'object' && 'group' in (data as Record<string, unknown>)) {
          throw new Error(`agents/${groupId}/${agentId}/AGENT.md：group 由目录推导，请勿在 front-matter 手写`)
        }
        const result = AgentFrontMatterSchema.safeParse(data)
        if (!result.success) {
          const issue = result.error.issues[0]
          throw new Error(`agents/${groupId}/${agentId}/AGENT.md: ${issue.path.join('.') || 'front-matter'} ${issue.message}`)
        }
        const agent = result.data as AgentDefinition
        if (agent.id !== agentId) {
          throw new Error(`agents/${groupId}/${agentId}/AGENT.md：id "${agent.id}" 与目录名不一致（目录即 id）`)
        }
        if (agents.has(agent.id)) {
          throw new Error(`agents/${groupId}/${agentId}/AGENT.md：id "${agent.id}" 与已有角色重复（跨场景全局唯一）`)
        }
        agent.group = groupId

        // 灵魂变体（可选目录）
        const soulsDir = path.join(agentDir, 'souls')
        const docMap = new Map<string, SoulDoc>()
        if (fs.existsSync(soulsDir)) {
          for (const soulFile of fs.readdirSync(soulsDir).filter((f) => f.endsWith('.md')).sort()) {
            const stem = soulFile.replace(/\.md$/, '')
            const soulRaw = fs.readFileSync(path.join(soulsDir, soulFile), 'utf8')
            const soulDoc = parseFrontMatter(soulRaw)
            const soulResult = SoulFrontMatterSchema.safeParse(soulDoc.data)
            if (!soulResult.success) {
              const issue = soulResult.error.issues[0]
              throw new Error(
                `agents/${groupId}/${agentId}/souls/${soulFile}: ${issue.path.join('.') || 'front-matter'} ${issue.message}`,
              )
            }
            const parsedSoul = soulResult.data
            const soulId = parsedSoul.id ?? stem
            if (soulId !== stem) {
              throw new Error(`agents/${groupId}/${agentId}/souls/${soulFile}：id "${soulId}" 与文件名不一致`)
            }
            if (docMap.has(soulId)) {
              throw new Error(`agents/${groupId}/${agentId}/souls/${soulFile}：灵魂 id "${soulId}" 重复`)
            }
            const meta: SoulMeta = {
              id: soulId,
              name: parsedSoul.name,
              tagline: parsedSoul.tagline,
              traits: parsedSoul.traits,
              tone: parsedSoul.tone,
            }
            if (parsedSoul.icon) meta.icon = parsedSoul.icon
            docMap.set(soulId, { meta, quirks: parsedSoul.quirks, body: soulDoc.body })
          }
        }
        const frontSoul = result.data.soul
        if (docMap.size > 0) {
          agent.souls = [...docMap.values()].map((d) => d.meta)
          if (frontSoul && !docMap.has(frontSoul)) {
            throw new Error(`agents/${groupId}/${agentId}/AGENT.md：soul "${frontSoul}" 在 souls/ 下不存在`)
          }
          const defaultSoul = frontSoul ?? (docMap.has('default') ? 'default' : undefined)
          if (defaultSoul) agent.defaultSoul = defaultSoul
          soulDocs.set(agent.id, docMap)
        } else if (frontSoul) {
          throw new Error(`agents/${groupId}/${agentId}/AGENT.md：指定了 soul "${frontSoul}"，但 souls/ 目录不存在或为空`)
        }

        // 头像自动发现（front-matter 显式 image 时让位）
        const avatarPath = path.join(agentDir, 'avatar.png')
        if (fs.existsSync(avatarPath)) {
          avatarPaths.set(agent.id, avatarPath)
          if (!agent.avatar.image) agent.avatar.image = `/api/agents/${agent.id}/avatar`
        }

        // 声纹（P1 去 AI 化，可选文件 voice.md；解析失败不阻塞加载，告警即可）
        const voicePath = path.join(agentDir, 'voice.md')
        if (fs.existsSync(voicePath)) {
          try {
            const voiceRaw = fs.readFileSync(voicePath, 'utf8')
            const voiceBody = voiceRaw.startsWith('---') ? parseFrontMatter(voiceRaw).body : voiceRaw
            voiceDocs.set(agent.id, parseVoiceDoc(voiceBody))
          } catch (err) {
            this.warn(`agents/${groupId}/${agentId}/voice.md 解析失败（已跳过）：${(err as Error).message}`)
          }
        }

        // 场景默认技能：agent 未显式配置 skills 时生效
        if (agent.skills === undefined && group.defaultSkills.length > 0) {
          agent.skills = [...group.defaultSkills]
        }

        agents.set(agent.id, agent)
        bodies.set(agent.id, body)
      }
    }

    groupList.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))

    // 快速组队预设（可选文件；缺失 / 为空时保持 [] → 前端隐藏该区块）
    const presetList: RosterPreset[] = []
    const presetFile = path.join(this.agentsDir, '_presets.yaml')
    if (fs.existsSync(presetFile)) {
      let presetData: unknown
      try {
        presetData = YAML.parse(fs.readFileSync(presetFile, 'utf8')) ?? {}
      } catch (err) {
        throw new Error(`agents/_presets.yaml：YAML 解析失败 ${(err as Error).message}`)
      }
      const presetResult = PresetFileSchema.safeParse(presetData)
      if (!presetResult.success) {
        const issue = presetResult.error.issues[0]
        throw new Error(`agents/_presets.yaml: ${issue.path.join('.') || '内容'} ${issue.message}`)
      }
      for (const preset of presetResult.data.presets as RosterPreset[]) {
        if (presetList.some((p) => p.id === preset.id)) {
          throw new Error(`agents/_presets.yaml：预设 id "${preset.id}" 重复（全局唯一）`)
        }
        presetList.push(preset)
      }
      presetList.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    }

    this.groupList = groupList
    this.agents = agents
    this.bodies = bodies
    this.soulDocs = soulDocs
    this.voiceDocs = voiceDocs
    this.avatarPaths = avatarPaths
    this.groupProtocols = groupProtocols
    this.presetList = presetList
    this.protocol = protocol
  }

  // ---------- 加载：旧 prompts/ 回退模式 ----------

  private reloadLegacy(): void {
    this.mode = 'legacy'
    const agents = new Map<string, AgentDefinition>()
    const bodies = new Map<string, string>()
    let protocol = ''

    if (fs.existsSync(this.promptsDir)) {
      const files = fs.readdirSync(this.promptsDir).filter((f) => f.endsWith('.md'))
      for (const file of files) {
        // 变更日志等说明文档不是角色定义（如 prompts/CHANGELOG.md）
        if (file === 'CHANGELOG.md') continue
        const full = path.join(this.promptsDir, file)
        const raw = fs.readFileSync(full, 'utf8')
        if (file.startsWith('_')) {
          // 全局协议文档（_protocol.md）
          protocol = raw
          continue
        }
        const parsed = parseFrontMatter(raw)
        const result = AgentFrontMatterSchema.safeParse(parsed.data)
        if (!result.success) {
          const issue = result.error.issues[0]
          throw new Error(`${file}: ${issue.path.join('.') || 'front-matter'} ${issue.message}`)
        }
        const agent = result.data as AgentDefinition
        if (agents.has(agent.id)) {
          throw new Error(`${file}: id "${agent.id}" 与已有角色重复`)
        }
        agent.group = 'development'
        agents.set(agent.id, agent)
        bodies.set(agent.id, parsed.body)
      }
    }

    if (agents.size > 0) {
      this.warn(
        '[agents] 未找到 agents/ 目录，按旧版 prompts/ 逻辑加载（无分组 / 无灵魂）。建议运行 `npm run migrate:agents` 迁移，详见 agents/README.md',
      )
    }

    this.groupList = agents.size > 0 ? [LEGACY_GROUP] : []
    this.agents = agents
    this.bodies = bodies
    this.soulDocs = new Map()
    this.avatarPaths = new Map()
    this.groupProtocols = new Map()
    this.presetList = []
    this.protocol = protocol
  }

  // ---------- 热更新（mtime 签名比对） ----------

  private collectFiles(): Map<string, number> {
    const files = new Map<string, number>()
    const stat = (p: string): number => {
      try {
        return fs.statSync(p).mtimeMs
      } catch {
        return -1
      }
    }
    if (this.mode === 'agents') {
      if (!fs.existsSync(this.agentsDir)) return files
      const proto = path.join(this.agentsDir, '_protocol.md')
      if (fs.existsSync(proto)) files.set(proto, stat(proto))
      const presets = path.join(this.agentsDir, '_presets.yaml')
      if (fs.existsSync(presets)) files.set(presets, stat(presets))
      for (const g of listDirs(this.agentsDir)) {
        const groupDir = path.join(this.agentsDir, g)
        for (const name of ['_group.yaml', '_protocol.md']) {
          const f = path.join(groupDir, name)
          if (fs.existsSync(f)) files.set(f, stat(f))
        }
        for (const a of listDirs(groupDir)) {
          const agentDir = path.join(groupDir, a)
          const agentFile = path.join(agentDir, 'AGENT.md')
          if (fs.existsSync(agentFile)) files.set(agentFile, stat(agentFile))
          const avatar = path.join(agentDir, 'avatar.png')
          if (fs.existsSync(avatar)) files.set(avatar, 0)
          const soulsDir = path.join(agentDir, 'souls')
          if (fs.existsSync(soulsDir)) {
            for (const s of fs.readdirSync(soulsDir)) {
              if (!s.endsWith('.md')) continue
              const soulFile = path.join(soulsDir, s)
              files.set(soulFile, stat(soulFile))
            }
          }
        }
      }
      return files
    }
    if (fs.existsSync(this.promptsDir)) {
      for (const f of fs.readdirSync(this.promptsDir).filter((f) => f.endsWith('.md'))) {
        const full = path.join(this.promptsDir, f)
        files.set(full, stat(full))
      }
    }
    return files
  }

  private maybeReload(): void {
    try {
      // 模式切换检测：agents/ 出现即升级（运行中完成迁移也可热生效）；消失即回退
      const hasAgents = fs.existsSync(this.agentsDir)
      if ((this.mode === 'agents') !== hasAgents) {
        this.reload()
        return
      }
      const current = this.collectFiles()
      let changed = current.size !== this.files.size
      if (!changed) {
        for (const [file, mtime] of current) {
          if (this.files.get(file) !== mtime) {
            changed = true
            break
          }
        }
      }
      if (changed) this.reload()
    } catch (err) {
      // 热更新失败保留旧数据，仅告警（不影响正在进行的会话）
      this.warn(`[agents] 热更新失败，保留旧版本：${(err as Error).message}`)
    }
  }
}

/**
 * M26：资产控制台写盘入口（AssetManager）。
 *
 * agents/ 与 skills/ 目录仍是唯一事实源，本类是控制台唯一写盘通道：
 *   zod 校验 → 固定字段顺序序列化（与仓库手写风格一致）→ 写前自检
 *   （重新解析比对 front-matter 与正文）→ 同目录 .tmp + rename 原子写。
 * 删除一律软删除到 data/trash/assets/<时间戳>/<相对路径>（本产品无 Git，
 * 回收站兜底）；删除 / 覆盖前由调用方检查引用（409 返回引用清单）。
 * 每次写盘后主动 reload PromptLibrary / SkillLibrary（mtime 热更新之外的
 * 双保险）；本类不做通知，notify:assets-changed 由路由层发布。
 */
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import type {
  AgentAvatar,
  AgentCreateInput,
  AgentDefinition,
  AgentGroup,
  AgentWriteInput,
  AssetRefs,
  ConsoleAgentDetail,
  ConsoleAgentSummary,
  ConsoleSkillDetail,
  ConsoleSkillSummary,
  ConsoleSoulDetail,
  GroupWriteInput,
  SkillWriteInput,
  SoulWriteInput,
  ValidationIssue,
} from '@multi-agent/shared'
import type { PromptLibrary } from '../store/prompts.js'
import { AgentFrontMatterSchema, AgentGroupSchema, parseFrontMatter, SoulFrontMatterSchema } from '../store/prompts.js'
import type { SkillLibrary } from '../store/skills.js'
import { SkillFrontMatterSchema } from '../store/skills.js'
import type { SessionStore } from '../store/sessions.js'

/** id / 技能名 / 场景名的统一安全约束（防路径穿越） */
const ID_RE = /^[a-z][a-z0-9-]{0,39}$/

/** 头像 PNG magic（仅按文件头校验，≤8MB） */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const AVATAR_MAX_BYTES = 8 * 1024 * 1024

/** 序列化字段顺序（与仓库既有 AGENT.md 风格一致） */
const AGENT_FIELD_ORDER = ['id', 'name', 'role', 'title', 'description', 'capabilities', 'catalog', 'avatar', 'soul', 'handoff', 'tools', 'skills', 'model', 'temperature']
const SOUL_FIELD_ORDER = ['id', 'name', 'tagline', 'icon', 'traits', 'tone', 'quirks']
const GROUP_FIELD_ORDER = ['id', 'name', 'category', 'catalog', 'description', 'icon', 'theme', 'objective', 'chain', 'defaultSkills', 'parallel', 'rounds', 'parallelMax', 'order']
const SKILL_FIELD_ORDER = ['name', 'description', 'tags']

export class AssetNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AssetNotFoundError'
  }
}

/** 引用冲突（删除前需二次确认；refs 为影响面清单） */
export class AssetConflictError extends Error {
  constructor(
    message: string,
    readonly refs: string[],
  ) {
    super(message)
    this.name = 'AssetConflictError'
  }
}

/** 校验失败（id 不合法 / front-matter 不符 / 写前自检失败等） */
export class AssetValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AssetValidationError'
  }
}

/** 控制台读到的原始资产（直接来自磁盘，不走 PromptLibrary 的场景兜底展开） */
interface RawAgent {
  group: string
  dir: string
  meta: AgentDefinition
  /** front-matter 显式 soul 字段原值（AgentDefinition 公开类型未声明；仅删除灵魂时用于清理） */
  explicitSoul?: string
  /** 标准化后的正文（去除前导空行与尾部空白） */
  body: string
}

export interface AssetManagerOptions {
  agentsDir: string
  skillsDir: string
  /** 软删除回收站根目录（data/trash/assets） */
  trashDir: string
  prompts: PromptLibrary
  skills: SkillLibrary
  sessions: SessionStore
  /** 已知工具名（写白名单时校验；缺省 = 不校验） */
  toolNames?: () => string[]
}

// ---------- 序列化（与仓库手写 YAML 风格一致：内联数组 + 块式对象） ----------

/** YAML 标量（可裸写则裸写，含特殊字符自动加引号） */
function scalar(value: string | number | boolean): string {
  return YAML.stringify(value).trimEnd()
}

function formatInline(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => formatInline(item)).join(', ')}]`
  }
  if (value !== null && typeof value === 'object') return '{}' // 更深嵌套不支持（现有资产无此形态）
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return scalar(String(value ?? ''))
}

function serializeEntry(key: string, value: unknown): string {
  if (Array.isArray(value)) return `${key}: ${formatInline(value)}`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
    if (entries.length === 0) return `${key}: {}`
    return `${key}:\n${entries.map(([k, v]) => `  ${k}: ${formatInline(v)}`).join('\n')}`
  }
  return `${key}: ${formatInline(value)}`
}

/** 固定字段顺序 → front-matter 文本行（undefined 键省略，未知键追加在末尾） */
function serializeFrontMatter(data: Record<string, unknown>, order: string[]): string {
  const keys = [
    ...order.filter((key) => data[key] !== undefined),
    ...Object.keys(data).filter((key) => !order.includes(key) && data[key] !== undefined),
  ]
  return keys.map((key) => serializeEntry(key, data[key])).join('\n')
}

/** 稳定 JSON（键排序 + 丢弃 undefined）：写前自检的往返比对 */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`
}

/** 正文标准化：去除前导空行与尾部空白（编辑器往返与热更新约定一致） */
function normalizeBody(raw: string): string {
  return raw.replace(/^\n+/, '').replace(/\s+$/, '')
}

/** 列出子目录（跳过隐藏目录与 `_` 前缀目录；与 PromptLibrary 扫描规则一致） */
function listDirs(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_'))
    .map((d) => d.name)
    .sort()
}

export class AssetManager {
  private readonly agentsDir: string
  private readonly skillsDir: string
  private readonly trashDir: string
  private readonly prompts: PromptLibrary
  private readonly skills: SkillLibrary
  private readonly sessions: SessionStore
  private readonly toolNames?: () => string[]

  constructor(opts: AssetManagerOptions) {
    this.agentsDir = opts.agentsDir
    this.skillsDir = opts.skillsDir
    this.trashDir = opts.trashDir
    this.prompts = opts.prompts
    this.skills = opts.skills
    this.sessions = opts.sessions
    this.toolNames = opts.toolNames
  }

  // ---------- 读取：Agent ----------

  /** 角色清单（含引用计数；破损文件仍列出，问题由 validate() 汇总） */
  listAgents(): ConsoleAgentSummary[] {
    const refIndex = this.agentRefIndex()
    return this.prompts.list().map((agent) => {
      const loc = this.locate(agent.id)
      let meta = agent
      if (loc) {
        try {
          meta = this.readAgentRaw(agent.id)?.meta ?? agent
        } catch {
          // 破损文件：保留列表项，细节见 validate()
        }
      }
      const dir = loc?.dir ?? this.agentDirPath(agent.group, agent.id)
      // souls 来自 souls/ 目录扫描（PromptLibrary），raw front-matter 不含；合并后摘要才能显示灵魂数
      const loaded = this.prompts.get(agent.id)
      const summaryMeta = loaded?.souls && !meta.souls ? { ...meta, souls: loaded.souls } : meta
      return this.toSummary(summaryMeta, agent.group, dir, refIndex.get(agent.id) ?? [])
    })
  }

  getAgent(id: string): ConsoleAgentDetail {
    this.assertId(id, '角色 id')
    const raw = this.readAgentRaw(id)
    if (!raw) throw new AssetNotFoundError(`角色 "${id}" 不存在`)
    const refs = this.references(id).items
    const meta: AgentDefinition = { ...raw.meta, group: raw.group }
    const loaded = this.prompts.get(id)
    if (loaded?.souls) meta.souls = loaded.souls
    if (loaded?.defaultSoul) meta.defaultSoul = loaded.defaultSoul
    const summary = this.toSummary(meta, raw.group, raw.dir, refs)
    return { ...summary, meta, body: raw.body, souls: this.listSouls(raw), refs: { items: refs } }
  }

  // ---------- 写入：Agent ----------

  createAgent(input: AgentCreateInput): ConsoleAgentDetail {
    this.assertWritableMode()
    this.assertId(input.id, '角色 id')
    const { meta, body } = this.buildMeta(input.id, input)
    if (this.agentExists(input.id)) throw new AssetConflictError(`角色 id "${input.id}" 已被占用（id 跨场景全局唯一）`, [])
    const groupIds = new Set(this.prompts.groups().map((g) => g.id))
    if (input.newGroup) {
      if (input.newGroup.id !== input.group) throw new AssetValidationError('newGroup.id 必须与 group 一致')
      if (groupIds.has(input.group) || fs.existsSync(this.groupDir(input.group))) {
        throw new AssetConflictError(`场景 "${input.group}" 已存在`, [])
      }
      this.createGroup(input.newGroup)
    } else if (!groupIds.has(input.group)) {
      throw new AssetValidationError(`场景 "${input.group}" 不存在（可随向导一并新建场景）`)
    }
    this.writeAgentFile(this.agentDirPath(input.group, input.id), meta, body)
    this.reloadLibraries()
    return this.getAgent(input.id)
  }

  updateAgent(id: string, input: AgentWriteInput): ConsoleAgentDetail {
    this.assertWritableMode()
    this.assertId(id, '角色 id')
    const raw = this.readAgentRaw(id)
    if (!raw) throw new AssetNotFoundError(`角色 "${id}" 不存在`)
    const { meta, body } = this.buildMeta(id, { ...input, catalog: input.catalog === undefined ? raw.meta.catalog : input.catalog }, raw.dir)
    this.writeAgentFile(raw.dir, meta, body)
    this.reloadLibraries()
    return this.getAgent(id)
  }

  duplicateAgent(id: string): ConsoleAgentDetail {
    this.assertWritableMode()
    this.assertId(id, '角色 id')
    const raw = this.readAgentRaw(id)
    if (!raw) throw new AssetNotFoundError(`角色 "${id}" 不存在`)
    let newId = `${id}-copy`
    let n = 2
    while (this.agentExists(newId)) newId = `${id}-copy-${n++}`
    const destDir = this.agentDirPath(raw.group, newId)
    fs.cpSync(raw.dir, destDir, { recursive: true })
    const meta: AgentDefinition = { ...raw.meta, id: newId, name: `${raw.meta.name}（副本）` }
    this.writeAgentFile(destDir, meta, raw.body)
    this.reloadLibraries()
    return this.getAgent(newId)
  }

  /** 软删除：无引用或 force=true 时移入回收站；组内最后一个角色 = 整组移入 */
  deleteAgent(id: string, force: boolean): { deletedGroup: boolean; refs: string[] } {
    this.assertWritableMode()
    this.assertId(id, '角色 id')
    const raw = this.readAgentRaw(id)
    if (!raw) throw new AssetNotFoundError(`角色 "${id}" 不存在`)
    const refs = this.references(id).items
    if (refs.length > 0 && !force) {
      throw new AssetConflictError(`角色 "${id}" 被 ${refs.length} 处引用，删除前请确认影响面`, refs)
    }
    const siblings = this.agentSiblings(raw.group, id)
    if (siblings.length === 0) {
      this.moveToTrash(this.groupDir(raw.group), `agents/${raw.group}`)
      this.reloadLibraries()
      return { deletedGroup: true, refs }
    }
    this.moveToTrash(raw.dir, `agents/${raw.group}/${id}`)
    this.reloadLibraries()
    return { deletedGroup: false, refs }
  }

  // ---------- 写入：头像 / 灵魂 ----------

  writeAvatar(id: string, base64: string): ConsoleAgentDetail {
    this.assertWritableMode()
    this.assertId(id, '角色 id')
    const raw = this.readAgentRaw(id)
    if (!raw) throw new AssetNotFoundError(`角色 "${id}" 不存在`)
    const cleaned = base64.replace(/^data:image\/\w+;base64,/, '')
    const buf = Buffer.from(cleaned, 'base64')
    if (buf.length === 0) throw new AssetValidationError('头像数据为空')
    if (buf.length > AVATAR_MAX_BYTES) throw new AssetValidationError('头像不得超过 8MB（PNG）')
    if (!PNG_MAGIC.every((byte, i) => buf[i] === byte)) {
      throw new AssetValidationError('仅支持 PNG 图片（文件头校验失败）')
    }
    this.atomicWrite(path.join(raw.dir, 'avatar.png'), buf)
    this.reloadLibraries()
    return this.getAgent(id)
  }

  deleteAvatar(id: string): ConsoleAgentDetail {
    this.assertWritableMode()
    this.assertId(id, '角色 id')
    const raw = this.readAgentRaw(id)
    if (!raw) throw new AssetNotFoundError(`角色 "${id}" 不存在`)
    const file = path.join(raw.dir, 'avatar.png')
    if (!fs.existsSync(file)) throw new AssetNotFoundError(`角色 "${id}" 未配置头像`)
    this.moveToTrash(file, `agents/${raw.group}/${id}/avatar.png`)
    this.reloadLibraries()
    return this.getAgent(id)
  }

  writeSoul(agentId: string, soulId: string, input: SoulWriteInput): ConsoleAgentDetail {
    this.assertWritableMode()
    this.assertId(agentId, '角色 id')
    this.assertId(soulId, '灵魂 id')
    const raw = this.readAgentRaw(agentId)
    if (!raw) throw new AssetNotFoundError(`角色 "${agentId}" 不存在`)
    const candidate: Record<string, unknown> = {
      id: soulId,
      name: input.name,
      tagline: input.tagline ?? '',
      traits: input.traits ?? [],
      tone: input.tone ?? '',
      quirks: input.quirks ?? [],
    }
    if (input.icon) candidate.icon = input.icon
    const result = SoulFrontMatterSchema.safeParse(candidate)
    if (!result.success) {
      const issue = result.error.issues[0]
      throw new AssetValidationError(`灵魂 front-matter：${issue.path.join('.') || '内容'} ${issue.message}`)
    }
    const soul = result.data as Record<string, unknown>
    const body = normalizeBody(input.body)
    if (!body) throw new AssetValidationError('灵魂正文不能为空')
    const label = `agents/${raw.group}/${agentId}/souls/${soulId}.md`
    const text = `---\n${serializeFrontMatter(soul, SOUL_FIELD_ORDER)}\n---\n\n${body}\n`
    this.verifyDocument(label, text, soul, body)
    this.atomicWrite(path.join(raw.dir, 'souls', `${soulId}.md`), text)
    if (input.setDefault) this.patchAgentField(raw, { soul: soulId })
    this.reloadLibraries()
    return this.getAgent(agentId)
  }

  deleteSoul(agentId: string, soulId: string): ConsoleAgentDetail {
    this.assertWritableMode()
    this.assertId(agentId, '角色 id')
    this.assertId(soulId, '灵魂 id')
    const raw = this.readAgentRaw(agentId)
    if (!raw) throw new AssetNotFoundError(`角色 "${agentId}" 不存在`)
    const file = path.join(raw.dir, 'souls', `${soulId}.md`)
    if (!fs.existsSync(file)) throw new AssetNotFoundError(`灵魂 "${soulId}" 不存在`)
    this.moveToTrash(file, `agents/${raw.group}/${agentId}/souls/${soulId}.md`)
    // 显式 soul 指向被删灵魂时必须清字段，否则 PromptLibrary 拒绝加载
    if (raw.explicitSoul === soulId) this.patchAgentField(raw, { soul: undefined })
    this.reloadLibraries()
    return this.getAgent(agentId)
  }

  // ---------- 场景 ----------

  /** 新建场景（_group.yaml；供新建向导与二期场景管理共用） */
  createGroup(input: GroupWriteInput): AgentGroup {
    this.assertWritableMode()
    this.assertId(input.id, '场景 id')
    if (fs.existsSync(this.groupDir(input.id))) throw new AssetConflictError(`场景 "${input.id}" 已存在`, [])
    const candidate = {
      id: input.id,
      name: input.name,
      description: input.description ?? '',
      icon: input.icon ?? 'user',
      theme: input.theme ?? (['#64748b', '#94a3b8'] as [string, string]),
      objective: input.objective ?? '',
      category: input.category,
      catalog: input.catalog,
      chain: [],
      defaultSkills: [],
      parallel: false,
      rounds: false,
      order: 100,
    }
    const result = AgentGroupSchema.safeParse(candidate)
    if (!result.success) {
      const issue = result.error.issues[0]
      throw new AssetValidationError(`场景元数据：${issue.path.join('.') || '内容'} ${issue.message}`)
    }
    const group = result.data as AgentGroup
    const text = `${serializeFrontMatter(group as unknown as Record<string, unknown>, GROUP_FIELD_ORDER)}\n`
    let data: unknown
    try {
      data = YAML.parse(text)
    } catch (err) {
      throw new AssetValidationError(`写前自检失败（agents/${input.id}/_group.yaml）：${(err as Error).message}`)
    }
    const reparsed = AgentGroupSchema.safeParse(data)
    if (!reparsed.success || stableJson(reparsed.data) !== stableJson(group)) {
      throw new AssetValidationError(`写前自检失败（agents/${input.id}/_group.yaml）：序列化往返不一致`)
    }
    this.atomicWrite(path.join(this.groupDir(input.id), '_group.yaml'), text)
    this.reloadLibraries()
    return group
  }

  // ---------- 读取 / 写入：Skill ----------

  listSkills(): ConsoleSkillSummary[] {
    const refIndex = this.skillRefIndex()
    return this.skills.list().map((skill) => {
      const record = this.skills.get(skill.name)
      const body = record ? normalizeBody(record.body) : ''
      const refs = refIndex.get(skill.name)
      return {
        name: skill.name,
        description: skill.description,
        tags: skill.tags,
        lineCount: body ? body.split('\n').length : 0,
        usedByAgents: refs?.agents ?? [],
        usedByGroups: refs?.groups ?? [],
      }
    })
  }

  getSkill(name: string): ConsoleSkillDetail {
    this.assertId(name, '技能名')
    const file = path.join(this.skillsDir, name, 'SKILL.md')
    if (!fs.existsSync(file)) throw new AssetNotFoundError(`技能 "${name}" 不存在`)
    const parsed = this.parseSkillFile(name, fs.readFileSync(file, 'utf8'))
    const body = normalizeBody(parsed.body)
    const refs = this.skillRefIndex().get(name)
    const items = [
      ...(refs?.agents ?? []).map((id) => `角色 ${id} 的预载技能`),
      ...(refs?.groups ?? []).map((id) => `场景 ${id} 的默认技能`),
    ]
    return {
      name,
      description: parsed.meta.description,
      tags: parsed.meta.tags,
      lineCount: body ? body.split('\n').length : 0,
      usedByAgents: refs?.agents ?? [],
      usedByGroups: refs?.groups ?? [],
      body,
      refs: { items },
    }
  }

  createSkill(name: string, input: SkillWriteInput): ConsoleSkillDetail {
    this.assertId(name, '技能名')
    if (fs.existsSync(path.join(this.skillsDir, name))) {
      throw new AssetConflictError(`技能 "${name}" 已存在（name 即目录名，全局唯一）`, [])
    }
    this.writeSkillFile(name, input)
    try {
      this.skills.reload()
    } catch (err) {
      throw new AssetValidationError(`写盘完成，但技能库重载失败：${(err as Error).message}`)
    }
    return this.getSkill(name)
  }

  updateSkill(name: string, input: SkillWriteInput): ConsoleSkillDetail {
    this.assertId(name, '技能名')
    const file = path.join(this.skillsDir, name, 'SKILL.md')
    if (!fs.existsSync(file)) throw new AssetNotFoundError(`技能 "${name}" 不存在`)
    this.writeSkillFile(name, input)
    try {
      this.skills.reload()
    } catch (err) {
      throw new AssetValidationError(`写盘完成，但技能库重载失败：${(err as Error).message}`)
    }
    return this.getSkill(name)
  }

  /** 软删除：默认拒绝有引用；force=true 时移入回收站（引用方仅告警，不自动清理） */
  deleteSkill(name: string, force: boolean): { refs: string[] } {
    this.assertId(name, '技能名')
    const dir = path.join(this.skillsDir, name)
    if (!fs.existsSync(dir)) throw new AssetNotFoundError(`技能 "${name}" 不存在`)
    const refs = this.skillRefIndex().get(name)
    const items = [
      ...(refs?.agents ?? []).map((id) => `角色 ${id} 的预载技能`),
      ...(refs?.groups ?? []).map((id) => `场景 ${id} 的默认技能`),
    ]
    if (items.length > 0 && !force) {
      throw new AssetConflictError(`技能 "${name}" 被 ${items.length} 处引用，删除前请确认影响面`, items)
    }
    this.moveToTrash(dir, `skills/${name}`)
    try {
      this.skills.reload()
    } catch (err) {
      throw new AssetValidationError(`删除完成，但技能库重载失败：${(err as Error).message}`)
    }
    return { refs: items }
  }

  // ---------- 引用索引（删除 / 修改前的影响面） ----------

  references(id: string): AssetRefs {
    return { items: this.agentRefIndex().get(id) ?? [] }
  }

  /** 工具白名单使用情况（工具中心列用）：工具名 → 引用该工具的角色 id */
  toolUsage(): Map<string, string[]> {
    const usage = new Map<string, string[]>()
    for (const agent of this.prompts.list()) {
      let tools: string[] | undefined
      try {
        tools = this.readAgentRaw(agent.id)?.meta.tools
      } catch {
        tools = agent.tools
      }
      for (const name of tools ?? []) {
        const list = usage.get(name) ?? []
        list.push(agent.id)
        usage.set(name, list)
      }
    }
    return usage
  }

  // ---------- 校验聚合（页头徽章 / 校验中心） ----------

  /** 汇总 PromptLibrary 解析与语义问题 + skills 目录结构扫描 + 技能跨引用（异常转 issue，不 500） */
  validate(): ValidationIssue[] {
    const issues: ValidationIssue[] = []
    if (this.prompts.currentMode() === 'legacy') {
      issues.push({
        level: 'warning',
        path: 'agents/',
        message: '当前为 prompts/ 回退模式：控制台不可写，请运行 npm run migrate:agents 迁移后编辑',
      })
    }
    try {
      for (const problem of this.prompts.validate()) issues.push(mapPromptProblem(problem))
    } catch (err) {
      issues.push({ level: 'error', path: 'agents/', message: `资产加载失败：${(err as Error).message}` })
    }
    issues.push(...this.skillStructureIssues())
    issues.push(...this.skillRefIssues())
    return issues
  }

  // ---------- 内部：定位与读取 ----------

  private assertWritableMode(): void {
    if (this.prompts.currentMode() !== 'agents' || !fs.existsSync(this.agentsDir)) {
      throw new AssetValidationError('当前资产库为 prompts/ 回退模式：请先运行 npm run migrate:agents 迁移后再使用控制台编辑')
    }
  }

  private assertId(value: string, label: string): void {
    if (!ID_RE.test(value)) {
      throw new AssetValidationError(`${label} "${value}" 不合法：需以小写字母开头，仅含小写字母、数字与连字符（1-40 位）`)
    }
  }

  private groupDir(groupId: string): string {
    return path.join(this.agentsDir, groupId)
  }

  private agentDirPath(groupId: string, id: string): string {
    return path.join(this.agentsDir, groupId, id)
  }

  private locate(id: string): { group: string; dir: string } | undefined {
    const found = this.prompts.get(id)
    if (!found || this.prompts.currentMode() !== 'agents') return undefined
    return { group: found.group, dir: this.agentDirPath(found.group, id) }
  }

  private existingGroups(): string[] {
    if (!fs.existsSync(this.agentsDir)) return []
    return listDirs(this.agentsDir)
  }

  private agentExists(id: string): boolean {
    return this.existingGroups().some((group) => fs.existsSync(path.join(this.agentsDir, group, id, 'AGENT.md')))
  }

  /** 组内其它角色（含未加载的损毁目录，避免误删整组） */
  private agentSiblings(groupId: string, excludeId: string): string[] {
    const dir = this.groupDir(groupId)
    if (!fs.existsSync(dir)) return []
    return listDirs(dir).filter((name) => name !== excludeId && fs.existsSync(path.join(dir, name, 'AGENT.md')))
  }

  /** 读原始 AGENT.md（不经 PromptLibrary 场景兜底展开）；文件缺失返回 undefined，结构破损抛 400 */
  private readAgentRaw(id: string): RawAgent | undefined {
    if (this.prompts.currentMode() !== 'agents') {
      const legacy = this.prompts.get(id)
      if (!legacy) return undefined
      return { group: legacy.group, dir: this.agentDirPath(legacy.group, id), meta: legacy, body: normalizeBody(this.prompts.body(id)) }
    }
    const loc = this.locate(id)
    if (!loc) return undefined
    const file = path.join(loc.dir, 'AGENT.md')
    if (!fs.existsSync(file)) return undefined
    const label = `agents/${loc.group}/${id}/AGENT.md`
    try {
      const doc = parseFrontMatter(fs.readFileSync(file, 'utf8'))
      if (doc.data !== null && typeof doc.data === 'object' && 'group' in (doc.data as Record<string, unknown>)) {
        throw new Error('group 由目录推导，请勿在 front-matter 手写')
      }
      const result = AgentFrontMatterSchema.safeParse(doc.data)
      if (!result.success) {
        const issue = result.error.issues[0]
        throw new Error(`${issue.path.join('.') || 'front-matter'} ${issue.message}`)
      }
      const meta = result.data as AgentDefinition
      if (meta.id !== id) throw new Error(`id "${meta.id}" 与目录名不一致（目录即 id）`)
      const explicitSoul = (result.data as { soul?: string }).soul
      const raw: RawAgent = { group: loc.group, dir: loc.dir, meta, body: normalizeBody(doc.body) }
      if (explicitSoul) raw.explicitSoul = explicitSoul
      return raw
    } catch (err) {
      throw new AssetValidationError(`${label}：${(err as Error).message}`)
    }
  }

  private toSummary(meta: AgentDefinition, group: string, dir: string, refs: string[]): ConsoleAgentSummary {
    const hasAvatar = fs.existsSync(path.join(dir, 'avatar.png'))
    const avatar: AgentAvatar = { ...meta.avatar }
    if (hasAvatar && !avatar.image) avatar.image = `/api/agents/${meta.id}/avatar`
    return {
      id: meta.id,
      name: meta.name,
      role: meta.role,
      title: meta.title,
      description: meta.description,
      group,
      avatar,
      hasAvatar,
      skillCount: meta.skills ? meta.skills.length : -1,
      toolCount: meta.tools ? meta.tools.length : -1,
      soulCount: meta.souls?.length ?? 0,
      handoffCount: meta.handoff.length,
      refCount: refs.length,
    }
  }

  private listSouls(raw: RawAgent): ConsoleSoulDetail[] {
    const soulsDir = path.join(raw.dir, 'souls')
    if (!fs.existsSync(soulsDir)) return []
    const loaded = this.prompts.get(raw.meta.id)
    const out: ConsoleSoulDetail[] = []
    for (const file of fs.readdirSync(soulsDir).filter((f) => f.endsWith('.md')).sort()) {
      const soulId = file.replace(/\.md$/, '')
      const doc = this.prompts.soul(raw.meta.id, soulId)
      if (!doc) continue // 无法解析的灵魂不会进入 PromptLibrary，问题由 validate() 汇总
      const item: ConsoleSoulDetail = {
        id: soulId,
        name: doc.meta.name,
        tagline: doc.meta.tagline,
        traits: doc.meta.traits,
        tone: doc.meta.tone,
        quirks: doc.quirks,
        body: normalizeBody(doc.body),
        isDefault: loaded?.defaultSoul === soulId,
      }
      if (doc.meta.icon) item.icon = doc.meta.icon
      out.push(item)
    }
    return out
  }

  private parseSkillFile(name: string, raw: string): { meta: { description: string; tags: string[] }; body: string } {
    const label = `skills/${name}/SKILL.md`
    try {
      const doc = parseFrontMatter(raw)
      const result = SkillFrontMatterSchema.safeParse(doc.data)
      if (!result.success) {
        const issue = result.error.issues[0]
        throw new Error(`${issue.path.join('.') || 'front-matter'} ${issue.message}`)
      }
      if (result.data.name !== name) throw new Error(`name "${result.data.name}" 与目录名不一致`)
      return { meta: { description: result.data.description, tags: result.data.tags }, body: doc.body }
    } catch (err) {
      throw new AssetValidationError(`${label}：${(err as Error).message}`)
    }
  }

  // ---------- 内部：构造与写盘 ----------

  /** 由入参构造白名单 front-matter（zod 校验 + 工具名/灵魂存在性检查）；soulDir = 更新时用于校验灵魂 */
  private buildMeta(id: string, input: AgentWriteInput, soulDir?: string): { meta: AgentDefinition; body: string } {
    const candidate: Record<string, unknown> = {
      id,
      name: input.name,
      role: input.role,
      title: input.title ?? '',
      description: input.description ?? '',
      capabilities: input.capabilities ?? [],
      catalog: input.catalog ?? undefined,
      avatar: input.avatar ?? {},
      handoff: input.handoff ?? [],
    }
    const soul = (input.soul ?? '').trim()
    if (soul) candidate.soul = soul
    if (input.tools) candidate.tools = input.tools
    if (input.skills) candidate.skills = input.skills
    if (input.model) candidate.model = input.model
    if (input.temperature !== null && input.temperature !== undefined) candidate.temperature = input.temperature
    const result = AgentFrontMatterSchema.safeParse(candidate)
    if (!result.success) {
      const issue = result.error.issues[0]
      throw new AssetValidationError(`front-matter：${issue.path.join('.') || '内容'} ${issue.message}`)
    }
    const meta = result.data as AgentDefinition
    // 自动注入的头像路径不落盘（存在性由 avatar.png 决定）
    if (meta.avatar.image === `/api/agents/${id}/avatar`) delete meta.avatar.image
    if (meta.tools && this.toolNames) {
      const known = new Set(this.toolNames())
      // M27：放宽为「精确名或尾部 * 模式」——MCP 通配（mcp__<slug>__* / mcp__*）与服务器增删解耦
      const unknown = meta.tools.filter((name) => !name.endsWith('*') && !known.has(name))
      if (unknown.length > 0)
        throw new AssetValidationError(
          `未知工具：${unknown.join('、')}（可选项来自已注册工具清单；MCP 工具可用 mcp__<slug>__* 通配）`,
        )
    }
    if (soul) {
      if (!soulDir) throw new AssetValidationError('新建角色暂不能预指定灵魂：请先创建角色，再在「灵魂」标签页添加')
      if (!fs.existsSync(path.join(soulDir, 'souls', `${soul}.md`))) {
        throw new AssetValidationError(`灵魂 "${soul}" 不存在（请先创建对应灵魂文件）`)
      }
    }
    const body = normalizeBody(input.body)
    if (!body) throw new AssetValidationError('人设正文不能为空')
    return { meta, body }
  }

  private writeAgentFile(dir: string, meta: AgentDefinition, body: string): void {
    const label = `agents/${path.basename(path.dirname(dir))}/${meta.id}/AGENT.md`
    const text = `---\n${serializeFrontMatter(meta as unknown as Record<string, unknown>, AGENT_FIELD_ORDER)}\n---\n\n${body}\n`
    this.verifyDocument(label, text, meta as unknown as Record<string, unknown>, body)
    this.atomicWrite(path.join(dir, 'AGENT.md'), text)
  }

  private writeSkillFile(name: string, input: SkillWriteInput): void {
    const candidate: Record<string, unknown> = {
      name,
      description: input.description,
      tags: input.tags ?? [],
    }
    const result = SkillFrontMatterSchema.safeParse(candidate)
    if (!result.success) {
      const issue = result.error.issues[0]
      throw new AssetValidationError(`技能 front-matter：${issue.path.join('.') || '内容'} ${issue.message}`)
    }
    const data = result.data as Record<string, unknown>
    const body = normalizeBody(input.body)
    if (!body) throw new AssetValidationError('技能正文不能为空')
    const label = `skills/${name}/SKILL.md`
    const text = `---\n${serializeFrontMatter(data, SKILL_FIELD_ORDER)}\n---\n\n${body}\n`
    this.verifyDocument(label, text, data, body)
    this.atomicWrite(path.join(this.skillsDir, name, 'SKILL.md'), text)
  }

  /**
   * 补丁式重写 AGENT.md 的 front-matter 单字段（保留其余键、正文与顺序），
   * 用于「设为默认灵魂 / 删除默认灵魂」——避免把场景兜底 skills 固化进文件。
   */
  private patchAgentField(raw: RawAgent, patch: Record<string, unknown>): void {
    const file = path.join(raw.dir, 'AGENT.md')
    const doc = parseFrontMatter(fs.readFileSync(file, 'utf8'))
    const data = { ...(doc.data as Record<string, unknown>) }
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete data[key]
      else data[key] = value
    }
    const body = normalizeBody(doc.body)
    const label = `agents/${raw.group}/${raw.meta.id}/AGENT.md`
    const text = `---\n${serializeFrontMatter(data, AGENT_FIELD_ORDER)}\n---\n\n${body}\n`
    this.verifyDocument(label, text, data, body)
    this.atomicWrite(file, text)
  }

  /** 写前自检：必须可被 parseFrontMatter 解析且往返一致（写出的文件必然可被 PromptLibrary 加载） */
  private verifyDocument(label: string, text: string, expected: Record<string, unknown>, expectedBody: string): void {
    let doc: { data: unknown; body: string }
    try {
      doc = parseFrontMatter(text)
    } catch (err) {
      throw new AssetValidationError(`写前自检失败（${label}）：${(err as Error).message}`)
    }
    const data = (doc.data ?? {}) as Record<string, unknown>
    if ('group' in data) throw new AssetValidationError(`写前自检失败（${label}）：front-matter 不应包含 group 键`)
    if (stableJson(data) !== stableJson(expected)) {
      throw new AssetValidationError(`写前自检失败（${label}）：front-matter 序列化往返不一致`)
    }
    if (normalizeBody(doc.body) !== expectedBody) {
      throw new AssetValidationError(`写前自检失败（${label}）：正文序列化往返不一致`)
    }
  }

  /** 同目录 .tmp → rename 原子写（文件名/目录自动创建） */
  private atomicWrite(file: string, content: string | Buffer): void {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    try {
      fs.writeFileSync(tmp, content)
      fs.renameSync(tmp, file)
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true })
      } catch {
        // 清理失败不掩盖原始错误
      }
      throw err
    }
  }

  /** 软删除：移动到 data/trash/assets/<ISO 时间戳>/<相对路径>（跨设备时复制 + 删除兜底） */
  private moveToTrash(absPath: string, relative: string): void {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    let dest = path.join(this.trashDir, stamp, relative)
    let n = 1
    while (fs.existsSync(dest)) dest = path.join(this.trashDir, `${stamp}-${++n}`, relative)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    try {
      fs.renameSync(absPath, dest)
    } catch {
      fs.cpSync(absPath, dest, { recursive: true })
      fs.rmSync(absPath, { recursive: true, force: true })
    }
  }

  private reloadLibraries(): void {
    try {
      this.prompts.reload()
    } catch (err) {
      throw new AssetValidationError(`写盘完成，但资产库重载失败：${(err as Error).message}`)
    }
  }

  // ---------- 内部：引用索引与校验 ----------

  /** agentId → 引用文案（handoff / 编制链 / 预设成员 / 会话成员） */
  private agentRefIndex(): Map<string, string[]> {
    const index = new Map<string, string[]>()
    const push = (id: string, text: string): void => {
      const list = index.get(id) ?? []
      list.push(text)
      index.set(id, list)
    }
    for (const agent of this.prompts.list()) {
      for (const target of agent.handoff) push(target, `角色 ${agent.group}/${agent.id}《${agent.name}》的交接对象`)
    }
    for (const group of this.prompts.groups()) {
      for (const target of group.chain) push(target, `场景 ${group.id}《${group.name}》的接力链`)
    }
    for (const preset of this.prompts.presets()) {
      for (const member of preset.members) push(member, `预设 ${preset.id}《${preset.name}》的成员`)
    }
    // 会话成员合并为一行（避免长列表淹没其它引用）
    const participants = new Map<string, string[]>()
    for (const session of this.sessions.list(null)) {
      for (const id of session.participantIds) {
        const list = participants.get(id) ?? []
        list.push(session.title)
        participants.set(id, list)
      }
    }
    for (const [id, titles] of participants) {
      const shown = titles.slice(0, 5).map((title) => `《${title}》`).join('、')
      push(id, titles.length > 5 ? `${titles.length} 个会话的成员（${shown} 等）` : `会话成员：${shown}`)
    }
    return index
  }

  /** 技能名 → 引用方（角色显式预载 / 场景默认技能；角色侧读原始 front-matter，不含场景兜底展开） */
  private skillRefIndex(): Map<string, { agents: string[]; groups: string[] }> {
    const index = new Map<string, { agents: string[]; groups: string[] }>()
    const ensure = (name: string): { agents: string[]; groups: string[] } => {
      let entry = index.get(name)
      if (!entry) {
        entry = { agents: [], groups: [] }
        index.set(name, entry)
      }
      return entry
    }
    for (const agent of this.prompts.list()) {
      let skills: string[] | undefined
      try {
        skills = this.readAgentRaw(agent.id)?.meta.skills
      } catch {
        skills = agent.skills
      }
      for (const name of skills ?? []) ensure(name).agents.push(agent.id)
    }
    for (const group of this.prompts.groups()) {
      for (const name of group.defaultSkills) ensure(name).groups.push(group.id)
    }
    return index
  }

  private skillStructureIssues(): ValidationIssue[] {
    const issues: ValidationIssue[] = []
    if (!fs.existsSync(this.skillsDir)) return issues
    for (const entry of fs.readdirSync(this.skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_')) continue
      const label = `skills/${entry.name}/SKILL.md`
      const file = path.join(this.skillsDir, entry.name, 'SKILL.md')
      if (!fs.existsSync(file)) {
        issues.push({ level: 'error', path: `skills/${entry.name}`, message: '缺少 SKILL.md（目录即技能名）' })
        continue
      }
      try {
        const doc = parseFrontMatter(fs.readFileSync(file, 'utf8'))
        const result = SkillFrontMatterSchema.safeParse(doc.data)
        if (!result.success) {
          const issue = result.error.issues[0]
          issues.push({ level: 'error', path: label, message: `${issue.path.join('.') || 'front-matter'} ${issue.message}` })
          continue
        }
        if (result.data.name !== entry.name) {
          issues.push({ level: 'error', path: label, message: `name "${result.data.name}" 与目录名不一致` })
        }
        if (!normalizeBody(doc.body)) {
          issues.push({ level: 'warning', path: label, message: '正文为空（load_skill 将无内容可注入）' })
        }
      } catch (err) {
        issues.push({ level: 'error', path: label, message: (err as Error).message })
      }
    }
    return issues
  }

  /** 技能跨引用：角色预载 / 场景默认技能指向不存在的技能（warning；引擎 load_skill 会报错但资产仍可加载） */
  private skillRefIssues(): ValidationIssue[] {
    const issues: ValidationIssue[] = []
    if (this.prompts.currentMode() !== 'agents') return issues
    const known = new Set(this.skills.list().map((skill) => skill.name))
    for (const agent of this.prompts.list()) {
      let skills: string[] | undefined
      try {
        skills = this.readAgentRaw(agent.id)?.meta.skills
      } catch {
        continue // 结构问题已由 prompts.validate() 覆盖
      }
      for (const name of skills ?? []) {
        if (!known.has(name)) {
          issues.push({ level: 'warning', path: `agents/${agent.group}/${agent.id}/AGENT.md`, message: `预载技能 "${name}" 不存在（load_skill 将返回错误）` })
        }
      }
    }
    for (const group of this.prompts.groups()) {
      for (const name of group.defaultSkills) {
        if (!known.has(name)) {
          issues.push({ level: 'warning', path: `agents/${group.id}/_group.yaml`, message: `默认技能 "${name}" 不存在（load_skill 将返回错误）` })
        }
      }
    }
    return issues
  }
}

/** PromptLibrary.validate() 的字符串问题 → 结构化 issue（尽力解析出资产路径） */
function mapPromptProblem(problem: string): ValidationIssue {
  const agent = /^角色 (\S+?)\//.exec(problem)
  if (agent) return { level: 'error', path: `agents/${agent[1]}/AGENT.md`, message: problem }
  const group = /^场景 (\S+?)[ 的]/.exec(problem)
  if (group) return { level: 'error', path: `agents/${group[1]}/_group.yaml`, message: problem }
  if (problem.startsWith('预设')) return { level: 'error', path: 'agents/_presets.yaml', message: problem }
  if (problem.includes('_protocol.md')) return { level: 'error', path: 'agents/_protocol.md', message: problem }
  return { level: 'error', path: 'agents/', message: problem }
}

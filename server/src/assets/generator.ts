/**
 * Agent Studio 资产生成器（docs/agent-studio-design.md §3–§6）：
 * 用户一句话描述 → LLM 生成「结构合规、人设专业」的 Agent / Skill 草稿。
 *
 * - 草稿仅内存流转；落盘一律走既有 createAgent / createSkill（校验 / 409 / 热生效复用）；
 * - 六段骨架与 scripts/check-agents.ts 同源（职责 / 专业判断 / 工作方式 / 质量与自检 / 交付契约 / 协作接口）；
 * - 上下文注入：现有场景（含成员链）/ 技能名单——避免重复造轮子，供 group / handoff / skills 建议；
 * - 失败重试 ≤ GENERATE_MAX_ATTEMPTS：解析失败 / 校验 issues 回注提示词再生成。
 */
import { z } from 'zod'
import type { AppConfig } from '../config.js'
import { extractJson } from '../context/compressor.js'
import { getLogger } from '../logger.js'
import type { ChatRequest, LlmProvider } from '../llm/provider.js'
import { resilientStream } from '../llm/resilience.js'
import type { PromptLibrary } from '../store/prompts.js'
import type { SkillLibrary } from '../store/skills.js'

/** 六段骨架（与 check-agents.ts 的 SECTIONS 同源） */
export const AGENT_SECTIONS = ['职责', '专业判断', '工作方式', '质量与自检', '交付契约', '协作接口'] as const

const MIN_SECTION_CHARS = 60
const MIN_BODY_CHARS = 900
const MIN_SKILL_BODY_CHARS = 300
const ID_RE = /^[a-z][a-z0-9-]{0,39}$/
const GENERATE_MAX_ATTEMPTS = 3
const GENERATE_TEMPERATURE = 0.4

/** 可见字符数（忽略空白；中文按 1 计） */
function visibleLength(text: string): number {
  return text.replace(/\s+/g, '').length
}

const AgentDraftSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: z.string().min(1),
  title: z.string().default(''),
  description: z.string().default(''),
  capabilities: z.array(z.string()).default([]),
  group: z.string().default(''),
  newGroup: z
    .object({
      id: z.string().min(1),
      name: z.string().min(1),
      description: z.string().optional(),
      objective: z.string().optional(),
    })
    .optional(),
  icon: z.string().default('sparkles'),
  gradient: z.array(z.string()).default([]),
  handoff: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  temperature: z.number().optional(),
  sections: z.record(z.string(), z.string()).default({}),
})
type AgentDraftRaw = z.infer<typeof AgentDraftSchema>

const SkillDraftSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  tags: z.array(z.string()).default([]),
  body: z.string().default(''),
})
type SkillDraftRaw = z.infer<typeof SkillDraftSchema>

/** 组装后的 Agent 草稿（字段子集可直接喂 /api/console/agents） */
export interface AgentDraft {
  id: string
  name: string
  role: string
  title: string
  description: string
  capabilities: string[]
  group: string
  newGroup?: { id: string; name: string; description?: string; objective?: string }
  avatar: { icon: string; gradient?: [string, string] }
  handoff: string[]
  skills: string[] | null
  temperature: number
  body: string
}

export interface SkillDraft {
  name: string
  description: string
  tags: string[]
  body: string
}

export interface GenerationResult<T> {
  draft: T
  issues: string[]
  attempts: number
  model: string
}

export interface AssetGeneratorDeps {
  provider: LlmProvider
  cfg: AppConfig
  prompts: PromptLibrary
  skills: SkillLibrary
}

const AGENT_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: true,
  required: ['id', 'name', 'role', 'description', 'capabilities', 'group', 'sections'],
  properties: {
    id: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,39}$' },
    name: { type: 'string' },
    role: { type: 'string' },
    title: { type: 'string' },
    description: { type: 'string' },
    capabilities: { type: 'array', items: { type: 'string' } },
    group: { type: 'string' },
    icon: { type: 'string' },
    gradient: { type: 'array', items: { type: 'string' } },
    handoff: { type: 'array', items: { type: 'string' } },
    skills: { type: 'array', items: { type: 'string' } },
    temperature: { type: 'number' },
    sections: { type: 'object', additionalProperties: { type: 'string' } },
  },
}

const SKILL_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: true,
  required: ['name', 'description', 'body'],
  properties: {
    name: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,39}$' },
    description: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    body: { type: 'string' },
  },
}

const AGENT_SYSTEM = [
  '你是 Owli Team 的「角色资产架构师」，负责把用户的一句话诉求撰写成一名专业、可用、风格鲜明的协作角色。',
  '',
  '输出要求：',
  '- 只输出一个 JSON 对象，不要输出任何解释文字、Markdown 围栏或注释；',
  '- 字段：id / name / role / title / description / capabilities / group / icon / gradient / handoff / skills / temperature / sections；',
  '- id：小写字母开头，仅含字母 / 数字 / 连字符，≤40 字符，语义化英文（如 content-ops、billing-assistant）；',
  '- name：中文角色名（2-4 字，有人格感，如「沈丛」「顾一问」）；role：中文职位名；title：英文职位名；',
  '- description：一句话职责（≤60 字）；capabilities：3-6 项中文能力词；',
  '- group：从「现有场景」清单中选择最贴近的 id；若确实没有合适场景，可给出 newGroup={id,name,description,objective}；',
  '- icon：一个 lucide 图标名（如 megaphone / scale / stethoscope）；gradient：两个十六进制色值；',
  '- handoff：1-3 个可交接的现有成员 id（从场景清单的成员中选）；skills：0-3 个现有技能名；',
  '- temperature：0.3-0.8 之间（推理严谨型偏低、创意型偏高）；',
  '- sections：对象，键必须且仅包含六段（中文键）：职责 / 专业判断 / 工作方式 / 质量与自检 / 交付契约 / 协作接口；',
  `- 每段正文 ≥${MIN_SECTION_CHARS} 字、正文总量 ≥${MIN_BODY_CHARS} 字（按可见字符计），具体、可执行、有专业细节，避免空话套话；`,
  '- 六段写法：职责=做什么 / 不做什么（含职责边界）；专业判断=专业口径与方法论；工作方式=可执行的步骤与工具纪律；',
  '  质量与自检=交付前检查清单与反模式；交付契约=交付物路径 / 格式 / 命名；协作接口=与谁交接、何时交接、交接内容。',
].join('\n')

const SKILL_SYSTEM = [
  '你是 Owli Team 的「技能手册作者」，负责把用户诉求撰写成一份专业、可执行、可直接使用的技能手册（SKILL.md）。',
  '',
  '输出要求：',
  '- 只输出一个 JSON 对象，不要输出任何解释文字、Markdown 围栏或注释；',
  '- 字段：name / description / tags / body；',
  '- name：kebab-case 英文名（目录名，≤40 字符，如 competitor-teardown）；',
  '- description：一句中文描述（≤80 字，写清「什么时候用 + 解决什么」，用于技能检索触发）；',
  '- tags：2-4 个小写英文标签（如 [research, analysis]）；',
  `- body：Markdown 正文（≥${MIN_SKILL_BODY_CHARS} 字）：开篇一句话主线，随后按需分节（工作流步骤 / 检查清单 / 模板与示例 / 常见错误与修正 / 质量门槛）；用到表格或代码块时保持真实可执行，不要占位符。`,
].join('\n')

export class AssetGenerator {
  constructor(private readonly deps: AssetGeneratorDeps) {}

  /** Agent 草稿生成（描述 → 合规草稿；issues 不阻断，由调用方决定重生成或手改） */
  async generateAgent(
    description: string,
    opts: { sceneHint?: string } = {},
  ): Promise<GenerationResult<AgentDraft>> {
    const context = this.contextBlock()
    let feedback = ''
    let lastIssues: string[] = []
    for (let attempt = 1; attempt <= GENERATE_MAX_ATTEMPTS; attempt++) {
      const user = [
        context,
        '## 用户描述',
        description.trim(),
        opts.sceneHint ? `偏好场景：${opts.sceneHint}` : '',
        feedback,
        '请输出单个 JSON。',
      ]
        .filter(Boolean)
        .join('\n')
      const raw = await this.collect(AGENT_SYSTEM, user, 'agent_draft', AGENT_JSON_SCHEMA)
      const parsed = AgentDraftSchema.safeParse(extractJson(raw))
      if (!parsed.success) {
        lastIssues = [`输出不是合法 JSON 或字段缺失：${parsed.error.issues[0]?.message ?? '未知'}`]
        feedback = this.retryFeedback(raw, lastIssues)
        getLogger().warn({ attempt, issues: lastIssues }, 'Agent 草稿生成重试（解析失败）')
        continue
      }
      const { draft, issues } = this.assembleAgentDraft(parsed.data)
      lastIssues = issues
      if (issues.length === 0 || attempt === GENERATE_MAX_ATTEMPTS) {
        return { draft, issues, attempts: attempt, model: this.deps.cfg.llmModel }
      }
      feedback = this.retryFeedback(raw, issues)
      getLogger().warn({ attempt, issues }, 'Agent 草稿生成重试（校验未过）')
    }
    throw new Error(`生成失败：${lastIssues.join('；') || '达到重试上限'}`)
  }

  /** Skill 草稿生成（诉求 → 手册草稿） */
  async generateSkill(requirement: string): Promise<GenerationResult<SkillDraft>> {
    const context = this.contextBlock()
    let feedback = ''
    let lastIssues: string[] = []
    for (let attempt = 1; attempt <= GENERATE_MAX_ATTEMPTS; attempt++) {
      const user = [context, '## 用户诉求', requirement.trim(), feedback, '请输出单个 JSON。']
        .filter(Boolean)
        .join('\n')
      const raw = await this.collect(SKILL_SYSTEM, user, 'skill_draft', SKILL_JSON_SCHEMA)
      const parsed = SkillDraftSchema.safeParse(extractJson(raw))
      if (!parsed.success) {
        lastIssues = [`输出不是合法 JSON 或字段缺失：${parsed.error.issues[0]?.message ?? '未知'}`]
        feedback = this.retryFeedback(raw, lastIssues)
        continue
      }
      const { draft, issues } = this.assembleSkillDraft(parsed.data)
      lastIssues = issues
      if (issues.length === 0 || attempt === GENERATE_MAX_ATTEMPTS) {
        return { draft, issues, attempts: attempt, model: this.deps.cfg.llmModel }
      }
      feedback = this.retryFeedback(raw, issues)
    }
    throw new Error(`生成失败：${lastIssues.join('；') || '达到重试上限'}`)
  }

  // ---------- 内部 ----------

  /** 一次性调用（与摘要压缩同范式：resilientStream 包裹，收集文本） */
  private async collect(
    system: string,
    user: string,
    schemaName: string,
    schema: Record<string, unknown>,
  ): Promise<string> {
    const request: ChatRequest = {
      system,
      messages: [{ role: 'user', content: user }],
      model: this.deps.cfg.llmModel,
      temperature: GENERATE_TEMPERATURE,
      responseFormat: { type: 'json_schema', name: schemaName, schema },
      meta: { agentId: '__asset_generator__', participantIds: [], stepIndex: 0 },
    }
    let received = ''
    for await (const chunk of resilientStream((signal) => this.deps.provider.chatStream(request, signal), {
      maxAttempts: Math.max(1, this.deps.cfg.llmMaxRetries),
      baseDelayMs: this.deps.cfg.llmRetryBaseDelayMs,
      firstTokenTimeoutMs: this.deps.cfg.firstTokenTimeoutMs,
      idleTimeoutMs: this.deps.cfg.streamIdleTimeoutMs,
    })) {
      if (chunk.type === 'text') received += chunk.text
    }
    return received
  }

  /** 上下文：现有场景（含成员链）+ 技能名单（供 group / handoff / skills 建议） */
  private contextBlock(): string {
    const groups = this.deps.prompts.groups()
    const skills = this.deps.skills.list()
    const sceneLines = groups.map((g) => {
      const members = g.chain.length > 0 ? `（成员：${g.chain.join(', ')}）` : ''
      const objective = g.objective ? `｜目标：${g.objective.slice(0, 40)}` : ''
      return `- ${g.id}：${g.name}${objective}${members}`
    })
    const skillLines = skills.map((s) => `- ${s.name}（${s.description.slice(0, 40)}）`)
    return [
      '## 现有场景（group 优先从中选择；不要重复创建已存在的场景）',
      ...sceneLines,
      '',
      '## 现有技能（skills 字段可选其中 0-3 个）',
      ...skillLines,
      '',
    ].join('\n')
  }

  private retryFeedback(raw: string, issues: string[]): string {
    return [
      '',
      '## 上一轮输出（JSON）',
      raw.slice(0, 6000),
      '',
      '## 需要修正的问题',
      ...issues.map((issue) => `- ${issue}`),
      '',
      '请修正以上问题后，重新输出完整 JSON。',
    ].join('\n')
  }

  /** 组装 Agent 草稿 + 后校验（六段 / 长度 / 命名 / 引用过滤） */
  private assembleAgentDraft(raw: AgentDraftRaw): { draft: AgentDraft; issues: string[] } {
    const issues: string[] = []
    const existingAgents = this.deps.prompts.list()
    const agentIds = new Set(existingAgents.map((a) => a.id))
    const groupIds = new Set(this.deps.prompts.groups().map((g) => g.id))
    const skillNames = new Set(this.deps.skills.list().map((s) => s.name))

    const id = raw.id.trim()
    if (!ID_RE.test(id)) issues.push(`id「${id}」不合规：需小写字母开头、仅含字母 / 数字 / 连字符且 ≤40 字符`)
    else if (agentIds.has(id)) issues.push(`id「${id}」已被现有角色占用，请换一个（如 ${id}-2）`)
    if (raw.name.trim() && existingAgents.some((a) => a.name === raw.name.trim())) {
      issues.push(`name「${raw.name}」与现有角色重名（可保留，但建议区分）`)
    }
    if (!raw.group || (!groupIds.has(raw.group) && !raw.newGroup)) {
      issues.push(`group「${raw.group || '（空）'}」不存在且未提供 newGroup——请从场景清单中选择`)
    }

    const sections = AGENT_SECTIONS.map((name) => ({ name, text: (raw.sections[name] ?? '').trim() }))
    for (const section of sections) {
      if (!section.text) issues.push(`缺少「${section.name}」段`)
      else if (visibleLength(section.text) < MIN_SECTION_CHARS) {
        issues.push(`「${section.name}」段过短（${visibleLength(section.text)} 字，需 ≥${MIN_SECTION_CHARS}）`)
      }
    }
    const body = sections.map((s) => `## ${s.name}\n\n${s.text}`).join('\n\n')
    if (visibleLength(body) < MIN_BODY_CHARS) {
      issues.push(`正文总量不足（${visibleLength(body)} 字，需 ≥${MIN_BODY_CHARS}）`)
    }

    const handoff = [...new Set(raw.handoff.map((x) => x.trim()).filter(Boolean))].filter((x) => {
      if (agentIds.has(x)) return true
      issues.push(`handoff 引用了不存在的成员「${x}」（已移除）`)
      return false
    })
    const skills = [...new Set(raw.skills.map((x) => x.trim()).filter(Boolean))].filter((x) => {
      if (skillNames.has(x)) return true
      issues.push(`skills 引用了不存在的技能「${x}」（已移除）`)
      return false
    })
    const gradient =
      raw.gradient.length >= 2 && raw.gradient[0] && raw.gradient[1]
        ? ([raw.gradient[0], raw.gradient[1]] as [string, string])
        : undefined
    const temperature = Math.min(0.9, Math.max(0.2, raw.temperature ?? 0.6))

    return {
      draft: {
        id,
        name: raw.name.trim(),
        role: raw.role.trim(),
        title: raw.title.trim(),
        description: raw.description.trim(),
        capabilities: raw.capabilities.map((c) => c.trim()).filter(Boolean).slice(0, 6),
        group: raw.group.trim(),
        newGroup: raw.newGroup
          ? {
              id: raw.newGroup.id.trim(),
              name: raw.newGroup.name.trim(),
              description: raw.newGroup.description?.trim() || undefined,
              objective: raw.newGroup.objective?.trim() || undefined,
            }
          : undefined,
        avatar: { icon: raw.icon.trim() || 'sparkles', gradient },
        handoff,
        skills: skills.length > 0 ? skills : null,
        temperature,
        body,
      },
      issues,
    }
  }

  /** 组装 Skill 草稿 + 后校验 */
  private assembleSkillDraft(raw: SkillDraftRaw): { draft: SkillDraft; issues: string[] } {
    const issues: string[] = []
    const name = raw.name.trim()
    if (!ID_RE.test(name)) issues.push(`name「${name}」不合规：需 kebab-case 英文（小写字母开头，≤40 字符）`)
    else if (this.deps.skills.list().some((s) => s.name === name)) {
      issues.push(`技能「${name}」已存在，请换名（或直接编辑现有技能）`)
    }
    if (visibleLength(raw.body) < MIN_SKILL_BODY_CHARS) {
      issues.push(`正文过短（${visibleLength(raw.body)} 字，需 ≥${MIN_SKILL_BODY_CHARS}）`)
    }
    return {
      draft: {
        name,
        description: raw.description.trim(),
        tags: [...new Set(raw.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 6),
        body: raw.body.trim(),
      },
      issues,
    }
  }
}

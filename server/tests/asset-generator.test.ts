/**
 * Agent Studio 生成器测试（docs/agent-studio-design.md §9）：
 * 假 provider 注入（不触网）——正常一次通过 / 坏 JSON 回注重试 / 六段缺失 issues /
 * id 冲突提示 / handoff·skills 越界过滤 / Skill 重名与短正文。
 */
import { describe, expect, it } from 'vitest'
import type { AppConfig } from '../src/config.js'
import type { ChatRequest, LlmChunk, LlmProvider } from '../src/llm/provider.js'
import type { PromptLibrary } from '../src/store/prompts.js'
import type { SkillLibrary } from '../src/store/skills.js'
import { AssetGenerator } from '../src/assets/generator.js'

/** 按调用次序吐出预设文本的假 provider（超出取最后一轮） */
function fakeProvider(responses: string[]): { provider: LlmProvider; calls: () => number } {
  let call = 0
  const provider = {
    chatStream: (_req: ChatRequest) => {
      const text = responses[Math.min(call, responses.length - 1)]
      call += 1
      return (async function* (): AsyncIterable<LlmChunk> {
        yield { type: 'text', text }
        yield { type: 'done' }
      })()
    },
  } as unknown as LlmProvider
  return { provider, calls: () => call }
}

const CFG = {
  llmModel: 'test-model',
  llmMaxRetries: 1,
  llmRetryBaseDelayMs: 1,
  firstTokenTimeoutMs: 2000,
  streamIdleTimeoutMs: 2000,
} as unknown as AppConfig

const PROMPTS = {
  list: () => [
    { id: 'pm', name: '费利', role: '产品经理', group: 'development' },
    { id: 'architect', name: '顾衡', role: '架构师', group: 'development' },
  ],
  groups: () => [
    {
      id: 'development',
      name: '研发团队',
      description: '',
      objective: '把需求做成可交付',
      chain: ['pm', 'architect'],
    },
  ],
} as unknown as PromptLibrary

const SKILLS = {
  list: () => [{ name: 'prd-authoring', description: '需求文档写作', tags: ['pm'] }],
} as unknown as SkillLibrary

function makeGenerator(responses: string[]): { gen: AssetGenerator; calls: () => number } {
  const { provider, calls } = fakeProvider(responses)
  return {
    gen: new AssetGenerator({ provider, cfg: CFG, prompts: PROMPTS, skills: SKILLS }),
    calls,
  }
}

/** 合规 Agent JSON（六段每段 ~160 字，总量 >900） */
function goodAgentJson(overrides: Record<string, unknown> = {}): string {
  const seg = (name: string): string => `${name}段：` + '具体口径、执行步骤与检查要点逐条写清。'.repeat(12)
  return JSON.stringify({
    id: 'test-bot',
    name: '测试角色',
    role: '测试岗',
    title: 'Test Bot',
    description: '一句话职责',
    capabilities: ['能力一', '能力二', '能力三'],
    group: 'development',
    icon: 'sparkles',
    gradient: ['#111111', '#222222'],
    handoff: ['pm'],
    skills: ['prd-authoring'],
    temperature: 0.5,
    sections: {
      职责: seg('职责'),
      专业判断: seg('专业判断'),
      工作方式: seg('工作方式'),
      质量与自检: seg('质量与自检'),
      交付契约: seg('交付契约'),
      协作接口: seg('协作接口'),
    },
    ...overrides,
  })
}

describe('Agent Studio：Agent 草稿生成', () => {
  it('正常路径：一次通过，issues 为空，body 按六段拼接', async () => {
    const { gen, calls } = makeGenerator([goodAgentJson()])
    const result = await gen.generateAgent('做一个测试角色')
    expect(result.attempts).toBe(1)
    expect(result.issues).toEqual([])
    expect(result.draft.id).toBe('test-bot')
    expect(result.draft.body.startsWith('## 职责')).toBe(true)
    expect(result.draft.body).toContain('## 协作接口')
    expect(result.draft.skills).toEqual(['prd-authoring'])
    expect(calls()).toBe(1)
  })

  it('坏 JSON 回注重试：首轮非 JSON，次轮修正通过（attempts=2）', async () => {
    const { gen, calls } = makeGenerator(['抱歉，我无法输出 JSON。', goodAgentJson()])
    const result = await gen.generateAgent('做一个测试角色')
    expect(result.attempts).toBe(2)
    expect(result.issues).toEqual([])
    expect(calls()).toBe(2)
  })

  it('六段缺失：校验 issues 进入结果并重试（上限后带 issues 返回）', async () => {
    const bad = goodAgentJson({
      sections: {
        职责: '太短',
        专业判断: '',
        工作方式: '短',
        质量与自检: '',
        交付契约: '短',
        协作接口: '',
      },
    })
    const { gen, calls } = makeGenerator([bad])
    const result = await gen.generateAgent('做一个测试角色')
    expect(result.attempts).toBe(3)
    expect(result.issues.length).toBeGreaterThan(0)
    expect(result.issues.some((i) => i.includes('职责') || i.includes('正文总量'))).toBe(true)
    expect(calls()).toBe(3)
  })

  it('id 冲突与引用越界：占用 id / 不存在 handoff·skill 均进 issues 并过滤', async () => {
    const { gen } = makeGenerator([
      goodAgentJson({ id: 'pm', handoff: ['pm', 'ghost'], skills: ['prd-authoring', 'nope-skill'] }),
    ])
    const result = await gen.generateAgent('做一个测试角色')
    expect(result.issues.some((i) => i.includes('已被现有角色占用'))).toBe(true)
    expect(result.issues.some((i) => i.includes('ghost'))).toBe(true)
    expect(result.issues.some((i) => i.includes('nope-skill'))).toBe(true)
    expect(result.draft.handoff).toEqual(['pm'])
    expect(result.draft.skills).toEqual(['prd-authoring'])
  })

  it('全部输出均无法解析：抛错（路由层映射 502）', async () => {
    const { gen } = makeGenerator(['不是 JSON'])
    await expect(gen.generateAgent('做一个测试角色')).rejects.toThrow('生成失败')
  })
})

describe('Agent Studio：Skill 草稿生成', () => {
  const goodSkillJson = (overrides: Record<string, unknown> = {}): string =>
    JSON.stringify({
      name: 'weekly-report',
      description: '编写结构化周报时使用：汇总进展、风险与下周计划',
      tags: ['writing', 'pm'],
      body: '# 周报手册\n\n' + '按模板汇总进展 / 风险 / 下周计划，逐条核对数据来源。'.repeat(12),
      ...overrides,
    })

  it('正常路径：一次通过', async () => {
    const { gen } = makeGenerator([goodSkillJson()])
    const result = await gen.generateSkill('帮我做一个周报技能')
    expect(result.attempts).toBe(1)
    expect(result.issues).toEqual([])
    expect(result.draft.name).toBe('weekly-report')
    expect(result.draft.tags).toEqual(['writing', 'pm'])
  })

  it('重名与短正文：进 issues；tags 去重', async () => {
    const { gen } = makeGenerator([
      goodSkillJson({ name: 'prd-authoring', body: '太短', tags: ['a', 'a', 'B'] }),
    ])
    const result = await gen.generateSkill('帮我做一个技能')
    expect(result.issues.some((i) => i.includes('已存在'))).toBe(true)
    expect(result.issues.some((i) => i.includes('正文过短'))).toBe(true)
    expect(result.draft.tags).toEqual(['a', 'b'])
  })
})

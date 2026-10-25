/**
 * P1 去 AI 化测试：声纹资产（voice.md）加载 / 装配注入 / 回合指令示例行 / 温度加成。
 */
import { describe, expect, it } from 'vitest'
import type { AgentDefinition } from '@multi-agent/shared'
import { parseVoiceDoc } from '../src/store/prompts.js'
import { loadConfig } from '../src/config.js'
import { PromptLibrary } from '../src/store/prompts.js'
import { buildSystemPrompt, buildTurnInstruction } from '../src/context/assembler.js'

const VOICE_BODY = `
## 说话方式
- 连段成文。

## 句式偏好
- 禁用词表：综上所述 / 赋能 / 闭环 / 总而言之

## 示例（好的发言）
> 示例一：先说你最担心的那个点。
> 示例二：谈取舍时报数字。
> 示例三：收尾停在具体动作上。
`

const agent = {
  id: 'pm',
  name: '费利',
  role: '产品经理',
  handoff: [],
  skills: [],
  tools: [],
} as unknown as AgentDefinition

describe('P1：声纹解析与加载', () => {
  it('parseVoiceDoc：提取示例（> 行）与禁用词表', () => {
    const doc = parseVoiceDoc(VOICE_BODY)
    expect(doc.examples).toHaveLength(3)
    expect(doc.examples[0]).toContain('示例一')
    expect(doc.banned).toEqual(['综上所述', '赋能', '闭环', '总而言之'])
  })

  it('parseVoiceDoc 容错：缺段 = 空数组；无 front-matter 的纯文本也可解析', () => {
    const empty = parseVoiceDoc('随便一段正文')
    expect(empty.examples).toEqual([])
    expect(empty.banned).toEqual([])
  })

  it('真实资产库：20 个活动角色 voice.md 已加载且达标（示例 ≥2 / 禁用词 ≥3）', () => {
    const cfg = loadConfig()
    const lib = new PromptLibrary({ agentsDir: cfg.agentsDir, promptsDir: cfg.promptsDir, onWarn: () => {} })
    const expected = [
      'pm', 'architect', 'designer', 'frontend', 'backend', 'qa',
      'lead', 'scout', 'analyst', 'verifier',
      'invest-lead', 'analyst-fa', 'analyst-ta', 'analyst-news', 'quant',
      'facilitator', 'ideator', 'challenger', 'refiner',
      'coach',
    ]
    for (const id of expected) {
      const v = lib.voice(id)
      expect(v, `${id} 缺少 voice.md`).toBeDefined()
      expect(v!.examples.length, `${id} 示例不足`).toBeGreaterThanOrEqual(2)
      expect(v!.banned.length, `${id} 禁用词不足`).toBeGreaterThanOrEqual(3)
    }
    // 未覆盖角色 = undefined（行为零差异）
    expect(lib.voice('sre')).toBeUndefined()
  })
})

describe('P1：装配注入', () => {
  const baseInput = {
    protocol: '<role_contract>协议</role_contract>',
    agent,
    agentBody: '我是产品经理。',
    roster: [agent],
    preloadedSkills: [],
    skillsIndex: '',
    workspaceListing: '',
    memoryBlock: '',
    summaryBlock: '',
  }

  it('buildSystemPrompt：有声纹 → L0 含声纹段；无声纹 → 零差异', () => {
    const withVoice = buildSystemPrompt({ ...baseInput, voice: { body: VOICE_BODY } })
    expect(withVoice.text).toContain('你的声纹')
    expect(withVoice.text).toContain('连段成文')
    const without = buildSystemPrompt(baseInput)
    expect(without.text).not.toContain('你的声纹')
  })

  it('buildTurnInstruction：execute 波注入语气参考行；无声纹 / plan 范式不注入', () => {
    const out = buildTurnInstruction(agent, [agent], [], [], 'execute', {
      voiceExample: '先说你最担心的那个点。',
    })
    expect(out).toContain('语气参考')
    expect(out).toContain('先说你最担心的那个点')
    const plain = buildTurnInstruction(agent, [agent], [], [], 'execute', {})
    expect(plain).not.toContain('语气参考')
    const plan = buildTurnInstruction(agent, [agent], [], [], 'plan', {
      voiceExample: '先说你最担心的那个点。',
    })
    expect(plan).not.toContain('语气参考')
  })
})

describe('P1：全局协议去 AI 腔约定', () => {
  it('全局协议含三通道文体契约与 AI 腔禁用词表', () => {
    const cfg = loadConfig()
    const lib = new PromptLibrary({ agentsDir: cfg.agentsDir, promptsDir: cfg.promptsDir, onWarn: () => {} })
    const text = lib.protocolText
    expect(text).toContain('<style_channels>')
    expect(text).toContain('段落优先')
    expect(text).toContain('AI 腔禁用词表')
    expect(text).toContain('综上所述')
    // 旧的「一刀切分点 + 200 字」表述已移除
    expect(text).not.toContain('用 Markdown 分点表达')
  })
})

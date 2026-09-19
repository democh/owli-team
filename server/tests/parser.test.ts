import { describe, expect, it } from 'vitest'
import type { AgentDefinition } from '@multi-agent/shared'
import { parseMentions, stripMinutesBlocks } from '../src/orchestration/parser.js'

const agents: AgentDefinition[] = [
  { id: 'pm', name: '费利', role: '产品经理' } as AgentDefinition,
  { id: 'architect', name: '艾达', role: '架构师' } as AgentDefinition,
  { id: 'qa', name: '诺娃', role: '测试工程师' } as AgentDefinition,
  { id: 'backend', name: '马克斯', role: '后端工程师' } as AgentDefinition,
]

describe('parser：别名解析', () => {
  it('中文名 → agentId', () => {
    expect(parseMentions('@费利 帮忙拆一下需求', agents).mentions).toEqual(['pm'])
  })

  it('英文 id（大小写不敏感）', () => {
    expect(parseMentions('@pm 看一下', agents).mentions).toEqual(['pm'])
    expect(parseMentions('@PM 看一下', agents).mentions).toEqual(['pm'])
    expect(parseMentions('@Architect 评估方案', agents).mentions).toEqual(['architect'])
  })

  it('多提及按出现顺序去重', () => {
    const result = parseMentions('@诺娃 和 @马克斯 一起看看，之后 @诺娃 再回归', agents)
    expect(result.mentions).toEqual(['qa', 'backend'])
  })
})

describe('parser：@用户 交还', () => {
  it('行首 @用户 是交还', () => {
    expect(parseMentions('@用户 请确认上述方案', agents).handedToUser).toBe(true)
  })

  it('@user / @你 变体（大小写）', () => {
    expect(parseMentions('@User 请拍板', agents).handedToUser).toBe(true)
    expect(parseMentions('@你 需要补充信息', agents).handedToUser).toBe(true)
  })

  it('行首 markdown 前缀（> / - 空格）仍识别', () => {
    expect(parseMentions('- @用户 请确认', agents).handedToUser).toBe(true)
    expect(parseMentions('> @用户 待确认', agents).handedToUser).toBe(true)
  })

  it('句中 @用户 不算交还（真实模型描述不误判）', () => {
    expect(parseMentions('以上完成后可以 @用户 来验收', agents).handedToUser).toBe(false)
  })
})

describe('parser：minutes 容器（M42 §71.5）', () => {
  it('纪要待办行的 @ 不计入 mentions（派活锚点，用户确认制）', () => {
    const minutes = [
      '全体议毕，我出纪要。',
      '',
      '::: minutes 本周例会纪要',
      '- 决议 | 数字口径统一按财务版本',
      '- 待办 | @诺娃 更新执行排期并同步工作区',
      '- 待办 | @马克斯 补齐数据口径说明',
      ':::',
      '',
      '@用户 我这边告一段落，请确认下一步。',
    ].join('\n')
    const result = parseMentions(minutes, agents)
    expect(result.mentions).toEqual([])
    expect(result.handedToUser).toBe(true)
  })

  it('容器外的 @ 照常解析（回交主持人 / 接力）', () => {
    const text = '::: minutes 纪要\n- 待办 | @诺娃 跟进\n:::\n\n@马克斯 接力棒给你了。'
    expect(parseMentions(text, agents).mentions).toEqual(['backend'])
  })

  it('多块剥离 / 块内 @用户 不算交还 / 未闭合不剥离（fail-safe）', () => {
    const text = [
      '::: minutes 一\n- 待办 | @诺娃 A\n:::',
      '::: minutes 二\n- 待办 | @马克斯 B\n:::',
      '@用户 请拍板',
    ].join('\n')
    expect(parseMentions(text, agents).mentions).toEqual([])
    expect(parseMentions(text, agents).handedToUser).toBe(true)
    const unclosed = '::: minutes 纪要\n@用户 以上\n- 待办 | @诺娃 C'
    expect(parseMentions(unclosed, agents).mentions).toEqual(['qa'])
    expect(parseMentions(unclosed, agents).handedToUser).toBe(true)
  })

  it('stripMinutesBlocks 保留容器外原文', () => {
    expect(stripMinutesBlocks('段落一\n::: minutes 纪要\n- 待办 | @诺娃 A\n:::\n段落二')).toBe('段落一\n段落二')
    // 非 minutes 容器不动（meeting 声明卡含议题行）
    const meeting = '::: meeting 周会\n- 议题一\n- [x] 议题二\n:::'
    expect(stripMinutesBlocks(meeting)).toBe(meeting)
  })
})

describe('parser：边界', () => {
  it('`@用户名` 不算 @用户（token 精确匹配）', () => {
    const result = parseMentions('请输入 @用户名 和密码', agents)
    expect(result.handedToUser).toBe(false)
    expect(result.mentions).toEqual([])
  })

  it('`@费利克斯` 不误判 `@费利`', () => {
    expect(parseMentions('介绍一下 @费利克斯 这个人', agents).mentions).toEqual([])
  })

  it('无 @ 的文本解析为空', () => {
    const result = parseMentions('大家好，开始干活吧', agents)
    expect(result.mentions).toEqual([])
    expect(result.handedToUser).toBe(false)
  })
})

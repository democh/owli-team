/**
 * P0 优化测试：协议 scope 裁剪 / deliverable_spec 按需注入 / L4 用户消息 critical 豁免。
 */
import { describe, expect, it } from 'vitest'
import type { AgentDefinition, ChatMessage } from '@multi-agent/shared'
import { filterProtocolByScopes } from '../src/context/protocol-scope.js'
import { buildSystemPrompt, buildWindow } from '../src/context/assembler.js'
import { buildSpecInstructionLine } from '../src/context/deliverable-spec.js'
import { loadConfig } from '../src/config.js'
import { PromptLibrary } from '../src/store/prompts.js'

const PROTOCOL = [
  '<tool_policy>',
  '- 通用文件纪律。',
  '<segment scope="git">',
  '- 真实仓库纪律：git_status / git_commit。',
  '</segment>',
  '<segment scope="web">',
  '- 联网纪律：web_search / web_fetch。',
  '</segment>',
  '<segment scope="business">',
  '- 业务纪律：calc / date_calc。',
  '</segment>',
  '<segment scope="schedule">',
  '- 定时纪律：schedule_task 最小间隔 5 分钟。',
  '</segment>',
  '- 记录真实性红线。',
  '</tool_policy>',
].join('\n')

describe('P0：协议 scope 裁剪', () => {
  it('无 git/web/business/schedule 工具的角色 → 四个段全部剔除，通用纪律保留', () => {
    const out = filterProtocolByScopes(PROTOCOL, ['read_file', 'write_file', 'tarot_draw'])
    expect(out).toContain('通用文件纪律')
    expect(out).toContain('记录真实性红线')
    expect(out).not.toContain('git_status')
    expect(out).not.toContain('web_search')
    expect(out).not.toContain('calc')
    expect(out).not.toContain('schedule_task')
    expect(out).not.toContain('<segment')
  })

  it('命中即保留：git_* 任一保留 git 段；calc 保留 business 段；保留段脱掉 segment 外壳', () => {
    const out = filterProtocolByScopes(PROTOCOL, ['git_status', 'calc'])
    expect(out).toContain('真实仓库纪律')
    expect(out).toContain('业务纪律')
    expect(out).not.toContain('联网纪律')
    expect(out).not.toContain('定时纪律')
    expect(out).not.toContain('</segment>')
  })

  it('向后兼容：无 segment 标记的协议原文返回；未声明 tools（undefined / 空数组）不过滤', () => {
    const plain = '<tool_policy>\n- 纯文本协议。\n</tool_policy>'
    expect(filterProtocolByScopes(plain, ['read_file'])).toBe(plain)
    expect(filterProtocolByScopes(PROTOCOL, undefined)).toBe(PROTOCOL)
    expect(filterProtocolByScopes(PROTOCOL, [])).toBe(PROTOCOL)
  })

  it('真实全局协议：塔罗师裁掉 git 与 schedule 段（保留其真实具备的 web / business 段）；pm 保留 git 与 business 段', () => {
    const cfg = loadConfig()
    const lib = new PromptLibrary({ agentsDir: cfg.agentsDir, promptsDir: cfg.promptsDir })
    const protocol = lib.protocolText
    expect(protocol).toContain('<segment') // 协议事实源仍含完整分段（校验面向全文）

    // tarot-reader front-matter 含 web_search / calc（术语查源与日期推算是其真实能力），
    // 因此 web / business 段正确保留；无 git_* 与定时工具 → 两段裁剪
    const tarot = lib.list().find((a) => a.id === 'tarot-reader')!
    const tarotOut = filterProtocolByScopes(protocol, tarot.tools)
    expect(tarotOut).not.toContain('git_status')
    expect(tarotOut).not.toContain('schedule_task')
    expect(tarotOut).toContain('web_search')
    expect(tarotOut).toContain('calc')
    expect(tarotOut).toContain('记录真实性')
    expect(tarotOut.length).toBeLessThan(protocol.length) // 有缩量

    const pm = lib.list().find((a) => a.id === 'pm')!
    const pmOut = filterProtocolByScopes(protocol, pm.tools)
    expect(pmOut).toContain('git_status')
    expect(pmOut).toContain('calc')
    expect(pmOut).not.toContain('schedule_task') // pm 无定时工具 → 定时段裁剪
  })

  it('buildSystemPrompt 集成：L0 反映裁剪结果', () => {
    const agent = {
      id: 'tarot-reader',
      name: '测试',
      role: '解读师',
      handoff: [],
      skills: [],
      tools: ['tarot_draw'],
    } as unknown as AgentDefinition
    const out = buildSystemPrompt({
      protocol: PROTOCOL,
      agent,
      agentBody: '我是解读师。',
      roster: [agent],
      preloadedSkills: [],
      skillsIndex: '',
      workspaceListing: '',
      memoryBlock: '',
      summaryBlock: '',
    })
    expect(out.text).not.toContain('git_status')
    expect(out.text).toContain('通用文件纪律')
  })
})

describe('P0：deliverable_spec 按需注入（协议不再常驻）', () => {
  it('真实全局协议不再含 deliverable_spec 常驻段', () => {
    const cfg = loadConfig()
    const lib = new PromptLibrary({ agentsDir: cfg.agentsDir, promptsDir: cfg.promptsDir })
    expect(lib.protocolText).not.toContain('<deliverable_spec>')
  })

  it('声明档位时回合指令携带该档规格全文（速览 / 深度）', () => {
    const brief = buildSpecInstructionLine('brief')
    expect(brief).toContain('速览档')
    expect(brief).toContain('≤800 字')
    expect(brief).toContain('可独立成立')
    const deep = buildSpecInstructionLine('deep')
    expect(deep).toContain('深度档')
    expect(deep).toContain('≥4000 字')
    expect(deep).toContain('来源编号')
    expect(deep).toContain('mode=append')
    expect(buildSpecInstructionLine(undefined)).toBe('')
  })
})

describe('P0：L4 窗口用户消息 critical 豁免', () => {
  let seq = 0
  const msg = (role: 'user' | 'agent', content: string): ChatMessage =>
    ({
      id: `m${++seq}`,
      sessionId: 's',
      role,
      agentId: role === 'agent' ? 'pm' : undefined,
      content,
      mentions: [],
      seq,
      status: 'complete',
      createdAt: new Date().toISOString(),
    }) as ChatMessage

  it('裁剪丢组时，被省略回合的用户发言以要点摘要保留在窗口最前', () => {
    const messages: ChatMessage[] = []
    for (let t = 0; t < 10; t++) {
      messages.push(msg('user', `第 ${t} 轮的关键口径：预算上限是 ${t * 1000} 元。`.repeat(3)))
      messages.push(msg('agent', `第 ${t} 轮的详细回复内容。`.repeat(3)))
    }
    const out = buildWindow({
      messages,
      agentId: 'pm',
      agents: [],
      fromSeq: 0,
      budgetTokens: 300,
      toolDetailKeep: 6,
    })
    expect(out.droppedGroups).toBeGreaterThan(0)
    expect(out.retainedUserMessages).toBeGreaterThan(0)
    const first = out.messages[0]
    expect(first.role).toBe('user')
    expect(String(first.content)).toContain('历史发言要点')
    expect(String(first.content)).toContain('关键口径') // 早期用户约束未静默丢失
    // 摘要块之后仍是正常的最近回合
    expect(String(out.messages[out.messages.length - 1].content)).toContain('第 9 轮')
  })

  it('无裁剪时零差异（retainedUserMessages=0，无摘要块）', () => {
    const out = buildWindow({
      messages: [msg('user', '唯一需求'), msg('agent', '回复')],
      agentId: 'pm',
      agents: [],
      fromSeq: 0,
      budgetTokens: 10_000,
      toolDetailKeep: 6,
    })
    expect(out.retainedUserMessages).toBe(0)
    expect(out.messages).toHaveLength(2)
  })
})

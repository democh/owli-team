/**
 * 交付规格闭环（报告专业化）：档位解析 / 回合指令注入 / prepareTurn 集成。
 *
 * 口径：会话级粘性（最近一条含声明的用户消息生效，新声明覆盖旧声明）；
 * 未声明不注入（按角色交付契约默认档执行）。
 */
import { describe, expect, it } from 'vitest'
import { buildSpecInstructionLine, parseDeliverableSpec } from '../src/context/deliverable-spec.js'
import { makeEnv } from './helpers.js'

describe('交付规格：档位解析', () => {
  it('关键词解析：速览 / 深度 / 未声明（宽词不误伤）', () => {
    expect(parseDeliverableSpec(['给我一份深度报告'])).toBe('deep')
    // 真实模型探针实测补入：协议标准术语「深度档」须命中
    expect(parseDeliverableSpec(['研究报告要达到深度档规格'])).toBe('deep')
    expect(parseDeliverableSpec(['先来个简报'])).toBe('brief')
    expect(parseDeliverableSpec(['帮我分析一下这个市场'])).toBeUndefined()
    expect(parseDeliverableSpec(['深入了解一下'])).toBeUndefined()
    expect(parseDeliverableSpec(['尽量详细一点'])).toBe('deep')
  })

  it('会话级粘性：最近一条声明覆盖旧声明；同消息 brief 优先', () => {
    expect(parseDeliverableSpec(['要深度报告', '算了给我一页纸'])).toBe('brief')
    expect(parseDeliverableSpec(['要一页纸', '还是给深度报告吧'])).toBe('deep')
    expect(parseDeliverableSpec(['给我深度报告，不过先来份简报'])).toBe('brief')
  })

  it('注入行：未声明为空串；深度 / 速览含档位口径', () => {
    expect(buildSpecInstructionLine(undefined)).toBe('')
    expect(buildSpecInstructionLine('deep')).toContain('深度档')
    expect(buildSpecInstructionLine('deep')).toContain('mode=append')
    expect(buildSpecInstructionLine('brief')).toContain('速览档')
  })
})

describe('交付规格：prepareTurn 集成', () => {
  it('用户声明深度 → deliverableSpec=deep 且回合指令注入规格行；未声明则不注入', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['lead', 'scout'], '规格集成')
    env.sessions.appendMessage({
      sessionId: session.id,
      role: 'user',
      content: '请给一份深度报告：调研权限模型',
      mentions: [],
      status: 'complete',
    })
    const prepared = await env.context.prepareTurn({
      sessionId: session.id,
      agentId: 'lead',
      runId: 'r-spec',
      queue: [],
    })
    expect(prepared.deliverableSpec).toBe('deep')
    expect(prepared.turnInstruction).toContain('本任务交付规格：深度档')

    const plain = env.sessions.create(['lead'], '规格缺省')
    env.sessions.appendMessage({
      sessionId: plain.id,
      role: 'user',
      content: '调研一下权限模型',
      mentions: [],
      status: 'complete',
    })
    const prepared2 = await env.context.prepareTurn({
      sessionId: plain.id,
      agentId: 'lead',
      runId: 'r-plain',
      queue: [],
    })
    expect(prepared2.deliverableSpec).toBeUndefined()
    expect(prepared2.turnInstruction).not.toContain('本任务交付规格')
  })
})

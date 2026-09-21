/**
 * 运行时上下文注入（时间 / 系统）：
 * - <runtime_context>（L3 尾段）：当前日期 / 时区 / 运行环境——天级稳定（同一天内字节级一致，护前缀缓存）；
 * - 回合指令「当前时刻」行（分钟级）：随每回合新建的最后一条 user 消息注入，零额外缓存损失；
 * - 全部角色 / 场景通用（装配必经路径，资产零改动）。
 */
import { describe, expect, it } from 'vitest'
import { buildRuntimeContext, buildSystemPrompt, buildTurnInstruction } from '../src/context/assembler.js'
import { makeEnv } from './helpers.js'

// 本地时间构造（避免时区歧义：Date(y, m, d, h, min) 即本地墙钟时间）
const at = (y: number, m: number, d: number, h: number, min: number) => new Date(y, m - 1, d, h, min)

describe('运行时上下文：buildRuntimeContext', () => {
  it('注入日期 / 星期 / 时区 / 运行环境（固定时刻）', () => {
    const block = buildRuntimeContext(at(2026, 9, 20, 14, 30))
    expect(block.startsWith('<runtime_context>')).toBe(true)
    expect(block.endsWith('</runtime_context>')).toBe(true)
    expect(block).toContain('当前日期：2026-09-20（周日）')
    expect(block).toContain('时区：')
    expect(block).toContain('UTC')
    expect(block).toContain('运行环境：')
  })

  it('天级稳定：同一天内任意时刻输出字节级一致（护前缀缓存）', () => {
    const early = buildRuntimeContext(at(2026, 9, 20, 0, 5))
    const late = buildRuntimeContext(at(2026, 9, 20, 23, 55))
    expect(early).toBe(late)
  })

  it('跨天变化：日期与星期随天推进', () => {
    const sunday = buildRuntimeContext(at(2026, 9, 20, 23, 59))
    const monday = buildRuntimeContext(at(2026, 9, 21, 0, 0))
    expect(monday).not.toBe(sunday)
    expect(sunday).toContain('2026-09-20（周日）')
    expect(monday).toContain('2026-09-21（周一）')
  })
})

describe('运行时上下文：buildSystemPrompt（L3 尾段）', () => {
  const base = {
    protocol: '<role_contract>\n测试协议</role_contract>',
    agent: { id: 'pm', name: '费利', role: '产品经理', handoff: [], skills: [], tools: [] } as never,
    agentBody: '我是产品经理。',
    roster: [{ id: 'pm', name: '费利', role: '产品经理', handoff: [], skills: [], tools: [] }] as never,
    preloadedSkills: [],
    skillsIndex: '',
    workspaceListing: '',
    memoryBlock: '',
    summaryBlock: '',
  }

  it('注入 <runtime_context>：日期正确、位于 system 尾段（花名册之后）', () => {
    const out = buildSystemPrompt({ ...base, now: at(2026, 9, 20, 9, 0) })
    expect(out.text).toContain('<runtime_context>')
    expect(out.text).toContain('2026-09-20（周日）')
    // 尾段：花名册在前，runtime 在后
    expect(out.text.indexOf('团队花名册')).toBeLessThan(out.text.indexOf('<runtime_context>'))
    // 时刻不进 system（分钟级信息由回合指令承载）
    expect(out.text).not.toMatch(/当前时刻：\d{2}:\d{2}/)
  })

  it('未传 now：缺省取当前时刻（不做断言固定值，仅结构完整）', () => {
    const out = buildSystemPrompt(base)
    expect(out.text).toMatch(/当前日期：\d{4}-\d{2}-\d{2}（周[一二三四五六日]）/)
  })
})

describe('运行时上下文：buildTurnInstruction（时刻行）', () => {
  it('三范式回合指令均含「当前时刻」行（固定时刻断言）', () => {
    const env = makeEnv()
    const agent = env.prompts.get('pm')!
    for (const mode of ['execute', 'plan', 'review'] as const) {
      const text = buildTurnInstruction(agent, env.prompts.list(), [], [], mode, { now: at(2026, 9, 20, 14, 30) })
      expect(text).toContain('- 当前时刻：14:30（当天日期与时区见系统提示）。')
    }
  })

  it('未传 now：缺省取当前时刻（HH:mm 格式）', () => {
    const env = makeEnv()
    const agent = env.prompts.get('pm')!
    const text = buildTurnInstruction(agent, env.prompts.list(), [], [], 'execute', {})
    expect(text).toMatch(/- 当前时刻：\d{2}:\d{2}（当天日期与时区见系统提示）。/)
  })
})

describe('运行时上下文：回合装配集成（全部角色通用）', () => {
  it('prepareTurn：任意角色 / 任意场景均注入 runtime 块与时刻行', async () => {
    const env = makeEnv()
    try {
      // 跨场景混搭（研发 + 空场景通用助手），验证与角色无关
      const session = env.sessions.create(['pm', 'general'], '运行时注入')
      for (const agentId of ['pm', 'general']) {
        const prepared = await env.context.prepareTurn({ sessionId: session.id, agentId, runId: `run_${agentId}`, queue: [] })
        expect(prepared.system).toContain('<runtime_context>')
        expect(prepared.system).toMatch(/当前日期：\d{4}-\d{2}-\d{2}（周[一二三四五六日]）/)
        expect(prepared.turnInstruction).toMatch(/- 当前时刻：\d{2}:\d{2}（当天日期与时区见系统提示）。/)
      }
      // L3 层 token 统计纳入 runtime 块（上下文抽屉展示口径）
      const layer = env.context.snapshot(session.id, 'pm').layers.find((l) => l.key === 'L3')
      expect(layer?.label).toBe('技能 / 工作区 / 运行时')
      expect(layer?.tokens).toBeGreaterThan(0)
    } finally {
      env.sessions.close()
      env.db.close()
    }
  })
})

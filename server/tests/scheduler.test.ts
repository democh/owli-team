import { describe, expect, it } from 'vitest'
import {
  decideHandoff,
  detectContentLoop,
  detectLoop,
  mergeWaveSchedule,
  planWave,
  trigramDice,
  waveSignature,
} from '../src/orchestration/scheduler.js'

const participants = ['pm', 'architect', 'designer', 'frontend', 'backend', 'qa', 'devops']

/** 串行等价助手：单成员波（当前成员已出队，queue = 剩余队列） */
function merge(overrides: Partial<Parameters<typeof mergeWaveSchedule>[0]> = {}) {
  return mergeWaveSchedule({
    decisions: [
      {
        agentId: 'pm',
        ...decideHandoff({ mentions: [], handedToUser: false, participants, currentAgentId: 'pm' }),
      },
    ],
    participants,
    queue: [],
    signatures: ['pm'],
    waveTexts: [],
    spoken: ['pm'],
    fallbackUsed: false,
    rounds: false,
    ...overrides,
  })
}

/** 单成员裁决构造器（按真实流程：mentions → decideHandoff） */
function decision(agentId: string, mentions: string[], handedToUser = false) {
  return {
    agentId,
    ...decideHandoff({ mentions, handedToUser, participants, currentAgentId: agentId }),
  }
}

describe('scheduler：单成员裁决（decideHandoff）', () => {
  it('候选去重（重复 @ 只保留一次）', () => {
    const result = decideHandoff({
      mentions: ['architect', 'architect', 'qa'],
      handedToUser: false,
      participants,
      currentAgentId: 'pm',
    })
    expect(result.accepted).toEqual(['architect', 'qa'])
    expect(result.dropped).toEqual([{ id: 'architect', reason: 'duplicate' }])
  })

  it('参与者过滤（不在场的委派被丢弃，§6.4）', () => {
    const result = decideHandoff({
      mentions: ['architect', 'i-am-not-here'],
      handedToUser: false,
      participants: ['pm', 'architect'],
      currentAgentId: 'pm',
    })
    expect(result.accepted).toEqual(['architect'])
    expect(result.dropped).toEqual([{ id: 'i-am-not-here', reason: 'not-in-room' }])
  })

  it('自续抑制（刚发言者不会被自己接回）', () => {
    const result = decideHandoff({
      mentions: ['pm', 'architect'],
      handedToUser: false,
      participants,
      currentAgentId: 'pm',
    })
    expect(result.accepted).toEqual(['architect'])
    expect(result.dropped[0]).toEqual({ id: 'pm', reason: 'self-continuous' })
  })
})

describe('scheduler：波次合并（mergeWaveSchedule）', () => {
  it('已有队列 + 新候选合并去重', () => {
    const result = merge({ decisions: [decision('pm', ['qa'])], queue: ['architect', 'qa'] })
    expect(result.queue).toEqual(['architect', 'qa'])
    expect(result.acceptedByAgent).toEqual([{ agentId: 'pm', accepted: ['qa'] }])
  })

  it('全员交还 → 队列清空，全员 accepted = [user]', () => {
    const result = merge({ decisions: [decision('pm', [], true)], queue: ['architect'] })
    expect(result.handedToUser).toBe(true)
    expect(result.acceptedByAgent).toEqual([{ agentId: 'pm', accepted: ['user'] }])
    expect(result.queue).toEqual([])
  })

  it('M46-2 派发优先：同条消息「派发成员 + @用户 报备」→ 成员接手不被吞（单成员波）', () => {
    // 典型场景：调度官派发梅森定稿，并在同条消息末尾 @用户 报备（历史缺陷：被误判全员交还，派发被静默丢弃）
    const result = merge({ decisions: [decision('pm', ['architect'], true)] })
    expect(result.handedToUser).toBe(false)
    expect(result.queue).toEqual(['architect'])
    expect(result.acceptedByAgent).toEqual([{ agentId: 'pm', accepted: ['architect'] }])
  })

  it('M46-2 派发优先：同条消息多目标派发 + @用户 报备 → 入队且下一波并行', () => {
    const result = merge({ decisions: [decision('pm', ['architect', 'qa'], true)] })
    expect(result.handedToUser).toBe(false)
    expect(result.queue).toEqual(['architect', 'qa'])
    expect(result.forceNextParallel).toBe(true)
    expect(result.acceptedByAgent).toEqual([{ agentId: 'pm', accepted: ['architect', 'qa'] }])
  })

  it('M46-2 纯 @用户 报备（无成员接手）→ 仍然交还（不因修复而漏交还）', () => {
    const result = merge({ decisions: [decision('pm', [], true)], queue: [] })
    expect(result.handedToUser).toBe(true)
    expect(result.queue).toEqual([])
  })

  it('部分交还（并行波）→ 不交还：其余成员接手继续', () => {
    const result = merge({ decisions: [decision('pm', [], true), decision('qa', ['architect'])] })
    expect(result.handedToUser).toBe(false)
    expect(result.acceptedByAgent).toEqual([
      { agentId: 'pm', accepted: ['user'] },
      { agentId: 'qa', accepted: ['architect'] },
    ])
    expect(result.queue).toEqual(['architect'])
  })

  it('循环检测：A/B 交替签名（含本波，长度 4）→ 抑制并交还（全员 [user]）', () => {
    const result = merge({
      decisions: [decision('pm', ['architect'])],
      signatures: ['pm', 'architect', 'pm'],
    })
    expect(result.loopSuppressed).toBe(true)
    expect(result.handedToUser).toBe(true)
    expect(result.queue).toEqual([])
    expect(result.acceptedByAgent).toEqual([{ agentId: 'pm', accepted: ['user'] }])
  })

  it('rounds 场景：交替阈值放宽到 6（长度 4 不抑制，长度 6 命中）', () => {
    const four = merge({
      decisions: [decision('pm', ['architect'])],
      signatures: ['pm', 'architect', 'pm'],
      rounds: true,
    })
    expect(four.loopSuppressed).toBe(false)
    expect(four.handedToUser).toBe(false)
    const six = merge({
      decisions: [decision('pm', ['architect'])],
      signatures: ['pm', 'architect', 'pm', 'architect', 'pm'],
      rounds: true,
    })
    expect(six.loopSuppressed).toBe(true)
    expect(six.handedToUser).toBe(true)
  })

  it('内容级循环：连续 4 波相似文本 → 强制交还', () => {
    const text = '这是完全相同的一段回复内容，用于内容级循环检测。'
    const result = merge({
      decisions: [decision('architect', ['qa'])],
      waveTexts: [text, text, text, text],
    })
    expect(result.loopSuppressed).toBe(true)
    expect(result.handedToUser).toBe(true)
  })

  it('handoff 多目标 → 下一波强制并行（fan-out）', () => {
    const result = merge({ decisions: [decision('pm', ['architect', 'qa'])] })
    expect(result.forceNextParallel).toBe(true)
    expect(result.queue).toEqual(['architect', 'qa'])
  })
})

describe('scheduler：收尾兜底', () => {
  it('模型沉默且队列空 → 按编制顺序兜底一位未发言者（仅一次）', () => {
    const first = merge({ signatures: ['pm', 'architect'], spoken: ['pm', 'architect'] })
    expect(first.queue).toEqual(['designer'])
    expect(first.fallbackUsed).toBe(true)

    const second = merge({
      signatures: ['pm', 'architect', 'designer'],
      spoken: ['pm', 'architect', 'designer'],
      fallbackUsed: true,
    })
    expect(second.handedToUser).toBe(true)
    expect(second.queue).toEqual([])
  })

  it('队列非空时模型沉默 → 不触发兜底，继续消费队列', () => {
    const result = merge({ decisions: [decision('pm', [])], queue: ['architect'] })
    expect(result.queue).toEqual(['architect'])
    expect(result.fallbackUsed).toBe(false)
    expect(result.handedToUser).toBe(false)
  })

  it('兜底无可用成员（全员发言过）→ 直接交还用户', () => {
    const result = merge({ signatures: [...participants], spoken: [...participants] })
    expect(result.handedToUser).toBe(true)
  })
})

describe('scheduler：循环检测与签名', () => {
  it('detectLoop：两人严格交替 / 单人三连 命中；正常序列不命中', () => {
    expect(detectLoop(['a', 'b', 'a', 'b'])).toBe(true)
    expect(detectLoop(['a', 'a', 'a'])).toBe(true)
    expect(detectLoop(['a', 'b', 'c', 'a'])).toBe(false)
    expect(detectLoop(['a', 'b'])).toBe(false)
    expect(detectLoop(['a', 'b', 'a', 'b'])).toBe(true) // 长度 4 交替：默认阈值命中
    expect(detectLoop(['a', 'b', 'a', 'b'], 6, 6)).toBe(false) // rounds：4 轮交替不抑制
    expect(detectLoop(['a', 'b', 'a', 'b', 'a', 'b'], 6, 6)).toBe(true)
  })

  it('trigramDice / detectContentLoop：完全相同 = 1；不足 4 波不判定', () => {
    expect(trigramDice('abc', 'abc')).toBe(1)
    expect(trigramDice('abc', 'xyz')).toBe(0)
    expect(detectContentLoop(['x', 'x', 'x'])).toBe(false)
  })

  it('waveSignature：排序拼接（并行波与顺序无关；串行 = 成员 id）', () => {
    expect(waveSignature(['pm'])).toBe('pm')
    expect(waveSignature(['qa', 'pm'])).toBe(waveSignature(['pm', 'qa']))
  })
})

describe('scheduler：波规划（planWave）', () => {
  const groups: Record<string, { id: string; parallel: boolean; parallelMax?: number }> = {
    pm: { id: 'development', parallel: false },
    architect: { id: 'development', parallel: false },
    facilitator: { id: 'brainstorm', parallel: true, parallelMax: 4 },
    ideator: { id: 'brainstorm', parallel: true, parallelMax: 4 },
    challenger: { id: 'brainstorm', parallel: true, parallelMax: 4 },
    scout: { id: 'research', parallel: true, parallelMax: 2 },
  }
  const groupOf = (id: string) => groups[id]

  it('默认串行：场景未开并行 → 单成员波', () => {
    const wave = planWave({ queue: ['pm', 'architect'], groupOf, globalParallelMax: 3, forceParallel: false })
    expect(wave).toEqual({ members: ['pm'], parallel: false })
  })

  it('场景 parallel → 取队首连续同场景成员成波（受全局上限截断）', () => {
    const wave = planWave({
      queue: ['facilitator', 'ideator', 'challenger', 'pm'],
      groupOf,
      globalParallelMax: 3,
      forceParallel: false,
    })
    expect(wave.members).toEqual(['facilitator', 'ideator', 'challenger'])
    expect(wave.parallel).toBe(true)
  })

  it('场景 parallelMax 覆盖全局上限（brainstorm 圆桌 4 人）', () => {
    const wave = planWave({
      queue: ['facilitator', 'ideator', 'challenger'],
      groupOf,
      globalParallelMax: 2,
      forceParallel: false,
    })
    expect(wave.members).toHaveLength(3)
    expect(wave.parallel).toBe(true)
  })

  it('PARALLEL_MAX=1 关闭并行（含显式触发）', () => {
    const wave = planWave({ queue: ['facilitator', 'ideator'], groupOf, globalParallelMax: 1, forceParallel: true })
    expect(wave).toEqual({ members: ['facilitator'], parallel: false })
  })

  it('显式触发（@≥2 / handoff 多目标）→ 取队首最多 N 位（可跨场景混搭）', () => {
    const wave = planWave({ queue: ['pm', 'facilitator', 'scout'], groupOf, globalParallelMax: 3, forceParallel: true })
    expect(wave.members).toEqual(['pm', 'facilitator', 'scout'])
    expect(wave.parallel).toBe(true)
  })

  it('显式触发同样截断到上限', () => {
    const wave = planWave({
      queue: ['pm', 'architect', 'facilitator', 'ideator'],
      groupOf,
      globalParallelMax: 2,
      forceParallel: true,
    })
    expect(wave.members).toEqual(['pm', 'architect'])
  })

  it('空队列 → 空波', () => {
    expect(planWave({ queue: [], groupOf, globalParallelMax: 3, forceParallel: false })).toEqual({
      members: [],
      parallel: false,
    })
  })
})

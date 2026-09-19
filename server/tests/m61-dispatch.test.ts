/**
 * M61：调度增强单测（D1 PRS v2 / D3 停滞抑制 / D5 写冲突 / D6 调度指标 / D7 链路降级）。
 * - write-tracking 纯函数（路径提取 / 补丁头解析 / 冲突检测）；
 * - detectStall 判定矩阵 + mergeWaveSchedule 停滞集成（与循环抑制同走 handedToUser）；
 * - coerceRoutePlan 的 mode 白名单容错；
 * - RunEventStore.schedulingStats 聚合（payload 条件）。
 */
import { describe, expect, it } from 'vitest'
import type { ChatRequest, LlmChunk } from '../src/llm/provider.js'
import { decideHandoff, detectStall, mergeWaveSchedule } from '../src/orchestration/scheduler.js'
import { coerceRoutePlan } from '../src/orchestration/platform-router.js'
import {
  detectWriteConflicts,
  extractWritePaths,
  newWaveWriteBuffer,
  patchPaths,
  recordWrite,
} from '../src/orchestration/write-tracking.js'
import { appendUserMessage, makeEnv, waitRunFinished } from './helpers.js'

describe('M61-D5：写目标提取与冲突检测（write-tracking）', () => {
  it('extractWritePaths：write_file / edit_file 取 path（归一化）；非写工具与缺参为空', () => {
    expect(extractWritePaths('write_file', { path: './docs/a.md' })).toEqual(['docs/a.md'])
    expect(extractWritePaths('edit_file', { path: 'src/x.ts' })).toEqual(['src/x.ts'])
    expect(extractWritePaths('apply_patch', {})).toEqual([])
    expect(extractWritePaths('read_file', { path: 'x' })).toEqual([])
    expect(extractWritePaths('canvas_write', { path: 'x' })).toEqual([])
  })

  it('apply_patch：从补丁头提取路径（a/ b/ 剥离、/dev/null 剔除、去重）', () => {
    const patch = [
      '--- a/docs/需求.md',
      '+++ b/docs/需求.md',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      '--- /dev/null',
      '+++ b/docs/new.md',
      '@@ -0,0 +1 @@',
      '+new',
    ].join('\n')
    expect(patchPaths(patch)).toEqual(['docs/需求.md', 'docs/new.md'])
    expect(extractWritePaths('apply_patch', { patch })).toEqual(['docs/需求.md', 'docs/new.md'])
  })

  it('recordWrite / detectWriteConflicts：重叠产出 / 无重叠与单成员不产出', () => {
    const buf = newWaveWriteBuffer()
    recordWrite(buf, 'a', ['docs/x.md', 'docs/y.md'])
    recordWrite(buf, 'b', ['docs/y.md'])
    recordWrite(buf, 'c', ['docs/z.md'])
    expect(buf.count).toBe(3)
    expect(detectWriteConflicts(buf.byAgent)).toEqual([{ a: 'a', b: 'b', paths: ['docs/y.md'] }])
    const solo = newWaveWriteBuffer()
    recordWrite(solo, 'a', ['x'])
    expect(detectWriteConflicts(solo.byAgent)).toEqual([])
  })
})

describe('M61-D3：停滞判定（detectStall）', () => {
  it('同一成员两波零写动作 + 文本相似 → true；有写动作 / 签名不同 / 不相似 / 不足两波 / 空文本 → false', () => {
    const text = '方案基本维持上一轮结论，等待进一步确认。'
    expect(detectStall([text, text], [0, 0], ['pm', 'pm'])).toBe(true)
    expect(detectStall([text, text], [0, 1], ['pm', 'pm'])).toBe(false) // 本波有写动作
    expect(detectStall([text, text], [1, 0], ['pm', 'pm'])).toBe(false) // 上波有写动作
    expect(detectStall([text, text], [0, 0], ['pm', 'qa'])).toBe(false) // 签名不同（多人轮转交内容级循环）
    expect(detectStall(['甲'.repeat(60), '乙'.repeat(60)], [0, 0], ['pm', 'pm'])).toBe(false) // 文本不相似
    expect(detectStall([text], [0], ['pm'])).toBe(false) // 不足两波
    expect(detectStall(['', text], [0, 0], ['pm', 'pm'])).toBe(false) // 空文本防御
  })

  it('mergeWaveSchedule：同签名停滞抑制与循环抑制同走 handedToUser（stallSuppressed 分开标注）', () => {
    const text = '同上，仍待确认。'
    const result = mergeWaveSchedule({
      decisions: [
        {
          agentId: 'pm',
          ...decideHandoff({
            mentions: ['qa'],
            handedToUser: false,
            participants: ['pm', 'qa'],
            currentAgentId: 'pm',
          }),
        },
      ],
      participants: ['pm', 'qa'],
      queue: [],
      signatures: ['pm', 'pm'],
      waveTexts: [text, text],
      waveWriteCounts: [0, 0],
      spoken: ['pm'],
      fallbackUsed: false,
      rounds: false,
    })
    expect(result.stallSuppressed).toBe(true)
    expect(result.handedToUser).toBe(true)
    expect(result.queue).toEqual([])
  })

  it('mergeWaveSchedule：多人轮转（签名不同）不触发停滞（交内容级循环处理）', () => {
    const text = '同上，仍待确认。'
    const result = mergeWaveSchedule({
      decisions: [
        {
          agentId: 'pm',
          ...decideHandoff({
            mentions: ['qa'],
            handedToUser: false,
            participants: ['pm', 'qa'],
            currentAgentId: 'pm',
          }),
        },
      ],
      participants: ['pm', 'qa'],
      queue: [],
      signatures: ['qa', 'pm'],
      waveTexts: [text, text],
      waveWriteCounts: [0, 0],
      spoken: ['pm'],
      fallbackUsed: false,
      rounds: false,
    })
    expect(result.stallSuppressed).toBe(false)
    expect(result.handedToUser).toBe(false)
    expect(result.queue).toEqual(['qa'])
  })

  it('mergeWaveSchedule：缺省 waveWriteCounts 时不做停滞判定（既有调用零差异）', () => {
    const text = '同上，仍待确认。'
    const result = mergeWaveSchedule({
      decisions: [
        {
          agentId: 'pm',
          ...decideHandoff({
            mentions: ['qa'],
            handedToUser: false,
            participants: ['pm', 'qa'],
            currentAgentId: 'pm',
          }),
        },
      ],
      participants: ['pm', 'qa'],
      queue: [],
      signatures: ['pm', 'pm'],
      waveTexts: [text, text],
      spoken: ['pm'],
      fallbackUsed: false,
      rounds: false,
    })
    expect(result.stallSuppressed).toBe(false)
    expect(result.handedToUser).toBe(false)
    expect(result.queue).toEqual(['qa'])
  })
})

describe('M61-D1：PRS v2 输出容错（mode 白名单）', () => {
  const opts = { presentIds: ['pm'], knownIds: new Set(['pm', 'architect']) }

  it('mode=plan/review 保留；非法值丢弃为缺省；未知角色仍被既有守卫丢弃', () => {
    const parsed = coerceRoutePlan(
      {
        members: [],
        assignments: [
          { agentId: 'pm', task: 'A', mode: 'plan' },
          { agentId: 'architect', task: 'B' }, // 不在场且未召集 → 丢弃
        ],
        reason: 'r',
      },
      opts,
    )
    expect(parsed?.assignments).toEqual([{ agentId: 'pm', task: 'A', mode: 'plan' }])

    const off = coerceRoutePlan(
      { members: [], assignments: [{ agentId: 'pm', task: 'A', mode: 'hack' }], reason: '' },
      opts,
    )
    expect(off?.assignments).toEqual([{ agentId: 'pm', task: 'A' }])

    const review = coerceRoutePlan(
      { members: ['architect'], assignments: [{ agentId: 'architect', task: 'B', mode: 'review' }], reason: '' },
      opts,
    )
    expect(review?.assignments).toEqual([{ agentId: 'architect', task: 'B', mode: 'review' }])
  })
})

describe('M61-D6：schedulingStats 聚合', () => {
  it('按事件类型与 payload 条件聚合（路由 / 波次 / 抑制 / 冲突 / 接单）', () => {
    const env = makeEnv()
    const store = env.events
    const rec = (type: string, payload: Record<string, unknown> = {}): void =>
      store.record({ runId: 'r1', sessionId: 's1', type, payload })
    rec('run:start')
    rec('routing:dispatched', { assignments: [{ agentId: 'pm' }] })
    rec('routing:dispatched', { fallback: true, error: '解析失败' })
    rec('wave:start', { parallel: true })
    rec('wave:start')
    rec('schedule', { loopSuppressed: true })
    rec('schedule', { stallSuppressed: true })
    rec('wave:write-conflict', { pairs: [] })
    rec('handoff:accepted', { agentId: 'pm' })

    expect(store.schedulingStats()).toEqual({
      runs: 1,
      routes: 1,
      routeFallbacks: 1,
      waves: 2,
      parallelWaves: 1,
      loopSuppressed: 1,
      stallSuppressed: 1,
      writeConflicts: 1,
      handoffAccepted: 1,
    })
  })
})

describe('M61-D5：并行写冲突端到端（引擎）', () => {
  it('两成员并行修改同一文件 → 系统事件条 + trace 留痕（单文件重叠一次）', async () => {
    const env = makeEnv({ approvalMode: 'off' })
    // M46-2：会话默认串行；显式 serial: false 启用并行成波（本用例聚焦并行写冲突路径）
    const session = env.sessions.create(['backend', 'qa'], 'M61 写冲突', { serial: false })
    const provider = env.provider as unknown as {
      chatStream: (req: ChatRequest, signal: AbortSignal) => AsyncIterable<LlmChunk>
    }
    provider.chatStream = async function* (req) {
      const last = req.messages[req.messages.length - 1]
      if (last?.role === 'tool') {
        yield { type: 'text', text: '已完成，交还用户。\n@用户' }
        yield { type: 'done' }
        return
      }
      yield {
        type: 'tool_calls',
        calls: [
          {
            id: `c_${req.meta.agentId}`,
            name: 'write_file',
            arguments: JSON.stringify({ path: 'docs/共享文档.md', content: '# 共享' }),
          },
        ],
      }
      yield { type: 'done' }
    }
    const message = appendUserMessage(env, session.id, '@backend @qa 请各自更新文档')
    const { runId } = env.engine.launch(session.id, message.id)
    await waitRunFinished(env.engine, runId)

    const conflicts = env.events.listByRun(runId).filter((e) => e.type === 'wave:write-conflict')
    expect(conflicts).toHaveLength(1)
    const system = env.sessions
      .messages(session.id)
      .find((m) => m.role === 'system' && m.content.includes('并行写冲突提醒'))
    expect(system?.content).toContain('docs/共享文档.md')
    expect(env.published.some((n) => n.type === 'notify:plan-updated')).toBe(true)
  })
})

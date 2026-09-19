/**
 * M9 测试：Trace 落库（回合 / 工具 / 调度 / 压缩）、指标汇总、反馈闭环、FTS 检索、评测断言器。
 *
 * 验收对照（计划 M9）：
 * - Run 全链路事件（run/turn/tool/schedule）落 run_events，turn:end 含耗时与 token；
 * - GET /api/metrics/summary 聚合回合数 / token / 费用 / 工具失败率；
 * - feedback 表写入 / 覆盖 / 导出；
 * - messages_fts 检索（长词 FTS、短词 LIKE 回退、危险字符不报错）；
 * - eval 断言器 8 种类型的判定与 fail-fast 解析。
 */
import type { AddressInfo } from 'node:net'
import express from 'express'
import { describe, expect, it } from 'vitest'
import type { ChatMessage, TraceEntry } from '@multi-agent/shared'
import {
  parseAssertions,
  runAssertions,
  schedulingCounts,
  type Assertion,
  type AssertionContext,
} from '../src/eval/assertions.js'
import { createFeedbackRouter } from '../src/routes/feedback.js'
import { createMetricsRouter } from '../src/routes/metrics.js'
import type { ApiDeps } from '../src/routes/index.js'
import { makeEnv, sendAndWait, makeTmpDir } from './helpers.js'
import fs from 'node:fs'
import path from 'node:path'

type Env = ReturnType<typeof makeEnv>

/** 轻量 HTTP 挂载（只依赖 events/usage/metrics/feedback 子集） */
async function mountApi(env: Env): Promise<{ url: string; close: () => Promise<void> }> {
  const deps = env as unknown as ApiDeps
  const app = express()
  app.use(express.json())
  app.use('/api', createMetricsRouter(deps))
  app.use('/api', createFeedbackRouter(deps))
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

describe('M9 Trace 落库（真实 Run）', () => {
  it('单角色 Run 产出完整时间轴：run:start → turn:start → tool → turn:end → run:end', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['backend'], 'M9 Trace')
    await sendAndWait(env, session.id, '请帮我实现登录功能的接口')
    const runId = env.runs.latest(session.id)!.id

    const events = env.events.listByRun(runId)
    expect(events.length).toBeGreaterThan(0)
    expect(events[0].type).toBe('run:start')
    expect(events[events.length - 1].type).toBe('run:end')

    const types = events.map((e) => e.type)
    expect(types).toContain('turn:start')
    expect(types).toContain('turn:end')
    expect(types).toContain('tool')

    // 工具事件：首回合脚本化 write_todos + write_file，均成功且带耗时
    const toolEvents = events.filter((e) => e.type === 'tool')
    expect(toolEvents.some((e) => e.payload.name === 'write_file' && e.payload.ok === true)).toBe(true)
    expect(toolEvents.every((e) => typeof e.payload.durationMs === 'number')).toBe(true)

    // 回合结束：耗时与 token 计数可读
    const turnEnd = events.find((e) => e.type === 'turn:end')!
    expect(turnEnd.payload.agentId).toBe('backend')
    expect(typeof turnEnd.payload.durationMs).toBe('number')
    expect(Number(turnEnd.payload.promptTokens)).toBeGreaterThan(0)

    // 结束原因与队列调度
    const runEnd = events[events.length - 1]
    expect(runEnd.payload.reason).toBe('completed')
    const schedule = events.find((e) => e.type === 'schedule')
    expect(schedule).toBeDefined()
    // M16：波级调度明细（members = 本波成员；accepted = 逐成员接手）
    expect(schedule!.payload.members).toEqual(['backend'])
    const acceptedByAgent = schedule!.payload.accepted as Array<{ agentId: string; accepted: string[] }>
    expect(acceptedByAgent[0].agentId).toBe('backend')
    env.sessions.close()
    env.db.close()
  })

  it('多人接力：schedule 事件记录交接与交还用户', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm', 'architect', 'qa'], 'M9 接力')
    await sendAndWait(env, session.id, '请完成注册功能的需求与架构')
    const runId = env.runs.latest(session.id)!.id
    const events = env.events.listByRun(runId)

    const schedules = events.filter((e) => e.type === 'schedule')
    expect(schedules.length).toBeGreaterThanOrEqual(3)
    expect(
      schedules.some((e) =>
        (e.payload.accepted as Array<{ agentId: string; accepted: string[] }>).some((a) =>
          a.accepted.includes('architect'),
        ),
      ),
    ).toBe(true)
    expect(schedules.some((e) => e.payload.handedToUser === true)).toBe(true)

    // stats 聚合
    const stats = env.events.stats()
    expect(stats.runs).toBeGreaterThanOrEqual(1)
    expect(stats.turns).toBeGreaterThanOrEqual(3)
    expect(stats.avgTurnMs).toBeGreaterThanOrEqual(0)
    env.sessions.close()
    env.db.close()
  })
})

describe('M9 指标与反馈 API', () => {
  it('GET /api/metrics/summary 返回聚合指标；POST/GET/export 反馈闭环', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['backend'], 'M9 指标')
    await sendAndWait(env, session.id, '请实现支付回调接口')
    const messageId = env.sessions.messages(session.id).find((m) => m.role === 'agent')!.id

    const api = await mountApi(env)
    try {
      const metrics = (await (await fetch(`${api.url}/api/metrics/summary`)).json()) as {
        summary: {
          runs: number
          turns: number
          promptTokens: number
          toolCalls: number
          toolFailures: number
        }
        tools: Array<{ toolName: string; calls: number }>
        feedback: { total: number; up: number; down: number }
      }
      expect(metrics.summary.runs).toBeGreaterThanOrEqual(1)
      expect(metrics.summary.turns).toBeGreaterThanOrEqual(1)
      expect(metrics.summary.promptTokens).toBeGreaterThan(0)
      expect(metrics.summary.toolCalls).toBeGreaterThanOrEqual(2)
      expect(metrics.tools.some((t) => t.toolName === 'write_file')).toBe(true)
      expect(metrics.feedback.total).toBe(0)

      // 写入反馈
      const created = await fetch(`${api.url}/api/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: session.id, messageId, rating: 1, reason: '接口定义清晰' }),
      })
      expect(created.status).toBe(201)

      // 覆盖式：同消息再评 → 只有一条
      const overwrite = await fetch(`${api.url}/api/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: session.id, messageId, rating: -1 }),
      })
      expect(overwrite.status).toBe(201)
      const single = (await (await fetch(`${api.url}/api/feedback?messageId=${messageId}`)).json()) as {
        item: { rating: number } | null
      }
      expect(single.item?.rating).toBe(-1)

      const stats = (await (await fetch(`${api.url}/api/metrics/summary`)).json()) as {
        feedback: { total: number; up: number; down: number }
      }
      expect(stats.feedback).toEqual({ total: 1, up: 0, down: 1 })

      const exported = (await (await fetch(`${api.url}/api/feedback/export`)).json()) as {
        count: number
        items: Array<{ messageId: string }>
      }
      expect(exported.count).toBe(1)
      expect(exported.items[0].messageId).toBe(messageId)

      // 非法 rating → 400
      const bad = await fetch(`${api.url}/api/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: session.id, messageId, rating: 5 }),
      })
      expect(bad.status).toBe(400)
    } finally {
      await api.close()
      env.sessions.close()
      env.db.close()
    }
  })
})

describe('M9 FTS 检索', () => {
  it('长词走 FTS、短词走 LIKE 回退、危险字符不报错、删除后不再命中', () => {
    // 纯 store 断言：appendMessage 同步维护 FTS 索引，无需启动引擎
    const env = makeEnv()
    const session = env.sessions.create(['backend'], 'M9 检索')
    const userMessage = env.sessions.appendMessage({
      sessionId: session.id,
      role: 'user',
      content: '请帮我实现登录功能，注意幂等',
      mentions: [],
      status: 'complete',
    })
    env.sessions.appendMessage({
      sessionId: session.id,
      role: 'agent',
      agentId: 'backend',
      content: '登录功能已实现：幂等键放在请求头，登录失败返回可读错误',
      mentions: [],
      status: 'complete',
    })

    // 长词（≥3 字符）：trigram FTS 命中用户消息
    const longHits = env.sessions.search('登录功能')
    expect(longHits.some((h) => h.messageId === userMessage.id)).toBe(true)

    // 短词（2 字符）：LIKE 回退命中
    const shortHits = env.sessions.search('幂等')
    expect(shortHits.some((h) => h.messageId === userMessage.id)).toBe(true)

    // 危险字符：不抛错（回退 LIKE）
    expect(() => env.sessions.search('"')).not.toThrow()
    expect(() => env.sessions.search('***')).not.toThrow()

    // 无匹配
    expect(env.sessions.search('不存在的词xyz')).toEqual([])

    // 删除消息后：FTS 与主表均不再命中
    expect(env.sessions.deleteMessage(session.id, userMessage.id)).toBe(true)
    expect(env.sessions.search('登录功能').some((h) => h.messageId === userMessage.id)).toBe(false)
    expect(env.sessions.search('幂等').some((h) => h.messageId === userMessage.id)).toBe(false)

    env.sessions.close()
    env.db.close()
  })
})

describe('M9 eval 断言器', () => {
  function traceEntry(partial: Partial<TraceEntry> & { type: string }): TraceEntry {
    return {
      id: Math.floor(Math.random() * 1e9),
      runId: 'r1',
      sessionId: 's1',
      turnIndex: 0,
      payload: {},
      ts: new Date().toISOString(),
      ...partial,
    }
  }

  function makeCtx(over: Partial<AssertionContext> = {}): AssertionContext {
    const rootDir = makeTmpDir('ma-eval-')
    fs.mkdirSync(path.join(rootDir, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(rootDir, 'docs', '需求文档.md'), '# 需求\n\n- 验收标准：主流程 ≤ 2 步')
    const messages: ChatMessage[] = [
      {
        id: 'm1',
        sessionId: 's1',
        role: 'user',
        content: '需求',
        mentions: [],
        status: 'complete',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'm2',
        sessionId: 's1',
        role: 'agent',
        agentId: 'pm',
        content: '@architect 接力',
        mentions: ['architect'],
        status: 'complete',
        createdAt: new Date().toISOString(),
      },
    ]
    return {
      rootDir,
      events: [
        traceEntry({ type: 'turn:end', payload: { status: 'complete' } }),
        traceEntry({ type: 'schedule', payload: { loopSuppressed: false } }),
        traceEntry({
          type: 'routing:dispatched',
          payload: { source: 'route', members: ['architect', 'qa'], reason: '平台组队' },
        }),
        traceEntry({ type: 'run:end', payload: { reason: 'completed' } }),
      ],
      messages,
      context: { estimatedTokens: 1000, budgetTokens: 60000 },
      ...over,
    }
  }

  it('断言矩阵的成功与失败判定（含 M46/M48/M50：agent_spoke / invited_members / no_invite）', async () => {
    const ctx = makeCtx()
    const cases: Array<{ assertion: Assertion; ok: boolean }> = [
      { assertion: { type: 'artifact_exists', path: 'docs/需求文档.md' }, ok: true },
      { assertion: { type: 'artifact_exists', path: 'docs/无.md' }, ok: false },
      { assertion: { type: 'artifact_contains', path: 'docs/需求文档.md', text: '验收标准' }, ok: true },
      { assertion: { type: 'artifact_contains', path: 'docs/需求文档.md', text: '不存在' }, ok: false },
      { assertion: { type: 'min_chars', path: 'docs/需求文档.md', value: 10 }, ok: true },
      { assertion: { type: 'min_chars', path: 'docs/需求文档.md', value: 9999 }, ok: false },
      { assertion: { type: 'run_end_reason', value: 'completed' }, ok: true },
      { assertion: { type: 'run_end_reason', value: 'stopped' }, ok: false },
      { assertion: { type: 'turns_lte', value: 2 }, ok: true },
      { assertion: { type: 'turns_lte', value: 0 }, ok: false },
      { assertion: { type: 'handoff_targets', values: ['architect'] }, ok: true },
      { assertion: { type: 'handoff_targets', values: ['qa'] }, ok: false },
      { assertion: { type: 'agent_spoke', values: ['pm'] }, ok: true },
      { assertion: { type: 'agent_spoke', values: ['qa'] }, ok: false },
      { assertion: { type: 'invited_members', values: ['architect'] }, ok: true },
      { assertion: { type: 'invited_members', values: ['backend'] }, ok: false },
      { assertion: { type: 'no_invite' }, ok: false },
      { assertion: { type: 'no_loop' }, ok: true },
      { assertion: { type: 'no_stall' }, ok: true },
      { assertion: { type: 'scheduling', routesMin: 1 }, ok: true },
      { assertion: { type: 'scheduling', handoffAcceptedMin: 1 }, ok: false },
      { assertion: { type: 'token_budget_ok' }, ok: true },
    ]
    const results = await runAssertions(
      cases.map((c) => c.assertion),
      ctx,
    )
    results.forEach((result, i) => {
      expect(result.ok, `${cases[i].assertion.type} 期望 ${cases[i].ok}`).toBe(cases[i].ok)
    })
  })

  it('交付规格断言：min_chars / min_sections / min_sources 判定与解析', async () => {
    const ctx = makeCtx()
    fs.writeFileSync(
      path.join(ctx.rootDir, 'docs', '报告.md'),
      [
        '# 报告',
        '',
        '## 结论',
        '',
        '- 增长率 12%（来源：年报 2026）',
        '',
        '## 证据',
        '',
        '- 对照 [S1] 与 [S2]，详见 https://example.com/a',
        '- 另据 S-03 与 S-04 复盘（真实模型探针实测的连字符格式）',
        '',
      ].join('\n'),
    )
    const cases: Array<{ assertion: Assertion; ok: boolean }> = [
      { assertion: { type: 'min_chars', path: 'docs/报告.md', value: 30 }, ok: true },
      { assertion: { type: 'min_chars', path: 'docs/报告.md', value: 9999 }, ok: false },
      { assertion: { type: 'min_sections', path: 'docs/报告.md', value: 2 }, ok: true },
      { assertion: { type: 'min_sections', path: 'docs/报告.md', value: 3 }, ok: false },
      // 来源标记口径：URL 1 + 「来源：」1 + 方括号 [S1]/[S2] 2 + 裸编号 S-03/S-04 2 = 6
      { assertion: { type: 'min_sources', path: 'docs/报告.md', value: 6 }, ok: true },
      { assertion: { type: 'min_sources', path: 'docs/报告.md', value: 7 }, ok: false },
      { assertion: { type: 'min_chars', path: 'docs/无.md', value: 1 }, ok: false },
    ]
    const results = await runAssertions(
      cases.map((c) => c.assertion),
      ctx,
    )
    results.forEach((result, i) => {
      expect(result.ok, `${cases[i].assertion.type} 期望 ${cases[i].ok}`).toBe(cases[i].ok)
    })

    // 解析：path / value 透传（未知字段丢弃）
    const parsed = parseAssertions([{ type: 'min_sections', path: 'docs/报告.md', value: 4, bogus: 1 }])
    expect(parsed[0]).toEqual({ type: 'min_sections', path: 'docs/报告.md', value: 4 })
  })

  it('no_loop 命中循环抑制时失败；judge 无执行器跳过、低分失败', async () => {
    const loopCtx = makeCtx({
      events: [traceEntry({ type: 'schedule', payload: { loopSuppressed: true } })],
    })
    const [loopResult] = await runAssertions([{ type: 'no_loop' }], loopCtx)
    expect(loopResult.ok).toBe(false)

    // M50：no_invite 仅对「members 非空」的召集条目失败——派发 / 降级形状不误报
    const [noInviteOk] = await runAssertions(
      [{ type: 'no_invite' }],
      makeCtx({
        events: [
          traceEntry({ type: 'routing:dispatched', payload: { fallback: true, error: '平台路由解析失败' } }),
        ],
      }),
    )
    expect(noInviteOk.ok).toBe(true)

    const skipped = await runAssertions([{ type: 'judge', rubric: '质量', minScore: 7 }], makeCtx())
    expect(skipped[0].skipped).toBe(true)
    expect(skipped[0].ok).toBe(true)

    const judged = await runAssertions(
      [{ type: 'judge', rubric: '质量', minScore: 7 }],
      makeCtx({
        judge: async () => ({ score: 5, reasons: '内容偏薄' }),
      }),
    )
    expect(judged[0].ok).toBe(false)
    expect(judged[0].detail).toContain('得分 5')
  })

  it('parseAssertions：未知类型 / 非数组 fail-fast', () => {
    expect(() => parseAssertions('不是数组')).toThrow('assertions 必须是数组')
    expect(() => parseAssertions([{ type: 'unknown_type' }])).toThrow('未知断言类型')
    const parsed = parseAssertions([{ type: 'turns_lte', value: 3 }])
    expect(parsed[0]).toEqual({ type: 'turns_lte', value: 3 })
    expect(parseAssertions([{ type: 'no_invite' }])[0]).toEqual({ type: 'no_invite' })
  })

  it('M61：schedulingCounts 聚合与 no_stall / scheduling 判定', async () => {
    const events = [
      traceEntry({ type: 'routing:dispatched', payload: { members: ['pm'], reason: '平台组队' } }),
      traceEntry({ type: 'routing:dispatched', payload: { fallback: true, error: '路由解析失败' } }),
      traceEntry({ type: 'wave:start', payload: { members: ['a'], parallel: false } }),
      traceEntry({ type: 'wave:start', payload: { members: ['a', 'b'], parallel: true } }),
      traceEntry({ type: 'schedule', payload: { loopSuppressed: false, stallSuppressed: true } }),
      traceEntry({ type: 'wave:write-conflict', payload: { paths: ['docs/x.md'] } }),
      traceEntry({ type: 'handoff:accepted', payload: { agentId: 'a' } }),
      traceEntry({ type: 'handoff:accepted', payload: { agentId: 'b' } }),
    ]
    expect(schedulingCounts(events)).toEqual({
      routes: 1,
      routeFallbacks: 1,
      waves: 2,
      parallelWaves: 1,
      loopSuppressed: 0,
      stallSuppressed: 1,
      writeConflicts: 1,
      handoffAccepted: 2,
    })

    const ctx = makeCtx({ events })
    const [stall] = await runAssertions([{ type: 'no_stall' }], ctx)
    expect(stall.ok).toBe(false)

    const [pass] = await runAssertions(
      [
        {
          type: 'scheduling',
          routesMin: 1,
          handoffAcceptedMin: 2,
          wavesMin: 2,
          parallelWavesMin: 1,
          stallSuppressedMax: 1,
          writeConflictsMax: 1,
        },
      ],
      ctx,
    )
    expect(pass.ok).toBe(true)

    const [fail] = await runAssertions([{ type: 'scheduling', routesMin: 2, writeConflictsMax: 0 }], ctx)
    expect(fail.ok).toBe(false)
    expect(fail.detail).toContain('writeConflicts(1)≤0')

    // 解析：scheduling / no_stall 白名单入列（未知字段丢弃）
    const parsed = parseAssertions([{ type: 'scheduling', routesMin: 1, bogus: 9 }, { type: 'no_stall' }])
    expect(parsed[0]).toEqual({
      type: 'scheduling',
      routesMin: 1,
      handoffAcceptedMin: undefined,
      wavesMin: undefined,
      parallelWavesMin: undefined,
      stallSuppressedMax: undefined,
      writeConflictsMax: undefined,
    })
    expect(parsed[1]).toEqual({ type: 'no_stall' })
  })
})

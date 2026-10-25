/**
 * M2 上下文工程测试：token 计量与校准 / 五层装配 / 滚动压缩（水位·合并·降级）/ 端到端验收。
 */
import { describe, expect, it } from 'vitest'
import type { AgentDefinition, ChatMessage } from '@multi-agent/shared'
import type { ChatRequest } from '../src/llm/provider.js'
import { buildSystemPrompt, buildWindow } from '../src/context/assembler.js'
import { buildWorkspaceDigest } from '../src/context/workspace-digest.js'
import { extractJson, pickCompressionRange, renderForSummary, SUMMARY_AGENT_ID } from '../src/context/compressor.js'
import {
  countTokens,
  countTokensCalibrated,
  currentCalibration,
  recordUsage,
  resetTokenizer,
  truncateToTokens,
} from '../src/context/tokenizer.js'
import {
  coerceSummaryData,
  emptySummaryData,
  mergeSummaryData,
  renderSummaryData,
} from '../src/store/summaries.js'
import { makeEnv, sendAndWait } from './helpers.js'

let seq = 0
function msg(partial: Partial<ChatMessage> & { role: 'user' | 'agent' }): ChatMessage {
  seq++
  return {
    id: `m${seq}`,
    sessionId: 's1',
    seq,
    turnIndex: partial.role === 'user' ? -1 : 0,
    content: '',
    mentions: [],
    status: 'complete',
    createdAt: new Date().toISOString(),
    ...partial,
  }
}

/** 向会话追加一条消息（appendMessage 的最小必填封装） */
function feed(
  env: ReturnType<typeof makeEnv>,
  sessionId: string,
  role: 'user' | 'agent',
  content: string,
  turnIndex?: number,
): void {
  env.sessions.appendMessage({
    sessionId,
    role,
    content,
    mentions: [],
    status: 'complete',
    ...(turnIndex === undefined ? {} : { turnIndex }),
  })
}

/** 灌入 n 个完整回合（user + agent） */
function seedTurns(env: ReturnType<typeof makeEnv>, sessionId: string, turns: number, filler: string): void {
  for (let t = 0; t < turns; t++) {
    feed(env, sessionId, 'user', `第 ${t} 轮需求：${filler}`)
    feed(env, sessionId, 'agent', `第 ${t} 轮回复：${filler}`, t)
  }
}

describe('M2：token 计量与校准', () => {
  it('countTokens：空串为 0，中英文都有合理量级', () => {
    resetTokenizer()
    expect(countTokens('')).toBe(0)
    const en = countTokens('The quick brown fox jumps over the lazy dog')
    expect(en).toBeGreaterThan(5)
    expect(en).toBeLessThan(20)
    expect(countTokens('这是一个中文句子，用于测试分词估算。')).toBeGreaterThan(5)
  })

  it('校准：滚动均值收敛，非法样本被忽略', () => {
    resetTokenizer()
    recordUsage(100, 200)
    expect(currentCalibration()).toBe(2)
    recordUsage(100, 300)
    expect(currentCalibration()).toBe(2.5)
    // 非法：估算 0 / 真实 0 / 比值越界 → 忽略
    recordUsage(0, 100)
    recordUsage(100, 0)
    recordUsage(100, 10_000)
    expect(currentCalibration()).toBe(2.5)
    resetTokenizer()
    expect(currentCalibration()).toBe(1)
  })

  it('countTokensCalibrated：含 15% 安全余量', () => {
    resetTokenizer()
    const raw = countTokens('hello world')
    expect(countTokensCalibrated('hello world')).toBe(Math.ceil(raw * 1.15))
  })

  it('truncateToTokens：行边界截断 + 提示；未超限时原样返回', () => {
    const text = Array.from({ length: 200 }, (_, i) => `第 ${i + 1} 行：这是一段足够长的内容用于截断测试`).join('\n')
    const result = truncateToTokens(text, 100, '（已截断）')
    expect(result.truncated).toBe(true)
    expect(result.lines).toBeLessThan(200)
    expect(result.text).toContain('（已截断）')

    const short = truncateToTokens('短文本', 100)
    expect(short.truncated).toBe(false)
    expect(short.text).toBe('短文本')
  })
})

describe('M2：五层装配器', () => {
  const agent = {
    id: 'pm',
    name: '费利',
    role: '产品经理',
    handoff: ['architect'],
    skills: [],
    tools: [],
  } as unknown as AgentDefinition

  it('buildSystemPrompt：L0 在最前，分层 token 统计，L1/L2 顺序正确', () => {
    const out = buildSystemPrompt({
      protocol: '<role_contract>\n测试协议</role_contract>',
      agent,
      agentBody: '我是产品经理。',
      roster: [agent],
      preloadedSkills: [],
      skillsIndex: '',
      workspaceListing: '',
      memoryBlock: '<session_memory>\n## 已确认决策\n- 用 REST\n</session_memory>',
      summaryBlock: '<session_summary>\n## 已完成\n- 需求收集\n</session_summary>',
    })
    expect(out.text.startsWith('<role_contract>')).toBe(true)
    expect(out.text.indexOf('<session_memory>')).toBeLessThan(out.text.indexOf('<session_summary>'))
    expect(out.layers.l0).toBeGreaterThan(0)
    expect(out.layers.l1).toBeGreaterThan(0)
    expect(out.layers.l2).toBeGreaterThan(0)
    expect(out.layers.l3).toBeGreaterThan(0)
  })

  it('M79-J（§8.8）：人类花名册——在场人类注入 <human_roster>（含头衔与交还口径）；无人类零差异', () => {
    const base = {
      protocol: '<role_contract>\n测试协议</role_contract>',
      agent,
      agentBody: '我是产品经理。',
      roster: [agent],
      preloadedSkills: [],
      skillsIndex: '',
      workspaceListing: '',
      memoryBlock: '',
      summaryBlock: '',
    }
    const without = buildSystemPrompt(base)
    expect(without.text).not.toContain('<human_roster>')

    const withHumans = buildSystemPrompt({
      ...base,
      humans: [
        { displayName: '张三', username: 'zhang', headline: '产品经理' },
        { displayName: '李四', username: 'li' },
      ],
    })
    expect(withHumans.text).toContain('<human_roster>')
    expect(withHumans.text).toContain('张三（产品经理） · @zhang')
    expect(withHumans.text).toContain('李四 · @li')
    expect(withHumans.text).toContain('在回复行首用 @显示名')
  })

  it('buildWorkspaceDigest：保留最近文件名 + 本轮增量，无交付件不注入', () => {
    expect(buildWorkspaceDigest({ total: 0, recent: [], currentRun: [] })).toBe('')
    const digest = buildWorkspaceDigest({
      total: 12,
      recent: [
        { path: 'docs/需求.md', size: 2048, author: '费利' },
        { path: 'docs/接口.md', size: 8192, version: 3 },
      ],
      currentRun: [{ path: 'docs/接口.md', size: 8192, version: 3 }],
    })
    expect(digest).toContain('已有 12 个交付件')
    expect(digest).toContain('docs/需求.md（2KB · 费利）')
    expect(digest).toContain('docs/接口.md（8KB · v3）')
    expect(digest).toContain('本轮新增/变更：docs/接口.md（v3）')
    expect(digest).toContain('read_file')
    // 不再输出「目录计数」（旧折叠策略会让模型丢失文件名锚点）
    expect(digest).not.toMatch(/：\d+ 个文件/)
  })

  it('buildWindow：预算驱动从后往前填充，丢弃最旧组保留最近回合', () => {
    const messages: ChatMessage[] = []
    for (let t = 0; t < 10; t++) {
      messages.push(msg({ role: 'user', content: `用户需求 ${t} 的详细描述内容。`.repeat(3) }))
      messages.push(msg({ role: 'agent', agentId: 'pm', content: `第 ${t} 轮回复的详细内容说明。`.repeat(3) }))
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
    expect(out.messages.length).toBeLessThan(messages.length)
    expect(out.messages[out.messages.length - 1].content).toContain('第 9 轮回复')
  })

  it('buildWindow：fromSeq 水位过滤（只保留水位之后的消息）', () => {
    const messages = [
      msg({ role: 'user', content: '旧消息-应被过滤' }),
      msg({ role: 'agent', agentId: 'pm', content: '旧回复-应被过滤' }),
      msg({ role: 'user', content: '新消息' }),
      msg({ role: 'agent', agentId: 'pm', content: '新回复' }),
    ]
    const out = buildWindow({
      messages,
      agentId: 'pm',
      agents: [],
      fromSeq: messages[1].seq!,
      budgetTokens: 10_000,
      toolDetailKeep: 6,
    })
    const text = out.messages.map((m) => m.content).join('\n')
    expect(text).not.toContain('应被过滤')
    expect(text).toContain('新回复')
  })

  it('buildWindow：最近的组超预算 → 行级截断并注明', () => {
    const long = Array.from({ length: 50 }, (_, i) => `第 ${i} 行内容`).join('\n')
    const out = buildWindow({
      messages: [msg({ role: 'user', content: long })],
      agentId: 'pm',
      agents: [],
      fromSeq: 0,
      budgetTokens: 60,
      toolDetailKeep: 6,
    })
    expect(out.truncated).toBe(true)
    expect(out.messages).toHaveLength(1)
    expect(out.messages[0].content).toContain('已省略')
  })

  it('buildWindow：L5 最近 N 条工具保参数，更早折叠为单行', () => {
    const now = new Date().toISOString()
    const calls = Array.from({ length: 8 }, (_, i) => ({
      id: `c${i}`,
      name: 'read_file',
      args: { path: `f${i}.md` },
      status: 'ok' as const,
      summary: `已读取 f${i}.md`,
      startedAt: now,
      endedAt: now,
    }))
    const out = buildWindow({
      messages: [
        msg({ role: 'agent', agentId: 'pm', content: '早期消息', toolCalls: calls.slice(0, 4) }),
        msg({ role: 'agent', agentId: 'pm', content: '近期消息', toolCalls: calls.slice(4) }),
      ],
      agentId: 'pm',
      agents: [],
      fromSeq: 0,
      budgetTokens: 10_000,
      toolDetailKeep: 2,
    })
    const text = out.messages.map((m) => m.content).join('\n')
    expect(text).toContain('read_file({"path":"f7.md"})')
    expect(text).not.toContain('"f0.md"')
    expect(text).toContain('- read_file → 已读取 f0.md')
    expect(out.toolTokens).toBeGreaterThan(0)
  })
})

describe('M2：压缩切分与摘要合并', () => {
  it('pickCompressionRange：按回合组原子切分（组以 user 开头整体保留）', () => {
    const messages = [
      msg({ role: 'user', content: 'u1' }),
      msg({ role: 'agent', agentId: 'pm', content: 'a1' }),
      msg({ role: 'agent', agentId: 'architect', content: 'a2' }),
      msg({ role: 'user', content: 'u2' }),
      msg({ role: 'agent', agentId: 'pm', content: 'a3' }),
    ]
    const range = pickCompressionRange(messages, 1)!
    expect(range.map((m) => m.content)).toEqual(['u1', 'a1', 'a2'])
  })

  it('pickCompressionRange：单组长会话退化为 agent 边界切分', () => {
    const messages = [
      msg({ role: 'user', content: 'u1' }),
      ...Array.from({ length: 5 }, (_, i) => msg({ role: 'agent', agentId: 'pm', content: `a${i + 1}` })),
    ]
    const range = pickCompressionRange(messages, 2)!
    expect(range.map((m) => m.content)).toEqual(['u1', 'a1', 'a2', 'a3'])
  })

  it('pickCompressionRange：消息不足保留量 → 无可压缩区间', () => {
    const messages = [msg({ role: 'user', content: 'u1' }), msg({ role: 'agent', agentId: 'pm', content: 'a1' })]
    expect(pickCompressionRange(messages, 6)).toBeUndefined()
  })

  it('renderForSummary：消息带角色标签与工具摘要', () => {
    const text = renderForSummary([
      msg({ role: 'user', content: '做个登录页' }),
      msg({
        role: 'agent',
        agentId: 'pm',
        content: '已完成',
        toolCalls: [
          {
            id: 'c1',
            name: 'write_file',
            args: { path: 'docs/a.md' },
            status: 'ok',
            summary: '已写入 docs/a.md（1.2KB）',
            startedAt: new Date().toISOString(),
          },
        ],
      }),
    ])
    expect(text).toContain('[用户] 做个登录页')
    expect(text).toContain('[Agent(pm)] 已完成')
    expect(text).toContain('· 工具 write_file')
  })

  it('extractJson：容忍围栏与解释文本', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(extractJson('没问题：{"completed":[]} 以上')).toEqual({ completed: [] })
    expect(extractJson('没有 JSON')).toBeUndefined()
  })

  it('mergeSummaryData：内容去重、保留最新、未决问题整体替换', () => {
    const old = emptySummaryData()
    old.completed = ['完成 A', '完成 B']
    old.decisions = ['决策 A']
    old.openQuestions = ['旧问题']
    const incoming = emptySummaryData()
    incoming.completed = ['完成 B', '完成 C']
    incoming.decisions = ['决策 A', '决策 B']
    incoming.openQuestions = ['新问题']
    const merged = mergeSummaryData(old, incoming)
    expect(merged.completed).toEqual(['完成 A', '完成 B', '完成 C'])
    expect(merged.decisions).toEqual(['决策 A', '决策 B'])
    expect(merged.openQuestions).toEqual(['新问题'])
  })

  it('coerceSummaryData / renderSummaryData：结构校验与渲染', () => {
    expect(coerceSummaryData(null)).toBeUndefined()
    expect(coerceSummaryData('文本')).toBeUndefined()
    expect(coerceSummaryData({ other: 1 })).toBeUndefined()
    const data = coerceSummaryData({ completed: ['做了 X'], decisions: 'not-array' })!
    expect(data.completed).toEqual(['做了 X'])
    expect(data.decisions).toEqual([])
    const text = renderSummaryData(data)
    expect(text).toContain('## 已完成')
    expect(text).toContain('- 做了 X')
    expect(text).not.toContain('## 关键决策')
  })
})

describe('M2：压缩器（端到端）', () => {
  it('compress：成功推进水位、写摘要、提升 memory', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm'])
    for (let t = 0; t < 10; t++) {
      feed(env, session.id, 'user', `第 ${t} 轮需求：做一个功能`)
      feed(env, session.id, 'agent', `第 ${t} 轮回复：已写入 docs/需求文档-${t}.md`, t)
    }
    // 探针：验证压缩调用经由虚拟角色 + 结构化输出（json_schema）通道
    const requests: Array<{ agentId: string; format?: string }> = []
    const provider = env.provider as unknown as {
      chatStream: (req: ChatRequest, signal: AbortSignal) => AsyncIterable<unknown>
    }
    const base = provider.chatStream.bind(env.provider)
    provider.chatStream = (req, signal) => {
      requests.push({ agentId: req.meta.agentId, format: req.responseFormat?.type })
      return base(req, signal)
    }

    const result = await env.compressor.compress({ sessionId: session.id, keepRecentTurns: 3 })
    expect(result.compressed).toBe(true)
    expect(result.degraded).toBe(false)
    expect(requests).toHaveLength(1)
    expect(requests[0].agentId).toBe(SUMMARY_AGENT_ID)
    expect(requests[0].format).toBe('json_schema')

    const summary = env.summaries.get(session.id)!
    expect(summary.untilSeq).toBeGreaterThan(0)
    expect(summary.degraded).toBe(false)
    expect(summary.content).toContain('已完成')
    // mock 摘要从「已写入 …」提取交付件并提升为 artifact 记忆
    expect(env.memory.count(session.id)).toBeGreaterThan(0)
  })

  it('compress：调用失败 → degraded 标记且水位不动', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm'])
    seedTurns(env, session.id, 6, '需求与回复内容。')
    const provider = env.provider as unknown as {
      chatStream: () => AsyncIterable<unknown>
    }
    // eslint-disable-next-line require-yield
    provider.chatStream = async function* () {
      throw new Error('模拟摘要失败')
    }
    const result = await env.compressor.compress({ sessionId: session.id, keepRecentTurns: 2 })
    expect(result.compressed).toBe(false)
    expect(result.degraded).toBe(true)
    const summary = env.summaries.get(session.id)!
    expect(summary.untilSeq).toBe(0)
    expect(summary.degraded).toBe(true)
  })

  it('compress：输出非 JSON → degraded 降级', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm'])
    seedTurns(env, session.id, 6, '需求与回复内容。')
    const provider = env.provider as unknown as {
      chatStream: () => AsyncIterable<unknown>
    }
    provider.chatStream = async function* () {
      yield { type: 'text', text: '抱歉，我无法完成压缩。' }
      yield { type: 'done' }
    }
    const result = await env.compressor.compress({ sessionId: session.id, keepRecentTurns: 2 })
    expect(result.compressed).toBe(false)
    expect(result.degraded).toBe(true)
  })

  it('compress：消息不足 → 不可压缩（不写 degraded）', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm'])
    feed(env, session.id, 'user', '只有一条')
    const result = await env.compressor.compress({ sessionId: session.id, keepRecentTurns: 6 })
    expect(result.compressed).toBe(false)
    expect(result.degraded).toBe(false)
    expect(env.summaries.get(session.id)).toBeUndefined()
  })
})

describe('M2：端到端验收（30 回合）', () => {
  it('压缩后预算内、核心约束不丢、压缩事件可见、无 tool 孤儿', async () => {
    // M23→M29：预算夹具随资产扩容上调（39 技能索引 + development 场景协议 1.2k + pm 预载 prd-authoring
    // 后系统层约 9.8k；12k 仍能触发压缩且为对话窗口留出余量）
    // M61：pm 正文升级专家级六段骨架（+600 字符）+ 全局资产扩容 → 13.2k 夹具（实测 12.5k±）
    // M69：十场景扩展（163 角色 + 60 技能 + 40 协议）系统层进一步增重 → 14k 夹具（实测 13.6k±）
    // 外部安装批：69 技能索引（+8：literature-search / natural-writing / test-driven-development /
    // secure-coding / brand-naming / translation-quality / user-persona / health-metrics）→ 15k 夹具（实测 14.2k±）
    // 报告专业化批：全局协议新增 <deliverable_spec> 段（+18 行）+ report-authoring 技能索引（70 技能）
    // → 16k 夹具（实测 15.0k±）
    // M81：过程叙述通道（全局协议第四通道 + 40 场景协议「过程叙述约定」段）系统层再增重
    // → 17k 夹具（实测 16.3k±）
    const env = makeEnv({ contextBudgetTokens: 17000, keepRecentTurns: 1 })
    const session = env.sessions.create(['pm'])
    // 第 1 回合的核心约束 → 写入 L1 记忆（永不裁剪层）
    env.memory.upsert(session.id, 'constraint', '错误码必须复用现有 40001 规范', 'agent:pm')

    const filler = '为了触发压缩需要足够多的历史文本，这里填充一些内容。'.repeat(2)
    seedTurns(env, session.id, 30, filler)

    // 触发一次真实运行（装配 → 压缩 → 重新装配）
    await sendAndWait(env, session.id, '继续推进')

    // 1) 压缩事件已发出（WS 通知通道；SSE 通道由引擎 emit）
    expect(env.published.some((n) => n.type === 'notify:context-compressed')).toBe(true)
    // 2) 水位推进
    const summary = env.summaries.get(session.id)!
    expect(summary.untilSeq).toBeGreaterThan(0)
    expect(summary.degraded).toBe(false)
    // 3) 第 1 回合的核心约束仍在 system（L1 记忆）
    const prepared = await env.context.prepareTurn({
      sessionId: session.id,
      agentId: 'pm',
      runId: 'r-check',
      queue: [],
    })
    expect(prepared.system).toContain('错误码必须复用现有 40001 规范')
    // 4) 估算 token 稳定在预算内
    expect(prepared.estimatedTokens).toBeLessThanOrEqual(17000)
    // 5) 无 tool 角色孤儿消息（历史工具调用随所属 agent 消息渲染）
    expect(prepared.messages.every((m) => m.role !== 'tool')).toBe(true)
    // 6) 上下文快照可用（API 数据源）
    const snapshot = env.context.snapshot(session.id)
    expect(snapshot.layers).toHaveLength(6)
    expect(snapshot.memory.length).toBeGreaterThan(0)
    expect(snapshot.untilSeq).toBe(summary.untilSeq)
  })

  it('压缩失败时降级：context_notice 提示 + 硬截断', async () => {
    const env = makeEnv({ contextBudgetTokens: 3000, keepRecentTurns: 1 })
    const session = env.sessions.create(['pm'])
    const filler = '历史内容填充文本。'.repeat(10)
    seedTurns(env, session.id, 15, filler)
    const provider = env.provider as unknown as {
      chatStream: () => AsyncIterable<unknown>
    }
    // eslint-disable-next-line require-yield
    provider.chatStream = async function* () {
      throw new Error('模拟摘要失败')
    }
    const prepared = await env.context.prepareTurn({
      sessionId: session.id,
      agentId: 'pm',
      runId: 'r1',
      queue: [],
    })
    expect(prepared.compression).toBeUndefined()
    expect(prepared.system).toContain('context_notice')
    expect(env.summaries.get(session.id)!.degraded).toBe(true)
  })
})

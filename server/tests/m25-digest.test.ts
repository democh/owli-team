/**
 * M25.4 单测：Run 后记忆沉淀（MemoryDigester + 引擎收口钩子）。
 *
 * 覆盖：
 * - 引擎级：off 模式零调用零写入；session 模式主 Run 收尾 → 候选入库 + memory:digest 轨迹 + 用量落库；
 * - 解析层：coerceDigestCandidates（非法 kind / 空内容丢弃、scope 归一、importance 夹取、上限截断）；
 * - 直调级：global 候选落库、同内容去重（ADD-only）、坏输出零写入、调用异常静默降级。
 *
 * 环境：真实 prompts/skills + 临时目录；MockProvider（llmMock）沉淀脚本
 * （meta.agentId='__digester__' → 确定性候选 JSON，零网络）。
 */
import path from 'node:path'
import type { LlmChunk, LlmProvider } from '../src/llm/provider.js'
import type { AppConfig } from '../src/config.js'
import { loadConfig } from '../src/config.js'
import { EmbeddingManager } from '../src/embeddings/manager.js'
import { Engine } from '../src/orchestration/engine.js'
import { DIGEST_AGENT_ID, MemoryDigester, coerceDigestCandidates } from '../src/memory/digest.js'
import { MemoryService } from '../src/memory/service.js'
import { openDatabase } from '../src/store/db.js'
import { MemoryStore } from '../src/store/memory.js'
import { EmbeddingCacheStore, EmbedQueueStore, MemoryVectorStore } from '../src/store/memory-vectors.js'
import { SessionStore } from '../src/store/sessions.js'
import { UsageStore } from '../src/store/usage.js'
import { describe, expect, it } from 'vitest'
import { makeEnv, makeTmpDir, sendAndWait } from './helpers.js'

const SESSION_ID = 's1'

/** 轻量环境：内存主库 + 会话/记忆/用量（不启动向量服务——沉淀不依赖嵌入） */
function makeDigestEnv(overrides: Partial<AppConfig> = {}) {
  const dir = makeTmpDir('ma-m25-digest-')
  const cfg: AppConfig = {
    ...loadConfig(),
    dataDir: dir,
    workspaceDir: path.join(dir, 'ws'),
    logLevel: 'silent',
    llmMock: true,
    memoryDigestMode: 'session',
    ...overrides,
  }
  const db = openDatabase(':memory:', { memory: true, noExtensions: true })
  const now = new Date().toISOString()
  db.run(
    `INSERT INTO sessions (id, title, participant_ids, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    SESSION_ID,
    '测试会话',
    JSON.stringify(['pm']),
    now,
    now,
  )
  const sessions = new SessionStore(db)
  const memory = new MemoryStore(db)
  const usage = new UsageStore(db, cfg.llmPricing)
  return { cfg, db, sessions, memory, usage }
}

/** 脚本化 Provider：yield 固定文本 / 抛错 */
function scriptedProvider(text: string, opts: { throwError?: boolean } = {}): LlmProvider {
  return {
    async *chatStream(): AsyncIterable<LlmChunk> {
      if (opts.throwError) throw new Error('provider boom')
      yield { type: 'text', text }
      yield { type: 'usage', usage: { promptTokens: 10, completionTokens: 5 } }
      yield { type: 'done' }
    },
  }
}

async function waitFor(cond: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('等待条件超时')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('M25.4：记忆沉淀（MemoryDigester）', () => {
  it('coerceDigestCandidates：非法 kind / 空内容丢弃，scope 归一，importance 夹取，上限 5 条', () => {
    const parsed = coerceDigestCandidates({
      candidates: [
        { kind: 'preference', content: '用户偏好中文提交信息', scope: 'global', importance: 9 },
        { kind: 'bad-kind', content: '丢弃' },
        { kind: 'fact', content: '   ' },
        { kind: 'decision', content: '无 scope → 归一会话' },
        { kind: 'constraint', content: 'a' },
        { kind: 'lesson', content: 'b' },
        { kind: 'glossary', content: 'c' },
        { kind: 'artifact', content: 'd' },
        { kind: 'fact', content: 'e' },
      ],
    })!
    expect(parsed).toHaveLength(5) // preference + decision + constraint + lesson + glossary
    expect(parsed[0]).toMatchObject({ kind: 'preference', scope: 'global', importance: 5 })
    expect(parsed[1]).toMatchObject({ kind: 'decision', scope: 'session', importance: 3 })
    expect(coerceDigestCandidates({ candidates: 'nope' })).toEqual([])
    expect(coerceDigestCandidates(undefined)).toEqual([])
  })

  it('session 模式：候选落库（source/溯源/importance）+ 用量 kind=digest；重复沉淀内容去重', async () => {
    const env = makeDigestEnv()
    env.sessions.appendMessage({ sessionId: SESSION_ID, role: 'user', content: '确定错误码统一用 { code, message }', mentions: [], status: 'complete' })
    env.sessions.appendMessage({ sessionId: SESSION_ID, role: 'agent', agentId: 'pm', content: '已按该结构落地 API 层。', mentions: [], status: 'complete' })
    const sql = JSON.stringify({
      candidates: [
        { kind: 'global-bad', content: '丢弃' },
        { kind: 'preference', content: '用户偏好：提交信息用中文', scope: 'global', importance: 5 },
        { kind: 'decision', content: '错误码统一用 { code, message } 结构' },
      ],
    })
    const digester = new MemoryDigester({
      cfg: env.cfg,
      provider: scriptedProvider(`\`\`\`json\n${sql}\n\`\`\``), // 围栏容忍
      sessions: env.sessions,
      memory: env.memory,
      usage: env.usage,
    })
    const first = await digester.digestRun({ sessionId: SESSION_ID, runId: 'run_x1' })
    expect(first).toMatchObject({ ok: true, candidates: 2, added: 2 })

    // global 候选：owner='global'；session 候选：owner=会话 id；均为 candidate 待审
    const global = env.memory.query({ scope: 'global', ownerId: 'global' })
    expect(global).toHaveLength(1)
    expect(global[0]).toMatchObject({ kind: 'preference', importance: 5, status: 'candidate', source: 'digest' })
    const scoped = env.memory.query({ scope: 'session', ownerId: SESSION_ID, status: 'candidate' })
    expect(scoped).toHaveLength(1)
    expect(scoped[0]).toMatchObject({ kind: 'decision', sourceRunId: 'run_x1', sourceSessionId: SESSION_ID })

    // 用量：kind='digest' 已落库
    const usageKinds = env.db.all<{ kind: string }>(`SELECT kind FROM usage WHERE kind = 'digest'`)
    expect(usageKinds).toHaveLength(1)

    // 候选不参与 L1 渲染（list 仍可见；render 只渲染 active）
    expect(env.memory.render(SESSION_ID)).toBe('')

    // 同 Run 重复沉淀：内容哈希命中 → added=0
    const second = await digester.digestRun({ sessionId: SESSION_ID, runId: 'run_x1' })
    expect(second).toMatchObject({ ok: true, candidates: 2, added: 0 })
  })

  it('off 模式：零调用零写入（直接调用也短路）', async () => {
    const env = makeDigestEnv({ memoryDigestMode: 'off' })
    env.sessions.appendMessage({ sessionId: SESSION_ID, role: 'user', content: '任意内容', mentions: [], status: 'complete' })
    let calls = 0
    const provider: LlmProvider = {
      async *chatStream(): AsyncIterable<LlmChunk> {
        calls++
        yield { type: 'done' }
      },
    }
    const digester = new MemoryDigester({ cfg: env.cfg, provider, sessions: env.sessions, memory: env.memory })
    const result = await digester.digestRun({ sessionId: SESSION_ID, runId: 'run_off' })
    expect(result.ok).toBe(false)
    expect(result.skipped).toContain('沉淀已关闭')
    expect(calls).toBe(0)
    expect(env.memory.query({ status: 'candidate' })).toHaveLength(0)
  })

  it('坏输出：不可解析 → 零写入；调用异常 → 静默降级（ok=false + error）', async () => {
    const env = makeDigestEnv({ llmMaxRetries: 1 })
    env.sessions.appendMessage({ sessionId: SESSION_ID, role: 'user', content: '随便聊聊', mentions: [], status: 'complete' })
    const bad = new MemoryDigester({ cfg: env.cfg, provider: scriptedProvider('这不是 JSON'), sessions: env.sessions, memory: env.memory })
    expect(await bad.digestRun({ sessionId: SESSION_ID, runId: 'run_bad' })).toMatchObject({ ok: true, candidates: 0, added: 0 })
    expect(env.memory.query({ status: 'candidate' })).toHaveLength(0)

    const boom = new MemoryDigester({
      cfg: env.cfg,
      provider: scriptedProvider('', { throwError: true }),
      sessions: env.sessions,
      memory: env.memory,
    })
    const failed = await boom.digestRun({ sessionId: SESSION_ID, runId: 'run_boom' })
    expect(failed.ok).toBe(false)
    expect(failed.error).toContain('boom')
  })
})

describe('M25.4：引擎收口沉淀（主 Run 完成 → memory:digest）', () => {
  /** 全量引擎环境（替换 engine 注入 memories：沉淀不依赖向量服务启动，poke 为空操作） */
  function makeEngineEnv(overrides: Partial<AppConfig> = {}) {
    const env = makeEnv({ llmMock: true, memoryDigestMode: 'session', ...overrides })
    let digestCalls = 0
    const provider: LlmProvider = {
      chatStream: (req, signal) => {
        if (req.meta.agentId === DIGEST_AGENT_ID) digestCalls++
        return env.provider.chatStream(req, signal)
      },
    }
    const memories = new MemoryService({
      cfg: env.cfg,
      db: env.db,
      store: env.memory,
      vectors: new MemoryVectorStore(env.db),
      queue: new EmbedQueueStore(env.db),
      embeddings: new EmbeddingManager({ cfg: env.cfg, cache: new EmbeddingCacheStore(env.db) }),
    })
    const engine = new Engine({
      cfg: env.cfg,
      prompts: env.prompts,
      skills: env.skills,
      sessions: env.sessions,
      artifacts: env.artifacts,
      memory: env.memory,
      memories,
      context: env.context,
      provider,
      tools: env.tools,
      notify: env.notify,
      tasks: env.tasks,
      runs: env.runs,
      usage: env.usage,
      metrics: env.metrics,
      approvals: env.approvals,
      plans: env.plans,
      reviews: env.reviews,
      planReviews: env.planReviews,
      versions: env.versions,
      events: env.events,
    })
    return { ...env, engine, memories, digestCalls: () => digestCalls }
  }

  it('session 模式：主 Run 完成 → 候选入库 + memory:digest 轨迹 + 用量记录', async () => {
    const env = makeEngineEnv({ memoryDigestMode: 'session' })
    const session = env.sessions.create(['pm', 'architect'], 'M25.4 沉淀-session')
    await sendAndWait(env, session.id, '请完成登录模块的设计与实现拆分')

    const runId = env.runs.latest(session.id)!.id
    await waitFor(() => env.memory.query({ scope: 'session', ownerId: session.id, status: 'candidate' }).length > 0)

    const candidates = env.memory.query({ scope: 'session', ownerId: session.id, status: 'candidate' })
    expect(candidates.length).toBeGreaterThanOrEqual(1)
    expect(candidates.every((c) => c.source === 'digest' && c.sourceRunId === runId)).toBe(true)
    expect(env.digestCalls()).toBe(1)

    const events = env.events.listByRun(runId)
    const digestEvent = events.find((e) => e.type === 'memory:digest')
    expect(digestEvent).toBeDefined()
    expect(Number(digestEvent!.payload.added)).toBeGreaterThanOrEqual(1)

    const usageKinds = env.db.all<{ kind: string }>(`SELECT kind FROM usage WHERE session_id = ? AND kind = 'digest'`, session.id)
    expect(usageKinds).toHaveLength(1)
  })

  it('off 模式：主 Run 完成 → 零沉淀调用、零候选、无 memory:digest 轨迹', async () => {
    const env = makeEngineEnv({ memoryDigestMode: 'off' })
    const session = env.sessions.create(['pm'], 'M25.4 沉淀-off')
    await sendAndWait(env, session.id, '请输出一个简短的实现说明')

    const runId = env.runs.latest(session.id)!.id
    await new Promise((r) => setTimeout(r, 120)) // 给 fire-and-forget 留窗口（off 不应触发）
    expect(env.digestCalls()).toBe(0)
    expect(env.memory.query({ scope: 'session', ownerId: session.id, status: 'candidate' })).toHaveLength(0)
    expect(env.events.listByRun(runId).some((e) => e.type === 'memory:digest')).toBe(false)
  })
})

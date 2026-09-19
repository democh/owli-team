/**
 * M25.3b 单测：上下文 L1.5 接入（prepareTurn 语义召回注入 / 与 L1 去重 / 超时静默降级 / snapshot 层展示）。
 *
 * 环境：真实 prompts/skills + 内存主库（noExtensions 强制 JS 后端）+ mock 嵌入（确定性，零网络）。
 */
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AppConfig } from '../src/config.js'
import { loadConfig } from '../src/config.js'
import { SecretVault } from '../src/connections/crypto.js'
import { Compressor } from '../src/context/compressor.js'
import { ContextService, type ContextServiceDeps } from '../src/context/service.js'
import { EmbeddingManager } from '../src/embeddings/manager.js'
import { MOCK_EMBED_DIM, MOCK_EMBED_MODEL } from '../src/embeddings/provider.js'
import { MockProvider } from '../src/llm/mock.js'
import { MemoryService } from '../src/memory/service.js'
import { ArtifactStore } from '../src/store/artifacts.js'
import { ConnectionStore } from '../src/store/connections.js'
import { openDatabase } from '../src/store/db.js'
import { MemoryStore } from '../src/store/memory.js'
import { EmbedQueueStore, EmbeddingCacheStore, MemoryVectorStore } from '../src/store/memory-vectors.js'
import { PromptLibrary } from '../src/store/prompts.js'
import { SessionStore } from '../src/store/sessions.js'
import { SkillLibrary } from '../src/store/skills.js'
import { SummaryStore } from '../src/store/summaries.js'
import { UsageStore } from '../src/store/usage.js'
import { makeTmpDir } from './helpers.js'

const SESSION_ID = 's1'
const AGENT_ID = 'pm'

/** 环境：ContextService（装配 memories）+ 记忆三件套 + mock 嵌入 */
async function makeEnv(overrides: Partial<AppConfig> = {}) {
  const dir = makeTmpDir('ma-m25-context-')
  const cfg: AppConfig = {
    ...loadConfig(),
    dataDir: dir,
    workspaceDir: path.join(dir, 'ws'),
    logLevel: 'silent',
    llmMock: true,
    embeddingConnectionId: '',
    embeddingModel: '',
    embeddingBaseUrl: '',
    embeddingApiKey: '',
    embeddingDim: 0,
    memoryRecallEnabled: true,
    memoryRecallTimeoutMs: 300,
    ...overrides,
  }
  const prompts = new PromptLibrary({ agentsDir: cfg.agentsDir, promptsDir: cfg.promptsDir, onWarn: () => {} })
  const skills = new SkillLibrary(cfg.skillsDir)
  const db = openDatabase(':memory:', { memory: true, noExtensions: true })
  const now = new Date().toISOString()
  db.run(
    `INSERT INTO sessions (id, title, participant_ids, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    SESSION_ID,
    '测试会话',
    JSON.stringify([AGENT_ID]),
    now,
    now,
  )
  const sessions = new SessionStore(db)
  const summaries = new SummaryStore(db)
  const usage = new UsageStore(db, cfg.llmPricing)
  const artifacts = new ArtifactStore(cfg.workspaceDir, (sid) => path.join(cfg.workspaceDir, sid))
  const queue = new EmbedQueueStore(db)
  const store = new MemoryStore(db, queue)
  const vectors = new MemoryVectorStore(db)
  const vault = SecretVault.load({ keyFile: path.join(dir, 'secrets.key') })
  const connections = new ConnectionStore(db, vault)
  const embeddings = new EmbeddingManager({ cfg, connections, cache: new EmbeddingCacheStore(db) })
  const memories = new MemoryService({ cfg, db, store, vectors, queue, embeddings })
  await memories.start()
  const provider = new MockProvider({ delayMs: 0 })
  const compressor = new Compressor({ cfg, provider, sessions, summaries, memory: store, usage })
  const deps: ContextServiceDeps = {
    cfg,
    prompts,
    skills,
    sessions,
    artifacts,
    memory: store,
    summaries,
    compressor,
    memories,
  }
  const context = new ContextService(deps)
  return {
    dir,
    cfg,
    db,
    sessions,
    store,
    queue,
    vectors,
    embeddings,
    memories,
    context,
    deps,
    dispose: () => memories.stop(),
  }
}

function appendUser(env: Awaited<ReturnType<typeof makeEnv>>, content: string): void {
  env.sessions.appendMessage({
    sessionId: SESSION_ID,
    role: 'user',
    content,
    mentions: [],
    status: 'complete',
  })
}

describe('M25.3b：上下文 L1.5（prepareTurn 语义召回注入）', () => {
  it('agent scope 记忆注入 <recalled_memory> + recalled 明细 + L1.5 层', async () => {
    const env = await makeEnv()
    try {
      env.store.upsertScoped('agent', AGENT_ID, 'constraint', '构建产物必须输出到 workspace/dist 目录')!
      expect(await env.memories.poke()).toBe(1)
      appendUser(env, '构建产物应该输出到哪里？')

      const prepared = await env.context.prepareTurn({
        sessionId: SESSION_ID,
        agentId: AGENT_ID,
        runId: 'r1',
        queue: [],
      })
      expect(prepared.system).toContain('<recalled_memory>')
      expect(prepared.system).toContain('workspace/dist')
      expect(prepared.recalled).toHaveLength(1)
      expect(prepared.recalled![0]!.scope).toBe('agent')
      expect(prepared.recalled![0]!.signals).toBeDefined()
      const layer = prepared.layers.find((l) => l.key === 'L1.5')
      expect(layer).toBeTruthy()
      expect(layer!.tokens).toBeGreaterThan(0)
    } finally {
      env.dispose()
    }
  })

  it('与 L1 去重：session scope 记忆只走 L1 块，不再被召回注入', async () => {
    const env = await makeEnv()
    try {
      const sessionItem = env.store.upsertScoped('session', SESSION_ID, 'decision', '错误码统一使用 40001 规范')!.item
      env.store.upsertScoped('agent', AGENT_ID, 'lesson', '错误码排查先看服务端日志 40001')!
      expect(await env.memories.poke()).toBe(2)
      appendUser(env, '错误码 40001 怎么排查？')

      const prepared = await env.context.prepareTurn({
        sessionId: SESSION_ID,
        agentId: AGENT_ID,
        runId: 'r2',
        queue: [],
      })
      // L1：会话记忆块保持注入
      expect(prepared.system).toContain('<session_memory>')
      expect(prepared.system).toContain('40001 规范')
      // L1.5：session 条目被 exclude，不重复出现
      expect(prepared.recalled!.map((x) => x.id)).not.toContain(sessionItem.id)
      expect(prepared.recalled!.every((x) => x.scope === 'agent')).toBe(true)
    } finally {
      env.dispose()
    }
  })

  it('snapshot：复用最近一次召回（不触发新召回），layers 含 L1.5 与 recalled 明细', async () => {
    const env = await makeEnv()
    try {
      const item = env.store.upsertScoped('agent', AGENT_ID, 'fact', '发布窗口为每周四下午')!.item
      expect(await env.memories.poke()).toBe(1)
      appendUser(env, '发布窗口是什么时候？')
      await env.context.prepareTurn({ sessionId: SESSION_ID, agentId: AGENT_ID, runId: 'r3', queue: [] })

      const snap = env.context.snapshot(SESSION_ID, AGENT_ID)
      expect(snap.layers.find((l) => l.key === 'L1.5')).toBeTruthy()
      expect(snap.recalled?.map((x) => x.id)).toEqual([item.id])
    } finally {
      env.dispose()
    }
  })

  it('超时静默降级：慢嵌入 → prepareTurn 正常返回，L1.5 detail 记录跳过原因', async () => {
    const env = await makeEnv({ memoryRecallTimeoutMs: 50 })
    try {
      const slow = {
        resolve: () => ({
          source: 'mock',
          model: MOCK_EMBED_MODEL,
          dim: MOCK_EMBED_DIM,
          apiKey: '',
          batchSize: 1,
          timeoutMs: 1000,
        }),
        embed: () => new Promise<never>(() => {}), // 永不返回
        stats: env.embeddings.stats,
      } as unknown as EmbeddingManager
      const slowService = new MemoryService({
        cfg: env.cfg,
        db: env.db,
        store: env.store,
        vectors: env.vectors,
        queue: env.queue,
        embeddings: slow,
      })
      const context = new ContextService({ ...env.deps, memories: slowService })
      appendUser(env, '任意问题')

      const prepared = await context.prepareTurn({ sessionId: SESSION_ID, agentId: AGENT_ID, runId: 'r4', queue: [] })
      expect(prepared.system).not.toContain('<recalled_memory>')
      expect(prepared.recalled).toBeUndefined()
      const layer = prepared.layers.find((l) => l.key === 'L1.5')
      expect(layer?.detail).toContain('超时')
    } finally {
      env.dispose()
    }
  })

  it('未装配 memories：与既有行为零差异（无 L1.5 层、无 recalled）', async () => {
    const env = await makeEnv()
    try {
      const withoutMemories: ContextServiceDeps = {
        cfg: env.deps.cfg,
        prompts: env.deps.prompts,
        skills: env.deps.skills,
        sessions: env.deps.sessions,
        artifacts: env.deps.artifacts,
        memory: env.deps.memory,
        summaries: env.deps.summaries,
        compressor: env.deps.compressor,
      }
      const context = new ContextService(withoutMemories)
      appendUser(env, '任意问题')

      const prepared = await context.prepareTurn({ sessionId: SESSION_ID, agentId: AGENT_ID, runId: 'r5', queue: [] })
      expect(prepared.layers.find((l) => l.key === 'L1.5')).toBeUndefined()
      expect(prepared.recalled).toBeUndefined()
      expect(prepared.system).not.toContain('<recalled_memory>')
    } finally {
      env.dispose()
    }
  })
})

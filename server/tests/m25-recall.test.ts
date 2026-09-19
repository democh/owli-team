/**
 * M25.3 单测：混合评分 + 召回链路 + 嵌入 worker + MemoryService 编排。
 *
 * 覆盖策略：
 * - scoreMemory：权重公式（sim/keyword/entity/importance/recency）、scope 权重、半衰期衰减；
 * - recallMemories：状态过滤（镜像含非 active）、exclude 去重、minScore、topK、预算截断、渲染块；
 * - EmbedWorker：flush 落库（BLOB + 镜像 + markDone）、近重复合并（新替旧）、休眠零消费、残留清理；
 * - MemoryService：start/recall/stats/reindex（mock 嵌入确定性；noExtensions 强制 JS 后端）。
 */
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MemoryItem } from '@multi-agent/shared'
import type { AppConfig } from '../src/config.js'
import { loadConfig } from '../src/config.js'
import { SecretVault } from '../src/connections/crypto.js'
import { EmbeddingManager } from '../src/embeddings/manager.js'
import { MOCK_EMBED_DIM, MOCK_EMBED_MODEL } from '../src/embeddings/provider.js'
import { EmbedWorker } from '../src/memory/queue.js'
import { SCOPE_WEIGHT, recallMemories, scoreMemory } from '../src/memory/recall.js'
import { MemoryService } from '../src/memory/service.js'
import { bootstrapVectorIndex, bucketOf, type VecIndex } from '../src/memory/vectors.js'
import { ConnectionStore } from '../src/store/connections.js'
import { openDatabase } from '../src/store/db.js'
import { MemoryStore } from '../src/store/memory.js'
import { EmbedQueueStore, EmbeddingCacheStore, MemoryVectorStore } from '../src/store/memory-vectors.js'
import { makeTmpDir } from './helpers.js'

const SESSION_ID = 's1'

/** 环境：独立内存主库（含迁移）+ 记忆三件套 + 嵌入管理器（mock 默认开） */
function makeEnv(overrides: Partial<AppConfig> = {}) {
  const dir = makeTmpDir('ma-m25-recall-')
  const cfg: AppConfig = {
    ...loadConfig(),
    dataDir: dir,
    logLevel: 'silent',
    llmMock: true,
    embeddingConnectionId: '',
    embeddingModel: '',
    embeddingBaseUrl: '',
    embeddingApiKey: '',
    embeddingDim: 0,
    memoryRecallEnabled: true,
    memoryRecallTopK: 8,
    memoryRecallMinScore: 0.25,
    memoryRecallBudgetTokens: 600,
    memoryRecallTimeoutMs: 300,
    ...overrides,
  }
  const db = openDatabase(':memory:', { memory: true, noExtensions: true })
  const now = new Date().toISOString()
  db.run(
    `INSERT INTO sessions (id, title, participant_ids, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    SESSION_ID,
    '测试会话',
    '["pm"]',
    now,
    now,
  )
  const queue = new EmbedQueueStore(db)
  const store = new MemoryStore(db, queue)
  const vectors = new MemoryVectorStore(db)
  const vault = SecretVault.load({ keyFile: path.join(dir, 'secrets.key') })
  const connections = new ConnectionStore(db, vault)
  const cache = new EmbeddingCacheStore(db)
  const embeddings = new EmbeddingManager({ cfg, connections, cache })
  return { dir, cfg, db, queue, store, vectors, embeddings, connections, cache }
}

/** 最小 MemoryItem 构造（评分纯函数测试用） */
function makeItem(partial: Partial<MemoryItem> = {}): MemoryItem {
  const now = new Date().toISOString()
  return {
    id: 'mem_test',
    scope: 'session',
    ownerId: SESSION_ID,
    kind: 'fact',
    content: '内容',
    importance: 3,
    entities: [],
    status: 'active',
    validFrom: now,
    hits: 0,
    createdAt: now,
    updatedAt: now,
    ...partial,
  }
}

/** 仅返回固定命中的假索引（测 recall 的过滤与评分链路，不依赖向量后端） */
function stubIndex(hits: Array<{ memoryId: string; sim: number }>): VecIndex {
  return {
    backend: 'js',
    put() {},
    remove() {},
    query: () => hits,
    count: () => hits.length,
    drop() {},
  }
}

// ---------- 混合评分（纯函数） ----------

describe('M25.3：混合评分（纯函数）', () => {
  const nowMs = Date.now()

  it('权重公式：无分词信号时 = 0.50·sim + 0.15·importance + 0.10·recency（scope=session）', () => {
    const item = makeItem({ importance: 5 })
    const { score, signals } = scoreMemory(item, 1, [], nowMs)
    expect(score).toBeCloseTo(0.75, 3) // 0.5 + 0.15 + 0.1
    expect(signals).toMatchObject({ sim: 1, scopeWeight: 1 })
    expect(signals.recency).toBeCloseTo(1, 3)
    expect(signals.importance).toBe(1)
  })

  it('scope 权重：global 同输入收 0.90 倍，agent 0.95、project 0.92', () => {
    const session = scoreMemory(makeItem({ importance: 5 }), 1, [], nowMs).score
    const agent = scoreMemory(makeItem({ importance: 5, scope: 'agent', ownerId: 'pm' }), 1, [], nowMs).score
    const project = scoreMemory(makeItem({ importance: 5, scope: 'project', ownerId: 'p1' }), 1, [], nowMs).score
    const global = scoreMemory(makeItem({ importance: 5, scope: 'global', ownerId: 'global' }), 1, [], nowMs).score
    expect(agent).toBeCloseTo(session * SCOPE_WEIGHT.agent, 3)
    expect(project).toBeCloseTo(session * SCOPE_WEIGHT.project, 3)
    expect(global).toBeCloseTo(session * SCOPE_WEIGHT.global, 3)
  })

  it('recency 半衰期 30 天：30 天前 → 0.5，60 天前 → 0.25', () => {
    const day = 86_400_000
    const old30 = makeItem({ validFrom: new Date(nowMs - 30 * day).toISOString() })
    const old60 = makeItem({ validFrom: new Date(nowMs - 60 * day).toISOString() })
    expect(scoreMemory(old30, 0, [], nowMs).signals.recency).toBeCloseTo(0.5, 2)
    expect(scoreMemory(old60, 0, [], nowMs).signals.recency).toBeCloseTo(0.25, 2)
  })

  it('keyword 命中率与 entity Jaccard', () => {
    const hit = makeItem({ content: '我们决定数据库使用 sqlite 并启用 WAL' })
    const miss = makeItem({ content: '前端选用 React 组件库' })
    const tokens = ['数据库', 'sqlite', 'wal']
    expect(scoreMemory(hit, 0, tokens, nowMs).signals.keyword).toBeCloseTo(1, 3)
    expect(scoreMemory(miss, 0, tokens, nowMs).signals.keyword).toBe(0)
    expect(scoreMemory(makeItem({ entities: ['sqlite', 'wal'] }), 0, ['sqlite'], nowMs).signals.entity).toBeCloseTo(1 / 2, 3)
  })
})

// ---------- 召回链路（过滤 / 排序 / 预算） ----------

describe('M25.3：recallMemories 召回链路', () => {
  it('状态过滤 + exclude 去重 + minScore 过滤 + 渲染块', () => {
    const env = makeEnv()
    const a = env.store.upsertScoped('session', SESSION_ID, 'decision', '数据库使用 sqlite（含 WAL）')!.item
    const b = env.store.upsertScoped('session', SESSION_ID, 'fact', '部署在本地单机')!.item
    const c = env.store.upsertScoped('session', SESSION_ID, 'lesson', '旧经验：用 MySQL')!.item
    env.store.setStatus(c.id, 'superseded')
    // 假索引：A 1.0、B 0.8、C 0.95（C 非 active，模拟 vec0 镜像不过滤状态）
    const index = stubIndex([
      { memoryId: a.id, sim: 1 },
      { memoryId: b.id, sim: 0.8 },
      { memoryId: c.id, sim: 0.95 },
    ])
    const base = {
      queryText: '数据库 sqlite',
      queryVec: new Float32Array([1, 0]),
      buckets: [bucketOf('session', SESSION_ID)],
      topK: 8,
      budgetTokens: 600,
    }
    // 默认 minScore=0.25：A/B 通过，C 被状态过滤
    const all = recallMemories({ index, store: env.store }, { ...base, minScore: 0.25 })
    expect(all.items.map((x) => x.id)).toEqual([a.id, b.id])
    expect(all.rendered).toContain('<recalled_memory>')
    expect(all.rendered).toContain('数据库使用 sqlite')
    expect(all.rendered).not.toContain('旧经验：用 MySQL')

    // exclude：L1 已注入的 A 被去重
    const excluded = recallMemories({ index, store: env.store }, { ...base, minScore: 0.25, exclude: new Set([a.id]) })
    expect(excluded.items.map((x) => x.id)).toEqual([b.id])

    // minScore 抬高：只剩 A（B 分约 0.59）
    const strict = recallMemories({ index, store: env.store }, { ...base, minScore: 0.7 })
    expect(strict.items.map((x) => x.id)).toEqual([a.id])
  })

  it('topK 截断 + 预算贪心截断（严格不超预算）', () => {
    const env = makeEnv()
    const longText = '超长记忆内容'.repeat(30) // ≈ 360 字符 → 明显高 token
    const first = env.store.upsertScoped('session', SESSION_ID, 'decision', `高优先 ${longText}`)!.item
    const second = env.store.upsertScoped('session', SESSION_ID, 'fact', '短小精悍的事实')!.item
    const index = stubIndex([
      { memoryId: first.id, sim: 1 },
      { memoryId: second.id, sim: 0.9 },
    ])

    // topK=1：只保留最高分
    const top1 = recallMemories(
      { index, store: env.store },
      { queryText: '记忆', queryVec: new Float32Array([1]), buckets: ['session:x'], topK: 1, minScore: 0.2, budgetTokens: 600 },
    )
    expect(top1.items.map((x) => x.id)).toEqual([first.id])

    // 预算极小：长条目放不下 → 贪心跳过，保留短条目（严格不超预算）
    const tiny = recallMemories(
      { index, store: env.store },
      { queryText: '记忆', queryVec: new Float32Array([1]), buckets: ['session:x'], topK: 8, minScore: 0.2, budgetTokens: 100 },
    )
    expect(tiny.items.map((x) => x.id)).toEqual([second.id])
    expect(tiny.tokens).toBeLessThanOrEqual(100)
  })
})

// ---------- 嵌入 worker（flush / 合并 / 休眠） ----------

/** 构造 worker 测试环境（JS 后端；索引缓存引导） */
function makeWorkerEnv(overrides: Partial<AppConfig> = {}) {
  const env = makeEnv(overrides)
  let indexCache: { key: string; index: VecIndex } | null = null
  const worker = new EmbedWorker({
    queue: env.queue,
    vectors: env.vectors,
    store: env.store,
    embeddings: env.embeddings,
    indexFor: async (model, dim) => {
      const key = `${model}|${dim}`
      if (indexCache?.key === key) return indexCache.index
      const { index } = await bootstrapVectorIndex({ db: env.db, store: env.vectors, model, dim })
      if (index) indexCache = { key, index }
      return index
    },
  })
  return { ...env, worker }
}

describe('M25.3：EmbedWorker', () => {
  it('flush：嵌入落库（BLOB + 镜像）+ markDone；近重复合并新替旧', async () => {
    const env = makeWorkerEnv()
    const first = env.store.upsertScoped('session', SESSION_ID, 'fact', '数据库统一使用 sqlite wAL 模式')!.item
    const second = env.store.upsertScoped('session', SESSION_ID, 'preference', '数据库统一使用 sqlite wAL 模式')!.item
    expect(env.queue.pendingCount()).toBe(2)

    const processed = await env.worker.flush()
    expect(processed).toBe(2)
    expect(env.queue.pendingCount()).toBe(0)
    const vec = env.vectors.get(first.id)
    expect(vec?.model).toBe(MOCK_EMBED_MODEL)
    expect(vec?.dim).toBe(MOCK_EMBED_DIM)

    // 同文本两条 mock 向量完全一致 → cos=1 ≥ 0.92：新条目替代旧条目（方向由处理顺序决定）
    const refreshedFirst = env.store.get(first.id)!
    const refreshedSecond = env.store.get(second.id)!
    const superseded = [refreshedFirst, refreshedSecond].find((x) => x.status === 'superseded')
    const winner = [refreshedFirst, refreshedSecond].find((x) => x.status === 'active')
    expect(superseded).toBeDefined()
    expect(superseded!.supersededBy).toBe(winner!.id)
    expect(winner!.supersedes).toBe(superseded!.id)
  })

  it('休眠（未配置嵌入）：flush 零消费，队列保留', async () => {
    const env = makeWorkerEnv({ llmMock: false })
    env.store.upsertScoped('session', SESSION_ID, 'fact', '休眠期写入')!
    expect(env.queue.pendingCount()).toBe(1)
    expect(await env.worker.flush()).toBe(0)
    expect(env.queue.pendingCount()).toBe(1)
    expect(env.embeddings.stats.calls).toBe(0)
  })

  it('dropInactive：状态流转后的残留队列行被清理', async () => {
    const env = makeWorkerEnv()
    const item = env.store.upsertScoped('session', SESSION_ID, 'fact', '待归档内容')!.item
    env.store.setStatus(item.id, 'archived')
    expect(env.queue.pendingCount()).toBe(1) // 非 active 不被 claim，行仍在
    await env.worker.flush()
    expect(env.queue.pendingCount()).toBe(0) // worker 清理
  })

  it('setStatus 回到 active：重新入队并可被消费', async () => {
    const env = makeWorkerEnv()
    const item = env.store.upsertScoped('session', SESSION_ID, 'lesson', '候选记忆内容', { status: 'candidate' })!.item
    await env.worker.flush()
    expect(env.queue.pendingCount()).toBe(0)
    expect(env.vectors.get(item.id)).toBeUndefined()
    // 审核通过 → active：重新入队
    env.store.setStatus(item.id, 'active')
    expect(env.queue.pendingCount()).toBe(1)
    await env.worker.flush()
    expect(env.vectors.get(item.id)).toBeDefined()
  })
})

// ---------- MemoryService（编排 / 召回 / stats / reindex） ----------

function makeService(env: ReturnType<typeof makeEnv>) {
  return new MemoryService({
    cfg: env.cfg,
    db: env.db,
    store: env.store,
    vectors: env.vectors,
    queue: env.queue,
    embeddings: env.embeddings,
  })
}

describe('M25.3：MemoryService', () => {
  it('start → 写入 → poke → recall 端到端（mock 确定性）：注入块 + hits 回写', async () => {
    const env = makeEnv()
    const service = makeService(env)
    await service.start()
    try {
      env.store.upsertScoped('session', SESSION_ID, 'decision', '数据库统一使用 sqlite 存储向量')!
      env.store.upsertScoped('session', SESSION_ID, 'fact', '无关内容：周末团建定在公园')!
      expect(await service.poke()).toBe(2)

      const outcome = await service.recall({ query: '数据库 sqlite 向量', sessionId: SESSION_ID, agentId: 'pm' })
      expect(outcome.skipped).toBeUndefined()
      expect(outcome.items.length).toBeGreaterThan(0)
      expect(outcome.rendered).toContain('<recalled_memory>')
      expect(outcome.items[0]!.content).toContain('sqlite')
      expect(outcome.items[0]!.signals).toBeDefined()
      // hits 回写
      const hit = env.store.get(outcome.items[0]!.id)!
      expect(hit.hits).toBeGreaterThanOrEqual(1)

      const stats = service.stats()
      expect(stats).toMatchObject({ configured: true, source: 'mock', model: MOCK_EMBED_MODEL, backend: 'js', pending: 0 })
      expect(stats.vectorTotal).toBe(2)
    } finally {
      service.stop()
    }
  })

  it('recall：开关关闭 / 无配置休眠 → skipped（force 可绕过开关）', async () => {
    const off = makeEnv({ memoryRecallEnabled: false })
    const serviceOff = makeService(off)
    await serviceOff.start()
    try {
      const skipped = await serviceOff.recall({ query: 'x', sessionId: SESSION_ID })
      expect(skipped.skipped).toContain('未启用')
      expect(skipped.items).toEqual([])
      // force：跳过开关（评分调试），仍有结果返回路径
      const forced = await serviceOff.recall({ query: 'x', sessionId: SESSION_ID, force: true })
      expect(forced.skipped).toBeUndefined()
    } finally {
      serviceOff.stop()
    }

    const dormant = makeEnv({ llmMock: false })
    const serviceDormant = makeService(dormant)
    await serviceDormant.start()
    try {
      const skipped = await serviceDormant.recall({ query: 'x', sessionId: SESSION_ID, force: true })
      expect(skipped.skipped).toContain('休眠')
    } finally {
      serviceDormant.stop()
    }
  })

  it('recall：超时静默降级（慢嵌入 → 300ms 内跳过）', async () => {
    const env = makeEnv({ memoryRecallTimeoutMs: 50 })
    const slow = {
      resolve: () => ({ source: 'mock', model: MOCK_EMBED_MODEL, dim: MOCK_EMBED_DIM, apiKey: '', batchSize: 1, timeoutMs: 1000 }),
      embed: () => new Promise<never>(() => {}), // 永不返回
      stats: env.embeddings.stats,
    } as unknown as EmbeddingManager
    const service = new MemoryService({
      cfg: env.cfg,
      db: env.db,
      store: env.store,
      vectors: env.vectors,
      queue: env.queue,
      embeddings: slow,
    })
    const outcome = await service.recall({ query: '会超时', sessionId: SESSION_ID })
    expect(outcome.skipped).toContain('超时')
    expect(outcome.items).toEqual([])
  })

  it('reindex：清旧模型向量 + 补账 + 触发消费', async () => {
    const env = makeEnv()
    const service = makeService(env)
    await service.start()
    try {
      const item = env.store.upsertScoped('session', SESSION_ID, 'fact', '重建目标：写入旧向量')!.item
      // 伪造旧模型向量（模拟模型切换后的残留）
      env.vectors.put(item.id, 'legacy-model', 8, new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]))
      const result = await service.reindex()
      expect(result.ok).toBe(true)
      expect(result.model).toBe(MOCK_EMBED_MODEL)
      expect(result.removed).toBe(1) // 旧模型行被清理
      expect(result.requeued).toBe(1)
      // reindex 内部已触发消费（fire-and-forget）；等待落库
      await waitFor(() => env.vectors.get(item.id)?.model === MOCK_EMBED_MODEL)
      expect(env.vectors.count('legacy-model', 8)).toBe(0)
    } finally {
      service.stop()
    }
  })

  it('recall：global 桶参与召回且权重收敛（同文本同 sim → session 排前）', async () => {
    const env = makeEnv()
    const service = makeService(env)
    await service.start()
    try {
      // 两条完全相同的文本（mock 向量一致 → sim 相同），仅 scope 不同
      env.store.upsertScoped('global', 'global', 'preference', '文档用中文书写')!
      env.store.upsertScoped('session', SESSION_ID, 'decision', '文档用中文书写')!
      await service.poke()
      const outcome = await service.recall({ query: '文档 中文', sessionId: SESSION_ID })
      expect(outcome.items).toHaveLength(2)
      const sessionEntry = outcome.items.find((x) => x.scope === 'session')!
      const globalEntry = outcome.items.find((x) => x.scope === 'global')!
      expect(outcome.items[0]!.id).toBe(sessionEntry.id)
      expect(sessionEntry.score).toBeGreaterThan(globalEntry.score)
    } finally {
      service.stop()
    }
  })
})

/** 轮询等待（fire-and-forget 消费路径的测试同步） */
async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

// ---------- 队列方法补充单测 ----------

describe('M25.3：嵌入队列补充方法', () => {
  it('resetFailed：失败条目重置（attempts 清零、state 回 pending）', () => {
    const env = makeEnv()
    const item = env.store.upsertScoped('session', SESSION_ID, 'fact', '失败重试内容')!.item
    for (let i = 0; i < 5; i++) {
      env.queue.claim(10)
      env.queue.markFailed(item.id, `错误 ${i}`)
    }
    expect(env.queue.failedCount()).toBe(1)
    expect(env.queue.pendingCount()).toBe(0)
    expect(env.queue.resetFailed()).toBe(1)
    expect(env.queue.failedCount()).toBe(0)
    expect(env.queue.pendingCount()).toBe(1)
  })
})

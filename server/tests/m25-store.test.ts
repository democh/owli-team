/**
 * M25.1 单测：存储底座。
 *
 * - 迁移 v6/v7：旧库（v5 结构）无损搬迁、幂等、FK 级联语义；
 * - BLOB 序列化往返（float32 小端）、嵌入缓存修剪、嵌入队列状态机；
 * - MemoryStore 四层 scope：去重、状态过滤、supersede 链路、实体抽取、FTS 检索；
 * - 双后端（sqlite-vec / JS 余弦）top-k 一致性、bootstrap 降级（noExtensions）与镜像重建。
 */
import { describe, expect, it } from 'vitest'
import { applyMigrations, openDatabase } from '../src/store/db.js'
import { MemoryStore, extractEntities } from '../src/store/memory.js'
import {
  EmbeddingCacheStore,
  EmbedQueueStore,
  MemoryVectorStore,
  blobToF32,
  f32ToBlob,
  l2norm,
} from '../src/store/memory-vectors.js'
import { bootstrapVectorIndex, bucketOf, cosineSim } from '../src/memory/vectors.js'
import type { AppDb } from '../src/store/db.js'

const SESSION_ID = 's1'
const MODEL = 'mock-embed'
const DIM = 4

function makeDb(noExtensions = false): AppDb {
  const db = openDatabase(':memory:', { memory: true, noExtensions })
  const now = new Date().toISOString()
  db.run(
    `INSERT INTO sessions (id, title, participant_ids, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    SESSION_ID,
    '测试会话',
    '["pm"]',
    now,
    now,
  )
  return db
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('M25.1 迁移 v6/v7', () => {
  it('新库：memory 表重建为 scoped 结构 + 索引齐全', () => {
    const db = makeDb()
    const cols = db.all<{ name: string }>('PRAGMA table_info(memory)').map((r) => r.name)
    for (const col of [
      'scope',
      'owner_id',
      'importance',
      'entities',
      'status',
      'supersedes',
      'superseded_by',
      'valid_from',
      'valid_to',
      'source_session_id',
      'source_run_id',
      'hits',
      'last_used_at',
    ]) {
      expect(cols).toContain(col)
    }
    const indexes = db
      .all<{ name: string }>('SELECT name FROM sqlite_master WHERE type = ? AND tbl_name = ?', 'index', 'memory')
      .map((r) => r.name)
    expect(indexes).toContain('idx_memory_unique_scoped')
    expect(indexes).not.toContain('idx_memory_unique')
    const versions = db.all<{ version: number }>('SELECT version FROM schema_migrations').map((r) => Number(r.version))
    expect(versions).toEqual(expect.arrayContaining([6, 7]))
  })

  it('旧库（v5 结构）：数据无损搬迁为 session scope 默认值', () => {
    const db = makeDb()
    // 还原为 v5 结构：先移除 v6 新表，再重建旧 memory 表并写入旧数据
    db.exec('DROP TABLE IF EXISTS memory_vectors')
    db.exec('DROP TABLE IF EXISTS memory_embed_queue')
    db.exec('DROP TABLE IF EXISTS embedding_cache')
    db.exec('DROP TABLE IF EXISTS memory')
    db.exec(`CREATE TABLE memory (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      hash TEXT NOT NULL,
      source TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`)
    db.exec('CREATE UNIQUE INDEX idx_memory_unique ON memory(session_id, kind, hash)')
    const ts = new Date().toISOString()
    db.run(
      `INSERT INTO memory (id, session_id, kind, content, hash, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      'mem_old1',
      SESSION_ID,
      'decision',
      '旧库决策内容',
      'hash_old',
      'agent:pm',
      ts,
      ts,
    )
    try {
      db.run('DELETE FROM memory_fts')
    } catch {
      // FTS 不可用的构建：无回填表，忽略
    }
    db.run('DELETE FROM schema_migrations WHERE version >= 6')
    const report = applyMigrations(db)
    expect(report.applied).toEqual(expect.arrayContaining([6, 7]))

    const row = db.get<{
      scope: string
      owner_id: string
      session_id: string
      importance: number
      status: string
      valid_from: string
      content: string
      source: string
    }>('SELECT * FROM memory WHERE id = ?', 'mem_old1')
    expect(row).toMatchObject({
      scope: 'session',
      owner_id: SESSION_ID,
      session_id: SESSION_ID,
      importance: 3,
      status: 'active',
      valid_from: ts,
      content: '旧库决策内容',
      source: 'agent:pm',
    })
  })

  it('幂等：重复 applyMigrations 不再执行任何迁移', () => {
    const db = makeDb()
    const report = applyMigrations(db)
    expect(report.applied).toEqual([])
    expect(report.skipped).toEqual([])
  })

  it('级联：删除会话清 session 记忆；agent 记忆（无 FK）存活', () => {
    const db = makeDb()
    const memory = new MemoryStore(db)
    memory.upsert(SESSION_ID, 'decision', '会话内决策')
    memory.upsertScoped('agent', 'pm', 'fact', '跨会话事实', { sourceSessionId: SESSION_ID })
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM memory')?.n).toBe(2)
    db.run('DELETE FROM sessions WHERE id = ?', SESSION_ID)
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM memory WHERE scope = ?', 'session')?.n).toBe(0)
    const agentRow = db.get<{ session_id: string | null }>('SELECT session_id FROM memory WHERE scope = ?', 'agent')
    expect(agentRow?.session_id).toBeNull()
  })
})

describe('M25.1 BLOB 与存储类', () => {
  it('float32 小端序列化往返保精度', () => {
    const src = new Float32Array([0.5, -1.25, 3.14159, 1e-7])
    const blob = f32ToBlob(src)
    expect(blob.byteLength).toBe(src.length * 4)
    const back = blobToF32(blob)
    expect(back.length).toBe(src.length)
    for (let i = 0; i < src.length; i++) expect(back[i]).toBeCloseTo(src[i]!, 6)
    expect(l2norm(new Float32Array([3, 4]))).toBeCloseTo(5, 6)
    expect(cosineSim(new Float32Array([1, 0]), new Float32Array([1, 0]), 1, 1)).toBeCloseTo(1, 6)
    expect(cosineSim(new Float32Array([1, 0]), new Float32Array([0, 1]), 1, 1)).toBeCloseTo(0, 6)
  })

  it('MemoryVectorStore：put/get/scanBucket/listAll/deleteStale', () => {
    const db = makeDb()
    const memory = new MemoryStore(db)
    const store = new MemoryVectorStore(db)
    const a = memory.upsert(SESSION_ID, 'fact', '向量 A', 'test')!.item
    const b = memory.upsert(SESSION_ID, 'fact', '向量 B', 'test')!.item
    store.put(a.id, MODEL, DIM, new Float32Array([1, 0, 0, 0]))
    store.put(b.id, MODEL, DIM, new Float32Array([0, 1, 0, 0]))
    expect(store.count(MODEL, DIM)).toBe(2)
    expect(store.get(a.id)?.norm).toBeCloseTo(1, 5)
    const scanned = store.scanBucket('session', SESSION_ID, MODEL, DIM)
    expect(scanned.map((r) => r.memoryId).sort()).toEqual([a.id, b.id].sort())
    const all = store.listAll(MODEL, DIM)
    expect(all).toHaveLength(2)
    expect(all[0]!.scope).toBe('session')
    // archived 记忆不参与 scanBucket
    memory.setStatus(b.id, 'archived')
    expect(store.scanBucket('session', SESSION_ID, MODEL, DIM)).toHaveLength(1)
    expect(store.listAll(MODEL, DIM)).toHaveLength(2)
    // 模型切换清理旧行
    store.deleteStale('other-model', DIM)
    expect(store.count()).toBe(0)
  })

  it('EmbeddingCacheStore：get/put/容量修剪', async () => {
    const db = makeDb()
    const cache = new EmbeddingCacheStore(db, 3)
    for (let i = 0; i < 5; i++) {
      cache.put(`hash${i}`, MODEL, DIM, new Float32Array([i, 0, 0, 0]))
      await sleep(5)
    }
    expect(cache.count()).toBe(5)
    const removed = cache.prune()
    expect(removed).toBe(2)
    expect(cache.count()).toBe(3)
    expect(cache.get('hash4', MODEL)?.vec[0]).toBeCloseTo(4, 5)
    expect(cache.get('hash0', MODEL)).toBeUndefined()
  })

  it('EmbedQueueStore：状态机（claim/markDone/markFailed/recover/requeueMissing）', () => {
    const db = makeDb()
    const queue = new EmbedQueueStore(db)
    const memory = new MemoryStore(db, queue)
    const item = memory.upsert(SESSION_ID, 'fact', '待嵌入内容', 'test')!.item
    expect(queue.pendingCount()).toBe(1)

    const claimed = queue.claim(10)
    expect(claimed).toHaveLength(1)
    expect(claimed[0]).toMatchObject({ memoryId: item.id, content: '待嵌入内容', attempts: 0 })

    // processing 残留恢复
    queue.recoverStale()
    expect(queue.pendingCount()).toBe(1)

    queue.claim(10)
    queue.markFailed(item.id, '网络超时')
    expect(db.get<{ attempts: number; state: string; last_error: string }>('SELECT attempts, state, last_error FROM memory_embed_queue WHERE memory_id = ?', item.id)).toMatchObject({
      attempts: 1,
      state: 'pending',
      last_error: '网络超时',
    })

    queue.claim(10)
    queue.markDone(item.id)
    expect(queue.pendingCount()).toBe(0)

    // 补账：active 且无向量的重新入队
    const added = queue.requeueMissing(MODEL, DIM)
    expect(added).toBe(1)
    expect(queue.pendingCount()).toBe(1)
    // archived 记忆不补账
    memory.setStatus(item.id, 'archived')
    queue.markDone(item.id)
    expect(queue.requeueMissing(MODEL, DIM)).toBe(0)
  })
})

describe('M25.1 MemoryStore 四层 scope', () => {
  it('upsertScoped：scope+owner 隔离去重；patch 重算实体内并入队', () => {
    const db = makeDb()
    const queue = new EmbedQueueStore(db)
    const memory = new MemoryStore(db, queue)
    const first = memory.upsertScoped('session', SESSION_ID, 'decision', '使用 REST 而非 GraphQL', { source: 'agent:pm' })
    const dup = memory.upsertScoped('session', SESSION_ID, 'decision', '使用 REST 而非 GraphQL', { source: 'agent:pm' })
    const other = memory.upsertScoped('agent', 'pm', 'decision', '使用 REST 而非 GraphQL', { source: 'agent:pm' })
    expect(first?.added).toBe(true)
    expect(dup?.added).toBe(false)
    expect(other?.added).toBe(true)
    expect(first?.item.entities).toContain('rest')
    expect(memory.count(SESSION_ID)).toBe(1)

    const patched = memory.patch(first!.item.id, '改用 SQLite FTS5 做检索')
    expect(patched?.content).toBe('改用 SQLite FTS5 做检索')
    expect(patched?.entities).toContain('fts5')
    // 入队：first + other 两条（dup 去重不入队；patch 重入队命中 ON CONFLICT 不新增）
    expect(queue.pendingCount()).toBe(2)
  })

  it('render：仅 active、分区渲染、compact 截断', () => {
    const db = makeDb()
    const memory = new MemoryStore(db)
    memory.upsert(SESSION_ID, 'decision', '决策内容')
    memory.upsert(SESSION_ID, 'fact', '事实内容')
    memory.upsert(SESSION_ID, 'preference', '偏好内容')
    const archived = memory.upsert(SESSION_ID, 'glossary', '归档术语')!.item
    memory.setStatus(archived.id, 'archived')

    const full = memory.render(SESSION_ID)
    expect(full).toContain('<session_memory>')
    expect(full).toContain('决策内容')
    expect(full).toContain('事实内容')
    expect(full).toContain('偏好内容')
    expect(full).not.toContain('归档术语')

    const compact = memory.render(SESSION_ID, true)
    expect(compact).toContain('决策内容')
    expect(compact).toContain('偏好内容')
    expect(compact).not.toContain('事实内容')
  })

  it('markSuperseded：旧条目 superseded + valid_to；新条目 supersedes', () => {
    const db = makeDb()
    const memory = new MemoryStore(db)
    const oldItem = memory.upsert(SESSION_ID, 'constraint', '接口超时 3s')!.item
    const newItem = memory.upsert(SESSION_ID, 'constraint', '接口超时 5s')!.item
    expect(memory.markSuperseded(oldItem.id, newItem.id)).toBe(true)
    const oldRow = memory.get(oldItem.id)!
    const newRow = memory.get(newItem.id)!
    expect(oldRow.status).toBe('superseded')
    expect(oldRow.supersededBy).toBe(newItem.id)
    expect(oldRow.validTo).toBeTruthy()
    expect(newRow.supersedes).toBe(oldItem.id)
    expect(memory.render(SESSION_ID)).not.toContain('接口超时 3s')
  })

  it('extractEntities：确定性启发式（英文词 + CJK 双字组）', () => {
    const text = '使用 SQLite 的 sqlite-vec 扩展'
    const a = extractEntities(text)
    const b = extractEntities(text)
    expect(a).toEqual(b)
    expect(a).toContain('sqlite')
    expect(a).toContain('sqlite-vec')
    expect(a).toContain('使用')
    expect(a).toContain('扩展')
    expect(a.length).toBeLessThanOrEqual(32)
  })

  it('searchIds：trigram/LIKE 回退均可命中（FTS 缺失不报错）', () => {
    const db = makeDb()
    const memory = new MemoryStore(db)
    const item = memory.upsert(SESSION_ID, 'constraint', '错误码必须复用现有 40001 规范')!.item
    expect(memory.searchIds('错误码')).toContain(item.id)
    expect(memory.searchIds('40001')).toContain(item.id)
    expect(memory.searchIds('不存在的词')).toEqual([])
  })
})

describe('M25.1 双后端与 bootstrap', () => {
  /** 构造同构数据：4 条记忆 + 向量（A 与查询最相似） */
  async function seed(noExtensions: boolean): Promise<{
    db: AppDb
    store: MemoryVectorStore
    ids: string[]
    index: Awaited<ReturnType<typeof bootstrapVectorIndex>>['index']
  }> {
    const db = makeDb(noExtensions)
    const memory = new MemoryStore(db)
    const store = new MemoryVectorStore(db)
    const vectors = [
      new Float32Array([1, 0, 0, 0]),
      new Float32Array([0.8, 0.6, 0, 0]),
      new Float32Array([0, 1, 0, 0]),
      new Float32Array([-1, 0, 0, 0]),
    ]
    const ids: string[] = []
    for (let i = 0; i < vectors.length; i++) {
      const item = memory.upsert(SESSION_ID, 'fact', `向量记忆 ${i}`, 'test')!.item
      ids.push(item.id)
      store.put(item.id, MODEL, DIM, vectors[i]!)
    }
    const { index, status } = await bootstrapVectorIndex({ db, store, model: MODEL, dim: DIM })
    expect(status).not.toBeNull()
    if (!noExtensions) expect(status!.backend).toBe('sqlite-vec')
    else expect(status!.backend).toBe('js')
    // sqlite-vec 后端需要把 BLOB 灌入镜像（bootstrap 重建已覆盖；此处顺带验证 put 通道）
    for (let i = 0; i < vectors.length; i++) index!.put(ids[i]!, bucketOf('session', SESSION_ID), vectors[i]!)
    return { db, store, ids, index }
  }

  it('sqlite-vec 可用时 backend=sqlite-vec；noExtensions 强制 JS 且 kv 标记', async () => {
    const vec = await seed(false)
    expect(vec.db.kvGet('memory.vec.backend')).toBe('sqlite-vec')
    expect(vec.db.kvGet('memory.vec.model')).toBe(MODEL)
    expect(Number(vec.db.kvGet('memory.vec.dim'))).toBe(DIM)

    const js = await seed(true)
    expect(js.db.kvGet('memory.vec.backend')).toBe('js')
    expect(js.db.kvGet('memory.vec.extVersion')).toBe('')
  })

  it('双后端 top-k 一致性：同数据同查询 → 同顺序、sim 近似', async () => {
    const vec = await seed(false)
    const js = await seed(true)
    const query = new Float32Array([1, 0, 0, 0])
    const bucket = bucketOf('session', SESSION_ID)
    // 无平局：sim = [1, 0.8, 0, -1]，k=3 截断最后一条
    const hitsVec = vec.index!.query(bucket, query, 3)
    const hitsJs = js.index!.query(bucket, query, 3)
    expect(hitsVec).toHaveLength(3)
    expect(hitsJs).toHaveLength(3)
    // 两后端各自 id 顺序一致（id 不同库不同 → 以各自 ids 数组下标比较）
    const orderVec = hitsVec.map((h) => vec.ids.indexOf(h.memoryId))
    const orderJs = hitsJs.map((h) => js.ids.indexOf(h.memoryId))
    expect(orderVec).toEqual([0, 1, 2])
    expect(orderJs).toEqual(orderVec)
    for (let i = 0; i < 3; i++) expect(hitsVec[i]!.sim).toBeCloseTo(hitsJs[i]!.sim, 3)
  })

  it('bootstrap：镜像与 BLOB 数量不符 → 自动重建（含孤儿清理）', async () => {
    const db = makeDb()
    const memory = new MemoryStore(db)
    const store = new MemoryVectorStore(db)
    const item = memory.upsert(SESSION_ID, 'fact', '重建目标', 'test')!.item
    store.put(item.id, MODEL, DIM, new Float32Array([1, 0, 0, 0]))
    // 首次：镜像空 + BLOB 1 条 → 重建
    const first = await bootstrapVectorIndex({ db, store, model: MODEL, dim: DIM })
    expect(first.status!.rebuilt).toBe(true)
    expect(first.index!.query(bucketOf('session', SESSION_ID), new Float32Array([1, 0, 0, 0]), 5)).toHaveLength(1)
    // 二次：一致 → 不重建
    const second = await bootstrapVectorIndex({ db, store, model: MODEL, dim: DIM })
    expect(second.status!.rebuilt).toBe(false)
    // 注入孤儿（镜像有、BLOB 无）→ 重建后被清理
    second.index!.put('mem_orphan', bucketOf('session', SESSION_ID), new Float32Array([0, 1, 0, 0]))
    const third = await bootstrapVectorIndex({ db, store, model: MODEL, dim: DIM })
    expect(third.status!.rebuilt).toBe(true)
    const hits = third.index!.query(bucketOf('session', SESSION_ID), new Float32Array([0, 1, 0, 0]), 5)
    expect(hits.map((h) => h.memoryId)).toEqual([item.id])
  })

  it('SqliteVecIndex：put 覆盖与 remove 生效', async () => {
    const db = makeDb()
    const memory = new MemoryStore(db)
    const store = new MemoryVectorStore(db)
    const item = memory.upsert(SESSION_ID, 'fact', '覆盖目标', 'test')!.item
    const { index } = await bootstrapVectorIndex({ db, store, model: MODEL, dim: DIM })
    const bucket = bucketOf('session', SESSION_ID)
    index!.put(item.id, bucket, new Float32Array([1, 0, 0, 0]))
    expect(index!.query(bucket, new Float32Array([1, 0, 0, 0]), 1)[0]!.sim).toBeCloseTo(1, 3)
    index!.put(item.id, bucket, new Float32Array([0, 1, 0, 0]))
    expect(index!.query(bucket, new Float32Array([1, 0, 0, 0]), 1)[0]!.sim).toBeCloseTo(0, 3)
    index!.remove(item.id)
    expect(index!.query(bucket, new Float32Array([0, 1, 0, 0]), 5)).toHaveLength(0)
  })
})

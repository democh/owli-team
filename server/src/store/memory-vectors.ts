/**
 * 记忆向量存储（M25）：memory_vectors（规范副本）/ embedding_cache（指纹缓存）/ memory_embed_queue（嵌入队列）。
 *
 * - 序列化：float32 小端 BLOB（SQLite 裸字节约定）；小端平台零拷贝绑定，大端平台逐元素转换；
 * - memory_vectors 是唯一真相源：sqlite-vec 镜像（vec0）丢失/损坏/换模型时可随时由此重建；
 * - 余弦检索按「scope:ownerId 桶」扫描，norm 预存避免每查询重复计算。
 */
import type { AppDb } from './db.js'
import { nowIso } from './sessions.js'

const LITTLE_ENDIAN = (() => {
  const buf = new ArrayBuffer(2)
  new DataView(buf).setInt16(0, 256, true)
  return new Int16Array(buf)[0] === 256
})()

/** float32 序列化为小端 BLOB。小端平台返回与输入共享内存的视图（仅用于立即绑定，勿缓存）。 */
export function f32ToBlob(vec: Float32Array): Uint8Array {
  if (LITTLE_ENDIAN) return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength)
  const out = new Uint8Array(vec.length * 4)
  const dv = new DataView(out.buffer)
  for (let i = 0; i < vec.length; i++) dv.setFloat32(i * 4, vec[i], true)
  return out
}

/** BLOB 反序列化为 float32（小端优先零拷贝视图，其余路径逐元素读取） */
export function blobToF32(blob: Uint8Array): Float32Array {
  const n = Math.floor(blob.byteLength / 4)
  if (LITTLE_ENDIAN && blob.byteOffset % 4 === 0) return new Float32Array(blob.buffer, blob.byteOffset, n)
  const out = new Float32Array(n)
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength)
  for (let i = 0; i < n; i++) out[i] = dv.getFloat32(i * 4, true)
  return out
}

/** L2 范数（存入 memory_vectors.norm，供余弦检索复用） */
export function l2norm(vec: Float32Array): number {
  let sum = 0
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i]
  return Math.sqrt(sum)
}

export interface VectorRow {
  memoryId: string
  vec: Float32Array
  norm: number
}

export interface VectorStatsRow {
  model: string
  dim: number
  count: number
}

interface MemoryVectorDbRow {
  memory_id: string
  model: string
  dim: number
  vec: Uint8Array
  norm: number
}

export class MemoryVectorStore {
  constructor(private readonly db: AppDb) {}

  put(memoryId: string, model: string, dim: number, vec: Float32Array): void {
    this.db.run(
      `INSERT INTO memory_vectors (memory_id, model, dim, vec, norm, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(memory_id) DO UPDATE SET model = excluded.model, dim = excluded.dim,
         vec = excluded.vec, norm = excluded.norm, created_at = excluded.created_at`,
      memoryId,
      model,
      dim,
      f32ToBlob(vec),
      l2norm(vec),
      nowIso(),
    )
  }

  remove(memoryId: string): void {
    this.db.run('DELETE FROM memory_vectors WHERE memory_id = ?', memoryId)
  }

  get(memoryId: string): { model: string; dim: number; vec: Float32Array; norm: number } | undefined {
    const row = this.db.get<MemoryVectorDbRow>(
      'SELECT memory_id, model, dim, vec, norm FROM memory_vectors WHERE memory_id = ?',
      memoryId,
    )
    return row ? { model: row.model, dim: row.dim, vec: blobToF32(row.vec), norm: row.norm } : undefined
  }

  has(memoryId: string, model: string, dim: number): boolean {
    return !!this.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM memory_vectors WHERE memory_id = ? AND model = ? AND dim = ?',
      memoryId,
      model,
      dim,
    )?.n
  }

  count(model?: string, dim?: number): number {
    if (model !== undefined && dim !== undefined) {
      return Number(
        this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM memory_vectors WHERE model = ? AND dim = ?', model, dim)?.n ?? 0,
      )
    }
    return Number(this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM memory_vectors')?.n ?? 0)
  }

  /** 按模型/dim 聚合（后端状态展示与镜像重建范围判定） */
  stats(): VectorStatsRow[] {
    return this.db
      .all<{ model: string; dim: number; count: number }>(
        'SELECT model, dim, COUNT(*) AS count FROM memory_vectors GROUP BY model, dim',
      )
      .map((r) => ({ model: r.model, dim: Number(r.dim), count: Number(r.count) }))
  }

  /**
   * 扫描单个 bucket（scope + ownerId）的 active 向量（JS 余弦兜底路径；sqlite-vec 路径不走这里）。
   * limit 防止单桶无界扫描（默认 2 万，见计划 Assumptions）。
   */
  scanBucket(scope: string, ownerId: string, model: string, dim: number, limit = 20000): VectorRow[] {
    return this.db
      .all<MemoryVectorDbRow>(
        `SELECT v.memory_id, v.model, v.dim, v.vec, v.norm
         FROM memory_vectors v JOIN memory m ON m.id = v.memory_id
         WHERE m.scope = ? AND m.owner_id = ? AND m.status = 'active' AND v.model = ? AND v.dim = ?
         LIMIT ?`,
        scope,
        ownerId,
        model,
        dim,
        limit,
      )
      .map((r) => ({ memoryId: r.memory_id, vec: blobToF32(r.vec), norm: r.norm }))
  }

  /** 模型/dim 切换时清掉旧模型行（避免 BLOB 副本与新模型并存混淆统计） */
  deleteStale(model: string, dim: number): number {
    return this.db.run('DELETE FROM memory_vectors WHERE NOT (model = ? AND dim = ?)', model, dim).changes
  }

  /** 全量列出（指定 model/dim；vec0 镜像重建数据源，含非 active 行保持镜像与 BLOB 对齐） */
  listAll(model: string, dim: number): Array<{ memoryId: string; scope: string; ownerId: string; vec: Float32Array }> {
    return this.db
      .all<{ memory_id: string; scope: string; owner_id: string; vec: Uint8Array }>(
        `SELECT v.memory_id, m.scope, m.owner_id, v.vec
         FROM memory_vectors v JOIN memory m ON m.id = v.memory_id
         WHERE v.model = ? AND v.dim = ?`,
        model,
        dim,
      )
      .map((r) => ({ memoryId: r.memory_id, scope: r.scope, ownerId: r.owner_id, vec: blobToF32(r.vec) }))
  }

  clear(): void {
    this.db.run('DELETE FROM memory_vectors')
  }
}

export class EmbeddingCacheStore {
  constructor(
    private readonly db: AppDb,
    private readonly maxRows = 20000,
  ) {}

  get(textHash: string, model: string): { dim: number; vec: Float32Array } | undefined {
    const row = this.db.get<{ dim: number; vec: Uint8Array }>(
      'SELECT dim, vec FROM embedding_cache WHERE text_hash = ? AND model = ?',
      textHash,
      model,
    )
    return row ? { dim: row.dim, vec: blobToF32(row.vec) } : undefined
  }

  put(textHash: string, model: string, dim: number, vec: Float32Array): void {
    this.db.run(
      `INSERT INTO embedding_cache (text_hash, model, dim, vec, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(text_hash, model) DO UPDATE SET dim = excluded.dim, vec = excluded.vec, created_at = excluded.created_at`,
      textHash,
      model,
      dim,
      f32ToBlob(vec),
      nowIso(),
    )
  }

  count(): number {
    return Number(this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM embedding_cache')?.n ?? 0)
  }

  /** 容量修剪：超出上限时删最旧（按 created_at 升序） */
  prune(): number {
    const total = this.count()
    const excess = total - this.maxRows
    if (excess <= 0) return 0
    return this.db.run(
      `DELETE FROM embedding_cache WHERE rowid IN (
         SELECT rowid FROM embedding_cache ORDER BY created_at ASC LIMIT ?
       )`,
      excess,
    ).changes
  }

  clear(): void {
    this.db.run('DELETE FROM embedding_cache')
  }
}

export interface QueueItem {
  memoryId: string
  content: string
  attempts: number
}

interface QueueRow {
  memory_id: string
  attempts: number
  content: string
}

export class EmbedQueueStore {
  constructor(
    private readonly db: AppDb,
    private readonly maxAttempts = 5,
  ) {}

  /** 写入即入队（幂等；内容更新重新入队时重置失败计数） */
  enqueue(memoryId: string): void {
    this.db.run(
      `INSERT INTO memory_embed_queue (memory_id, state, attempts, last_error, updated_at) VALUES (?, 'pending', 0, NULL, ?)
       ON CONFLICT(memory_id) DO UPDATE SET state = 'pending', attempts = 0, last_error = NULL, updated_at = excluded.updated_at`,
      memoryId,
      nowIso(),
    )
  }

  /** 领取一批待嵌入记忆（join memory 过滤 active；置 processing 防重复领取） */
  claim(limit: number): QueueItem[] {
    const rows = this.db.all<QueueRow>(
      `SELECT q.memory_id, q.attempts, m.content
       FROM memory_embed_queue q JOIN memory m ON m.id = q.memory_id
       WHERE q.state = 'pending' AND q.attempts < ? AND m.status = 'active'
       ORDER BY q.updated_at ASC LIMIT ?`,
      this.maxAttempts,
      limit,
    )
    if (rows.length === 0) return []
    const now = nowIso()
    this.db.tx(() => {
      for (const row of rows) {
        this.db.run(
          'UPDATE memory_embed_queue SET state = ?, updated_at = ? WHERE memory_id = ?',
          'processing',
          now,
          row.memory_id,
        )
      }
    })
    return rows.map((r) => ({ memoryId: r.memory_id, content: r.content, attempts: r.attempts }))
  }

  markDone(memoryId: string): void {
    this.db.run('DELETE FROM memory_embed_queue WHERE memory_id = ?', memoryId)
  }

  /** 失败退避：重试计数 +1；达到上限置 failed（等待人工 reindex 或显式重新入队） */
  markFailed(memoryId: string, error: string): void {
    this.db.run(
      `UPDATE memory_embed_queue
       SET attempts = attempts + 1,
           state = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'pending' END,
           last_error = ?, updated_at = ?
       WHERE memory_id = ?`,
      this.maxAttempts,
      error.slice(0, 500),
      nowIso(),
      memoryId,
    )
  }

  /** 进程崩溃残留的 processing 行恢复为 pending（启动时调用） */
  recoverStale(): number {
    return this.db.run(
      `UPDATE memory_embed_queue SET state = 'pending', updated_at = ? WHERE state = 'processing'`,
      nowIso(),
    ).changes
  }

  /**
   * 启动补账：active 记忆中没有当前模型/dim 向量的全部入队。
   * 保留既有 attempts（防坏内容启动重试死循环），enqueue 路径才重置。
   */
  requeueMissing(model: string, dim: number): number {
    return this.db.run(
      `INSERT INTO memory_embed_queue (memory_id, state, attempts, last_error, updated_at)
       SELECT m.id, 'pending', 0, NULL, ?
       FROM memory m
       LEFT JOIN memory_vectors v ON v.memory_id = m.id
       LEFT JOIN memory_embed_queue q ON q.memory_id = m.id
       WHERE m.status = 'active'
         AND (v.memory_id IS NULL OR v.model != ? OR v.dim != ?)
         AND (q.memory_id IS NULL OR q.attempts < ?)
       ON CONFLICT(memory_id) DO UPDATE SET state = 'pending', updated_at = excluded.updated_at`,
      nowIso(),
      model,
      dim,
      this.maxAttempts,
    ).changes
  }

  pendingCount(): number {
    return Number(
      this.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM memory_embed_queue WHERE state IN ('pending', 'processing') AND attempts < ?`,
        this.maxAttempts,
      )?.n ?? 0,
    )
  }

  failedCount(): number {
    return Number(
      this.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM memory_embed_queue WHERE state = 'failed' OR attempts >= ?`,
        this.maxAttempts,
      )?.n ?? 0,
    )
  }

  /** 清理对应记忆已非 active 的残留队列行（状态流转后不再需要嵌入；worker 定期调用） */
  dropInactive(): number {
    return this.db.run(
      `DELETE FROM memory_embed_queue
       WHERE NOT EXISTS (SELECT 1 FROM memory m WHERE m.id = memory_embed_queue.memory_id AND m.status = 'active')`,
    ).changes
  }

  /** 重置失败条目（人工 reindex 时重试；与 enqueue 的重置路径区分） */
  resetFailed(): number {
    return this.db.run(
      `UPDATE memory_embed_queue SET state = 'pending', attempts = 0, last_error = NULL, updated_at = ?
       WHERE state = 'failed' OR attempts >= ?`,
      nowIso(),
      this.maxAttempts,
    ).changes
  }
}

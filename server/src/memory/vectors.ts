/**
 * 向量索引（M25.1b）：sqlite-vec（vec0）优先，JS 余弦兜底。
 *
 * - 双后端语义一致：query(bucket, vec, k) 返回 [{ memoryId, sim }]（sim = 余弦相似度，降序）；
 * - memory_vectors（BLOB）是唯一真相源：vec0 镜像丢失 / 损坏 / 换模型换维度 / 后端切换时全量重建；
 * - vec0 DDL 运行时幂等创建（不进 migrations：扩展缺失不该拖垮 memory 表迁移）；
 * - 能力探测：动态 import sqlite-vec → db.loadExtension → vec_version() 冒烟，任一步失败即降级 JS；
 * - 加载后由 db.loadExtension 内部立即收回许可（最小权限）。
 */
import type { AppDb } from '../store/db.js'
import type { MemoryVectorStore } from '../store/memory-vectors.js'
import { f32ToBlob, l2norm } from '../store/memory-vectors.js'
import { getLogger } from '../logger.js'

export type VectorBackend = 'sqlite-vec' | 'js'

export interface QueryHit {
  memoryId: string
  sim: number
}

export interface VecIndex {
  readonly backend: VectorBackend
  /** 写入/覆盖镜像（BLOB 写入由调用方先行完成；JS 后端为空操作） */
  put(memoryId: string, bucket: string, vec: Float32Array): void
  remove(memoryId: string): void
  /** 桶内 KNN top-k（sim 降序） */
  query(bucket: string, vec: Float32Array, k: number): QueryHit[]
  count(): number
  drop(): void
}

/** 桶标识：scope:ownerId（agent/project/global 的 ownerId 为对应实体 id） */
export function bucketOf(scope: string, ownerId: string): string {
  return `${scope}:${ownerId}`
}

export function parseBucket(bucket: string): { scope: string; ownerId: string } {
  const idx = bucket.indexOf(':')
  return idx < 0 ? { scope: bucket, ownerId: '' } : { scope: bucket.slice(0, idx), ownerId: bucket.slice(idx + 1) }
}

/** 余弦相似度（norm 预存时复用；不考虑向量维度不一致——同源嵌入保证） */
export function cosineSim(a: Float32Array, b: Float32Array, aNorm: number, bNorm: number): number {
  if (aNorm === 0 || bNorm === 0) return 0
  let dot = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) dot += a[i]! * b[i]!
  return dot / (aNorm * bNorm)
}

/** vec0 索引表名（MemoryStore 的 best-effort 镜像清理也依赖此名） */
const VEC_TABLE = 'memory_vec_index'

/** sqlite-vec 后端（vec0 虚拟表；按 bucket 分区 KNN） */
export class SqliteVecIndex implements VecIndex {
  readonly backend = 'sqlite-vec' as const

  constructor(
    private readonly db: AppDb,
    private readonly dim: number,
  ) {
    this.ensureTable()
  }

  private ensureTable(): void {
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${VEC_TABLE} USING vec0(
      memory_id TEXT PRIMARY KEY,
      bucket TEXT PARTITION KEY,
      embedding float[${this.dim}] distance_metric=cosine
    )`)
  }

  put(memoryId: string, bucket: string, vec: Float32Array): void {
    // vec0 的 UPDATE 有限制（分区键不可更新）→ DELETE + INSERT
    this.db.run(`DELETE FROM ${VEC_TABLE} WHERE memory_id = ?`, memoryId)
    this.db.run(
      `INSERT INTO ${VEC_TABLE} (memory_id, bucket, embedding) VALUES (?, ?, ?)`,
      memoryId,
      bucket,
      f32ToBlob(vec),
    )
  }

  remove(memoryId: string): void {
    this.db.run(`DELETE FROM ${VEC_TABLE} WHERE memory_id = ?`, memoryId)
  }

  query(bucket: string, vec: Float32Array, k: number): QueryHit[] {
    return this.db
      .all<{ memory_id: string; distance: number }>(
        `SELECT memory_id, distance FROM ${VEC_TABLE}
         WHERE bucket = ? AND embedding MATCH ? AND k = ?
         ORDER BY distance`,
        bucket,
        f32ToBlob(vec),
        k,
      )
      .map((r) => ({ memoryId: r.memory_id, sim: 1 - r.distance }))
  }

  count(): number {
    return Number(this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${VEC_TABLE}`)?.n ?? 0)
  }

  drop(): void {
    this.db.exec(`DROP TABLE IF EXISTS ${VEC_TABLE}`)
  }

  /** 从 BLOB 全量重灌（drop + create；分批事务避免长事务锁） */
  rebuild(rows: Array<{ memoryId: string; bucket: string; vec: Float32Array }>): void {
    this.drop()
    this.ensureTable()
    const batch = 500
    for (let i = 0; i < rows.length; i += batch) {
      const slice = rows.slice(i, i + batch)
      this.db.tx(() => {
        for (const row of slice) {
          this.db.run(
            `INSERT INTO ${VEC_TABLE} (memory_id, bucket, embedding) VALUES (?, ?, ?)`,
            row.memoryId,
            row.bucket,
            f32ToBlob(row.vec),
          )
        }
      })
    }
  }
}

/** JS 余弦兜底（≤2 万行/桶全扫描；BLOB 即真相源，无需镜像维护） */
export class JsCosineIndex implements VecIndex {
  readonly backend = 'js' as const

  constructor(
    private readonly store: MemoryVectorStore,
    private readonly model: string,
    private readonly dim: number,
  ) {}

  put(): void {
    // BLOB 已由调用方写入 memory_vectors；JS 后端无镜像副本
  }

  remove(): void {
    // 同上（BLOB 删除即生效）
  }

  query(bucket: string, vec: Float32Array, k: number): QueryHit[] {
    const { scope, ownerId } = parseBucket(bucket)
    const rows = this.store.scanBucket(scope, ownerId, this.model, this.dim)
    const qNorm = l2norm(vec)
    if (qNorm === 0) return []
    const hits: QueryHit[] = rows.map((r) => ({
      memoryId: r.memoryId,
      sim: cosineSim(vec, r.vec, qNorm, r.norm),
    }))
    hits.sort((a, b) => b.sim - a.sim)
    return hits.slice(0, k)
  }

  count(): number {
    return this.store.count(this.model, this.dim)
  }

  drop(): void {
    // 不触碰 BLOB（真相源）
  }
}

// ---------- kv 标记（backend / model / dim / extVersion） ----------

const KV_BACKEND = 'memory.vec.backend'
const KV_MODEL = 'memory.vec.model'
const KV_DIM = 'memory.vec.dim'
const KV_EXT_VERSION = 'memory.vec.extVersion'

export interface VecBootstrapStatus {
  backend: VectorBackend
  model: string
  dim: number
  extVersion?: string
  rebuilt: boolean
  reason?: string
}

export interface BootstrapOptions {
  db: AppDb
  store: MemoryVectorStore
  /** 当前嵌入模型/维度；null = 尚未配置（休眠，不建索引） */
  model: string | null
  dim: number | null
}

/**
 * 向量索引引导：探测扩展 → 校验标记与镜像一致性 → 必要时从 BLOB 重建 → 写回 kv 标记。
 * 扩展不可用（旧 Node / 平台缺二进制 / 加载失败）自动降级 JS 后端，行为一致。
 */
export async function bootstrapVectorIndex(opts: BootstrapOptions): Promise<{ index: VecIndex | null; status: VecBootstrapStatus | null }> {
  const { db, store, model, dim } = opts
  if (!model || !dim || dim <= 0) return { index: null, status: null }

  const sqlite = await probeSqliteVec(db)
  const kvBackend = db.kvGet(KV_BACKEND)
  const kvModel = db.kvGet(KV_MODEL)
  const kvDim = Number(db.kvGet(KV_DIM) ?? 0)

  let index: VecIndex
  let rebuilt = false
  let reason: string | undefined

  if (sqlite.ok) {
    const vecIndex = new SqliteVecIndex(db, dim)
    index = vecIndex
    const blobCount = store.count(model, dim)
    const needRebuild =
      sqlite.tableDim !== dim ||
      vecIndex.count() !== blobCount ||
      kvBackend !== 'sqlite-vec' ||
      kvModel !== model ||
      kvDim !== dim
    if (needRebuild) {
      const rows = store.listAll(model, dim).map((r) => ({
        memoryId: r.memoryId,
        bucket: bucketOf(r.scope, r.ownerId),
        vec: r.vec,
      }))
      vecIndex.rebuild(rows)
      rebuilt = true
      reason =
        sqlite.tableDim !== dim
          ? `维度变化（${sqlite.tableDim || '无表'} → ${dim}）`
          : kvBackend !== 'sqlite-vec'
            ? `后端切换（${kvBackend ?? '未标记'} → sqlite-vec）`
            : kvModel !== model || kvDim !== dim
              ? '模型/维度切换'
              : '镜像与规范副本数量不符'
      getLogger().info({ rows: rows.length, reason }, 'vec0 镜像已从 BLOB 重建')
    }
  } else {
    index = new JsCosineIndex(store, model, dim)
    reason = sqlite.reason
    if (kvBackend === 'sqlite-vec') {
      getLogger().warn({ reason }, 'sqlite-vec 不可用，向量检索降级为 JS 余弦后端')
    }
  }

  db.kvSet(KV_BACKEND, index.backend)
  db.kvSet(KV_MODEL, model)
  db.kvSet(KV_DIM, String(dim))
  db.kvSet(KV_EXT_VERSION, sqlite.extVersion ?? '')

  return {
    index,
    status: { backend: index.backend, model, dim, extVersion: sqlite.extVersion, rebuilt, reason },
  }
}

interface SqliteProbe {
  ok: boolean
  extVersion?: string
  /** 现有 vec0 表的维度（0 = 无表/不可解析） */
  tableDim: number
  reason?: string
}

/** 探测 sqlite-vec：动态 import → loadExtension → vec_version() 冒烟 → 读现有表维度 */
async function probeSqliteVec(db: AppDb): Promise<SqliteProbe> {
  try {
    const mod = await import('sqlite-vec')
    const loadPath = mod.getLoadablePath()
    if (!loadPath) return { ok: false, tableDim: 0, reason: 'sqlite-vec 平台二进制缺失（optionalDependencies 未安装）' }
    if (!db.loadExtension(loadPath)) {
      return { ok: false, tableDim: 0, reason: '扩展加载通道不可用（旧版 Node 或驱动限制）' }
    }
    const version = db.get<{ v: string }>('SELECT vec_version() AS v')?.v
    if (!version) return { ok: false, tableDim: 0, reason: 'vec_version() 冒烟失败' }
    return { ok: true, extVersion: version, tableDim: readTableDim(db) }
  } catch (err) {
    return { ok: false, tableDim: 0, reason: `sqlite-vec 加载失败：${(err as Error).message}` }
  }
}

/** 从 sqlite_master 解析现有 vec0 表的 float[N] 维度 */
function readTableDim(db: AppDb): number {
  const ddl = db.get<{ sql: string }>('SELECT sql FROM sqlite_master WHERE name = ?', VEC_TABLE)?.sql
  if (!ddl) return 0
  const match = /float\[(\d+)\]/.exec(ddl)
  return match ? Number(match[1]) : 0
}

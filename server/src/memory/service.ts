/**
 * 记忆服务（M25.3a）：索引生命周期 + 嵌入 worker + 语义召回（L1.5）编排。
 *
 * - 模块化休眠：未配置嵌入连接 → 零网络零索引；worker 定时器常驻但 flush 首行零 DB 提前返回；
 * - 索引懒引导：dim 未知（连接 dim 留空且 EMBEDDING_DIM=0）→ 首次嵌入拿到实际维度后建索引并补账；
 * - recall：开关 / 休眠 / 超时 / 异常一律静默 skipped（绝不影响主链路）；命中回写 hits；
 * - reindex：模型/维度切换或手动重建（清旧模型 BLOB + 全量补账 + 触发消费）。
 */
import type { AppConfig } from '../config.js'
import type { EmbeddingManager, EmbeddingManagerStats, EmbeddingSpec } from '../embeddings/manager.js'
import { getLogger } from '../logger.js'
import type { AppDb } from '../store/db.js'
import type { MemoryStore } from '../store/memory.js'
import type { EmbedQueueStore, MemoryVectorStore, VectorStatsRow } from '../store/memory-vectors.js'
import { EmbedWorker } from './queue.js'
import { recallMemories, type RecallResult } from './recall.js'
import { bootstrapVectorIndex, bucketOf, type VecBootstrapStatus, type VecIndex } from './vectors.js'

export interface MemoryServiceDeps {
  cfg: AppConfig
  db: AppDb
  store: MemoryStore
  vectors: MemoryVectorStore
  queue: EmbedQueueStore
  embeddings: EmbeddingManager
}

export interface RecallRequest {
  query: string
  sessionId?: string
  agentId?: string
  projectId?: string
  topK?: number
  minScore?: number
  budgetTokens?: number
  timeoutMs?: number
  /** 已在 L1 会话记忆中出现的 id（避免重复注入） */
  exclude?: Set<string>
  /** 跳过「语义召回开关」检查（评分调试接口用；休眠/超时仍静默跳过） */
  force?: boolean
}

export interface RecallOutcome extends RecallResult {
  /** 跳过原因；成功时为 undefined */
  skipped?: string
}

export interface ReindexResult {
  ok: boolean
  model?: string
  dim?: number
  /** 清理的旧模型/维度 BLOB 行数 */
  removed: number
  /** 补账入队的记忆数 */
  requeued: number
  error?: string
}

export interface MemoryServiceStats {
  configured: boolean
  source: EmbeddingSpec['source'] | null
  model: string | null
  dim: number
  backend: string | null
  extVersion: string | null
  rebuilt: boolean
  vectorTotal: number
  vectors: VectorStatsRow[]
  pending: number
  failed: number
  embeddings: EmbeddingManagerStats
}

export class MemoryService {
  private index: VecIndex | null = null
  private status: VecBootstrapStatus | null = null
  private indexKey = ''
  private pending: { key: string; promise: Promise<VecIndex | null> } | null = null
  private worker: EmbedWorker | null = null

  constructor(private readonly deps: MemoryServiceDeps) {}

  /** 启动：残留恢复 → 常驻 worker →（已配置且维度已知时）索引引导 + 启动补账 */
  async start(): Promise<void> {
    const recovered = this.deps.queue.recoverStale()
    if (recovered > 0) getLogger().info({ recovered }, '嵌入队列：残留处理中条目已恢复')
    this.worker = new EmbedWorker({
      queue: this.deps.queue,
      vectors: this.deps.vectors,
      store: this.deps.store,
      embeddings: this.deps.embeddings,
      indexFor: (model, dim) => this.ensureIndex(model, dim),
    })
    this.worker.start()
    const spec = this.deps.embeddings.resolve()
    if (spec && spec.dim > 0) await this.ensureIndex(spec.model, spec.dim)
  }

  stop(): void {
    this.worker?.stop()
    this.worker = null
  }

  get currentIndex(): VecIndex | null {
    return this.index
  }

  get currentStatus(): VecBootstrapStatus | null {
    return this.status
  }

  /** 轻量触发（写入后 fire-and-forget 加速消费；定时器兜底）。返回本轮落库条数（测试 / 脚本可 await） */
  poke(): Promise<number> {
    if (!this.worker) return Promise.resolve(0)
    return this.worker.flush()
  }

  /** 语义召回（L1.5）：任何失败静默降级，绝不影响主链路 */
  async recall(request: RecallRequest): Promise<RecallOutcome> {
    const cfg = this.deps.cfg
    if (!cfg.memoryRecallEnabled && !request.force) return skipped('语义召回未启用（设置 → 向量记忆）')
    const spec = this.deps.embeddings.resolve()
    if (!spec) return skipped('嵌入服务休眠（连接中心未选择 embedding 连接且 EMBEDDING_* 未设置）')
    const query = request.query.trim()
    if (!query) return skipped('查询为空')
    const timeoutMs = Math.max(1, request.timeoutMs ?? cfg.memoryRecallTimeoutMs)
    try {
      const result = await withTimeout(timeoutMs, async () => {
        const embed = await this.deps.embeddings.embed([query])
        const queryVec = embed.vecs[0]
        if (!queryVec) throw new Error('嵌入返回空向量')
        const index = await this.ensureIndex(embed.model, embed.dim)
        if (!index) throw new Error('向量索引不可用（引导失败）')
        return recallMemories(
          { index, store: this.deps.store },
          {
            queryText: query,
            queryVec,
            buckets: this.bucketsOf(request),
            topK: request.topK ?? cfg.memoryRecallTopK,
            minScore: request.minScore ?? cfg.memoryRecallMinScore,
            budgetTokens: request.budgetTokens ?? cfg.memoryRecallBudgetTokens,
            exclude: request.exclude,
          },
        )
      })
      if (result.items.length > 0) this.deps.store.updateHitStats(result.items.map((item) => item.id))
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      getLogger().warn({ err: message }, '语义召回静默跳过')
      return skipped(message)
    }
  }

  /** 重建（模型/维度切换或手动触发）：引导索引 → 清旧模型 BLOB → 全量补账 → 触发消费 */
  async reindex(force = false): Promise<ReindexResult> {
    const spec = this.deps.embeddings.resolve()
    if (!spec) return { ok: false, removed: 0, requeued: 0, error: '嵌入服务未配置（休眠）' }
    let dim = spec.dim
    if (dim <= 0) {
      const probe = await this.deps.embeddings.probe()
      if (!probe.ok || !probe.dim) return { ok: false, removed: 0, requeued: 0, error: probe.error ?? '维度探测失败' }
      dim = probe.dim
    }
    const index = await this.ensureIndex(spec.model, dim, force)
    if (!index) return { ok: false, removed: 0, requeued: 0, error: '向量索引不可用' }
    const removed = this.deps.vectors.deleteStale(spec.model, dim)
    // 人工重建语义：失败条目重置后一并重试
    const reset = this.deps.queue.resetFailed()
    const requeued = this.deps.queue.requeueMissing(spec.model, dim)
    void this.poke()
    getLogger().info({ model: spec.model, dim, removed, reset, requeued }, '记忆向量重建完成（补账已入队）')
    return { ok: true, model: spec.model, dim, removed, requeued }
  }

  /** 运行状态（管理接口 / 设置页只读展示） */
  stats(): MemoryServiceStats {
    const spec = this.deps.embeddings.resolve()
    return {
      configured: spec !== null,
      source: spec?.source ?? null,
      model: spec?.model ?? null,
      dim: spec?.dim ?? 0,
      backend: this.index?.backend ?? null,
      extVersion: this.status?.extVersion ?? null,
      rebuilt: this.status?.rebuilt ?? false,
      vectorTotal: this.deps.vectors.count(),
      vectors: this.deps.vectors.stats(),
      pending: this.deps.queue.pendingCount(),
      failed: this.deps.queue.failedCount(),
      embeddings: this.deps.embeddings.stats,
    }
  }

  /** 召回桶：session + agent + project + global（缺省维度自动跳过） */
  private bucketsOf(request: RecallRequest): string[] {
    const buckets: string[] = []
    if (request.sessionId) buckets.push(bucketOf('session', request.sessionId))
    if (request.agentId) buckets.push(bucketOf('agent', request.agentId))
    if (request.projectId) buckets.push(bucketOf('project', request.projectId))
    buckets.push(bucketOf('global', 'global'))
    return buckets
  }

  /** 索引引导（同 key 复用缓存与在途 promise；force 时先丢镜像强制从 BLOB 重建） */
  private ensureIndex(model: string, dim: number, force = false): Promise<VecIndex | null> {
    if (dim <= 0) return Promise.resolve(null)
    const key = `${model}|${dim}`
    if (force) {
      try {
        this.index?.drop()
      } catch {
        // 镜像丢弃失败不阻断（bootstrap 内部还有一致性重建）
      }
      this.index = null
      this.indexKey = ''
    } else {
      if (this.index && this.indexKey === key) return Promise.resolve(this.index)
      if (this.pending?.key === key) return this.pending.promise
    }
    const promise = this.bootstrapIndex(model, dim, key)
    this.pending = { key, promise }
    void promise.finally(() => {
      if (this.pending?.promise === promise) this.pending = null
    })
    return promise
  }

  private async bootstrapIndex(model: string, dim: number, key: string): Promise<VecIndex | null> {
    try {
      const { index, status } = await bootstrapVectorIndex({ db: this.deps.db, store: this.deps.vectors, model, dim })
      if (!index) return null
      this.index = index
      this.status = status
      this.indexKey = key
      getLogger().info({ backend: index.backend, model, dim, rebuilt: status?.rebuilt ?? false }, '向量索引就绪')
      try {
        const requeued = this.deps.queue.requeueMissing(model, dim)
        if (requeued > 0) getLogger().info({ requeued }, '记忆向量补账：缺向量的记忆已重新入队')
      } catch (err) {
        getLogger().warn({ err: (err as Error).message }, '记忆向量补账失败')
      }
      return index
    } catch (err) {
      getLogger().warn({ err: (err as Error).message }, '向量索引引导失败（召回将跳过）')
      return null
    }
  }
}

function skipped(reason: string): RecallOutcome {
  return { items: [], rendered: '', tokens: 0, candidates: 0, skipped: reason }
}

/** 超时包装（召回 300ms 硬上限；任务无法取消——只读路径，结果被忽略） */
function withTimeout<T>(timeoutMs: number, task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`语义召回超时（${timeoutMs}ms）`)), timeoutMs)
    timer.unref?.()
    task().then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })
}

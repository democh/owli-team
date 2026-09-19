/**
 * 嵌入队列 worker（M25.3a）：批量消费 memory_embed_queue，BLOB → 镜像 → 近重复合并。
 *
 * - 休眠（未配置嵌入）时 flush 首行零 DB 提前返回，定时器常驻（配置连接后无需重启进程）；
 * - 整批失败 → 逐条 markFailed（计数 +1，达上限置 failed）+ 指数退避（上限 60s）；
 * - 近重复合并（ADD-only）：同桶 cos ≥ 阈值 → 新条目替代旧条目（markSuperseded）。
 */
import type { MemoryItem } from '@multi-agent/shared'
import type { EmbedBatchResult, EmbeddingManager } from '../embeddings/manager.js'
import { getLogger } from '../logger.js'
import type { MemoryStore } from '../store/memory.js'
import type { EmbedQueueStore, MemoryVectorStore } from '../store/memory-vectors.js'
import { bucketOf, type VecIndex } from './vectors.js'

export interface EmbedWorkerDeps {
  queue: EmbedQueueStore
  vectors: MemoryVectorStore
  store: MemoryStore
  embeddings: EmbeddingManager
  /** 索引引导（model/dim 变化时由 service 建立并缓存；无法建立返回 null） */
  indexFor: (model: string, dim: number) => Promise<VecIndex | null>
  /** 定时器间隔（默认 2000ms；unref 不阻塞进程退出） */
  intervalMs?: number
  /** batchSize 兜底（优先取当前嵌入规格） */
  batchSize?: number
  /** 近重复合并阈值（默认 0.92） */
  nearDuplicateThreshold?: number
}

const DEFAULT_INTERVAL_MS = 2000
const DEFAULT_BATCH_SIZE = 8
const DEFAULT_NEAR_DUPLICATE = 0.92
const MAX_ROUNDS_PER_FLUSH = 8
const MAX_BACKOFF_MS = 60_000

export class EmbedWorker {
  private timer: ReturnType<typeof setInterval> | null = null
  private flushing = false
  private failures = 0
  private nextAttemptAt = 0

  constructor(private readonly deps: EmbedWorkerDeps) {}

  get running(): boolean {
    return this.timer !== null
  }

  /** 启动常驻定时器（幂等） */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.flush()
    }, this.deps.intervalMs ?? DEFAULT_INTERVAL_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  /**
   * 消费一轮队列（重入保护 + 退避窗口）。返回成功落库条数；任何异常都不抛出
   * （定时器调用方无 catch；失败经 markFailed 留痕）。
   */
  async flush(): Promise<number> {
    if (this.flushing) return 0
    if (Date.now() < this.nextAttemptAt) return 0
    const spec = this.deps.embeddings.resolve()
    if (!spec) return 0
    const batchSize = spec.batchSize > 0 ? spec.batchSize : (this.deps.batchSize ?? DEFAULT_BATCH_SIZE)
    try {
      // 状态流转（archived / superseded）后的残留队列行无需嵌入
      const dropped = this.deps.queue.dropInactive()
      if (dropped > 0) getLogger().info({ dropped }, '嵌入队列：清理非 active 记忆残留条目')
    } catch (err) {
      getLogger().warn({ err: (err as Error).message }, '嵌入队列清理失败')
    }

    this.flushing = true
    let processed = 0
    try {
      for (let round = 0; round < MAX_ROUNDS_PER_FLUSH; round++) {
        const items = this.deps.queue.claim(batchSize)
        if (items.length === 0) break
        let result: EmbedBatchResult
        try {
          result = await this.deps.embeddings.embed(items.map((item) => item.content))
          this.failures = 0
        } catch (err) {
          const message = (err as Error).message
          for (const item of items) this.deps.queue.markFailed(item.memoryId, message)
          this.failures++
          this.nextAttemptAt =
            Date.now() + Math.min(MAX_BACKOFF_MS, (this.deps.intervalMs ?? DEFAULT_INTERVAL_MS) * 2 ** this.failures)
          getLogger().warn({ err: message, count: items.length, attempt: this.failures }, '嵌入失败：整批退避重试')
          break
        }
        const index = await this.deps.indexFor(result.model, result.dim)
        if (!index) {
          for (const item of items) this.deps.queue.markFailed(item.memoryId, '向量索引不可用')
          break
        }
        for (let i = 0; i < items.length; i++) {
          const item = items[i]!
          const vec = result.vecs[i]
          if (!vec) {
            this.deps.queue.markFailed(item.memoryId, '嵌入结果缺失')
            continue
          }
          if (this.storeOne(item.memoryId, vec, result.model, result.dim, index)) processed++
        }
      }
    } catch (err) {
      // 兜底（如 DB 写异常）：留待下一轮定时器重试
      getLogger().warn({ err: (err as Error).message }, '嵌入 worker flush 异常')
    } finally {
      this.flushing = false
    }
    return processed
  }

  /** 单条落库（异常单条隔离）：BLOB → 镜像 → markDone → 近重复合并 */
  private storeOne(memoryId: string, vec: Float32Array, model: string, dim: number, index: VecIndex): boolean {
    try {
      this.deps.vectors.put(memoryId, model, dim, vec)
      const mem = this.deps.store.get(memoryId)
      if (!mem || mem.status !== 'active') {
        // 已被删除 / 状态变更：清理镜像行即可
        index.remove(memoryId)
        this.deps.queue.markDone(memoryId)
        return false
      }
      index.put(memoryId, bucketOf(mem.scope, mem.ownerId), vec)
      this.deps.queue.markDone(memoryId)
      this.mergeNearDuplicate(mem, vec, index)
      return true
    } catch (err) {
      this.deps.queue.markFailed(memoryId, (err as Error).message)
      return false
    }
  }

  /** 近重复合并：同桶 cos ≥ 阈值且非自身 → 旧条目 superseded（新替旧） */
  private mergeNearDuplicate(mem: MemoryItem, vec: Float32Array, index: VecIndex): void {
    const threshold = this.deps.nearDuplicateThreshold ?? DEFAULT_NEAR_DUPLICATE
    const hit = index
      .query(bucketOf(mem.scope, mem.ownerId), vec, 3)
      .find((h) => h.memoryId !== mem.id && h.sim >= threshold)
    if (!hit) return
    const dup = this.deps.store.get(hit.memoryId)
    if (!dup || dup.status !== 'active') return
    this.deps.store.markSuperseded(hit.memoryId, mem.id)
  }
}

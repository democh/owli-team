/**
 * 嵌入管理（M25.2a）：解析（mock > 连接中心 > env > 休眠）+ 批量 + 双层缓存 + 热切换失效。
 *
 * - 凭据：连接中心 SecretVault 在服务端解密进内存使用（对外永不回传明文）；
 * - 缓存：embedding_cache（SQLite，跨重启）+ 内存 LRU（同进程重复文本）；
 * - 解析每次调用即时进行：settings.embeddingConnectionId / 连接内容变更下一回合即生效；
 * - invalidate(connectionId)：连接 CRUD 后由路由调用（provider 实例指纹重建）；
 * - probe()：连接测试 + 维度自动探测（EMBEDDING_DIM=0 时由首次调用/探测确定）。
 */
import { createHash } from 'node:crypto'
import type { AppConfig } from '../config.js'
import type { EmbeddingCacheStore } from '../store/memory-vectors.js'
import {
  MOCK_EMBED_DIM,
  MOCK_EMBED_MODEL,
  MockEmbeddingProvider,
  OpenAICompatEmbeddingProvider,
  type EmbeddingProvider,
} from './provider.js'

/** 休眠态调用（未配置嵌入）：调用方捕获后静默跳过（零网络零影响） */
export class EmbeddingDisabledError extends Error {
  constructor() {
    super('嵌入服务未配置（连接中心未选择 embedding 连接且 EMBEDDING_* 未设置）')
    this.name = 'EmbeddingDisabledError'
  }
}

/** 连接中心最小接口（结构兼容 ConnectionStore，避免 import 循环） */
export interface EmbeddingConnectionSource {
  get(id: string): { id: string; kind: string; enabled: boolean; config: Record<string, unknown> } | undefined
  getSecret(id: string): Record<string, unknown> | undefined
}

export interface EmbeddingSpec {
  source: 'mock' | 'connection' | 'env'
  connectionId?: string
  model: string
  /** 0 = 未显式配置（首次调用确定实际维度） */
  dim: number
  baseUrl?: string
  apiKey: string
  batchSize: number
  timeoutMs: number
}

export interface EmbedBatchResult {
  vecs: Float32Array[]
  model: string
  /** 实际维度（dim=0 配置时为端点返回的维度） */
  dim: number
  cacheHits: number
}

export interface EmbedProbeResult {
  ok: boolean
  source?: EmbeddingSpec['source']
  model?: string
  dim?: number
  latencyMs: number
  error?: string
}

export interface EmbeddingManagerStats {
  configured: boolean
  /** 真实调用批次数（不含缓存命中） */
  calls: number
  texts: number
  cacheHits: number
  errors: number
}

export interface EmbeddingManagerDeps {
  cfg: AppConfig
  /** 连接中心（装配后注入；测试可省略） */
  connections?: EmbeddingConnectionSource
  cache: EmbeddingCacheStore
}

const LRU_MAX = 500

export class EmbeddingManager {
  private cached: { key: string; provider: EmbeddingProvider } | null = null
  private readonly lru = new Map<string, Float32Array>()
  private readonly counters = { calls: 0, texts: 0, cacheHits: 0, errors: 0 }

  constructor(private readonly deps: EmbeddingManagerDeps) {}

  /** 解析当前嵌入配置（每次调用——settings 白名单与连接变更热切换即时生效） */
  resolve(): EmbeddingSpec | null {
    const cfg = this.deps.cfg
    // 1) LLM_MOCK=true：确定性 Mock（零网络，E2E/evals 断言基线）
    if (cfg.llmMock) {
      return {
        source: 'mock',
        model: MOCK_EMBED_MODEL,
        dim: cfg.embeddingDim > 0 ? cfg.embeddingDim : MOCK_EMBED_DIM,
        apiKey: '',
        batchSize: cfg.embeddingBatchSize,
        timeoutMs: cfg.embeddingTimeoutMs,
      }
    }
    // 2) 连接中心（settings.embeddingConnectionId）
    if (cfg.embeddingConnectionId && this.deps.connections) {
      const conn = this.deps.connections.get(cfg.embeddingConnectionId)
      const spec = conn ? this.connectionSpec(conn) : null
      if (spec) return spec
    }
    // 3) env 后备
    if (cfg.embeddingModel) {
      return {
        source: 'env',
        model: cfg.embeddingModel,
        dim: cfg.embeddingDim,
        baseUrl: cfg.embeddingBaseUrl || undefined,
        apiKey: cfg.embeddingApiKey,
        batchSize: Math.max(1, cfg.embeddingBatchSize),
        timeoutMs: cfg.embeddingTimeoutMs,
      }
    }
    // 4) 休眠
    return null
  }

  /** 当前是否可用（休眠 = false → 零网络） */
  get configured(): boolean {
    return this.resolve() !== null
  }

  get stats(): EmbeddingManagerStats {
    return { configured: this.configured, ...this.counters }
  }

  /**
   * 批量嵌入（含双层缓存；未配置抛 EmbeddingDisabledError）。
   * 返回顺序与输入一致；缓存命中的向量是内部对象引用（调用方只读）。
   */
  async embed(texts: string[]): Promise<EmbedBatchResult> {
    const spec = this.resolve()
    if (!spec) throw new EmbeddingDisabledError()
    if (texts.length === 0) return { vecs: [], model: spec.model, dim: spec.dim, cacheHits: 0 }

    const out: Float32Array[] = new Array(texts.length)
    const missIdx: number[] = []
    let cacheHits = 0
    for (let i = 0; i < texts.length; i++) {
      const hash = textHash(texts[i] ?? '')
      const memKey = `${spec.model}:${hash}`
      const fromLru = this.lruGet(memKey)
      if (fromLru) {
        out[i] = fromLru
        cacheHits++
        continue
      }
      const cached = this.deps.cache.get(hash, spec.model)
      if (cached && (spec.dim <= 0 || cached.dim === spec.dim)) {
        out[i] = cached.vec
        this.lruSet(memKey, cached.vec)
        cacheHits++
        continue
      }
      missIdx.push(i)
    }

    if (missIdx.length > 0) {
      const provider = this.providerFor(spec)
      this.counters.calls++
      this.counters.texts += missIdx.length
      try {
        for (let start = 0; start < missIdx.length; start += spec.batchSize) {
          const batch = missIdx.slice(start, start + spec.batchSize)
          const vecs = await provider.embed(
            batch.map((i) => texts[i] ?? ''),
            { timeoutMs: spec.timeoutMs },
          )
          if (vecs.length !== batch.length) {
            throw new Error(`嵌入返回数量不符：期望 ${batch.length} 条，实际 ${vecs.length} 条`)
          }
          for (let j = 0; j < batch.length; j++) {
            const idx = batch[j]!
            const vec = vecs[j]!
            if (spec.dim > 0 && vec.length !== spec.dim) {
              throw new Error(`嵌入维度不符：期望 ${spec.dim}，实际 ${vec.length}（检查 EMBEDDING_DIM / 模型配置）`)
            }
            out[idx] = vec
            const hash = textHash(texts[idx] ?? '')
            this.deps.cache.put(hash, spec.model, vec.length, vec)
            this.lruSet(`${spec.model}:${hash}`, vec)
          }
        }
      } catch (err) {
        this.counters.errors++
        throw err
      }
    }

    const dim = out[0]?.length ?? spec.dim
    return { vecs: out, model: spec.model, dim, cacheHits }
  }

  /**
   * 连通性探测：一次真实调用（不经缓存）。供维度自动探测
   * （bootstrap 索引前若 dim 未知，用探测结果）。
   */
  async probe(): Promise<EmbedProbeResult> {
    const spec = this.resolve()
    if (!spec) return { ok: false, latencyMs: 0, error: '未配置嵌入服务（连接中心未选择 embedding 连接且 EMBEDDING_* 未设置）' }
    return this.probeSpec(spec)
  }

  /**
   * 按连接 id 探测（连接中心「测试」按钮；不依赖 settings 是否选中该连接）。
   * 成功返回端点实际维度（表单 dim 留空时的回填值）。
   */
  async probeConnection(connectionId: string): Promise<EmbedProbeResult> {
    const conn = this.deps.connections?.get(connectionId)
    if (!conn) return { ok: false, latencyMs: 0, error: '连接不存在' }
    if (conn.kind !== 'embedding') return { ok: false, latencyMs: 0, error: `连接类型不是 embedding（${conn.kind}）` }
    if (!conn.enabled) return { ok: false, latencyMs: 0, error: '连接已禁用' }
    // LLM_MOCK：与 resolve 顺序一致走确定性 Mock（演示 / e2e 零网络）
    if (this.deps.cfg.llmMock) {
      const mock = this.resolve()
      if (mock) return this.probeSpec(mock)
    }
    const spec = this.connectionSpec(conn)
    if (!spec) return { ok: false, latencyMs: 0, error: '缺少模型配置（config.model 为空且 EMBEDDING_MODEL 未设置）' }
    return this.probeSpec(spec)
  }

  private async probeSpec(spec: EmbeddingSpec): Promise<EmbedProbeResult> {
    const t0 = Date.now()
    try {
      const provider = this.providerFor(spec)
      const vecs = await provider.embed(['嵌入连接连通性测试'], { timeoutMs: spec.timeoutMs })
      const dim = vecs[0]?.length ?? 0
      if (!dim) {
        return { ok: false, source: spec.source, model: spec.model, latencyMs: Date.now() - t0, error: '端点返回空向量' }
      }
      return { ok: true, source: spec.source, model: spec.model, dim, latencyMs: Date.now() - t0 }
    } catch (err) {
      return { ok: false, source: spec.source, model: spec.model, latencyMs: Date.now() - t0, error: (err as Error).message }
    }
  }

  /** 连接 → 嵌入规格（kind='embedding' 且启用且模型可解析；否则 null） */
  private connectionSpec(conn: {
    id: string
    kind: string
    enabled: boolean
    config: Record<string, unknown>
  }): EmbeddingSpec | null {
    if (conn.kind !== 'embedding' || !conn.enabled) return null
    const cfg = this.deps.cfg
    const config = conn.config
    const model = str(config.model) || cfg.embeddingModel
    if (!model) return null
    const dim = num(config.dim)
    const batchSize = num(config.batchSize)
    return {
      source: 'connection',
      connectionId: conn.id,
      model,
      // dim 留空 / 0 = 自动探测（回退 env 显式维度，仍为 0 则首次调用确定）
      dim: dim !== undefined && dim > 0 ? dim : cfg.embeddingDim,
      baseUrl: str(config.baseUrl) || cfg.embeddingBaseUrl || undefined,
      apiKey: str(this.deps.connections?.getSecret(conn.id)?.apiKey) || cfg.embeddingApiKey,
      batchSize: batchSize !== undefined && batchSize > 0 ? batchSize : cfg.embeddingBatchSize,
      timeoutMs: num(config.timeoutMs) ?? cfg.embeddingTimeoutMs,
    }
  }

  /** 连接/设置变更后调用：清 provider 实例（指纹含密钥哈希与模型，变更即重建） */
  invalidate(connectionId?: string): void {
    if (connectionId && this.cached) {
      const parts = this.cached.key.split('|')
      if (parts[1] !== connectionId) return
    }
    this.cached = null
  }

  private providerFor(spec: EmbeddingSpec): EmbeddingProvider {
    const key = [
      spec.source,
      spec.connectionId ?? '',
      spec.model,
      spec.baseUrl ?? '',
      spec.apiKey ? createHash('sha1').update(spec.apiKey).digest('hex').slice(0, 12) : '',
      spec.dim,
      spec.timeoutMs,
    ].join('|')
    if (this.cached?.key === key) return this.cached.provider
    const provider: EmbeddingProvider =
      spec.source === 'mock'
        ? new MockEmbeddingProvider(spec.dim > 0 ? spec.dim : MOCK_EMBED_DIM)
        : new OpenAICompatEmbeddingProvider({
            apiKey: spec.apiKey,
            baseUrl: spec.baseUrl,
            model: spec.model,
            timeoutMs: spec.timeoutMs,
          })
    this.cached = { key, provider }
    return provider
  }

  private lruGet(key: string): Float32Array | undefined {
    const value = this.lru.get(key)
    if (!value) return undefined
    this.lru.delete(key)
    this.lru.set(key, value)
    return value
  }

  private lruSet(key: string, value: Float32Array): void {
    if (this.lru.has(key)) this.lru.delete(key)
    this.lru.set(key, value)
    while (this.lru.size > LRU_MAX) {
      const oldest = this.lru.keys().next().value
      if (oldest === undefined) break
      this.lru.delete(oldest)
    }
  }
}

/** 嵌入缓存键：内容 sha1（与记忆 hashOf 的 kind 前缀无关，跨 kind 可复用同一文本向量） */
export function textHash(text: string): string {
  return createHash('sha1').update(text).digest('hex')
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

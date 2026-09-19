/**
 * 嵌入 Provider（M25.2a）：OpenAI 兼容 /embeddings + 确定性 Mock。
 *
 * - OpenAICompatEmbeddingProvider：官方 SDK（自定义 baseURL；OpenAI/Ollama/vLLM 等兼容端点），
 *   批量输入 → 顺序对齐的 float32 向量；错误分类复用 LLM 韧性层（429/5xx/网络可重试），
 *   SDK 内置重试关闭，由本类自管分类退避（避免双重叠加）；
 * - MockEmbeddingProvider：token 哈希投影（FNV-1a → 维度桶 ±1 + L2 归一），零网络、完全确定性
 *   （LLM_MOCK=true 的 E2E/evals 断言基础；相似文本共享 token → 高余弦）。
 */
import OpenAI from 'openai'
import { classifyLlmError } from '../llm/resilience.js'

export interface EmbedRequestOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

/** 嵌入 Provider：批量输入 → 与输入顺序一致的向量数组（出错上抛） */
export interface EmbeddingProvider {
  embed(texts: string[], opts?: EmbedRequestOptions): Promise<Float32Array[]>
}

export interface OpenAICompatEmbeddingOptions {
  apiKey: string
  baseUrl?: string
  model: string
  timeoutMs?: number
  /** 总尝试次数（含首次），默认 3 */
  maxAttempts?: number
}

export class OpenAICompatEmbeddingProvider implements EmbeddingProvider {
  private readonly client: OpenAI

  constructor(private readonly opts: OpenAICompatEmbeddingOptions) {
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseUrl || undefined, maxRetries: 0 })
  }

  async embed(texts: string[], requestOpts: EmbedRequestOptions = {}): Promise<Float32Array[]> {
    if (texts.length === 0) return []
    const attempts = Math.max(1, this.opts.maxAttempts ?? 3)
    const timeout = requestOpts.timeoutMs ?? this.opts.timeoutMs ?? 15_000
    let lastError: unknown
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const res = await this.client.embeddings.create(
          { model: this.opts.model, input: texts },
          { signal: requestOpts.signal, timeout },
        )
        const rows = [...res.data].sort((a, b) => a.index - b.index)
        return rows.map((row) => Float32Array.from(row.embedding))
      } catch (err) {
        lastError = err
        const classified = classifyLlmError(err)
        if (classified.kind !== 'retryable' || attempt >= attempts) throw err
        const delay = classified.retryAfterMs ?? Math.min(500 * 2 ** (attempt - 1), 4_000)
        await sleep(delay)
      }
    }
    throw lastError ?? new Error('嵌入请求失败')
  }
}

/** Mock 默认维度（E2E/evals 断言基线；配置 EMBEDDING_DIM 可覆盖） */
export const MOCK_EMBED_DIM = 256
export const MOCK_EMBED_MODEL = 'mock-embed'

export class MockEmbeddingProvider implements EmbeddingProvider {
  constructor(private readonly dim = MOCK_EMBED_DIM) {}

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => this.project(text))
  }

  /** 词哈希投影：token → 维度桶 ±1 → L2 归一（确定性；共享 token 越多余弦越高） */
  project(text: string): Float32Array {
    const vec = new Float32Array(this.dim)
    const tokens = mockTokens(text)
    if (tokens.length === 0) {
      vec[fnv1a('') % this.dim] = 1
      return vec
    }
    for (const token of tokens) {
      const h = fnv1a(token)
      vec[h % this.dim] += (h & 0x10000) === 0 ? 1 : -1
    }
    let sum = 0
    for (let i = 0; i < vec.length; i++) sum += vec[i]! * vec[i]!
    const norm = Math.sqrt(sum)
    if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i]! /= norm
    return vec
  }
}

/** 轻量分词：英文/数字词（小写）+ CJK 单字与双字组（确定性；质量诉求由真实模型承担） */
function mockTokens(text: string): string[] {
  const lower = text.toLowerCase()
  const tokens: string[] = []
  for (const m of lower.matchAll(/[a-z0-9][a-z0-9_.-]*/g)) tokens.push(m[0])
  for (const run of lower.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (const ch of run) tokens.push(ch)
    for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2))
  }
  return tokens
}

/** FNV-1a 32 位（确定性哈希，与 crypto 无关） */
function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 多 Provider 路由（模型服务）：按「服务名/模型名」或裸模型名把请求路由到对应 llm 连接。
 *
 * 解析顺序（index.ts 装配为最外层）：
 *   1) 清单精确匹配（raw 全串；模型名本身含 `/` 时由此直接引用；同名以创建序先者为准）；
 *   2) 前缀形式 `服务名/模型名`（服务名 = 连接名称，精确优先、大小写不敏感兜底）
 *      → 以该连接的 baseUrl / apiKey 调用，并把模型改写为去前缀的裸名（端点只认裸名）；
 *   3) 未命中 → 透传下层（BYOK → 系统默认，绝不阻断主链路；未指定 model 亦透传）。
 *
 * 语义：
 * - 连接名全局唯一 → 前缀形式无歧义（推荐）；连接名不得含 `/`（路由层校验）；
 * - `LLM_MOCK=true`（测试 / E2E）恒直通底层，保证确定性；
 * - 每连接独立 provider 实例（独立限流闸门与韧性层），按连接 updatedAt 缓存失效。
 */
import type { ConnectionDefinition } from '@multi-agent/shared'
import type { AppConfig } from '../config.js'
import type { ConnectionStore } from '../store/connections.js'
import type { ChatRequest, LlmChunk, LlmProvider } from './provider.js'

/** llm 连接的规范化配置（openai 协议；baseUrl 缺失视为无效） */
export interface LlmProviderConfig {
  baseUrl: string
  /** 模型清单（裸模型名的匹配来源；前缀形式引用不依赖清单） */
  models: string[]
}

/** 解析 llm 连接配置（宽容归一；供路由与连接测试共用） */
export function normalizeLlmConfig(config: Record<string, unknown>): LlmProviderConfig | undefined {
  const baseUrl = typeof config.baseUrl === 'string' ? config.baseUrl.trim() : ''
  if (!baseUrl) return undefined
  const models = Array.isArray(config.models)
    ? config.models.filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
    : []
  return { baseUrl, models }
}

/** 连接凭据中的 apiKey（缺省空串，兼容本地免 Key 端点） */
export function apiKeyOf(secret: Record<string, unknown> | undefined): string {
  return typeof secret?.apiKey === 'string' ? secret.apiKey : ''
}

/** 路由命中结果：upstreamModel = 实际发给端点的模型名（前缀形式已去前缀） */
export interface ModelRouteHit {
  connection: ConnectionDefinition
  config: LlmProviderConfig
  upstreamModel: string
}

export interface LlmProviderRouterDeps {
  base: LlmProvider
  cfg: AppConfig
  connections: ConnectionStore
  /** 按连接凭据构建 provider（生产 = createProvider 覆盖 baseUrl/apiKey；测试可注入替身） */
  createFor: (config: { baseUrl: string; apiKey: string }, connectionId: string) => LlmProvider
}

interface CacheEntry {
  updatedAt: string
  provider: LlmProvider
}

export class LlmProviderRouter implements LlmProvider {
  private readonly cache = new Map<string, CacheEntry>()

  constructor(private readonly deps: LlmProviderRouterDeps) {}

  /**
   * 按模型名解析模型服务（启用中的 llm 连接）：
   * ① 清单精确匹配（raw 全串；创建序先者）→ ② `服务名/模型名` 前缀（精确优先、大小写不敏感兜底）；
   * 未命中 / 未指定 → undefined（透传系统默认）。
   */
  resolveForModel(model: string | undefined): ModelRouteHit | undefined {
    const raw = model?.trim()
    if (!raw) return undefined
    const conns = this.deps.connections.list().filter((c) => c.kind === 'llm' && c.enabled)
    // ① 清单精确匹配：清单是显式声明的具体模型；含 `/` 的模型名（如 qwen/qwen2.5）由此直接引用
    for (const conn of conns) {
      const config = normalizeLlmConfig(conn.config)
      if (config && config.models.includes(raw)) return { connection: conn, config, upstreamModel: raw }
    }
    // ② 前缀形式：服务名/模型名（连接名全局唯一 → 无歧义）
    const slash = raw.indexOf('/')
    if (slash > 0) {
      const prefix = raw.slice(0, slash).trim()
      const rest = raw.slice(slash + 1).trim()
      if (prefix && rest) {
        const hit =
          conns.find((c) => c.name === prefix) ?? conns.find((c) => c.name.toLowerCase() === prefix.toLowerCase())
        if (hit) {
          const config = normalizeLlmConfig(hit.config)
          if (config) return { connection: hit, config, upstreamModel: rest }
        }
      }
    }
    return undefined
  }

  async *chatStream(req: ChatRequest, signal: AbortSignal): AsyncIterable<LlmChunk> {
    // Mock 纯确定性：不消费模型服务（连接凭据仅生产路径生效）
    if (this.deps.cfg.llmMock || !req.model) {
      yield* this.deps.base.chatStream(req, signal)
      return
    }
    const hit = this.resolveForModel(req.model)
    if (!hit) {
      yield* this.deps.base.chatStream(req, signal)
      return
    }
    const conn = hit.connection
    let entry = this.cache.get(conn.id)
    if (!entry || entry.updatedAt !== conn.updatedAt) {
      const apiKey = apiKeyOf(this.deps.connections.getSecret(conn.id))
      entry = {
        updatedAt: conn.updatedAt,
        provider: this.deps.createFor({ baseUrl: hit.config.baseUrl, apiKey }, conn.id),
      }
      this.cache.set(conn.id, entry)
    }
    // 前缀形式：去掉服务名前缀再调用（端点只认裸模型名）
    yield* entry.provider.chatStream({ ...req, model: hit.upstreamModel }, signal)
  }
}

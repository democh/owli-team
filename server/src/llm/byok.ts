/**
 * M57 P3：BYOK Provider 包装 —— 按「会话属主」解析用户 LLM 凭据，无凭据直通系统 Provider。
 *
 * 语义：
 * - 请求携带 `sessionId` 时：会话属主配置了 BYOK → 用其凭据（每次凭据变更 `invalidate` 重建）；否则系统默认；
 * - `LLM_MOCK=true`（测试 / E2E）→ 恒直通底层 Mock（BYOK 不参与，保证确定性）；
 * - 计费归因：`modelFor(sessionId)` 供引擎 / 压缩器把「实际生效模型」写入 usage（BYOK 模型按各自单价计）；
 * - 每用户独立 provider 实例 = 独立限流闸门与韧性层（互不挤占系统并发池）。
 */
import type { AppConfig } from '../config.js'
import type { LlmCredentialStore, LlmCredentials } from '../store/llm-credentials.js'
import type { SessionStore } from '../store/sessions.js'
import type { ChatRequest, LlmChunk, LlmProvider } from './provider.js'

export interface ByokProviderDeps {
  base: LlmProvider
  cfg: AppConfig
  sessions: SessionStore
  credentials: LlmCredentialStore
  /** 按用户凭据构建 provider（生产 = createProvider({ ...cfg, llmApiKey/llmBaseUrl/llmModel 覆盖 }）；测试可注入替身） */
  createFor: (creds: LlmCredentials, userId: string) => LlmProvider
}

export class ByokProvider implements LlmProvider {
  private readonly cache = new Map<string, LlmProvider>()

  constructor(private readonly deps: ByokProviderDeps) {}

  /** 生效模型（用量 / 成本归因用；无凭据 / 无 model = undefined 回退系统语义） */
  modelFor(sessionId: string | undefined): string | undefined {
    if (!sessionId) return undefined
    const ownerId = this.deps.sessions.getSession(sessionId)?.ownerId
    return ownerId ? this.deps.credentials.get(ownerId)?.model : undefined
  }

  /** 凭据变更（PUT / DELETE / 账号删除）→ 失效缓存，下次调用按新凭据重建 */
  invalidate(userId: string): void {
    this.cache.delete(userId)
  }

  private resolveSessionUserId(req: ChatRequest): string | undefined {
    return req.sessionId ? this.deps.sessions.getSession(req.sessionId)?.ownerId : undefined
  }

  async *chatStream(req: ChatRequest, signal: AbortSignal): AsyncIterable<LlmChunk> {
    // Mock 纯确定性：不消费 BYOK（凭据仅生产路径生效）
    if (this.deps.cfg.llmMock) {
      yield* this.deps.base.chatStream(req, signal)
      return
    }
    const ownerId = this.resolveSessionUserId(req)
    const creds = ownerId ? this.deps.credentials.get(ownerId) : undefined
    if (!ownerId || !creds) {
      yield* this.deps.base.chatStream(req, signal)
      return
    }
    let inner = this.cache.get(ownerId)
    if (!inner) {
      inner = this.deps.createFor(creds, ownerId)
      this.cache.set(ownerId, inner)
    }
    yield* inner.chatStream(req, signal)
  }
}

/**
 * Provider 工厂（§7.4）：真实模型（OpenAI 兼容）为默认运行路径。
 * M4：套一层全局并发信号量（LLM_MAX_CONCURRENCY），引擎与压缩器共享同一限流闸门。
 * M10：LLM_MOCK=true 时显式切换为脚本化 MockProvider（E2E/离线演示；生产默认关闭）。
 */
import type { AppConfig } from '../config.js'
import type { ChatRequest, LlmChunk, LlmProvider } from './provider.js'
import { LlmSemaphore } from './resilience.js'
import { OpenAIProvider } from './openai.js'

/** 限流包装：每次 chatStream 持有同一许可直到流结束 */
class GatedProvider implements LlmProvider {
  constructor(
    private readonly inner: LlmProvider,
    private readonly gate: LlmSemaphore,
  ) {}

  async *chatStream(req: ChatRequest, signal: AbortSignal): AsyncIterable<LlmChunk> {
    const release = await this.gate.acquire(signal)
    try {
      yield* this.inner.chatStream(req, signal)
    } finally {
      release()
    }
  }
}

/**
 * Mock 按需加载：mock.ts 约 5k 行脚本化台本，仅 LLM_MOCK=true 时需要。
 * 改为动态 import 后生产构建把它拆成独立 chunk（dist 主包不再携带），首个 mock 请求时才加载。
 */
class LazyMockProvider implements LlmProvider {
  private inner?: Promise<LlmProvider>

  constructor(private readonly delayMs: number) {}

  async *chatStream(req: ChatRequest, signal: AbortSignal): AsyncIterable<LlmChunk> {
    this.inner ??= import('./mock.js').then(
      ({ MockProvider }) => new MockProvider({ delayMs: this.delayMs }) as LlmProvider,
    )
    yield* (await this.inner).chatStream(req, signal)
  }
}

export function createProvider(cfg: AppConfig): LlmProvider {
  const gate = new LlmSemaphore(cfg.llmMaxConcurrency)
  if (cfg.llmMock) {
    // 显式开关（非自动降级）：脚本化输出，零网络，用于 E2E 与离线演示
    return new GatedProvider(new LazyMockProvider(cfg.llmMockDelayMs), gate)
  }
  return new GatedProvider(new OpenAIProvider(cfg), gate)
}

/**
 * Provider 工厂（§7.4）：真实模型（OpenAI 兼容）为默认运行路径。
 * M4：套一层全局并发信号量（LLM_MAX_CONCURRENCY），引擎与压缩器共享同一限流闸门。
 * M10：LLM_MOCK=true 时显式切换为脚本化 MockProvider（E2E/离线演示；生产默认关闭）。
 */
import type { AppConfig } from '../config.js'
import type { ChatRequest, LlmChunk, LlmProvider } from './provider.js'
import { LlmSemaphore } from './resilience.js'
import { MockProvider } from './mock.js'
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

export function createProvider(cfg: AppConfig): LlmProvider {
  const gate = new LlmSemaphore(cfg.llmMaxConcurrency)
  if (cfg.llmMock) {
    // 显式开关（非自动降级）：脚本化输出，零网络，用于 E2E 与离线演示
    return new GatedProvider(new MockProvider({ delayMs: cfg.llmMockDelayMs }), gate)
  }
  return new GatedProvider(new OpenAIProvider(cfg), gate)
}

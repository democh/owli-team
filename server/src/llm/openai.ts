/**
 * openai-compatible 实现（§7.2）：官方 SDK + 自定义 baseURL，逐段产出增量文本，
 * 流式聚合 tool_calls 增量后一次性 yield（§21.2）。
 * 思考模式（DeepSeek V4，§7.5）：thinking 开关 + reasoning_effort 透传；
 * 思维链经 delta.reasoning_content 产出 reasoning chunk，带 tool_calls 的 assistant
 * 消息回传 reasoning_content（API 硬性要求，见回传策略注释）。
 */
import OpenAI from 'openai'
import type { AppConfig } from '../config.js'
import { LlmStreamInterruptedError, type ChatRequest, type LlmChunk, type LlmProvider, type LlmToolCall } from './provider.js'

/** DeepSeek V4 思考模式扩展字段（openai SDK 类型未覆盖，整体透传进请求体） */
interface ThinkingParams {
  thinking?: { type: 'enabled' | 'disabled' }
  reasoning_effort?: 'low' | 'high' | 'max'
}

export class OpenAIProvider implements LlmProvider {
  private client: OpenAI

  constructor(private readonly cfg: AppConfig) {
    this.client = new OpenAI({ apiKey: cfg.llmApiKey, baseURL: cfg.llmBaseUrl })
  }

  async *chatStream(req: ChatRequest, signal: AbortSignal): AsyncIterable<LlmChunk> {
    const thinking = req.thinking ?? this.cfg.llmThinking
    const messages = [
      { role: 'system' as const, content: req.system },
      ...req.messages.map((m) => {
        if (m.role === 'tool') {
          return { role: 'tool' as const, tool_call_id: m.toolCallId ?? '', content: m.content }
        }
        if (m.role === 'assistant') {
          return {
            role: 'assistant' as const,
            content: m.content || null,
            // 回传策略：仅对本轮工具循环内的 assistant 消息回传思考内容（API 校验硬性要求）；
            // 历史窗口消息不带 tool_calls，无需回传（实测 200），避免上下文无谓膨胀
            ...(m.reasoning ? { reasoning_content: m.reasoning } : {}),
            ...(m.toolCalls?.length
              ? {
                  tool_calls: m.toolCalls.map((c) => ({
                    id: c.id,
                    type: 'function' as const,
                    function: { name: c.name, arguments: c.arguments },
                  })),
                }
              : {}),
          }
        }
        // M33：多模态透传——content 为纯文本或内容块数组（text + image_url data URL）
        return { role: 'user' as const, content: m.content }
      }),
    ]

    // V4 思考默认开启：显式下发开关；思考模式下 temperature 不生效，故仅关闭时携带
    const thinkingParams: ThinkingParams = thinking
      ? { thinking: { type: 'enabled' }, reasoning_effort: this.cfg.llmReasoningEffort }
      : { thinking: { type: 'disabled' } }
    // 结构化输出（M2）：按 LLM_JSON_MODE 选择请求形态，off 时仅依赖提示词约束
    const responseFormatParams =
      req.responseFormat && this.cfg.llmJsonMode === 'json_schema'
        ? {
            response_format: {
              type: 'json_schema' as const,
              json_schema: { name: req.responseFormat.name, schema: req.responseFormat.schema },
            },
          }
        : req.responseFormat && this.cfg.llmJsonMode === 'json_object'
          ? { response_format: { type: 'json_object' as const } }
          : {}
    const params = {
      model: req.model || this.cfg.llmModel,
      stream: true,
      // M4：流末回传 usage（OpenAI 兼容协议：choices 为空的最后一个 chunk）
      stream_options: { include_usage: true },
      messages,
      // 输出截断治理：显式下发单次输出上限（0 = 交给服务商默认）；思考模式下 reasoning 与正文共享该上限
      ...(this.cfg.llmMaxOutputTokens > 0 ? { max_tokens: this.cfg.llmMaxOutputTokens } : {}),
      ...(thinking ? {} : { temperature: req.temperature }),
      ...thinkingParams,
      ...responseFormatParams,
      ...(req.tools?.length
        ? {
            tools: req.tools.map((t) => ({
              type: 'function' as const,
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
            tool_choice: 'auto' as const,
          }
        : {}),
    }

    const stream = await this.client.chat.completions.create(
      params as unknown as OpenAI.Chat.ChatCompletionCreateParamsStreaming,
      { signal },
    )

    // 聚合 tool_calls 增量（index -> 分片累积）
    const buffers = new Map<number, { id: string; name: string; args: string }>()
    let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined
    /** finish_reason=length：达到单次输出上限被截断（流末通知引擎；不污染正文） */
    let truncated = false
    /** 协议收尾标记（finish_reason / usage）：正常流必达；全程缺失 = 流被静默截断 */
    let sawClosure = false
    for await (const chunk of stream) {
      // M4：usage chunk 的 choices 为空数组，单独收集（协议规定在流末）
      if (chunk.usage) {
        usage = chunk.usage
        sawClosure = true
      }
      const finishReason = chunk.choices[0]?.finish_reason
      if (finishReason) sawClosure = true
      if (finishReason === 'length') truncated = true
      const delta = chunk.choices[0]?.delta as
        | (OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta & { reasoning_content?: string })
        | undefined
      if (delta?.reasoning_content) {
        yield { type: 'reasoning', text: delta.reasoning_content }
      }
      if (delta?.content) {
        yield { type: 'text', text: delta.content }
      }
      for (const tc of delta?.tool_calls ?? []) {
        const idx = tc.index ?? 0
        const buf = buffers.get(idx) ?? { id: '', name: '', args: '' }
        if (tc.id) buf.id = tc.id
        if (tc.function?.name) buf.name = tc.function.name
        if (tc.function?.arguments) buf.args += tc.function.arguments
        buffers.set(idx, buf)
      }
    }

    // 流结束复核：全程无收尾标记且非主动中止 → 网络 / 网关静默截断（不可当「完整」收尾）；
    // 主动中止（abort）场景由 resilience 层按父级信号 / 超时相位统一判定，此处不拦截
    if (!sawClosure && !signal.aborted) throw new LlmStreamInterruptedError()

    const calls: LlmToolCall[] = [...buffers.entries()]
      .sort((a, b) => a[0] - b[0])
      .filter(([, b]) => b.name)
      .map(([idx, b]) => ({
        id: b.id || `call_${Date.now()}_${idx}`,
        name: b.name,
        arguments: b.args || '{}',
      }))
    if (calls.length) yield { type: 'tool_calls', calls }
    if (truncated) yield { type: 'truncated' }
    if (usage) {
      yield {
        type: 'usage',
        usage: { promptTokens: usage.prompt_tokens ?? 0, completionTokens: usage.completion_tokens ?? 0 },
      }
    }
    yield { type: 'done' }
  }
}

/**
 * LLM Provider 抽象（§7.1）：真实实现与测试替身完全互换。
 * LlmChunk 联合在 v1 的 AsyncIterable<string> 之上演进，加入 tool_calls 通道（§21.2）。
 */
import type { TurnMode } from '@multi-agent/shared'

/** 流式增量：文本 / 思考内容 / 聚合后的工具调用 / 用量 / 结束标记 */
export type LlmChunk =
  | { type: 'text'; text: string }
  /** 思考模式（V4）的思维链增量：不进正文，前端折叠展示 */
  | { type: 'reasoning'; text: string }
  | { type: 'tool_calls'; calls: LlmToolCall[] }
  /** 用量（M4）：include_usage 启用后由真实 Provider 在流末产出，引擎写入 usage 表 */
  | { type: 'usage'; usage: LlmUsage }
  /** 输出截断（finish_reason=length）：正文达到单次输出上限，引擎落系统事件条提示 */
  | { type: 'truncated' }
  | { type: 'done' }

export interface LlmUsage {
  promptTokens: number
  completionTokens: number
}

export interface LlmToolCall {
  id: string
  name: string
  /** JSON 字符串（与 OpenAI 协议一致，引擎侧解析后做 zod 校验） */
  arguments: string
}

/**
 * M33：多模态内容块（OpenAI 兼容协议）——文本 / 图片。
 * 用户消息携带图片附件时，content 从纯文本升级为内容块数组；
 * 图片以 data URL（base64 内联）传递，由对话窗口装配层注入（含预算护栏）。
 */
export type LlmContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface LlmMessageInput {
  role: 'system' | 'user' | 'assistant' | 'tool'
  /** 纯文本，或 M33 多模态内容块数组（text + image_url） */
  content: string | LlmContentPart[]
  /** role: 'tool' 时关联的调用 id */
  toolCallId?: string
  /** role: 'assistant' 且包含工具调用时 */
  toolCalls?: LlmToolCall[]
  /** role: 'assistant' 时的思维链：思考模式下带 tool_calls 的消息必须回传（否则 400） */
  reasoning?: string
  name?: string
}

/** 工具清单投影（OpenAI tools 协议形态） */
export interface LlmToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** 运行期元信息：测试替身用于选剧本与动态转交，真实 Provider 忽略（§7.1） */
export interface ChatRequestMeta {
  agentId: string
  participantIds: string[]
  /** 本 Run 内已发言者（含当前角色），防回环依据 */
  spokenAgentIds?: string[]
  /** 当前回合在 Run 内的序号（0 基） */
  stepIndex?: number
  /** 可用 Skill 名列表 */
  availableSkills?: string[]
  /** M16：命中的灵魂 id（会话覆盖 > 角色默认；缺省 = 无灵魂）——mock 风格化输出依据 */
  soul?: string
  /** M77：成员键 → 展示标签（同角多魂：分身 = `名字·灵魂名`）——转交行点名 / 纪要待办署名依据 */
  memberLabels?: Record<string, string>
  /** M24：本回合范式（execute 缺省不传；mock 据此输出 write_plan / submit_review / update_plan_step） */
  mode?: TurnMode
}

export interface ChatRequest {
  /** 完整系统提示（协作协议 + 人设 + Skill + 工作区清单，§21.4） */
  system: string
  messages: LlmMessageInput[]
  model?: string
  /** M57 P3：发起请求的会话（BYOK 按会话属主解析用户凭据；缺省 = 系统默认） */
  sessionId?: string
  temperature?: number
  /** 思考模式（V4）：由引擎按全局配置下发；缺省由 Provider 自行决定 */
  thinking?: boolean
  /** 工具清单；无可用工具时缺省 */
  tools?: LlmToolSchema[]
  /** 结构化输出（M2 摘要 / M4 通用）：OpenAI response_format 透传 */
  responseFormat?: { type: 'json_schema'; name: string; schema: Record<string, unknown> }
  meta: ChatRequestMeta
}

export interface LlmProvider {
  /** 契约：必须响应 AbortSignal（停止 / 超时依赖它中断底层请求与剧本循环） */
  chatStream(req: ChatRequest, signal: AbortSignal): AsyncIterable<LlmChunk>
}

export function abortError(): Error {
  const err = new Error('运行已被中断')
  err.name = 'AbortError'
  return err
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

/**
 * 流式响应无收尾标记异常结束（未收到 finish_reason / usage）：网络或网关静默截断的通用表征。
 * 分类为可重试（首个增量前由 resilience 层重放）；已产出内容时按「中断」语义上抛，供续写。
 */
export class LlmStreamInterruptedError extends Error {
  constructor(message = '模型流意外中断（未收到结束标记，可能被网络截断）') {
    super(message)
    this.name = 'LlmStreamInterruptedError'
  }
}

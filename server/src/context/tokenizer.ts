/**
 * token 计量（M2）：js-tiktoken（cl100k_base 近似）+ 安全余量 + 运行期校准。
 *
 * 为什么不用精确分词器：真实模型（DeepSeek 等）的分词器形态各异，
 * 目标不是「精确」而是「稳定可校准」——用统一编码器估算，再用每次真实调用的
 * `usage.prompt_tokens` 反推换算系数，滚动平均后即逼近目标模型。
 *
 * 兜底：分词器加载失败（子集构建未打包词表）时退化为字符启发式，功能不中断。
 */
import { type Tiktoken, getEncoding } from 'js-tiktoken'
import type { LlmMessageInput } from '../llm/provider.js'

/** 安全余量：估算值再 ×1.15，吸收分词差异（计划 §15 风险对策） */
export const SAFETY_MARGIN = 1.15

/** M33：视觉输入近似计量（每张注入图片约 800 token；装配侧口径一致） */
export const VISION_TOKENS_PER_IMAGE = 800

/** 每条消息的协议开销（role / 分隔符等，OpenAI 侧约 3~4 token） */
const MESSAGE_OVERHEAD = 4

let encoder: Tiktoken | undefined
let encoderFailed = false
let calibration = 1
const calibrationSamples: number[] = []
const CALIBRATION_WINDOW = 20

const cache = new Map<string, number>()
const CACHE_MAX = 4_096

function getEncoder(): Tiktoken | undefined {
  if (encoder || encoderFailed) return encoder
  try {
    encoder = getEncoding('cl100k_base')
  } catch {
    encoderFailed = true
  }
  return encoder
}

/** 无分词器时的启发式：CJK 约 1 token/字，其余约 4 字符/token */
function heuristicCount(text: string): number {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code >= 0x3000 && code <= 0x9fff) cjk++
    else other++
  }
  return Math.ceil(cjk + other / 4)
}

/** 原始估算（未含余量与校准） */
export function countTokens(text: string): number {
  if (!text) return 0
  const cached = cache.get(text)
  if (cached !== undefined) return cached
  const enc = getEncoder()
  let value: number
  try {
    value = enc ? enc.encode(text).length : heuristicCount(text)
  } catch {
    value = heuristicCount(text)
  }
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(text, value)
  return value
}

/** 含安全余量与校准系数的估算（预算判断与截断都用这个口径） */
export function countTokensCalibrated(text: string): number {
  return Math.ceil(countTokens(text) * calibration * SAFETY_MARGIN)
}

export function tokensOfMessages(messages: LlmMessageInput[]): number {
  let total = 0
  for (const message of messages) {
    // M33：多模态 content（内容块数组）——文本块按分词估算，图片块计固定近似
    if (typeof message.content === 'string') {
      total += countTokens(message.content) + MESSAGE_OVERHEAD
    } else {
      for (const part of message.content) {
        total += part.type === 'text' ? countTokens(part.text) : VISION_TOKENS_PER_IMAGE
      }
      total += MESSAGE_OVERHEAD
    }
    for (const call of message.toolCalls ?? []) {
      total += countTokens(call.name) + countTokens(call.arguments) + 2
    }
  }
  return total
}

/** 校准：用真实 usage 反推换算系数（滚动均值，收敛到 1 表示估算准确） */
export function recordUsage(estimatedTokens: number, actualPromptTokens: number): void {
  if (estimatedTokens <= 0 || actualPromptTokens <= 0) return
  const ratio = actualPromptTokens / estimatedTokens
  if (!Number.isFinite(ratio) || ratio <= 0.2 || ratio >= 5) return
  calibrationSamples.push(ratio)
  if (calibrationSamples.length > CALIBRATION_WINDOW) calibrationSamples.shift()
  calibration = calibrationSamples.reduce((a, b) => a + b, 0) / calibrationSamples.length
}

export function currentCalibration(): number {
  return Math.round(calibration * 1000) / 1000
}

/** 测试用：清空缓存 / 校准 / 分词器 */
export function resetTokenizer(): void {
  cache.clear()
  calibrationSamples.length = 0
  calibration = 1
  encoder = undefined
  encoderFailed = false
}

export interface TruncatedText {
  text: string
  truncated: boolean
  /** 截断点对应的行号（1 基），调用方可提示「用 offset 续读」 */
  lines: number
}

/**
 * 按 token 上限截断文本，尽量在行边界断开。
 * 用于工具结果回灌（TOOL_RESULT_MAX_TOKENS）与单条消息兜底。
 */
export function truncateToTokens(text: string, maxTokens: number, hint?: string): TruncatedText {
  const totalLines = text.split('\n')
  if (countTokensCalibrated(text) <= maxTokens) {
    return { text, truncated: false, lines: totalLines.length }
  }
  const out: string[] = []
  let used = 0
  for (let i = 0; i < totalLines.length; i++) {
    const line = totalLines[i]
    const cost = countTokensCalibrated(line) + 1
    if (used + cost > maxTokens) {
      return {
        text: `${out.join('\n')}${hint ? `\n\n${hint}` : ''}`,
        truncated: true,
        lines: i,
      }
    }
    out.push(line)
    used += cost
  }
  return { text: out.join('\n'), truncated: true, lines: totalLines.length }
}

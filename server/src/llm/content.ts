/**
 * 多模态消息内容工具（M33）：content 既可为纯文本，也可为内容块数组
 * （文本 + 图片 data URL）。凡只需文本通道的消费方（测试替身 / token 计量 /
 * 文本类断言）统一经 textOfContent 提取，避免各自实现漂移。
 */
import type { LlmContentPart } from './provider.js'

/** 提取纯文本：字符串原样返回；数组拼接全部 text 块（图片块忽略） */
export function textOfContent(content: string | LlmContentPart[]): string {
  if (typeof content === 'string') return content
  return content
    .filter((part): part is Extract<LlmContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
}

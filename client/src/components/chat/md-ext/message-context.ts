/**
 * M37：消息上下文（md-ext 交互容器用）——容器组件经此读取 messageId / sessionId，
 * 用于本地互动态（勾选 / 点选）的 sessionStorage 键（ADR 0064 / 0068）。
 * 未提供上下文（独立 Markdown 渲染等场景）时容器降级为「仅即时态、不持久化」。
 */
import * as React from 'react'

export interface MdMessageInfo {
  messageId: string
  sessionId: string
}

export const MessageContext = React.createContext<MdMessageInfo | null>(null)

export function useMessageInfo(): MdMessageInfo | null {
  return React.useContext(MessageContext)
}

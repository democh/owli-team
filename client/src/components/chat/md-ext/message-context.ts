/**
 * M37：消息上下文（md-ext 交互容器用）——容器组件经此读取 messageId / sessionId，
 * 用于本地互动态（勾选 / 点选）的 sessionStorage 键（ADR 0064 / 0068）。
 * 未提供上下文（独立 Markdown 渲染等场景）时容器降级为「仅即时态、不持久化」。
 */
import * as React from 'react'

export interface MdMessageInfo {
  messageId: string
  sessionId: string
  /**
   * M79：本条消息的人类定向目标展示名（humanMentions → 具体人名）。
   * 正文 `@用户` / `@user` 泛称 chip 就地展开为具体人；缺省 = 不展开、按原 token 渲染。
   */
  humanLabels?: string[]
}

export const MessageContext = React.createContext<MdMessageInfo | null>(null)

export function useMessageInfo(): MdMessageInfo | null {
  return React.useContext(MessageContext)
}

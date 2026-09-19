/**
 * 流式标志 Context（从 Markdown.tsx 抽出）：
 * 代码块 / mermaid / chart / 图片等扩展组件经 useStreaming() 读取，
 * 流式期间一律降级为纯文本（不触发高亮、不渲染图表），避免抖动与重复计算。
 */
import * as React from 'react'

export const StreamingContext = React.createContext(false)

export function useStreaming(): boolean {
  return React.useContext(StreamingContext)
}

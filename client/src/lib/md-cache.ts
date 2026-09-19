/**
 * Markdown 渲染 / 高亮缓存（M8）。
 * 独立于组件模块：主题切换（ui-store）可无循环依赖地清空缓存。
 * - renderCache：完成态 Markdown 渲染结果（LRU 200，key 含成员名单快照）；
 * - highlightCache：shiki 高亮 HTML（key 含主题前缀，防跨主题串色）；
 * - mermaidCache：mermaid 渲染 SVG（key = 图表源码，重复渲染/虚拟列表重挂载免重算）。
 */
import type * as React from 'react'

export const renderCache = new Map<string, React.ReactNode>()
export const highlightCache = new Map<string, string>()
export const mermaidCache = new Map<string, string>()

/** 主题切换后调用：shiki 高亮色为内联样式，必须重渲染 */
export function clearMarkdownCaches(): void {
  renderCache.clear()
  highlightCache.clear()
  mermaidCache.clear()
}

/**
 * 代码块（shiki 高亮 + 工具条）：文件名 title、行高亮（```lang {2,5-7}）、复制、超长折叠。
 * 流式期间保持纯文本（不触发高亮）；完成态按 [主题|语言|行标记|内容] 命中全局缓存。
 */
import * as React from 'react'
import { ChevronDown, ChevronUp, FileCode2 } from 'lucide-react'
import { highlightCache } from '../../../lib/md-cache'
import { SHIKI_THEME, highlightCode } from '../../../lib/shiki'
import { cn } from '../../../lib/utils'
import { CopyButton } from './CopyButton'
import { useStreaming } from './streaming'

const HIGHLIGHT_CACHE_MAX = 100
/** 超过该行数折叠（首屏只展示前 ~14 行 + 底部渐隐） */
const COLLAPSE_LINES = 24

export function CodeBlock({
  code,
  lang,
  title,
  lines,
}: {
  code: string
  lang: string
  title?: string
  lines?: number[]
}): React.JSX.Element {
  const streaming = useStreaming()
  const [html, setHtml] = React.useState<string | undefined>(undefined)
  const [expanded, setExpanded] = React.useState(false)

  const lineKey = lines?.join(',') ?? ''
  React.useEffect(() => {
    if (streaming) return
    const key = `${SHIKI_THEME}\u0000${lang}\u0000${lineKey}\u0000${code}`
    const cached = highlightCache.get(key)
    if (cached !== undefined) {
      setHtml(cached)
      return
    }
    let alive = true
    const highlightLines = lineKey ? lineKey.split(',').map(Number) : undefined
    void highlightCode(code, lang, { lines: highlightLines })
      .then((out) => {
        highlightCache.set(key, out)
        if (highlightCache.size > HIGHLIGHT_CACHE_MAX) {
          const first = highlightCache.keys().next().value
          if (first !== undefined) highlightCache.delete(first)
        }
        if (alive) setHtml(out)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [code, lang, lineKey, streaming])

  if (streaming || !html) {
    return (
      <pre className="md-code-plain">
        <code>{code}</code>
      </pre>
    )
  }

  const lineCount = code.split('\n').length
  const collapsible = lineCount > COLLAPSE_LINES
  const collapsed = collapsible && !expanded

  return (
    <div className="md-codeblock">
      <div className="md-block-bar">
        <FileCode2 className="size-3.5 shrink-0 opacity-70" />
        {title && <span className="md-block-title">{title}</span>}
        <span className="md-block-lang">{title ? lang : lang || 'code'}</span>
        {collapsible && <span className="md-block-meta">{lineCount} 行</span>}
        <span className="md-block-actions">
          <CopyButton text={code} />
        </span>
      </div>
      <div className={cn('md-code-wrap', collapsed && 'is-collapsed')}>
        <div className="md-shiki" dangerouslySetInnerHTML={{ __html: html }} />
        {collapsed && (
          <button type="button" className="md-code-more" onClick={() => setExpanded(true)}>
            <ChevronDown className="size-3.5" />
            展开全部 · {lineCount} 行
          </button>
        )}
      </div>
      {collapsible && expanded && (
        <button type="button" className="md-code-more is-static" onClick={() => setExpanded(false)}>
          <ChevronUp className="size-3.5" />
          收起
        </button>
      )}
    </div>
  )
}

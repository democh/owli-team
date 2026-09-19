/**
 * Mermaid 图表块（```mermaid）：懒加载 lib/mermaid（独立 chunk，不进首屏）；
 * - 流式期间显示源码，完成后渲染 SVG；
 * - 渲染失败 → 错误条 + 自动展开源码（不清空内容）；
 * - 工具条：源码开关 / 全屏（Overlay 复用同一 SVG 字符串）/ 复制源码。
 */
import * as React from 'react'
import { FileCode2, Maximize2, TriangleAlert } from 'lucide-react'
import { mermaidCache } from '../../../lib/md-cache'
import { renderMermaid } from '../../../lib/mermaid'
import { cn } from '../../../lib/utils'
import { CopyButton } from './CopyButton'
import { Overlay } from './Overlay'
import { useStreaming } from './streaming'

function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  const firstLines = msg.split('\n').filter((l) => l.trim()).slice(0, 2).join(' ')
  return firstLines.length > 160 ? `${firstLines.slice(0, 160)}…` : firstLines
}

export function MermaidBlock({ code, title }: { code: string; title?: string }): React.JSX.Element {
  const streaming = useStreaming()
  const [svg, setSvg] = React.useState<string | undefined>(() => mermaidCache.get(code))
  const [error, setError] = React.useState<string | undefined>(undefined)
  const [showSource, setShowSource] = React.useState(false)
  const [zoom, setZoom] = React.useState(false)

  React.useEffect(() => {
    if (streaming) return
    const cached = mermaidCache.get(code)
    if (cached !== undefined) {
      setSvg(cached)
      setError(undefined)
      return
    }
    let alive = true
    void renderMermaid(code)
      .then((out) => {
        if (!alive) return
        setSvg(out)
        setError(undefined)
      })
      .catch((err: unknown) => {
        if (!alive) return
        setSvg(undefined)
        setError(errorText(err))
      })
    return () => {
      alive = false
    }
  }, [code, streaming])

  if (streaming) {
    return (
      <pre className="md-code-plain">
        <code>{code}</code>
      </pre>
    )
  }

  const label = title || 'Mermaid 图表'
  const sourceOpen = showSource || error !== undefined

  return (
    <figure className="md-mermaid">
      <div className="md-block-bar">
        <span className="md-block-title">{label}</span>
        <span className="md-block-lang">mermaid</span>
        <span className="md-block-actions">
          <button
            type="button"
            className={cn('md-block-btn', sourceOpen && 'is-active')}
            title={sourceOpen ? '收起源码' : '查看源码'}
            onClick={() => setShowSource((v) => !v)}
          >
            <FileCode2 className="size-3.5" />
            <span>源码</span>
          </button>
          {svg && (
            <button type="button" className="md-block-btn" title="全屏查看" onClick={() => setZoom(true)}>
              <Maximize2 className="size-3.5" />
              <span>全屏</span>
            </button>
          )}
          <CopyButton text={code} />
        </span>
      </div>

      {error ? (
        <div className="md-mermaid-error">
          <TriangleAlert className="size-3.5 shrink-0" />
          <span>图表渲染失败：{error}</span>
        </div>
      ) : svg ? (
        <div className="md-mermaid-canvas" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <div className="md-mermaid-loading">图表加载中…</div>
      )}

      {sourceOpen && (
        <pre className="md-code-plain md-mermaid-source">
          <code>{code}</code>
        </pre>
      )}

      <Overlay open={zoom} title={label} onClose={() => setZoom(false)}>
        {svg && <div className="md-mermaid-canvas is-zoom" dangerouslySetInnerHTML={{ __html: svg }} />}
      </Overlay>
    </figure>
  )
}

/**
 * M41（§103，FU-2）：问答卡（`::: qa`）——投资人 / 客户常见问答折叠对（原生 details，无 JS 状态、缓存安全）；
 * 条目 `- 问 | 答`（答可缺省 → 折叠体显示占位）；解析失败 → raw 兜底静态渲染。
 */
import * as React from 'react'
import { MessagesSquare } from 'lucide-react'
import type { QaPair } from './remark-ext'

/** data-rows JSON → 问答对（非法 JSON / 形状不符 → 空数组，走 raw 回退） */
export function parseQaRows(json: string | undefined): QaPair[] {
  if (!json) return []
  try {
    const arr: unknown = JSON.parse(json)
    if (!Array.isArray(arr)) return []
    const out: QaPair[] = []
    for (const v of arr) {
      if (!v || typeof v !== 'object') continue
      const o = v as { q?: unknown; a?: unknown }
      if (typeof o.q !== 'string' || o.q === '') continue
      out.push({ q: o.q, a: typeof o.a === 'string' ? o.a : '' })
    }
    return out
  } catch {
    return []
  }
}

export function QaCard({
  title,
  rows: rowsRaw,
  raw,
  children,
}: {
  title?: string
  rows?: string
  raw?: string
  children?: React.ReactNode
}): React.JSX.Element {
  const pairs = React.useMemo(() => parseQaRows(rowsRaw), [rowsRaw])

  if (pairs.length === 0) {
    return (
      <div className="md-qa">
        {raw ? <pre className="md-qa-static">{raw}</pre> : null}
        {children}
      </div>
    )
  }

  return (
    <div className="md-qa" data-qa-card="">
      <div className="md-qa-head">
        <MessagesSquare className="size-3.5" aria-hidden />
        <span className="md-qa-title">{title || '问答'}</span>
        <span className="md-qa-count">{pairs.length} 组</span>
      </div>
      <div className="md-qa-list">
        {pairs.map((p, i) => (
          <details className="md-qa-row" key={i} data-qa-row="">
            <summary className="md-qa-q">{p.q}</summary>
            <div className="md-qa-a">{p.a !== '' ? p.a : '（暂无答案）'}</div>
          </details>
        ))}
      </div>
      {children}
    </div>
  )
}

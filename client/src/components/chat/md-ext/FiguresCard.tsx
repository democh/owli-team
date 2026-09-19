/**
 * M41（§103，FI-1）：测算表卡（`::: figures`）——行名 + 值 + 说明三列；
 * 值列右对齐（tabular-nums）；关键行（合计 / 总计 / 小计 / 毛利 / 净额 / 净利 / EBITDA / 税后）
 * 加粗 + 淡底。解析失败 → raw 兜底静态渲染。
 */
import * as React from 'react'
import { Table2 } from 'lucide-react'
import { cn } from '../../../lib/utils'
import type { FigureRow } from './remark-ext'

/** data-rows JSON → 测算表行（非法 JSON / 形状不符 → 空数组，走 raw 回退） */
export function parseFigureRowsJson(json: string | undefined): FigureRow[] {
  if (!json) return []
  try {
    const arr: unknown = JSON.parse(json)
    if (!Array.isArray(arr)) return []
    const out: FigureRow[] = []
    for (const v of arr) {
      if (!v || typeof v !== 'object') continue
      const o = v as { label?: unknown; value?: unknown; note?: unknown; key?: unknown }
      if (typeof o.label !== 'string' || o.label === '') continue
      out.push({
        label: o.label,
        value: typeof o.value === 'string' ? o.value : '',
        note: typeof o.note === 'string' ? o.note : '',
        key: o.key === true,
      })
    }
    return out
  } catch {
    return []
  }
}

export function FiguresCard({
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
  const rows = React.useMemo(() => parseFigureRowsJson(rowsRaw), [rowsRaw])

  if (rows.length === 0) {
    return (
      <div className="md-figures">
        {raw ? <pre className="md-figures-static">{raw}</pre> : null}
        {children}
      </div>
    )
  }

  return (
    <div className="md-figures" data-figures-card="">
      <div className="md-figures-head">
        <Table2 className="size-3.5" aria-hidden />
        <span className="md-figures-title">{title || '测算表'}</span>
        <span className="md-figures-count">{rows.length} 行</span>
      </div>
      <table className="md-figures-table">
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={cn(r.key && 'is-key')} data-figure-key={r.key ? 'true' : undefined}>
              <td className="md-figures-label">{r.label}</td>
              <td className="md-figures-value">{r.value}</td>
              <td className="md-figures-note">{r.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {children}
    </div>
  )
}

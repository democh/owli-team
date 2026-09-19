/**
 * 通用数据表格（M24）：CSV / TSV 预览与 xlsx 工作表预览共用。
 * - 首行表头（sticky，滚动时保持可见）；斑马纹；数值列 tabular-nums；
 * - 长内容自动换行（不撑破面板）；滚动容器由父级提供。
 */
import * as React from 'react'

export interface DataTableProps {
  rows: string[][]
  /** 首行渲染为表头（默认 true） */
  header?: boolean
}

export function DataTable({ rows, header = true }: DataTableProps): React.JSX.Element {
  const head = header ? rows[0] : undefined
  const body = header ? rows.slice(1) : rows
  return (
    <table className="w-full min-w-max border-collapse text-[12px] leading-5">
      {head && (
        <thead>
          <tr>
            {head.map((cell, i) => (
              <th
                key={i}
                className="sticky top-0 z-10 border-b border-border bg-muted/95 px-2.5 py-1.5 text-left font-medium text-foreground/80 backdrop-blur-sm"
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
      )}
      <tbody>
        {body.map((row, r) => (
          <tr key={r} className="even:bg-muted/30">
            {row.map((cell, c) => (
              <td
                key={c}
                className="max-w-96 break-words border-b border-border/60 px-2.5 py-1.5 align-top tabular-nums whitespace-pre-wrap"
              >
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

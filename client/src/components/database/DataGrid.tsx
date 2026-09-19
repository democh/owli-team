/**
 * 数据网格（M23，Navicat 式）：表数据浏览与查询结果共用。
 * - 表头：列名 + 类型（对象树快照）+ 排序箭头（点击循环：ASC → DESC → 取消）；
 * - 单元格：NULL 灰斜体；对象 / 二进制安全渲染；超长省略（title 全文）；双击复制单元格；
 * - 行号列连续（rowOffset = 分页起始），便于对照页码。
 */
import * as React from 'react'
import { ArrowDown, ArrowUp, ChevronsUpDown, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import type { DbPanelColumn } from '@multi-agent/shared'
import { cn } from '../../lib/utils'

export function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

function CellValue({ value }: { value: unknown }): React.JSX.Element {
  if (value === null || value === undefined) {
    return <span className="text-[11px] italic text-muted-foreground/70">NULL</span>
  }
  if (typeof value === 'boolean') return <span>{value ? 'true' : 'false'}</span>
  return <span>{cellText(value)}</span>
}

export interface DataGridProps {
  columns: string[]
  rows: Array<Record<string, unknown>>
  /** 列类型信息（来自对象树快照；表头小字） */
  columnsMeta?: DbPanelColumn[]
  orderBy?: string
  desc?: boolean
  /** 提供时列头可点击排序 */
  onSort?: (column: string) => void
  loading?: boolean
  error?: string
  emptyText?: string
  /** 行号起始（分页续排） */
  rowOffset?: number
}

export function DataGrid({
  columns,
  rows,
  columnsMeta,
  orderBy,
  desc,
  onSort,
  loading,
  error,
  emptyText = '暂无数据',
  rowOffset = 0,
}: DataGridProps): React.JSX.Element {
  const meta = React.useMemo(() => new Map((columnsMeta ?? []).map((c) => [c.name, c])), [columnsMeta])
  const copyCell = (value: unknown): void => {
    const text = cellText(value)
    if (!text) return
    void navigator.clipboard
      ?.writeText(text)
      .then(() => toast.success('已复制单元格内容'))
      .catch(() => toast.error('复制失败（浏览器未授权剪贴板）'))
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {error && <p className="shrink-0 border-b bg-rose-50 px-3 py-1.5 text-[11.5px] text-rose-700">{error}</p>}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-separate border-spacing-0 text-[11.5px]">
          <thead>
            <tr>
              <th className="sticky top-0 z-10 w-10 border-b border-r bg-muted/70 px-2 py-1 text-right font-medium text-muted-foreground backdrop-blur">
                #
              </th>
              {columns.map((column) => {
                const sortable = !!onSort
                const active = orderBy === column
                return (
                  <th
                    key={column}
                    className={cn(
                      'sticky top-0 z-10 border-b bg-muted/70 px-2 py-1 text-left font-medium backdrop-blur',
                      sortable && 'cursor-pointer select-none hover:bg-accent/70',
                    )}
                    title={meta.get(column)?.type ? `${column} · ${meta.get(column)?.type}` : column}
                    onClick={sortable ? () => onSort(column) : undefined}
                  >
                    <span className="flex items-center gap-1 whitespace-nowrap">
                      <span className={cn(active && 'text-primary')}>{column}</span>
                      {meta.get(column)?.type && (
                        <span className="hidden text-[10px] font-normal text-muted-foreground/80 sm:inline">
                          {meta.get(column)?.type}
                        </span>
                      )}
                      {sortable &&
                        (active ? (
                          desc ? (
                            <ArrowDown className="size-3 shrink-0 text-primary" />
                          ) : (
                            <ArrowUp className="size-3 shrink-0 text-primary" />
                          )
                        ) : (
                          <ChevronsUpDown className="size-3 shrink-0 text-muted-foreground/50" />
                        ))}
                    </span>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index} className="odd:bg-card even:bg-muted/20 hover:bg-primary/5">
                <td className="border-b border-r px-2 py-1 text-right tabular-nums text-muted-foreground/70">{rowOffset + index + 1}</td>
                {columns.map((column) => (
                  <td
                    key={column}
                    className="max-w-[360px] truncate border-b px-2 py-1 font-mono"
                    title={cellText(row[column])}
                    onDoubleClick={() => copyCell(row[column])}
                  >
                    <CellValue value={row[column]} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && !loading && (
          <p className="px-3 py-10 text-center text-[12px] text-muted-foreground">{emptyText}</p>
        )}
      </div>
      {loading && (
        <div className="absolute inset-x-0 top-0 flex items-center justify-center gap-1.5 bg-background/60 py-2 text-[11.5px] text-muted-foreground backdrop-blur-[1px]">
          <Loader2 className="size-3.5 animate-spin" />
          加载中…
        </div>
      )}
    </div>
  )
}

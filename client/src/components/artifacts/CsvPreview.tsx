/**
 * CSV / TSV 表格预览（M24）：lib/csv 解析 → DataTable 渲染。
 * - 顶部信息条：行 × 列 · 分隔符 · 截断提示；
 * - 首行作为表头；无数据行时给出空态。
 */
import * as React from 'react'
import { Table2 } from 'lucide-react'
import { delimiterLabel, parseDelimited } from '../../lib/csv'
import { DataTable } from './DataTable'

export function CsvPreview({ content }: { content: string }): React.JSX.Element {
  const parsed = React.useMemo(() => parseDelimited(content), [content])
  if (parsed.rows.length === 0) {
    return <p className="p-6 text-center text-[12.5px] text-muted-foreground">文件中没有可展示的数据行</p>
  }
  const cols = parsed.rows[0]?.length ?? 0
  const dataRows = Math.max(0, parsed.rows.length - 1)
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-0.5 border-b bg-muted/40 px-3 py-1 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Table2 className="size-3" />
          {dataRows} 行 × {cols} 列
        </span>
        <span>· {delimiterLabel(parsed.delimiter)}分隔</span>
        {parsed.truncated && (
          <span className="font-medium text-amber-600">超出预览上限，已截断（完整数据请下载）</span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <DataTable rows={parsed.rows} />
      </div>
    </div>
  )
}

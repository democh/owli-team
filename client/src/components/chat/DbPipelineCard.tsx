/**
 * M39（§97，BI-1，ADR 0150）：取数管道卡——bi 场景的 db_query / db_schema 工具卡变体
 * （数据同源 ToolCallRecord，与 LiveDock 操作流不重复；非 bi 场景保持通用 ToolCard）。
 * - 结构：问题 → SQL（可展开）→ 结果预览（≤5 行，来自工具 meta）→ 校验徽章；
 * - meta 缺省（历史消息 / 错误路径）→ 降级为 summary 行（不空白）；
 * - 运行中 / 失败 / 停止 三态一色系与通用卡对齐。
 */
import * as React from 'react'
import { ChevronDown, ChevronRight, Database, Loader2, ShieldCheck, XCircle, CircleSlash } from 'lucide-react'
import type { ToolCallRecord } from '@multi-agent/shared'
import { cn } from '../../lib/utils'

export interface DbPipelineMeta {
  columns: string[]
  rows: Array<Record<string, string>>
  rowCount: number
  durationMs: number
}

/** meta → 管道数据（非法 / 历史缺省 → undefined，走 summary 降级） */
export function parseDbMeta(meta: Record<string, unknown> | undefined): DbPipelineMeta | undefined {
  if (!meta) return undefined
  const columns = Array.isArray(meta.columns) ? meta.columns.filter((c): c is string => typeof c === 'string') : []
  const rows: Array<Record<string, string>> = []
  if (Array.isArray(meta.rows)) {
    for (const r of meta.rows) {
      if (!r || typeof r !== 'object') continue
      const row: Record<string, string> = {}
      for (const [k, v] of Object.entries(r as Record<string, unknown>)) row[k] = typeof v === 'string' ? v : String(v)
      rows.push(row)
    }
  }
  const rowCount = typeof meta.rowCount === 'number' ? meta.rowCount : rows.length
  const durationMs = typeof meta.durationMs === 'number' ? meta.durationMs : 0
  if (columns.length === 0 && rows.length === 0) return undefined
  return { columns, rows, rowCount, durationMs }
}

/** SQL 摘要（未展开时显示首行；空 SQL → 空串） */
function sqlHead(sql: string): string {
  const first = sql
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '')
  return first ?? ''
}

export function DbPipelineCard({ call }: { call: ToolCallRecord }): React.JSX.Element {
  const [sqlOpen, setSqlOpen] = React.useState(false)
  const sql = typeof call.args.sql === 'string' ? call.args.sql : ''
  const meta = React.useMemo(() => parseDbMeta(call.meta), [call.meta])
  const isSchema = call.name === 'db_schema'
  const multiLine = sql.includes('\n') || sql.length > 96

  return (
    <div className="rounded-md border border-sky-500/25 bg-card text-[12px]" data-db-pipeline={call.name}>
      <div className="flex w-full items-center gap-1.5 px-2 py-1.5">
        {call.status === 'running' ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-sky-600" />
        ) : call.status === 'ok' ? (
          <ShieldCheck className="size-3.5 shrink-0 text-emerald-600" />
        ) : call.status === 'stopped' ? (
          <CircleSlash className="size-3.5 shrink-0 text-amber-600" />
        ) : (
          <XCircle className="size-3.5 shrink-0 text-destructive" />
        )}
        <Database className="size-3.5 shrink-0 text-sky-600" />
        <span className="shrink-0 font-medium">{isSchema ? '表结构探查' : '取数管道'}</span>
        {call.status === 'ok' ? (
          <span
            className="shrink-0 rounded-full bg-emerald-500/10 px-1.5 text-[10px] font-medium leading-[1.7] text-emerald-600"
            title="已过取数校验（执行成功）"
            data-db-verified=""
          >
            已校验
          </span>
        ) : null}
        {meta && call.status === 'ok' ? (
          <span className="shrink-0 rounded-full bg-sky-500/10 px-1.5 text-[10px] tabular-nums leading-[1.7] text-sky-700">
            {meta.rowCount} 行 · {meta.durationMs}ms
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {isSchema ? (call.summary ?? '') : sqlHead(sql) || (call.summary ?? '')}
        </span>
      </div>

      {sql !== '' ? (
        <div className="border-t border-sky-500/15">
          <button
            type="button"
            className="flex w-full items-center gap-1 px-2 py-1 text-left text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            aria-expanded={sqlOpen}
            data-sql-toggle=""
            onClick={() => setSqlOpen((v) => !v)}
          >
            {sqlOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            SQL {multiLine ? '（可展开）' : null}
          </button>
          {sqlOpen ? (
            <pre className="max-h-40 overflow-auto border-t border-sky-500/10 bg-muted/30 px-2 py-1.5 font-mono text-[11px] leading-5 whitespace-pre-wrap break-all">
              {sql}
            </pre>
          ) : null}
        </div>
      ) : null}

      {meta && meta.rows.length > 0 ? (
        <div className="border-t border-sky-500/15" data-db-preview="">
          <div className="px-2 py-1 text-[10.5px] text-muted-foreground">
            结果预览 · 前 {meta.rows.length} 行（共 {meta.rowCount} 行）
          </div>
          <div className="overflow-x-auto px-2 pb-1.5">
            <table className="w-full border-collapse text-[11px]">
              <thead>
                <tr>
                  {meta.columns.map((c) => (
                    <th key={c} className="border-b border-border px-1.5 py-0.5 text-left font-medium text-muted-foreground">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {meta.rows.map((row, i) => (
                  <tr key={i}>
                    {meta.columns.map((c) => (
                      <td key={c} className="border-b border-border/60 px-1.5 py-0.5 align-top font-mono tabular-nums">
                        {row[c] ?? ''}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : call.status !== 'running' && call.summary ? (
        <div className={cn('border-t border-sky-500/15 px-2 py-1 text-[11.5px]', call.status === 'ok' ? 'text-muted-foreground' : 'text-destructive')}>
          {call.summary}
        </div>
      ) : null}
    </div>
  )
}

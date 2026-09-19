/**
 * SQL 编辑器（M23，查询页）：编辑器 + 运行（⌘/Ctrl+Enter）+ 历史 + 结果网格。
 *
 * 交互（对齐 Navicat / DataGrip 习惯）：
 * - 运行按钮 / ⌘(Ctrl)+Enter 触发；运行中按钮转圈并禁用；
 * - 写语句由父级弹出确认框（dryRun 分类），确认后再执行；
 * - 结果区：只读结果显示行网格；写操作显示影响行数；错误就地红条展示；
 * - 历史：最近 30 条（下拉即插回编辑器，不自动执行）。
 */
import * as React from 'react'
import { History, Loader2, Play } from 'lucide-react'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import type { DbQueryRun } from '../../stores/database-store'
import { DataGrid } from './DataGrid'

export interface SqlEditorProps {
  value: string
  onChange: (value: string) => void
  onRun: () => void
  running: boolean
  error?: string
  result?: DbQueryRun
  history: string[]
  /** 连接未开启「允许写入」：写语句确认框会提示将被拒绝 */
  writesAllowed: boolean
  placeholder?: string
}

function summarize(result: DbQueryRun | undefined, error: string | undefined, running: boolean): React.ReactNode {
  if (running) {
    return (
      <span className="flex items-center gap-1 text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        执行中…
      </span>
    )
  }
  if (error) return <span className="text-rose-600">{error}</span>
  if (!result) return <span className="text-muted-foreground">就绪</span>
  const duration = result.durationMs >= 1000 ? `${(result.durationMs / 1000).toFixed(2)}s` : `${result.durationMs}ms`
  if (result.mode === 'execute') {
    return (
      <span className="text-emerald-700">
        执行成功 · 影响 {result.affectedRows ?? '未知'} 行 · {duration}
      </span>
    )
  }
  return (
    <span className="text-muted-foreground">
      {result.rowCount} 行{result.truncated ? '（已截断）' : ''} · {duration}
    </span>
  )
}

export function SqlEditor({
  value,
  onChange,
  onRun,
  running,
  error,
  result,
  history,
  writesAllowed,
  placeholder = 'SELECT * FROM users LIMIT 100;',
}: SqlEditorProps): React.JSX.Element {
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      if (!running) onRun()
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b px-2 py-1.5">
        <Button size="xs" disabled={running} onClick={onRun} title="运行（⌘/Ctrl+Enter）">
          {running ? <Loader2 className="mr-1 size-3 animate-spin" /> : <Play className="mr-1 size-3" />}
          运行
        </Button>
        <span className="hidden text-[10.5px] text-muted-foreground sm:inline">⌘/Ctrl+Enter</span>
        {!writesAllowed && (
          <span className="rounded-full border border-amber-500/30 bg-amber-50 px-1.5 py-px text-[10px] text-amber-700">
            只读连接 · 写语句将被拒绝
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {history.length > 0 && (
            <label className="flex items-center gap-1 text-[10.5px] text-muted-foreground">
              <History className="size-3" />
              <select
                className="max-w-[220px] rounded-md border border-input bg-card px-1.5 py-0.5 text-[11px]"
                value=""
                onChange={(e) => {
                  if (e.target.value) onChange(e.target.value)
                }}
              >
                <option value="">历史（{history.length}）</option>
                {history.map((sql, index) => (
                  <option key={index} value={sql}>
                    {sql.split('\n')[0]?.slice(0, 80)}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </div>

      <textarea
        className={cn(
          'h-40 shrink-0 resize-y border-b bg-card px-3 py-2 font-mono text-[12px] leading-5 outline-none',
          'placeholder:text-muted-foreground/60 focus:bg-card',
        )}
        value={value}
        spellCheck={false}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
      />

      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1 text-[11px]">{summarize(result, error, running)}</div>

      {result && result.mode === 'query' && (
        <DataGrid columns={result.columns} rows={result.rows} emptyText="查询返回 0 行" rowOffset={0} />
      )}
      {result && result.mode === 'execute' && (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-[12px] text-muted-foreground">
          语句已执行 · 影响 {result.affectedRows ?? '未知'} 行（{result.durationMs}ms）
          <br />
          刷新对应「数据」页签查看最新结果。
        </div>
      )}
      {!result && <div className="flex min-h-0 flex-1 items-center justify-center text-[12px] text-muted-foreground">运行 SQL 后在此查看结果</div>}
    </div>
  )
}

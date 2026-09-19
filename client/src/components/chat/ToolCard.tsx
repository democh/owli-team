/**
 * 工具调用卡片（§21.6）：名称/状态/摘要/参数折叠。
 */
import * as React from 'react'
import {
  BookOpen,
  Calculator,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleSlash,
  FilePenLine,
  FileSpreadsheet,
  FileText,
  FolderTree,
  Globe,
  Link,
  ListTodo,
  Loader2,
  Search,
  SquarePen,
  Table2,
  Terminal,
  XCircle,
  type LucideIcon,
} from 'lucide-react'
import type { ToolCallRecord } from '@multi-agent/shared'
import { cn } from '../../lib/utils'

const TOOL_META: Record<string, { label: string; icon: LucideIcon }> = {
  list_dir: { label: '列出目录', icon: FolderTree },
  read_file: { label: '读取文件', icon: FileText },
  write_file: { label: '写入文件', icon: FilePenLine },
  edit_file: { label: '编辑文件', icon: SquarePen },
  search_text: { label: '搜索文本', icon: Search },
  web_search: { label: '联网搜索', icon: Globe },
  web_fetch: { label: '抓取网页', icon: Link },
  write_todos: { label: '更新待办', icon: ListTodo },
  load_skill: { label: '加载技能', icon: BookOpen },
  run_command: { label: '执行命令', icon: Terminal },
  // M21.2：业务工具集
  calc: { label: '计算', icon: Calculator },
  date_calc: { label: '日期计算', icon: CalendarDays },
  csv_analyze: { label: '表格分析', icon: Table2 },
  template_fill: { label: '模板填充', icon: FileSpreadsheet },
}

function argsPreview(args: Record<string, unknown>): string {
  const key = ['path', 'file_path', 'pattern', 'query', 'command', 'name', 'todos'].find((k) => k in args)
  if (!key) return JSON.stringify(args).slice(0, 80)
  const v = args[key]
  return `${key}: ${typeof v === 'string' ? v : JSON.stringify(v)}`.slice(0, 96)
}

export function ToolCard({ call }: { call: ToolCallRecord }): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  const meta = TOOL_META[call.name] ?? { label: call.name, icon: Terminal }
  const Icon = meta.icon

  return (
    <div className="rounded-md border bg-muted/40 text-[12px]">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left"
        onClick={() => setOpen((v) => !v)}
      >
        {call.status === 'running' ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
        ) : call.status === 'ok' ? (
          <CheckCircle2 className="size-3.5 shrink-0 text-emerald-600" />
        ) : call.status === 'stopped' ? (
          // M47：中断（用户停止 / 回合超时）—— 非失败，琥珀色呈现
          <CircleSlash className="size-3.5 shrink-0 text-amber-600" />
        ) : (
          <XCircle className="size-3.5 shrink-0 text-destructive" />
        )}
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="font-medium">{meta.label}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {call.summary ?? argsPreview(call.args)}
        </span>
        {open ? (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        )}
      </button>
      {open && (
        <div className="border-t px-2 py-1.5">
          <div className="mb-1 font-medium text-muted-foreground">参数</div>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-5">
            {JSON.stringify(call.args, null, 2)}
          </pre>
          {call.summary && (
            <>
              <div className="mb-1 mt-2 font-medium text-muted-foreground">结果</div>
              <div className="break-all">{call.summary}</div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

export function ToolCallsPanel({ calls }: { calls: ToolCallRecord[] }): React.JSX.Element {
  const anyRunning = calls.some((c) => c.status === 'running')
  const [open, setOpen] = React.useState(anyRunning)

  React.useEffect(() => {
    if (anyRunning) setOpen(true)
  }, [anyRunning])

  if (calls.length === 0) return <></>

  return (
    <div className="my-2 space-y-1">
      <button
        type="button"
        className={cn(
          'flex items-center gap-1 text-[11.5px] font-medium text-muted-foreground transition-colors hover:text-foreground',
        )}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        工具调用 · {calls.length}
        {anyRunning && <Loader2 className="size-3 animate-spin text-primary" />}
      </button>
      {open && (
        <div className="space-y-1">
          {calls.map((call) => (
            <ToolCard key={call.id} call={call} />
          ))}
        </div>
      )}
    </div>
  )
}

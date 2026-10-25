/**
 * 工具调用卡片（§21.6）：名称/状态/摘要/参数折叠。
 * M39（§97，ADR 0150）：场景化变体路由——bi × db_query / db_schema → 取数管道卡；
 * sre × ssh_exec → 证据卡；其余场景 / 工具保持通用卡（数据同源 ToolCallRecord）。
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
  Clapperboard,
  FilePenLine,
  FileSpreadsheet,
  FileText,
  FolderTree,
  Frame,
  Globe,
  Image as ImageIcon,
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
// import { toast } from 'sonner' // 临时隐藏「在画布查看」（仅该入口用到）
import type { ToolCallRecord } from '@multi-agent/shared'
import { cn } from '../../lib/utils'
// import { useCanvasStore } from '../../stores/canvas-store' // 临时隐藏「在画布查看」
// import { useSessionStore } from '../../stores/session-store' // 临时隐藏「在画布查看」
// import { useUiStore } from '../../stores/ui-store' // 临时隐藏「在画布查看」
import { useSceneCtx } from '../scene/context'
import { DbPipelineCard } from './DbPipelineCard'
import { SshEvidenceCard } from './SshEvidenceCard'

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
  // M31 修订：画布创作工具集（消息 → 画布入口的语义标签）
  canvas_read: { label: '读取画布', icon: Frame },
  canvas_write: { label: '画布写入', icon: Frame },
  media_generate: { label: '生成图片', icon: ImageIcon },
  media_video: { label: '生成视频', icon: Clapperboard },
}

/** 可跳画布查看的工具（写入类；完成态时卡片行尾给「在画布查看」）
 *  临时隐藏画布：跳转入口已注释，集合与解析函数一并保留为注释
const CANVAS_TOOLS = new Set(['canvas_write', 'media_generate', 'media_video'])
*/

function argsPreview(args: Record<string, unknown>): string {
  const key = ['path', 'file_path', 'pattern', 'query', 'command', 'name', 'todos'].find((k) => k in args)
  if (!key) return JSON.stringify(args).slice(0, 80)
  const v = args[key]
  return `${key}: ${typeof v === 'string' ? v : JSON.stringify(v)}`.slice(0, 96)
}

/** M31 修订：从工具记录元信息解析画布节点 id（canvas_write / media_* 的 meta.canvasNodes）
 *  临时隐藏画布：与「在画布查看」同步注释
function canvasNodeIdsOf(call: ToolCallRecord): string[] | undefined {
  const raw = call.meta?.canvasNodes
  if (!Array.isArray(raw)) return undefined
  const ids = raw.filter((x): x is string => typeof x === 'string')
  return ids.length > 0 ? ids : undefined
}
*/

/** 「在画布查看」（M31 修订）：完成态的写入类工具行尾入口（切主区画布 Tab + 精确定位；无会话时引导）
 *  临时隐藏画布：入口整体注释
function CanvasJumpButton({ nodeIds }: { nodeIds?: string[] }): React.JSX.Element {
  return (
    <button
      type="button"
      title={nodeIds ? '切到画布并定位到此次写入的节点' : '切到画布查看'}
      className="flex shrink-0 items-center gap-0.5 rounded border px-1 py-px text-[10.5px] text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 hover:text-primary"
      onClick={(e) => {
        e.stopPropagation()
        if (!useSessionStore.getState().currentId) {
          toast.error('先选择一个会话再使用画布')
          return
        }
        useUiStore.getState().setMainTab('canvas')
        // M31 修订：带节点 id → 走 focus 动作（居中 + 选中 + 闪环；lazy 挂载后消费不丢）
        if (nodeIds) useCanvasStore.getState().requestAction('focus', { nodeIds })
      }}
    >
      <Frame className="size-3" aria-hidden />
      在画布查看
    </button>
  )
}
*/

export function ToolCard({ call }: { call: ToolCallRecord }): React.JSX.Element {
  const ctx = useSceneCtx()
  const groupId = ctx?.group?.id
  // M39（§97，ADR 0150）：场景化变体（非场景 / 未命中 → 通用卡）
  if (groupId === 'bi' && (call.name === 'db_query' || call.name === 'db_schema')) return <DbPipelineCard call={call} />
  if (groupId === 'sre' && call.name === 'ssh_exec') return <SshEvidenceCard call={call} />
  return <GenericToolCard call={call} />
}

function GenericToolCard({ call }: { call: ToolCallRecord }): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  const meta = TOOL_META[call.name] ?? { label: call.name, icon: Terminal }
  const Icon = meta.icon

  return (
    <div className="rounded-md border bg-muted/40 text-[12px]">
      <div className="flex w-full items-center gap-1.5 px-2 py-1.5">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
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
        {/* 临时隐藏「在画布查看」（恢复时取消本段注释）
        {CANVAS_TOOLS.has(call.name) && call.status === 'ok' && <CanvasJumpButton nodeIds={canvasNodeIdsOf(call)} />}
        */}
      </div>
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

/**
 * 工具调用面板（面板级折叠）：展开锚点 = 本回合是否仍在进行（streaming），
 * 而非单个工具的瞬时 running——一个回合内多批工具之间的空档不再「收起 → 再展开」（消除抖动）。
 * 回合进行中恒展开跟随进度，回合结束自动收起一次为一行摘要；历史消息默认收起。
 * 用户手动切换过（touched）后尊重其选择，不再自动干预（对齐思考块范式）。
 */
export function ToolCallsPanel({
  calls,
  streaming,
}: {
  calls: ToolCallRecord[]
  streaming: boolean
}): React.JSX.Element {
  const anyRunning = calls.some((c) => c.status === 'running')
  const [open, setOpen] = React.useState(streaming)
  const [touched, setTouched] = React.useState(false)

  React.useEffect(() => {
    // streaming 在回合内单调（true 恒 true 至回合结束），据此开合不会抖动
    if (!touched) setOpen(streaming)
  }, [streaming, touched])

  if (calls.length === 0) return <></>

  return (
    <div className="my-2 space-y-1">
      <button
        type="button"
        className={cn(
          'process-row flex items-center gap-1 text-[11.5px] font-medium text-muted-foreground transition-colors hover:text-foreground',
        )}
        onClick={() => {
          setTouched(true)
          setOpen((v) => !v)
        }}
      >
        <ChevronDown className={cn('size-3.5 transition-transform duration-200', open && 'rotate-180')} />
        工具调用 · {calls.length}
        {anyRunning && <Loader2 className="size-3 animate-spin text-primary" />}
      </button>
      {open && (
        <div className="animate-fade-in space-y-1">
          {calls.map((call) => (
            <ToolCard key={call.id} call={call} />
          ))}
        </div>
      )}
    </div>
  )
}

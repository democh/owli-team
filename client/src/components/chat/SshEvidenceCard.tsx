/**
 * M39（§97，SR-2，ADR 0150）：证据卡——sre 场景的 ssh_exec 工具卡变体（数据同源 ToolCallRecord；
 * 非 sre 场景保持通用 ToolCard）。
 * - 结构：等宽命令块（`$ 命令`）+ 输出折叠（meta.output，≤2000 字符）+ 截断提示；
 * - 审批联动：summary 含「审批被拒绝 / 审批超时」→ 拒绝类徽章；status=stopped → 「已取消」；
 * - meta 缺省（历史消息 / 拒绝路径）→ 仅命令块（取 args.command）+ summary 行。
 */
import * as React from 'react'
import { ChevronDown, ChevronRight, CircleSlash, Loader2, ShieldAlert, Terminal, XCircle } from 'lucide-react'
import type { ToolCallRecord } from '@multi-agent/shared'
import { cn } from '../../lib/utils'

export interface SshEvidenceMeta {
  command: string
  exitCode: number | null
  durationMs: number
  output: string
  truncated: boolean
}

/** meta → 证据数据（缺省 → undefined；命令回退 args.command） */
export function parseSshMeta(meta: Record<string, unknown> | undefined): SshEvidenceMeta | undefined {
  if (!meta) return undefined
  const command = typeof meta.command === 'string' ? meta.command : ''
  const exitCode = typeof meta.exitCode === 'number' ? meta.exitCode : null
  const durationMs = typeof meta.durationMs === 'number' ? meta.durationMs : 0
  const output = typeof meta.output === 'string' ? meta.output : ''
  const truncated = meta.truncated === true
  if (command === '' && output === '') return undefined
  return { command, exitCode, durationMs, output, truncated }
}

/** 输出行数（折叠按钮读数） */
function lineCountOf(text: string): number {
  if (text === '') return 0
  return text.split('\n').length
}

export function SshEvidenceCard({ call }: { call: ToolCallRecord }): React.JSX.Element {
  const [outOpen, setOutOpen] = React.useState(false)
  const meta = React.useMemo(() => parseSshMeta(call.meta), [call.meta])
  const command = meta?.command || (typeof call.args.command === 'string' ? call.args.command : '')
  const output = meta?.output ?? ''
  // 审批联动：拒绝 / 超时（error 态）与运行停止（stopped 态）分别标记
  const denied = call.status === 'error' && (call.summary?.includes('审批被拒绝') || call.summary?.includes('审批超时'))
  const lines = lineCountOf(output)

  return (
    <div className="rounded-md border border-lime-600/25 bg-card text-[12px]" data-ssh-evidence="">
      <div className="flex w-full items-center gap-1.5 px-2 py-1.5">
        {call.status === 'running' ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-lime-700" />
        ) : call.status === 'ok' ? (
          <Terminal className="size-3.5 shrink-0 text-lime-700" />
        ) : call.status === 'stopped' ? (
          <CircleSlash className="size-3.5 shrink-0 text-amber-600" />
        ) : (
          <XCircle className="size-3.5 shrink-0 text-destructive" />
        )}
        <span className="shrink-0 font-medium">证据</span>
        {typeof meta?.exitCode === 'number' ? (
          <span
            className={cn(
              'shrink-0 rounded-full px-1.5 text-[10px] font-medium leading-[1.7] tabular-nums',
              meta.exitCode === 0 ? 'bg-emerald-500/10 text-emerald-600' : 'bg-rose-500/10 text-rose-600',
            )}
            data-exit-code={meta.exitCode}
          >
            exit {meta.exitCode}
          </span>
        ) : null}
        {meta && meta.durationMs > 0 ? (
          <span className="shrink-0 rounded-full bg-lime-600/10 px-1.5 text-[10px] tabular-nums leading-[1.7] text-lime-700">
            {meta.durationMs}ms
          </span>
        ) : null}
        {meta?.truncated ? (
          <span className="shrink-0 rounded-full bg-amber-500/10 px-1.5 text-[10px] font-medium leading-[1.7] text-amber-600" data-ssh-truncated="">
            输出已截断
          </span>
        ) : null}
        {call.status === 'stopped' ? (
          <span className="shrink-0 rounded-full bg-amber-500/10 px-1.5 text-[10px] font-medium leading-[1.7] text-amber-600">已取消</span>
        ) : null}
        {denied ? (
          <span className="shrink-0 rounded-full bg-rose-500/10 px-1.5 text-[10px] font-medium leading-[1.7] text-rose-600" data-ssh-denied="">
            <ShieldAlert className="mr-0.5 inline size-2.5 align-[-1px]" />
            审批拒绝
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{call.summary ?? ''}</span>
      </div>

      <pre className="border-t border-lime-600/15 bg-muted/30 px-2 py-1.5 font-mono text-[11px] leading-5 whitespace-pre-wrap break-all">
        <span className="text-muted-foreground">$ </span>
        {command}
      </pre>

      {output !== '' ? (
        <div className="border-t border-lime-600/15">
          <button
            type="button"
            className="flex w-full items-center gap-1 px-2 py-1 text-left text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            aria-expanded={outOpen}
            data-ssh-output-toggle=""
            onClick={() => setOutOpen((v) => !v)}
          >
            {outOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            输出 · {lines} 行
          </button>
          {outOpen ? (
            <pre className="max-h-56 overflow-auto border-t border-lime-600/10 bg-muted/30 px-2 py-1.5 font-mono text-[11px] leading-5 whitespace-pre-wrap break-all">
              {output}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

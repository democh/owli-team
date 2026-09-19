/**
 * 审批卡（M8）：渲染本 Run 的 request_approval —— 命令原文 / 文件 diff / 批准 / 拒绝 / 自定义反馈。
 * 数据源：run-store.approvals（SSE approval:requested|resolved + 重附着 GET /runs/:id/approvals）。
 * 挂载：ChatArea 底部（Composer 上方），仅渲染当前会话的挂起项 + 结论行。
 * M12：首张挂起卡支持快捷键 —— ⌘/Ctrl+Enter 批准（反馈框打开时提交反馈）、⌘/Ctrl+Backspace 拒绝；
 * capture 阶段拦截，避免同时触发 Composer 的 Enter 发送。
 */
import * as React from 'react'
import { toast } from 'sonner'
import { Check, Loader2, ShieldAlert, X } from 'lucide-react'
import type { ApprovalRequest } from '@multi-agent/shared'
import { useAgentStore } from '../../stores/agent-store'
import { useRunStore } from '../../stores/run-store'
import { useSessionStore } from '../../stores/session-store'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Badge } from '../ui/badge'
import { AgentAvatar } from '../agents/AgentAvatar'

const DECISION_TEXT: Record<string, string> = {
  approve: '已批准',
  reject: '已拒绝',
  custom: '已附反馈',
}

function PendingCard({ approval, hotkey }: { approval: ApprovalRequest; hotkey?: boolean }): React.JSX.Element {
  const agents = useAgentStore((s) => s.agents)
  const respondApproval = useRunStore((s) => s.respondApproval)
  const [busy, setBusy] = React.useState<string>()
  const [customOpen, setCustomOpen] = React.useState(false)
  const [feedback, setFeedback] = React.useState('')

  const agent = approval.agentId ? agents.find((a) => a.id === approval.agentId) : undefined

  const decide = async (decision: 'approve' | 'reject' | 'custom'): Promise<void> => {
    if (busy) return
    if (decision === 'custom' && !feedback.trim()) {
      toast.error('请填写修改意见后再提交')
      return
    }
    setBusy(decision)
    try {
      await respondApproval(approval.id, decision, decision === 'custom' ? feedback.trim() : undefined)
      toast(decision === 'approve' ? '已批准，成员继续执行' : decision === 'reject' ? '已拒绝，成员将改换方案' : '已提交反馈')
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(undefined)
    }
  }

  // M12：快捷键监听总是调用最新一轮闭包（含最新 busy / customOpen / feedback），无需重新绑定
  const decideRef = React.useRef(decide)
  decideRef.current = decide

  React.useEffect(() => {
    if (!hotkey) return
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
      if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        void decideRef.current(customOpen ? 'custom' : 'approve')
      } else if (e.key === 'Backspace') {
        e.preventDefault()
        e.stopPropagation()
        void decideRef.current('reject')
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [hotkey, customOpen])

  return (
    <div className="mx-4 mb-2 overflow-hidden rounded-xl border border-amber-300/70 bg-amber-50/80 shadow-soft">
      <div className="flex items-center gap-2 border-b border-amber-200/70 px-3 py-2 text-[12px]">
        <ShieldAlert className="size-4 shrink-0 text-amber-600" />
        <span className="font-semibold text-amber-900">模型请求审批</span>
        <Badge variant="warning">{approval.action}</Badge>
        {agent && (
          <span className="flex items-center gap-1 text-[11px] text-amber-800/80">
            <AgentAvatar agent={agent} size={14} animated={false} className="rounded" />
            {agent.name}
          </span>
        )}
        <span className="ml-auto text-[10.5px] text-amber-700/70">
          {new Date(approval.createdAt).toLocaleTimeString('zh-CN', { hour12: false })}
        </span>
      </div>

      <div className="px-3 py-2">
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-lg border border-amber-200/70 bg-background/70 p-2.5 font-mono text-[11.5px] leading-5 text-foreground">
          {approval.detail}
        </pre>
        {approval.options.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {approval.options.map((opt) => (
              <span key={opt} className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10.5px] text-amber-800">
                {opt}
              </span>
            ))}
          </div>
        )}

        {customOpen && (
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            rows={2}
            autoFocus
            placeholder="填写修改意见（模型将据此调整方案）…"
            className="mt-2 block w-full resize-none rounded-lg border bg-background px-2.5 py-2 text-[12.5px] leading-5 focus:border-primary/40 focus:outline-none focus:ring-[3px] focus:ring-primary/12"
          />
        )}

        <div className="mt-2 flex items-center gap-1.5">
          <Button size="sm" className="h-7 text-[12px]" disabled={!!busy} onClick={() => void decide('approve')}>
            {busy === 'approve' ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3.5" />}
            批准
            {hotkey && (
              <kbd className="ml-0.5 rounded border border-primary-foreground/25 bg-primary-foreground/15 px-1 font-mono text-[9.5px] leading-3.5">
                ⌘⏎
              </kbd>
            )}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-[12px]"
            disabled={!!busy}
            onClick={() => void decide('reject')}
          >
            {busy === 'reject' ? <Loader2 className="size-3 animate-spin" /> : <X className="size-3.5" />}
            拒绝
            {hotkey && (
              <kbd className="ml-0.5 rounded border bg-muted px-1 font-mono text-[9.5px] leading-3.5 text-muted-foreground">
                ⌘⌫
              </kbd>
            )}
          </Button>
          {customOpen ? (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[12px]"
              disabled={!!busy}
              onClick={() => void decide('custom')}
            >
              {busy === 'custom' && <Loader2 className="size-3 animate-spin" />}
              提交反馈
            </Button>
          ) : (
            <Button variant="ghost" size="sm" className="h-7 text-[12px]" onClick={() => setCustomOpen(true)}>
              自定义反馈…
            </Button>
          )}
          <span className="ml-auto text-[10.5px] text-amber-700/70">
            超时将自动拒绝
          </span>
        </div>
      </div>
    </div>
  )
}

function ResolvedRow({ approval }: { approval: ApprovalRequest }): React.JSX.Element {
  const ok = approval.status === 'approved'
  return (
    <div className="mx-4 mb-2 flex items-center gap-2 rounded-lg border bg-card/70 px-3 py-1.5 text-[11.5px] text-muted-foreground">
      {ok ? <Check className="size-3.5 text-emerald-600" /> : <X className="size-3.5 text-rose-500" />}
      <span className="font-medium text-foreground">{approval.action}</span>
      <span>{DECISION_TEXT[approval.decision ?? ''] ?? DECISION_TEXT[approval.status] ?? approval.status}</span>
      {approval.feedback && <span className="min-w-0 truncate">· {approval.feedback}</span>}
    </div>
  )
}

export function ApprovalPanel(): React.JSX.Element | null {
  const currentId = useSessionStore((s) => s.currentId)
  const approvals = useRunStore((s) => s.approvals)
  const mine = approvals.filter((a) => a.sessionId === currentId)
  if (!currentId || mine.length === 0) return null

  const pending = mine.filter((a) => a.status === 'pending')
  const resolved = mine.filter((a) => a.status !== 'pending').slice(-2)

  return (
    <div className={cn('shrink-0 pt-2', pending.length === 0 && 'pt-0')}>
      {pending.map((a, i) => (
        <PendingCard key={a.id} approval={a} hotkey={i === 0} />
      ))}
      {pending.length === 0 && resolved.map((a) => <ResolvedRow key={a.id} approval={a} />)}
    </div>
  )
}

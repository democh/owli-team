/**
 * 审批卡（M8）：渲染本 Run 的 request_approval —— 命令原文 / 文件 diff / 批准 / 拒绝 / 自定义反馈。
 * 数据源：run-store.approvals（SSE approval:requested|resolved + 重附着 GET /runs/:id/approvals）。
 * 挂载：ChatArea 底部（Composer 上方），仅渲染当前会话的挂起项——
 * 已决条不再以结论行常驻（2026-09-25 产品决策：空间治理；历史由消息流承接，零占位）。
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
import { Button } from '../ui/button'
import { Badge } from '../ui/badge'
import { AgentAvatar } from '../agents/AgentAvatar'

function PendingCard({
  approval,
  hotkey,
  readOnly,
}: {
  approval: ApprovalRequest
  hotkey?: boolean
  /** M79-AF：只读共享（viewer）——不渲染决策按钮与快捷键（服务端另有 403 兜底） */
  readOnly?: boolean
}): React.JSX.Element {
  const agents = useAgentStore((s) => s.agents)
  const respondApproval = useRunStore((s) => s.respondApproval)
  const [busy, setBusy] = React.useState<string>()
  const [customOpen, setCustomOpen] = React.useState(false)
  const [feedback, setFeedback] = React.useState('')

  const agent = approval.agentId ? agents.find((a) => a.id === approval.agentId) : undefined

  const decide = async (decision: 'approve' | 'reject' | 'custom'): Promise<void> => {
    if (busy || readOnly) return
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
    if (!hotkey || readOnly) return
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
            <AgentAvatar agent={agent} size={14} animated={false} />
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
          {readOnly ? (
            <span className="text-[11px] text-amber-800/90">
              只读共享（viewer）：无审批权限，是否放行由发起本轮的成员决定
            </span>
          ) : (
            <>
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
            </>
          )}
          <span className="ml-auto text-[10.5px] text-amber-700/70">
            超时将自动拒绝
          </span>
        </div>
      </div>
    </div>
  )
}

export function ApprovalPanel(): React.JSX.Element | null {
  const currentId = useSessionStore((s) => s.currentId)
  const approvals = useRunStore((s) => s.approvals)
  // M79-AF：只读共享（viewer）→ 审批卡仅展示、不渲染决策按钮（服务端另有定向 + 403 兜底）
  const role = useSessionStore((s) => s.current?.role)
  const readOnly = role === 'viewer'
  const mine = approvals.filter((a) => a.sessionId === currentId)
  if (!currentId) return null
  const pending = mine.filter((a) => a.status === 'pending')
  // 无挂起项 → 整体不渲染（已决条不常驻；零占位）
  if (pending.length === 0) return null
  return (
    <div className="shrink-0 pt-2">
      {pending.map((a, i) => (
        <PendingCard key={a.id} approval={a} hotkey={i === 0} readOnly={readOnly} />
      ))}
    </div>
  )
}

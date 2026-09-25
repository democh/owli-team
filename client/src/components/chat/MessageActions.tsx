/**
 * 消息操作菜单（M8/M9）：复制 / 引用到输入框 / 重新生成 / 编辑重发 / 从这条 fork / 删除 / 反馈。
 * - 重新生成：POST /api/runs/:runId/messages/:id/regenerate（仅文本，不重放工具副作用）→ 附着新 Run；
 * - 继续生成（M4）：POST /api/runs/:runId/messages/:id/resume（续写已中断消息，不重跑已完成部分）→ 附着新 Run；
 * - 编辑重发：打开 MessageItem 内联编辑（ui-store.editingMessageId）；
 * - 从这条 fork：POST /api/sessions/:id/fork → 切到新分支会话；
 * - 删除：两段式确认（避免误触）；
 * - 反馈（M9）：👍/👎 + 可选原因 → POST /api/feedback（导出为评测候选集）。
 * 运行中（active）的操作由服务端守卫拒绝，这里同步禁用并给出原因。
 */
import * as React from 'react'
import { toast } from 'sonner'
import {
  Copy,
  GitBranch,
  Loader2,
  MessageSquarePlus,
  MoreHorizontal,
  Play,
  Quote,
  RefreshCw,
  SquarePen,
  ThumbsDown,
  ThumbsUp,
  Trash2,
} from 'lucide-react'
import type { FeedbackItem, Session } from '@multi-agent/shared'
import { apiDelete, apiGet, apiPost } from '../../lib/api'
import { baseName } from '../../lib/artifacts'
import { commentDraft } from '../../lib/focus-artifact'
import { labelOfMemberKey } from '../../lib/members'
import { cn } from '../../lib/utils'
import { useAgentStore } from '../../stores/agent-store'
import { useAuthStore } from '../../stores/auth-store'
import { attachActiveRunFor, useRunStore } from '../../stores/run-store'
import { useSessionStore } from '../../stores/session-store'
import { useUiStore } from '../../stores/ui-store'
import { useWsStore } from '../../stores/ws-store'
import { Button } from '../ui/button'

interface MenuItemProps {
  icon: React.JSX.Element
  label: string
  danger?: boolean
  disabled?: boolean
  title?: string
  onClick: () => void
}

function MenuItem({ icon, label, danger, disabled, title, onClick }: MenuItemProps): React.JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors',
        danger ? 'text-rose-600 hover:bg-rose-500/10' : 'hover:bg-accent/70',
        disabled && 'cursor-not-allowed opacity-45 hover:bg-transparent',
      )}
    >
      {icon}
      {label}
    </button>
  )
}

export function MessageActions({
  messageId,
  align = 'end',
}: {
  messageId: string
  align?: 'start' | 'end'
}): React.JSX.Element | null {
  const message = useSessionStore((s) => s.byId.get(messageId))
  const currentId = useSessionStore((s) => s.currentId)
  const latestRun = useSessionStore((s) => s.latestRun)
  const active = useRunStore((s) => s.active)
  const attach = useRunStore((s) => s.attach)
  const insertToComposer = useUiStore((s) => s.insertToComposer)
  const startEditMessage = useUiStore((s) => s.startEditMessage)

  const [open, setOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const [feedback, setFeedback] = React.useState<FeedbackItem | null>(null)
  const [reasonMode, setReasonMode] = React.useState(false)
  const [reason, setReason] = React.useState('')
  const rootRef = React.useRef<HTMLDivElement>(null)
  // M79-AF：写项展示 gating（服务端为准；兼容模式 role/userId 缺省 → 全放行零变化）
  const myUserId = useAuthStore((s) => s.user?.id)
  const myRole = useSessionStore((s) => s.current?.role)

  // M9：打开菜单时同步已有反馈状态
  const feedbackTargetId = message?.id
  React.useEffect(() => {
    if (!open || !feedbackTargetId) return
    setReasonMode(false)
    setReason('')
    void apiGet<{ item: FeedbackItem | null }>(`/api/feedback?messageId=${encodeURIComponent(feedbackTargetId)}`)
      .then((res) => setFeedback(res.item))
      .catch(() => undefined)
  }, [open, feedbackTargetId])

  // 外部点击 / Escape 关闭
  React.useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false)
        setConfirmDelete(false)
      }
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setOpen(false)
        setConfirmDelete(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!message || !currentId) return null

  const close = (): void => {
    setOpen(false)
    setConfirmDelete(false)
  }

  const guard = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
      close()
    }
  }

  const copy = (): void => {
    void guard(async () => {
      await navigator.clipboard.writeText(message.content)
      toast.success('已复制消息内容')
    })
  }

  const quote = (): void => {
    const quoted = message.content
      .slice(0, 400)
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n')
    insertToComposer(`${quoted}\n\n`)
    toast.success('已引用到输入框')
    close()
  }

  /** M44（AF-3）：提意见——“@作者 对《交付名》的意见：”模板入草稿（无作者退化为纯引用；不直发）
   *  M77：@ 署名按成员实例（分身 = 名字·灵魂名，草稿点名到具体实例）
   */
  const comment = (): void => {
    const first = message.artifacts?.[0]
    if (!first) return
    const agents = useAgentStore.getState().agents
    const sessionStore = useSessionStore.getState()
    const session = sessionStore.sessions.find((s) => s.id === sessionStore.currentId)
    const key = message.memberKey ?? message.agentId
    const name = key ? labelOfMemberKey(agents, session, key) : undefined
    insertToComposer(name ? commentDraft(name, first) : `对《${baseName(first)}》的意见：`)
    toast.success('已写入提意见草稿')
    close()
  }

  const regenerate = (): void =>
    void guard(async () => {
      const runId = message.runId ?? latestRun?.id
      if (!runId) throw new Error('找不到该消息所属的运行，无法重新生成')
      const res = await apiPost<{ runId: string }>(`/api/runs/${runId}/messages/${message.id}/regenerate`)
      attach(res.runId, currentId)
    })

  /** M4：继续生成——续写已中断（stopped / error）消息的剩余内容（服务端守卫不可续写态） */
  const resume = (): void =>
    void guard(async () => {
      const runId = message.runId ?? latestRun?.id
      if (!runId) throw new Error('找不到该消息所属的运行，无法继续生成')
      const res = await apiPost<{ runId: string }>(`/api/runs/${runId}/messages/${message.id}/resume`)
      attach(res.runId, currentId)
    })

  const edit = (): void => {
    startEditMessage(message.id)
    close()
  }

  const fork = (): void =>
    void guard(async () => {
      const res = await apiPost<{ session: Session }>(`/api/sessions/${currentId}/fork`, {
        fromMessageId: message.id,
      })
      await useSessionStore.getState().loadSessions()
      await useSessionStore.getState().selectSession(res.session.id)
      useWsStore.getState().ensureSubscribed(res.session.id)
      // 切换会话后重附着：分支会话无进行中运行 → 同步断开本地旧流，防跨会话运行状态残留
      void attachActiveRunFor(res.session.id)
      toast.success(`已创建分支会话：${res.session.title}`)
    })

  const remove = (): void => {
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    void guard(async () => {
      await apiDelete(`/api/sessions/${currentId}/messages/${message.id}`)
      useSessionStore.getState().removeMessage(message.id)
      toast.success('已删除该消息')
    })
  }

  const isUser = message.role === 'user'
  // M79-AF：写项可见性（与服务端口径一致；兼容模式 / 历史消息缺 userId → 放行零变化）——
  // 编辑 = 作者本人；删除 = 作者 / 属主（agent/system 不受限）；运行写项（重生成 / 续写 / fork）= 非 viewer
  const isViewer = myRole === 'viewer'
  const isSessionOwner = !myRole || myRole === 'owner'
  const mineHuman = !!message.userId && !!myUserId && message.userId === myUserId
  const canEdit = isUser && (!message.userId || !myUserId || mineHuman)
  const canDelete = !isViewer && (!isUser || !message.userId || !myUserId || mineHuman || isSessionOwner)
  const busyReason = active ? '运行中暂不可操作' : undefined
  /** M4：可续写态（已中断且有正文；streaming / complete 与空正文由服务端守卫拒绝） */
  const resumable = !isUser && (message.status === 'stopped' || message.status === 'error') && message.content.trim().length > 0

  /** M9：反馈提交（rating 1/-1 + 可选原因；同消息覆盖） */
  const submitFeedback = (rating: 1 | -1, text?: string): void => {
    void guard(async () => {
      const res = await apiPost<{ item: FeedbackItem }>('/api/feedback', {
        sessionId: currentId,
        messageId: message.id,
        rating,
        reason: text?.trim() ? text.trim() : undefined,
      })
      setFeedback(res.item)
      toast(rating > 0 ? '已标记：有帮助' : '已记录：待改进')
    })
  }

  const feedbackLabel = feedback ? `已反馈：${feedback.rating > 0 ? '👍 有帮助' : '👎 待改进'}` : undefined

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        type="button"
        aria-label="消息操作"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="rounded p-0.5 text-muted-foreground/70 transition-colors hover:bg-accent/70 hover:text-foreground"
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <MoreHorizontal className="size-3.5" />}
      </button>

      {open && (
        <div
          role="menu"
          className={cn(
            'absolute top-full z-30 mt-1 rounded-lg border bg-popover p-1 shadow-lg shadow-slate-900/10 animate-fade-in',
            reasonMode ? 'w-56' : 'w-44',
            align === 'end' ? 'right-0' : 'left-0',
          )}
        >
          <MenuItem icon={<Copy className="size-3.5" />} label="复制" onClick={copy} />
          <MenuItem icon={<Quote className="size-3.5" />} label="引用到输入框" onClick={quote} />
          {!isUser && message.artifacts && message.artifacts.length > 0 ? (
            <MenuItem
              icon={<MessageSquarePlus className="size-3.5" />}
              label="提意见（对交付件）"
              title={`对《${baseName(message.artifacts[0]!)}》写意见草稿（可编辑后发送）`}
              onClick={comment}
            />
          ) : null}
          {isUser ? (
            canEdit ? (
              <MenuItem
                icon={<SquarePen className="size-3.5" />}
                label="编辑重发"
                disabled={active}
                title={busyReason}
                onClick={edit}
              />
            ) : null
          ) : (
            <>
              {!isViewer && resumable ? (
                <MenuItem
                  icon={<Play className="size-3.5" />}
                  label="继续生成"
                  title="从中断处续写剩余内容（不重复已完成部分）"
                  disabled={active}
                  onClick={resume}
                />
              ) : null}
              {!isViewer ? (
                <MenuItem
                  icon={<RefreshCw className="size-3.5" />}
                  label="重新生成"
                  disabled={active || message.status === 'streaming'}
                  title={busyReason}
                  onClick={regenerate}
                />
              ) : null}
            </>
          )}
          {!isViewer ? (
            <MenuItem
              icon={<GitBranch className="size-3.5" />}
              label="从这条 fork"
              disabled={active}
              title={busyReason}
              onClick={fork}
            />
          ) : null}
          {canDelete ? (
            <MenuItem
              icon={<Trash2 className="size-3.5" />}
              label={confirmDelete ? '确认删除？' : '删除'}
              danger
              disabled={active}
              title={busyReason}
              onClick={remove}
            />
          ) : null}

          <div className="my-1 h-px bg-border" />
          {reasonMode ? (
            <div className="space-y-1.5 p-1">
              <textarea
                value={reason}
                autoFocus
                rows={3}
                maxLength={2000}
                placeholder="哪里需要改进？（可选）"
                className="w-full resize-none rounded-md border bg-background px-2 py-1.5 text-[11.5px] leading-5 outline-none focus:border-primary/50"
                onChange={(e) => setReason(e.target.value)}
              />
              <div className="flex gap-1">
                <Button size="xs" variant="outline" className="flex-1" onClick={() => submitFeedback(-1, reason)}>
                  提交
                </Button>
                <Button size="xs" variant="ghost" className="flex-1" onClick={() => submitFeedback(-1)}>
                  跳过原因
                </Button>
              </div>
            </div>
          ) : (
            <>
              <MenuItem
                icon={<ThumbsUp className={cn('size-3.5', feedback?.rating === 1 && 'text-emerald-600')} />}
                label={feedback?.rating === 1 ? '有帮助（已标记）' : '标记有帮助'}
                onClick={() => submitFeedback(1)}
              />
              <MenuItem
                icon={<ThumbsDown className={cn('size-3.5', feedback?.rating === -1 && 'text-rose-600')} />}
                label={feedback?.rating === -1 ? '待改进（已标记）' : '标记待改进'}
                onClick={() => setReasonMode(true)}
              />
              {feedbackLabel && feedback?.reason && (
                <p className="px-2 pb-0.5 pt-1 text-[10.5px] leading-4 text-muted-foreground">
                  原因：{feedback.reason.slice(0, 60)}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

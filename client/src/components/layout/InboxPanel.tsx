/**
 * M79-I：通知中心（持久收件箱的 UI 落点——设计 §9.3 三层投递的可复看面）。
 *
 * - 入口：顶栏「通知」按钮 + 未读数徽章（inbox unreadCount；仅多用户模式渲染）；
 * - 列表：跨会话个人事件（好友申请 / 已同意 / 会话邀请 / @提及 / 等你回复 / 系统）按 seq 新在上；
 * - 交互：点击条目 → 单项已读 + 跳转（会话 → 打开并订阅；好友类 → 联系人页签）；「全部已读」；
 * - 关闭：外部点击 / Escape（复用 MessageActions 的 rootRef 模式）。
 */
import * as React from 'react'
import { AtSign, CheckCheck, Hourglass, Inbox, Info, Mail, UserCheck, UserPlus } from 'lucide-react'
import type { InboxItem, InboxType } from '@multi-agent/shared'
import { openConversation, openContacts } from '../../lib/navigation'
import { useAuthStore } from '../../stores/auth-store'
import { useInboxStore } from '../../stores/inbox-store'
import { Button } from '../ui/button'
import { cn } from '../../lib/utils'
import { timeAgo } from '../../lib/time'

const TYPE_META: Record<InboxType, { label: string; Icon: typeof Inbox }> = {
  'friend-request': { label: '好友申请', Icon: UserPlus },
  'friend-accepted': { label: '好友', Icon: UserCheck },
  'session-invite': { label: '会话邀请', Icon: Mail },
  mention: { label: '提及', Icon: AtSign },
  waiting: { label: '等你回复', Icon: Hourglass },
  system: { label: '系统', Icon: Info },
}

export function InboxPanel(): React.JSX.Element | null {
  const multiUser = useAuthStore((s) => s.status.multiUser)
  const items = useInboxStore((s) => s.items)
  const unreadCount = useInboxStore((s) => s.unreadCount)
  const [open, setOpen] = React.useState(false)
  const rootRef = React.useRef<HTMLDivElement>(null)

  // 外部点击 / Escape 关闭
  React.useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!multiUser) return null
  const ordered = [...items].sort((a, b) => b.seq - a.seq)

  const openItem = (item: InboxItem): void => {
    if (item.sessionId) {
      void openConversation(item.sessionId).then((opened) => {
        if (!opened) return
        setOpen(false)
        void useInboxStore.getState().ack([item.id])
      })
      return
    }
    if ((item.type === 'friend-request' || item.type === 'friend-accepted') && !openContacts()) return
    setOpen(false)
    void useInboxStore.getState().ack([item.id])
  }

  return (
    <div className="relative" ref={rootRef}>
      <Button
        variant="ghost"
        size="icon-sm"
        className="relative"
        title={unreadCount > 0 ? `通知中心（${unreadCount} 条未读）` : '通知中心'}
        onClick={() => setOpen((v) => !v)}
      >
        <Inbox className="size-4" />
        {unreadCount > 0 && (
          <span className="absolute -right-1 -top-0.5 flex h-[15px] min-w-[15px] items-center justify-center rounded-full border-2 border-background bg-destructive px-1 text-[9px] font-semibold leading-none tabular-nums text-destructive-foreground">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </Button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-80 max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-xl shadow-slate-900/10">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="text-[12.5px] font-medium">通知</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[11.5px] text-muted-foreground"
              disabled={unreadCount === 0}
              onClick={() => void useInboxStore.getState().ackAll()}
            >
              <CheckCheck className="mr-1 size-3.5" />
              全部已读
            </Button>
          </div>
          <div className="max-h-80 overflow-y-auto p-1.5">
            {ordered.length === 0 ? (
              <p className="px-2 py-8 text-center text-[12px] text-muted-foreground">暂无通知</p>
            ) : (
              ordered.map((item) => {
                const meta = TYPE_META[item.type]
                const Icon = meta.Icon
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={cn('flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent/60')}
                    onClick={() => openItem(item)}
                  >
                    <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                      <Icon className="size-3.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-[12.5px]">{item.title}</span>
                        {!item.readAt && <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label="未读" />}
                      </span>
                      <span className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                        <span className="shrink-0 rounded-full bg-muted px-1.5 leading-4">{meta.label}</span>
                        <span className="shrink-0">{timeAgo(item.createdAt)}</span>
                        {item.body && <span className="min-w-0 truncate">{item.body}</span>}
                      </span>
                    </span>
                  </button>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}

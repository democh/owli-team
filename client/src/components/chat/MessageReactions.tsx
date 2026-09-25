/**
 * M80-B：消息表情回应（docs/emoji-and-readreceipt-design.md §5.3）。
 *
 * - ReactionChips：气泡下方聚合条（emoji + 计数；自己挂过的高亮；悬停显示回应者名单）；
 * - ReactionPickerButton：悬停工具条「+表情」入口（快捷 6 个 + 「更多」完整面板 compact）；
 * - toggle 语义：已挂 → DELETE 摘除；未挂 → PUT；mine 本地按 userIds.includes(本人) 推导；
 * - viewer 只读不渲染入口（服务端 403 同口径兜底）。
 */
import * as React from 'react'
import { SmilePlus } from 'lucide-react'
import { toast } from 'sonner'
import type { ChatMessage, ReactionSummary } from '@multi-agent/shared'
import { apiDelete, apiPut } from '../../lib/api'
import { useAuthStore } from '../../stores/auth-store'
import { useSessionStore } from '../../stores/session-store'
import { cn } from '../../lib/utils'
import { EmojiPicker } from './EmojiPicker'
import { HumanAvatar } from './HumanAvatar'

/** 快捷条直出表情（高频 6 个） */
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '👌', '🙏']

/** toggle 一个回应（PUT/DELETE；服务端幂等；错误直通 toast） */
export async function toggleReaction(message: ChatMessage, emoji: string, mine: boolean): Promise<void> {
  try {
    const res = await (mine
      ? apiDelete<{ reactions: ReactionSummary[] }>(
          `/api/sessions/${message.sessionId}/messages/${message.id}/reactions?emoji=${encodeURIComponent(emoji)}`,
        )
      : apiPut<{ reactions: ReactionSummary[] }>(
          `/api/sessions/${message.sessionId}/messages/${message.id}/reactions`,
          { emoji },
        ))
    useSessionStore.getState().patchMessage(message.id, { reactions: res.reactions })
  } catch (err) {
    toast.error((err as Error).message || '操作失败，请重试')
  }
}

/** 聚合条（气泡下方；无回应不渲染） */
export function ReactionChips({ message }: { message: ChatMessage }): React.JSX.Element | null {
  const humanProfiles = useSessionStore((s) => s.humanProfiles)
  const humanNames = useSessionStore((s) => s.humanNames)
  const reactions = message.reactions
  if (!reactions || reactions.length === 0) return null
  const nameOf = (uid: string): string => humanProfiles[uid]?.name ?? humanNames[uid] ?? '成员'
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {reactions.map((r) => (
        <button
          key={r.emoji}
          type="button"
          title={r.userIds.map(nameOf).join('、')}
          aria-label={`${r.emoji} ${r.count} 人：${r.userIds.map(nameOf).join('、')}`}
          onClick={() => void toggleReaction(message, r.emoji, r.mine)}
          className={cn(
            'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[12px] leading-none transition-colors',
            r.mine
              ? 'border-primary/40 bg-primary/10 text-primary'
              : 'border-border/70 bg-muted/60 text-muted-foreground hover:border-primary/30 hover:bg-primary/5',
          )}
        >
          <span className="text-[13px]">{r.emoji}</span>
          <span className="text-[10.5px] font-medium tabular-nums">{r.count}</span>
        </button>
      ))}
    </div>
  )
}

/** 悬停工具条入口：快捷 6 连 + 「更多」完整面板（popover 单例，自身管理开关） */
export function ReactionPickerButton({ message, disabled }: { message: ChatMessage; disabled?: boolean }): React.JSX.Element {
  const myUserId = useAuthStore((s) => s.user?.id)
  const [open, setOpen] = React.useState(false)
  const [more, setMore] = React.useState(false)
  const rootRef = React.useRef<HTMLSpanElement>(null)

  React.useEffect(() => {
    if (!open) return
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') {
        ev.stopPropagation()
        setOpen(false)
        setMore(false)
      }
    }
    const onDown = (ev: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(ev.target as Node)) {
        setOpen(false)
        setMore(false)
      }
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])

  const mineOf = (emoji: string): boolean =>
    !!myUserId && (message.reactions ?? []).some((r) => r.emoji === emoji && r.userIds.includes(myUserId))

  const pick = (emoji: string): void => {
    setOpen(false)
    setMore(false)
    void toggleReaction(message, emoji, mineOf(emoji))
  }

  if (disabled) return <></>

  return (
    <span ref={rootRef} className="relative inline-flex">
      <button
        type="button"
        title="表情回应"
        aria-label="表情回应"
        onClick={() => setOpen((o) => !o)}
        className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <SmilePlus className="size-3.5" />
      </button>
      {open && (
        <span className="absolute bottom-full right-0 z-40 mb-1 block">
          {more ? (
            <EmojiPicker variant="compact" onPick={pick} onClose={() => setOpen(false)} />
          ) : (
            <span className="flex items-center gap-0.5 rounded-full border bg-popover px-1.5 py-1 shadow-lg">
              {QUICK_REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  aria-label={emoji}
                  onClick={() => pick(emoji)}
                  className={cn(
                    'flex size-7 items-center justify-center rounded-full text-[16px] transition-transform hover:scale-110 hover:bg-primary/10',
                    mineOf(emoji) && 'bg-primary/15',
                  )}
                >
                  {emoji}
                </button>
              ))}
              <button
                type="button"
                title="更多表情"
                aria-label="更多表情"
                onClick={() => setMore(true)}
                className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-primary/10 hover:text-foreground"
              >
                <SmilePlus className="size-4" />
              </button>
            </span>
          )}
        </span>
      )}
    </span>
  )
}

/** 悬停名单小头像组（预留：ReactionChips 的 title 已含名单；需要头像条时可启用） */
export function ReactionFaces({ userIds }: { userIds: string[] }): React.JSX.Element {
  const humanProfiles = useSessionStore((s) => s.humanProfiles)
  const humanNames = useSessionStore((s) => s.humanNames)
  return (
    <span className="inline-flex -space-x-1">
      {userIds.slice(0, 5).map((uid) => (
        <HumanAvatar key={uid} avatar={humanProfiles[uid]?.avatar} name={humanProfiles[uid]?.name ?? humanNames[uid] ?? '成员'} size={16} />
      ))}
    </span>
  )
}

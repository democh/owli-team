/** IM：会话头部「正在输入」提示（6s 无新帧自动消失；本人多端不回显）。 */
import * as React from 'react'
import { useAuthStore } from '../../stores/auth-store'
import { useWsStore } from '../../stores/ws-store'

export function TypingIndicator({ sessionId }: { sessionId?: string }): React.JSX.Element | null {
  const entries = useWsStore((s) => (sessionId ? s.typing[sessionId] : undefined))
  const myUserId = useAuthStore((s) => s.user?.id)
  const others = (entries ?? []).filter((x) => x.userId !== myUserId)
  if (!sessionId || others.length === 0) return null
  const names = others.map((x) => x.name ?? '成员')
  const label =
    names.length === 1
      ? `${names[0]} 正在输入`
      : names.length === 2
        ? `${names[0]}、${names[1]} 正在输入`
        : `${names.length} 人正在输入`
  return (
    <span className="flex shrink-0 items-center gap-1 text-[11.5px] text-primary/80" role="status" aria-live="polite">
      {label}
      <span className="flex items-end gap-[2px]" aria-hidden>
        {[0, 1, 2].map((i) => (
          <span key={i} className="pa-dot size-1 rounded-full bg-primary/70" style={{ animationDelay: `${i * 0.18}s` }} />
        ))}
      </span>
    </span>
  )
}

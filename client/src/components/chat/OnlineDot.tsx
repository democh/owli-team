/**
 * M79-G/H：在线点（绿 = 在线；灰 = 离线 / 未知）。
 * 联系人列表 / 成员弹窗 / @ 候选共用（可见域 = 好友 ∪ 同会话成员）；
 * 联系人面可传 `lastSeenAt` → 离线时 tooltip 显示「最后在线：x 分钟前」。
 */
import * as React from 'react'
import { cn } from '../../lib/utils'
import { timeAgo } from '../../lib/time'

export function OnlineDot({
  online,
  lastSeenAt,
  className,
}: {
  online?: boolean
  lastSeenAt?: string
  className?: string
}): React.JSX.Element {
  const title = online ? '在线' : lastSeenAt ? `最后在线：${timeAgo(lastSeenAt)}` : '离线'
  return (
    <span
      aria-label={online ? '在线' : '离线'}
      title={title}
      className={cn('size-1.5 shrink-0 rounded-full', online ? 'bg-emerald-500' : 'bg-muted-foreground/40', className)}
    />
  )
}

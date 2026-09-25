/**
 * M80-C：已读 / 未读徽章（docs/emoji-and-readreceipt-design.md §6）。
 *
 * - 语义：水位推导——成员 lastReadSeq >= 本消息 seq 即已读（零逐条已读表）；
 * - 只对「本人最后一条人类消息」渲染（历史消息状态可推导，逐条渲染是噪音）；
 * - 私聊（对端一人）：已读 / 未读；群聊 / 团队：N/M 人已读（悬停名单）；
 * - 分母 = memberReads 投影中的其他成员（已过滤停用账号与关闭开关者——对等原则）；
 * - 对等双向：本人关闭开关时整徽章不渲染（既不投影自己的已读，也不消费他人已读）；
 * - memberReads 为空（兼容模式 / 单人会话）不渲染。
 */
import * as React from 'react'
import type { ChatMessage } from '@multi-agent/shared'
import { useAuthStore } from '../../stores/auth-store'
import { useSessionStore } from '../../stores/session-store'
import { cn } from '../../lib/utils'

export function ReadReceiptBadge({ message }: { message: ChatMessage }): React.JSX.Element | null {
  const myUserId = useAuthStore((s) => s.user?.id)
  const receiptsOn = useAuthStore((s) => s.readReceiptsOn)
  const memberReads = useSessionStore((s) => s.memberReads)
  const humanProfiles = useSessionStore((s) => s.humanProfiles)
  const humanNames = useSessionStore((s) => s.humanNames)
  if (!myUserId || !receiptsOn || message.userId !== myUserId || message.role !== 'user') return null
  const seq = message.seq ?? 0
  const others = memberReads.filter((m) => m.userId !== myUserId)
  if (others.length === 0) return null
  const readBy = others.filter((m) => m.lastReadSeq >= seq)
  const nameOf = (uid: string): string => humanProfiles[uid]?.name ?? humanNames[uid] ?? '成员'

  if (others.length === 1) {
    // 私聊：二态徽章
    const read = readBy.length === 1
    return (
      <span
        className={cn('text-[10.5px] tabular-nums', read ? 'text-primary' : 'text-muted-foreground/70')}
        title={read ? `${nameOf(others[0].userId)} 已读` : '对方还未读到本条'}
      >
        {read ? '已读' : '未读'}
      </span>
    )
  }
  // 群聊 / 团队：计数 + 悬停名单
  return (
    <span
      className={cn('text-[10.5px] tabular-nums', readBy.length > 0 ? 'text-primary' : 'text-muted-foreground/70')}
      title={
        readBy.length > 0
          ? `已读：${readBy.map((m) => nameOf(m.userId)).join('、')}\n未读：${others.filter((m) => m.lastReadSeq < seq).map((m) => nameOf(m.userId)).join('、') || '（无）'}`
          : '还没有成员读到本条'
      }
    >
      {readBy.length > 0 ? `${readBy.length}/${others.length} 人已读` : '未读'}
    </span>
  )
}

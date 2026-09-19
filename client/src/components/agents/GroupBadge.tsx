/**
 * 场景徽标（M16）：场景 icon + 名称的小 chip，主题色点缀。
 * 建会话场景卡片 / 团队成员分组小节 / 名录页共用；缺 theme 时回退中性色。
 */
import * as React from 'react'
import type { AgentGroup } from '@multi-agent/shared'
import { resolveIcon } from '../../lib/avatar-icons'
import { cn } from '../../lib/utils'

export function GroupBadge({
  group,
  showName = true,
  className,
}: {
  group: AgentGroup
  showName?: boolean
  className?: string
}): React.JSX.Element {
  const Icon = resolveIcon(group.icon)
  const color = group.theme[0]
  return (
    <span
      className={cn('inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10.5px] font-medium', className)}
      style={{ backgroundColor: `${color}1f`, color }}
      title={group.description}
    >
      <Icon className="size-3 shrink-0" />
      {showName && group.name}
    </span>
  )
}

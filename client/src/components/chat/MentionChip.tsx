/**
 * @chip 渲染（§10.5）：按角色主色着色，未知 token 归用户色。
 */
import * as React from 'react'
import { useAgentStore } from '../../stores/agent-store'

const USER_COLOR = '#64748b'

export interface MentionChipProps {
  token: string
  /** M79：展开展示名（@用户 → 具体定向人；缺省 = 按 token 原文渲染） */
  label?: string
  className?: string
}

export function MentionChip({ token, label, className }: MentionChipProps): React.JSX.Element {
  const agents = useAgentStore((s) => s.agents)
  const agent = agents.find((a) => a.name === token || a.id === token)
  const color = agent?.avatar.gradient?.[0] ?? USER_COLOR
  return (
    <span
      data-mention={token}
      className={`inline-flex items-baseline rounded px-1 font-medium leading-[1.35] ${className ?? ''}`}
      style={{ color, backgroundColor: `${color}1f`, boxShadow: `inset 0 0 0 1px ${color}33` }}
    >
      @{label ?? token}
    </span>
  )
}

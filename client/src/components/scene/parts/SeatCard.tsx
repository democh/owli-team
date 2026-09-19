/**
 * M52-A 元件 3/12：席位卡（SeatCard）——arena 左右席 / 席位列表（§7.6）。
 * 在场上成员 + 状态（发言中 / 等待中）；点击 onSelect 回填 @ 草稿。
 */
import * as React from 'react'
import type { AgentDefinition } from '@multi-agent/shared'
import { cn } from '../../../lib/utils'
import { AgentAvatar } from '../../agents/AgentAvatar'

export function SeatCard({
  agent,
  side,
  speaking = false,
  waiting = false,
  onSelect,
}: {
  agent: AgentDefinition
  side?: 'left' | 'right' | 'center'
  speaking?: boolean
  waiting?: boolean
  onSelect?: (agentId: string) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={cn('scene-seat', side && `scene-seat-${side}`, speaking && 'scene-seat-speaking', waiting && 'scene-seat-waiting')}
      title={`${agent.name} · ${agent.role}`}
      onClick={() => onSelect?.(agent.id)}
    >
      <AgentAvatar agent={agent} size={26} animated={speaking} className="shrink-0" />
      <span className="scene-seat-meta">
        <span className="scene-seat-name">{agent.name}</span>
        <span className="scene-seat-role">{agent.role}</span>
      </span>
      {speaking ? <span className="scene-seat-flag">发言中</span> : waiting ? <span className="scene-seat-flag scene-seat-flag-wait">等待</span> : null}
    </button>
  )
}

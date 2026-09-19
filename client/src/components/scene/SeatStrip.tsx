/**
 * M52-A：席位横条（窄屏降级）——roundtable / arena 窄屏下的席位高亮载体（§7.3-4 单流 + 席位高亮）。
 */
import * as React from 'react'
import type { AgentDefinition } from '@multi-agent/shared'
import { cn } from '../../lib/utils'
import { AgentAvatar } from '../agents/AgentAvatar'

export function SeatStrip({
  agents,
  speakingId,
  waitingIds = [],
  onSelect,
}: {
  agents: AgentDefinition[]
  speakingId?: string
  waitingIds?: string[]
  onSelect?: (agentId: string) => void
}): React.JSX.Element {
  const waiting = new Set(waitingIds)
  return (
    <div className="scene-seat-strip" role="list" aria-label="席位">
      {agents.map((agent) => {
        const speaking = agent.id === speakingId
        return (
          <button
            type="button"
            role="listitem"
            key={agent.id}
            className={cn('scene-strip-seat', speaking && 'scene-strip-speaking', waiting.has(agent.id) && 'scene-strip-waiting')}
            title={`${agent.name} · ${agent.role}`}
            onClick={() => onSelect?.(agent.id)}
          >
            <AgentAvatar agent={agent} size={24} animated={speaking} className="ring-2 ring-background" />
            <span className="scene-strip-name">{agent.name}</span>
          </button>
        )
      })}
    </div>
  )
}

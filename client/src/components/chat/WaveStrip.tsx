/**
 * M37-3：悬浮阶段条（ADR 0065）——滚动位置派生的「当前波次」方位提示（不用 CSS sticky）：
 * 首个可见行向前扫描到的波次 → 波次号 + 成员头像流；点击跳波起点（focusMessage 定位闪光）。
 * 由调用侧在「上滑离开底部」且存在波次时挂载；头像订阅为 primitive key，不随流式增量重渲染。
 */
import * as React from 'react'
import { Waves } from 'lucide-react'
import type { WaveInfo } from '../../lib/chat-rows'
import { useAgentStore } from '../../stores/agent-store'
import { useSessionStore } from '../../stores/session-store'
import { AgentAvatar } from '../agents/AgentAvatar'

export function WaveStrip({ info, onJump }: { info: WaveInfo; onJump: () => void }): React.JSX.Element {
  const agents = useAgentStore((s) => s.agents)
  const memberKey = useSessionStore((s) => info.memberIds.map((id) => s.byId.get(id)?.agentId ?? '').join(','))

  const members = memberKey
    .split(',')
    .map((id) => (id ? agents.find((a) => a.id === id) : undefined))
    .filter((a): a is NonNullable<typeof a> => Boolean(a))

  return (
    <div className="pointer-events-none absolute inset-x-0 top-2 z-30 flex justify-center">
      <button
        type="button"
        data-wave-strip={info.turnIndex}
        onClick={onJump}
        title={`跳到第 ${info.turnIndex + 1} 波起点`}
        className="pointer-events-auto flex max-w-[80%] animate-fade-in items-center gap-2 rounded-full border bg-card/90 py-1 pl-2.5 pr-3 text-[11.5px] shadow-lg shadow-slate-900/5 backdrop-blur transition-colors hover:border-primary/40 hover:text-primary"
      >
        <Waves className="size-3.5 shrink-0 text-primary" />
        <span className="shrink-0 font-medium">第 {info.turnIndex + 1} 波</span>
        {members.length > 0 && (
          <span className="flex shrink-0 -space-x-1.5">
            {members.slice(0, 6).map((a) => (
              <AgentAvatar key={a.id} agent={a} size={18} animated={false} className="rounded-full ring-1 ring-card" />
            ))}
          </span>
        )}
        {members.length > 0 && (
          <span className="min-w-0 truncate text-muted-foreground">{members.map((a) => a.name).join('、')}</span>
        )}
      </button>
    </div>
  )
}

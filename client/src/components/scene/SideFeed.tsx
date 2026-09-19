/**
 * M52-D：席位发言流（SideFeed）——arena 左右席下栏（§7.2 目标形态的投影版）。
 * 纯前端派生：把该席成员消息投影为可定位条目（最新在上），不改消息数据层。
 * M60（§81）：改接实时快照（useSceneLiveMessages）——流式期间条目即时入流并随发言增长
 * （data-streaming 标记 + 闪烁光标）；点击条目定位原消息。
 */
import * as React from 'react'
import type { AgentDefinition, ChatMessage } from '@multi-agent/shared'
import { excerptOf } from './derive'

export function SideFeed({
  agents,
  messages,
  label,
  onSeek,
}: {
  /** 该席成员（发言流过滤依据；多成员时条目显示名字） */
  agents: AgentDefinition[]
  messages: ChatMessage[]
  /** 无障碍标签（左 / 右席区分） */
  label?: string
  onSeek?: (messageId: string) => void
}): React.JSX.Element {
  const ids = React.useMemo(() => new Set(agents.map((a) => a.id)), [agents])
  // 最新在上：反序扫描（跨成员按消息序混排）
  const items = React.useMemo(() => {
    const out: ChatMessage[] = []
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!
      if (m.role === 'agent' && m.agentId && ids.has(m.agentId)) out.push(m)
    }
    return out
  }, [messages, ids])

  if (items.length === 0) {
    return (
      <div className="scene-side-feed">
        <p className="scene-side-empty">该席发言将显示在这里</p>
      </div>
    )
  }

  const nameOf = (agentId: string | undefined): string =>
    agents.find((a) => a.id === agentId)?.name ?? ''

  return (
    <div className="scene-side-feed" role="list" aria-label={label ?? '该席发言流'}>
      {items.map((m) => {
        const text = excerptOf(m.content)
        return (
          <button
            key={m.id}
            type="button"
            role="listitem"
            className="scene-side-item"
            data-streaming={m.status === 'streaming' ? 'true' : undefined}
            title={text || undefined}
            onClick={() => onSeek?.(m.id)}
          >
            <span className="scene-side-meta">
              {m.turnIndex != null && m.turnIndex >= 0 ? <span className="scene-side-turn">第 {m.turnIndex + 1} 轮</span> : null}
              {agents.length > 1 && m.agentId ? <span className="scene-side-name">{nameOf(m.agentId)}</span> : null}
            </span>
            <span className="scene-side-text">
              {text !== '' ? text : m.status === 'streaming' ? '发言中…' : '（无正文）'}
            </span>
          </button>
        )
      })}
    </div>
  )
}

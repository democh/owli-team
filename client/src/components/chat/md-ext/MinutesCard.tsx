/**
 * M42（§71.4）：纪要卡（::: minutes [标题]）——条目由 remark 侧转 data-items JSON（`- 键 | 值`）。
 * - 三栏：决议 / 待办 / 风险（未识别键归入决议栏；空栏显示占位）；
 * - 待办值以 `@负责人 事项` 开头时显示负责人头像，整行可点 → 回填 `@负责人 ` 草稿（ADR 0064：只写草稿不直发）；
 * - 流式期间派活行不可点；解析失败 / 空条目 → raw 兜底静态渲染，其余内容照常。
 */
import * as React from 'react'
import { Send } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { MINUTES_KEYS, parseMinutesItems, splitMinutesOwner } from '../../../lib/meeting'
import { useAgentStore } from '../../../stores/agent-store'
import { useUiStore } from '../../../stores/ui-store'
import { AgentAvatar } from '../../agents/AgentAvatar'
import { useStreaming } from './streaming'

export function MinutesCard({
  title,
  items: itemsRaw,
  raw,
  children,
}: {
  title?: string
  items?: string
  raw?: string
  children?: React.ReactNode
}): React.JSX.Element {
  const agents = useAgentStore((s) => s.agents)
  const insertToComposer = useUiStore((s) => s.insertToComposer)
  const streaming = useStreaming()
  const parsed = React.useMemo(() => parseMinutesItems(itemsRaw), [itemsRaw])

  // 无条目（解析失败 / 空容器）：raw 兜底静态渲染，其余内容照常
  if (parsed.length === 0) {
    return (
      <div className="md-minutes">
        {raw ? <pre className="md-minutes-static">{raw}</pre> : null}
        {children}
      </div>
    )
  }

  return (
    <div className="md-minutes">
      <div className="md-minutes-head">
        <span className="md-minutes-title">{title || '会议纪要'}</span>
        <span className="md-minutes-count">{parsed.length} 条</span>
      </div>
      <div className="md-minutes-cols">
        {MINUTES_KEYS.map((key) => {
          const rows = parsed.filter((it) => (MINUTES_KEYS as readonly string[]).includes(it.key) ? it.key === key : key === MINUTES_KEYS[0])
          return (
            <div className="md-minutes-col" data-col={key} key={key}>
              <div className="md-minutes-col-head">
                <span>{key}</span>
                <span className="md-minutes-col-count">{rows.length}</span>
              </div>
              {rows.length === 0 ? <div className="md-minutes-empty">—</div> : null}
              {rows.map((it, i) => {
                if (key !== '待办') {
                  return (
                    <div className="md-minutes-row" key={i}>
                      {it.value}
                    </div>
                  )
                }
                const { owner, text } = splitMinutesOwner(it.value)
                if (!owner) {
                  return (
                    <div className="md-minutes-row" key={i}>
                      {text}
                    </div>
                  )
                }
                const agent = agents.find((a) => a.name === owner || a.id === owner)
                const assignable = !streaming
                return (
                  <button
                    key={i}
                    type="button"
                    className={cn('md-minutes-todo', assignable && 'is-assignable')}
                    disabled={!assignable}
                    data-owner={owner}
                    title={assignable ? `派活：回填 @${owner} 草稿（确认后发送）` : `${owner} 负责`}
                    onClick={() => insertToComposer(`@${owner} `)}
                  >
                    {agent ? (
                      <AgentAvatar agent={agent} size={18} animated={false} className="shrink-0 rounded-full" />
                    ) : (
                      <span className="md-minutes-owner-fallback" aria-hidden>
                        {owner.slice(0, 1)}
                      </span>
                    )}
                    <span className="md-minutes-todo-text">{text}</span>
                    {assignable ? <Send className="md-minutes-send size-3" aria-hidden /> : null}
                  </button>
                )
              })}
            </div>
          )
        })}
      </div>
      {children}
    </div>
  )
}

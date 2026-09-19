/**
 * M52-A 元件 6/12：论证树（ClaimTree，分层折叠）——arena / roundtable（§7.6）。
 * 数据源：`::: claim` 容器（主张 → 论据 → 证据；M43 接入后自动增强）；
 * 折叠态为组件本地态（不持久化的短交互）。
 */
import * as React from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '../../../lib/utils'

export interface ClaimReason {
  text: string
  evidence?: string
}

export interface ClaimNode {
  claim: string
  detail?: string
  reasons: ClaimReason[]
}

export function ClaimTree({
  nodes,
  onPick,
}: {
  nodes: ClaimNode[]
  /** 点论据回填（追问 / 引用） */
  onPick?: (text: string) => void
}): React.JSX.Element {
  const [open, setOpen] = React.useState<Set<number>>(() => new Set())
  const toggle = (i: number): void =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  return (
    <div className="scene-claim-tree" role="list" aria-label="论证树">
      {nodes.map((node, i) => {
        const expanded = open.has(i)
        return (
          <div className="scene-claim" key={i} role="listitem">
            <button type="button" className="scene-claim-head" onClick={() => toggle(i)} aria-expanded={expanded}>
              <ChevronRight className={cn('scene-claim-caret', expanded && 'scene-claim-caret-open')} size={14} />
              <span className="scene-claim-title">{node.claim}</span>
              {node.reasons.length > 0 ? <span className="scene-claim-count">{node.reasons.length} 论据</span> : null}
            </button>
            {node.detail ? <p className="scene-claim-detail">{node.detail}</p> : null}
            {expanded && node.reasons.length > 0 ? (
              <div className="scene-claim-reasons">
                {node.reasons.map((r, j) => (
                  <button type="button" className="scene-claim-reason" key={j} onClick={() => onPick?.(r.text)}>
                    <span className="scene-claim-text">{r.text}</span>
                    {r.evidence ? <span className="scene-claim-evidence">证据：{r.evidence}</span> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

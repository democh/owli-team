/**
 * M52-A 元件 6/12：论证树（ClaimTree，分层折叠）——arena / roundtable（§7.6）。
 * 数据源：`::: claim` 容器（主张 → 论据 → 证据；M43 接入后自动增强）；
 * 折叠态为组件本地态（不持久化的短交互）。
 * M63（A3 / N1）：论据行证据等级徽标（lib/evidence 单一词表；无等级 → 补证据回填 /
 * 无证据 → 假设明示回填）+ 扩展字段 chips（视角 / 倾向 / 置信度）。
 */
import * as React from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { EVIDENCE_LABEL, gradeOf } from '../../../lib/evidence'
import { stanceToneOf } from '../../../lib/pk'

export interface ClaimReason {
  text: string
  evidence?: string
}

export interface ClaimNode {
  claim: string
  detail?: string
  reasons: ClaimReason[]
  /** M63：扩展字段（视角 / 倾向 / 置信度；缺省不渲染 chips） */
  perspective?: string
  stance?: string
  confidence?: string
}

export function ClaimTree({
  nodes,
  onPick,
  onEvidenceAsk,
  onHypoAsk,
}: {
  nodes: ClaimNode[]
  /** 点论据回填（追问 / 引用） */
  onPick?: (text: string) => void
  /** M63：无等级证据 → 补标注回填（缺省时徽标不可点） */
  onEvidenceAsk?: (text: string) => void
  /** M63：无证据论据 → 假设明示回填（缺省时徽标不可点） */
  onHypoAsk?: (text: string) => void
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
              {node.perspective ? <span className="scene-claim-chip is-perspective">{node.perspective}</span> : null}
              {node.stance ? (
                <span className={cn('scene-claim-chip is-stance', `is-${stanceToneOf(node.stance)}`)}>{node.stance}</span>
              ) : null}
              {node.confidence ? <span className="scene-claim-chip is-conf">置信度 {node.confidence}</span> : null}
              {node.reasons.length > 0 ? <span className="scene-claim-count">{node.reasons.length} 论据</span> : null}
            </button>
            {node.detail ? <p className="scene-claim-detail">{node.detail}</p> : null}
            {expanded && node.reasons.length > 0 ? (
              <div className="scene-claim-reasons">
                {node.reasons.map((r, j) => {
                  const grade = r.evidence ? gradeOf(r.evidence) : undefined
                  return (
                    <div
                      className="scene-claim-reason"
                      role="button"
                      tabIndex={0}
                      key={j}
                      onClick={() => onPick?.(r.text)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          onPick?.(r.text)
                        }
                      }}
                    >
                      <span className="scene-claim-text">{r.text}</span>
                      {r.evidence ? <span className="scene-claim-evidence">证据：{r.evidence}</span> : null}
                      {grade ? (
                        <span
                          className={cn('scene-claim-grade', `is-${grade}`)}
                          title={`证据等级：${EVIDENCE_LABEL[grade]}`}
                        >
                          {EVIDENCE_LABEL[grade]}
                        </span>
                      ) : null}
                      {r.evidence && !grade && onEvidenceAsk ? (
                        <button
                          type="button"
                          className="scene-claim-ask"
                          title="补标注证据来源与等级"
                          onClick={(e) => {
                            e.stopPropagation()
                            onEvidenceAsk(r.text)
                          }}
                        >
                          补证据
                        </button>
                      ) : null}
                      {!r.evidence && onHypoAsk ? (
                        <button
                          type="button"
                          className="scene-claim-ask is-hypo"
                          title="明示为假设并补证据"
                          onClick={(e) => {
                            e.stopPropagation()
                            onHypoAsk(r.text)
                          }}
                        >
                          假设
                        </button>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

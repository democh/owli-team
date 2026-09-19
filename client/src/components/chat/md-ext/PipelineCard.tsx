/**
 * M41（§103，SA-1，ADR 委托见批次落位）：客户管道看板（`::: pipeline`）——
 * 四列（线索 / 意向 / 报价 / 成交）+ 未知阶段归「其他」列（fail-safe）；
 * 卡片 = 客户名 + 金额 + 下一步；点卡 → composerInsert「跟进 <客户>：」（只写草稿不直发，ADR 0064）。
 */
import * as React from 'react'
import { Kanban } from 'lucide-react'
import { useUiStore } from '../../../stores/ui-store'
import { cn } from '../../../lib/utils'
import { useStreaming } from './streaming'
import { PIPELINE_STAGES, type PipelineCardData, type PipelineStage } from './remark-ext'

const STAGE_LABEL: Record<PipelineStage, string> = {
  线索: '线索',
  意向: '意向',
  报价: '报价',
  成交: '成交',
  other: '其他',
}

const COLUMN_TONE: Record<PipelineStage, string> = {
  线索: 'bg-slate-500/10 text-slate-600',
  意向: 'bg-sky-500/10 text-sky-700',
  报价: 'bg-amber-500/10 text-amber-700',
  成交: 'bg-emerald-500/10 text-emerald-700',
  other: 'bg-muted text-muted-foreground',
}

/** data-rows JSON → 管道卡（非法 JSON / 形状不符 → 空数组，走 raw 回退） */
export function parsePipelineRows(json: string | undefined): PipelineCardData[] {
  if (!json) return []
  try {
    const arr: unknown = JSON.parse(json)
    if (!Array.isArray(arr)) return []
    const out: PipelineCardData[] = []
    for (const v of arr) {
      if (!v || typeof v !== 'object') continue
      const o = v as { name?: unknown; stage?: unknown; amount?: unknown; next?: unknown }
      if (typeof o.name !== 'string' || o.name === '') continue
      const stage: PipelineStage =
        typeof o.stage === 'string' && (PIPELINE_STAGES as readonly string[]).includes(o.stage)
          ? (o.stage as PipelineStage)
          : 'other'
      out.push({
        name: o.name,
        stage,
        amount: typeof o.amount === 'string' ? o.amount : '',
        next: typeof o.next === 'string' ? o.next : '',
      })
    }
    return out
  } catch {
    return []
  }
}

export function PipelineCard({
  title,
  rows: rowsRaw,
  raw,
  children,
}: {
  title?: string
  rows?: string
  raw?: string
  children?: React.ReactNode
}): React.JSX.Element {
  const insertToComposer = useUiStore((s) => s.insertToComposer)
  const streaming = useStreaming()
  const cards = React.useMemo(() => parsePipelineRows(rowsRaw), [rowsRaw])

  if (cards.length === 0) {
    return (
      <div className="md-pipeline">
        {raw ? <pre className="md-pipeline-static">{raw}</pre> : null}
        {children}
      </div>
    )
  }

  const columns = [...PIPELINE_STAGES, 'other' as const].filter(
    (stage) => stage !== 'other' || cards.some((c) => c.stage === 'other'),
  )

  return (
    <div className="md-pipeline" data-pipeline-card="">
      <div className="md-pipeline-head">
        <Kanban className="size-3.5" aria-hidden />
        <span className="md-pipeline-title">{title || '客户管道'}</span>
        <span className="md-pipeline-count">{cards.length} 家</span>
      </div>
      <div className="md-pipeline-board">
        {columns.map((stage) => {
          const items = cards.filter((c) => c.stage === stage)
          return (
            <div className="md-pipeline-col" key={stage} data-pipeline-col={stage}>
              <div className="md-pipeline-col-head">
                <span className={cn('md-pipeline-stage', COLUMN_TONE[stage])}>{STAGE_LABEL[stage]}</span>
                <span className="md-pipeline-col-count">{items.length}</span>
              </div>
              <div className="md-pipeline-col-body">
                {items.map((card) => (
                  <button
                    type="button"
                    key={`${card.name}-${card.amount}`}
                    className="md-pipeline-card"
                    disabled={streaming}
                    title={`写入跟进草稿：跟进 ${card.name}：`}
                    onClick={() => insertToComposer(`跟进 ${card.name}：`)}
                  >
                    <span className="md-pipeline-name">{card.name}</span>
                    {card.amount !== '' ? <span className="md-pipeline-amount">{card.amount}</span> : null}
                    {card.next !== '' ? <span className="md-pipeline-next">{card.next}</span> : null}
                  </button>
                ))}
                {items.length === 0 ? <span className="md-pipeline-empty">—</span> : null}
              </div>
            </div>
          )
        })}
      </div>
      {children}
    </div>
  )
}

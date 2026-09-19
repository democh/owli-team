/**
 * M40（§104，HL-5）：目标进度环（`::: goals`）——条目 `- 目标 | 当前 | 目标值`；
 * 数值解析支持「万」后缀（numberWithSuffix）；缺数值 / 目标值 ≤0 → 该行不走环（退化为文本）。
 * 纯展示件（无交互）；fail-safe → raw 兜底。
 */
import * as React from 'react'
import { Target } from 'lucide-react'
import { ProgressRing } from '../../scene/parts'
import type { GoalRow } from './remark-ext'

/** data-rows JSON → 目标行（非法 JSON / 形状不符 → 空数组，走 raw 回退） */
export function parseGoals(json: string | undefined): GoalRow[] {
  if (!json) return []
  try {
    const arr: unknown = JSON.parse(json)
    if (!Array.isArray(arr)) return []
    const out: GoalRow[] = []
    for (const v of arr) {
      if (!v || typeof v !== 'object') continue
      const o = v as { name?: unknown; current?: unknown; target?: unknown; currentNum?: unknown; targetNum?: unknown }
      if (typeof o.name !== 'string' || o.name === '') continue
      out.push({
        name: o.name,
        current: typeof o.current === 'string' ? o.current : '',
        target: typeof o.target === 'string' ? o.target : '',
        ...(typeof o.currentNum === 'number' ? { currentNum: o.currentNum } : {}),
        ...(typeof o.targetNum === 'number' ? { targetNum: o.targetNum } : {}),
      })
    }
    return out
  } catch {
    return []
  }
}

/** 进度百分比（0–100 截断；非法 → undefined） */
export function goalPct(row: GoalRow): number | undefined {
  if (row.currentNum === undefined || row.targetNum === undefined || row.targetNum <= 0) return undefined
  return Math.min(100, Math.max(0, Math.round((row.currentNum / row.targetNum) * 100)))
}

export function GoalsCard({
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
  const goals = React.useMemo(() => parseGoals(rowsRaw), [rowsRaw])

  if (goals.length === 0) {
    return (
      <div className="md-goals">
        {raw ? <pre className="md-goals-static">{raw}</pre> : null}
        {children}
      </div>
    )
  }

  return (
    <div className="md-goals" data-goals-card="">
      <div className="md-goals-head">
        <Target className="size-3.5" aria-hidden />
        <span className="md-goals-title">{title || '目标进度'}</span>
        <span className="md-goals-count">{goals.length} 项</span>
      </div>
      <div className="md-goals-list">
        {goals.map((g, i) => {
          const pct = goalPct(g)
          return (
            <div className="md-goals-row" key={i} data-goal={g.name}>
              {pct !== undefined ? <ProgressRing value={pct} size={52} label={g.name} sublabel={`${pct}%`} /> : null}
              <div className="md-goals-meta">
                <span className="md-goals-name">{g.name}</span>
                <span className="md-goals-values" data-goal-pct={pct}>
                  {g.current !== '' ? g.current : '—'}
                  <span className="md-goals-sep">/</span>
                  {g.target !== '' ? g.target : '—'}
                  {pct !== undefined ? <span className="md-goals-pct">{pct}%</span> : null}
                </span>
              </div>
            </div>
          )
        })}
      </div>
      {children}
    </div>
  )
}

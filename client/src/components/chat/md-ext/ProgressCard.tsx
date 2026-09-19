/**
 * M41（§103，FU-1）：进度卡（`::: progress`）——章节进度列表 + 总进度条；
 * 条目 `- 章节 | 状态`（完成 / 进行中 / 待办；未识别 → 待办）。
 * 解析失败 → raw 兜底静态渲染。
 */
import * as React from 'react'
import { Milestone } from 'lucide-react'
import { cn } from '../../../lib/utils'
import type { ProgressItem } from './remark-ext'

const STATE_WORD: Record<ProgressItem['state'], string> = { done: '完成', doing: '进行中', todo: '待办' }

/** data-rows JSON → 进度条目（非法 JSON / 形状不符 → 空数组，走 raw 回退） */
export function parseProgressRows(json: string | undefined): ProgressItem[] {
  if (!json) return []
  try {
    const arr: unknown = JSON.parse(json)
    if (!Array.isArray(arr)) return []
    const out: ProgressItem[] = []
    for (const v of arr) {
      if (!v || typeof v !== 'object') continue
      const o = v as { label?: unknown; state?: unknown }
      if (typeof o.label !== 'string' || o.label === '') continue
      const state = o.state === 'done' || o.state === 'doing' ? o.state : 'todo'
      out.push({ label: o.label, state })
    }
    return out
  } catch {
    return []
  }
}

export function ProgressCard({
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
  const rows = React.useMemo(() => parseProgressRows(rowsRaw), [rowsRaw])

  if (rows.length === 0) {
    return (
      <div className="md-progress">
        {raw ? <pre className="md-progress-static">{raw}</pre> : null}
        {children}
      </div>
    )
  }

  const done = rows.filter((r) => r.state === 'done').length
  const pct = Math.round((done / rows.length) * 100)

  return (
    <div className="md-progress" data-progress-card="">
      <div className="md-progress-head">
        <Milestone className="size-3.5" aria-hidden />
        <span className="md-progress-title">{title || '进度'}</span>
        <span className="md-progress-count">
          {done}/{rows.length} 完成
        </span>
      </div>
      <div className="md-progress-bar" aria-hidden>
        <span style={{ width: `${pct}%` }} data-progress-pct={pct} />
      </div>
      <div className="md-progress-list">
        {rows.map((r, i) => (
          <div className={cn('md-progress-row', `is-${r.state}`)} key={i} data-progress-state={r.state}>
            <span className="md-progress-dot" aria-hidden />
            <span className="md-progress-label">{r.label}</span>
            <span className="md-progress-state">{STATE_WORD[r.state]}</span>
          </div>
        ))}
      </div>
      {children}
    </div>
  )
}

/**
 * M38（§92）：评分卡（`::: score`）——ICE 等评分矩阵（子项 + 总分条形 + 排序）。
 * - 结构由 remark 侧转 data-scores JSON（parseScoreLines 单一实现：总分缺省 = 子项乘积，按总分降序）；
 * - 总分条形宽度按本卡最大总分归一；解析失败 → raw 兜底静态渲染。
 */
import * as React from 'react'
import { Gauge } from 'lucide-react'
import type { ScoreEntry, ScorePart } from './remark-ext'

/** data-scores JSON → 条目数组（非法 JSON / 形状不符 → 空数组，走 raw 回退）；按总分降序 */
export function parseScores(json: string | undefined): ScoreEntry[] {
  if (!json) return []
  try {
    const arr: unknown = JSON.parse(json)
    if (!Array.isArray(arr)) return []
    const out: ScoreEntry[] = []
    for (const v of arr) {
      if (!v || typeof v !== 'object') continue
      const o = v as { name?: unknown; parts?: unknown; total?: unknown }
      if (typeof o.name !== 'string' || o.name === '' || typeof o.total !== 'number' || !Number.isFinite(o.total)) continue
      const parts: ScorePart[] = []
      if (Array.isArray(o.parts)) {
        for (const p of o.parts) {
          if (!p || typeof p !== 'object') continue
          const q = p as { label?: unknown; value?: unknown }
          if (typeof q.label !== 'string' || typeof q.value !== 'number' || !Number.isFinite(q.value)) continue
          parts.push({ label: q.label, value: q.value })
        }
      }
      out.push({ name: o.name, parts, total: o.total })
    }
    return [...out].sort((a, b) => b.total - a.total)
  } catch {
    return []
  }
}

export function ScoreCard({
  title,
  scores: scoresRaw,
  raw,
  children,
}: {
  title?: string
  scores?: string
  raw?: string
  children?: React.ReactNode
}): React.JSX.Element {
  const entries = React.useMemo(() => parseScores(scoresRaw), [scoresRaw])

  if (entries.length === 0) {
    return (
      <div className="md-score">
        {raw ? <pre className="md-score-static">{raw}</pre> : null}
        {children}
      </div>
    )
  }

  const max = Math.max(...entries.map((e) => e.total), 1)

  return (
    <div className="md-score" data-score-card="">
      <div className="md-score-head">
        <Gauge className="size-3.5" aria-hidden />
        <span className="md-score-title">{title || '评分卡'}</span>
        <span className="md-score-count">{entries.length} 项 · 按总分排序</span>
      </div>
      <div className="md-score-list">
        {entries.map((e, i) => (
          <div className="md-score-row" key={i}>
            <span className="md-score-name">
              <span className="md-score-rank">{i + 1}</span>
              {e.name}
            </span>
            <span className="md-score-parts">
              {e.parts.map((p, j) => (
                <span className="md-score-part" key={j}>
                  {p.label}
                  <b>{p.value}</b>
                </span>
              ))}
              <span className="md-score-total">
                总分<b>{e.total}</b>
              </span>
            </span>
            <span className="md-score-bar" aria-hidden>
              <span style={{ width: `${Math.round((e.total / max) * 100)}%` }} />
            </span>
          </div>
        ))}
      </div>
      {children}
    </div>
  )
}

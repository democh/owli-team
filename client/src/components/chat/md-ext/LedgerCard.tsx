/**
 * M40（§104，HL-6）：记账流水（`::: ledger`）——条目 `- 日期 | 项目 | 金额`；
 * 金额列右对齐（tabular-nums）；负数（支出）色标（rose）；解析不出数值的金额原样展示（不猜正负）。
 * 纯展示件（无交互）；fail-safe → raw 兜底。
 */
import * as React from 'react'
import { NotebookText } from 'lucide-react'
import { cn } from '../../../lib/utils'
import type { LedgerRow } from './remark-ext'

/** data-rows JSON → 流水行（非法 JSON / 形状不符 → 空数组，走 raw 回退） */
export function parseLedger(json: string | undefined): LedgerRow[] {
  if (!json) return []
  try {
    const arr: unknown = JSON.parse(json)
    if (!Array.isArray(arr)) return []
    const out: LedgerRow[] = []
    for (const v of arr) {
      if (!v || typeof v !== 'object') continue
      const o = v as { date?: unknown; item?: unknown; amount?: unknown; amountNum?: unknown }
      if (typeof o.date !== 'string' || o.date === '') continue
      out.push({
        date: o.date,
        item: typeof o.item === 'string' ? o.item : '',
        amount: typeof o.amount === 'string' ? o.amount : '',
        ...(typeof o.amountNum === 'number' ? { amountNum: o.amountNum } : {}),
      })
    }
    return out
  } catch {
    return []
  }
}

export function LedgerCard({
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
  const rows = React.useMemo(() => parseLedger(rowsRaw), [rowsRaw])

  if (rows.length === 0) {
    return (
      <div className="md-ledger">
        {raw ? <pre className="md-ledger-static">{raw}</pre> : null}
        {children}
      </div>
    )
  }

  return (
    <div className="md-ledger" data-ledger-card="">
      <div className="md-ledger-head">
        <NotebookText className="size-3.5" aria-hidden />
        <span className="md-ledger-title">{title || '记账流水'}</span>
        <span className="md-ledger-count">{rows.length} 笔</span>
      </div>
      <table className="md-ledger-table">
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td className="md-ledger-date">{r.date}</td>
              <td className="md-ledger-item">{r.item}</td>
              <td
                className={cn('md-ledger-amount', r.amountNum !== undefined && r.amountNum < 0 && 'is-negative')}
                data-ledger-negative={r.amountNum !== undefined && r.amountNum < 0 ? 'true' : undefined}
              >
                {r.amount}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {children}
    </div>
  )
}

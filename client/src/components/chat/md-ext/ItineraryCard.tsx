/**
 * M40（§104，HL-7）：行程卡（`::: itinerary`）——条目 `- 日期 | 交通 | 住宿 | 安排`；
 * 按天分组（首次出现序）+ 日期头（含周几）+ **今天高亮**（本地日期比对）
 * + 交通 / 住宿 / 安排三行图标（缺列不占行）；非日期首列 → 「未标日期」组。
 * 纯展示件（无交互）；fail-safe → raw 兜底。
 */
import * as React from 'react'
import { BedDouble, MapPin, Plane } from 'lucide-react'
import { dateValueOf, localDateOf } from '../../../lib/habit'
import { cn } from '../../../lib/utils'
import type { ItineraryRow } from './remark-ext'

const WEEK_LABEL = ['日', '一', '二', '三', '四', '五', '六'] as const

/** data-rows JSON → 行程行（非法 JSON / 形状不符 → 空数组，走 raw 回退） */
export function parseItinerary(json: string | undefined): ItineraryRow[] {
  if (!json) return []
  try {
    const arr: unknown = JSON.parse(json)
    if (!Array.isArray(arr)) return []
    const out: ItineraryRow[] = []
    for (const v of arr) {
      if (!v || typeof v !== 'object') continue
      const o = v as { date?: unknown; transport?: unknown; stay?: unknown; plan?: unknown }
      if (typeof o.date !== 'string' || o.date === '') continue
      out.push({
        date: o.date,
        transport: typeof o.transport === 'string' ? o.transport : '',
        stay: typeof o.stay === 'string' ? o.stay : '',
        plan: typeof o.plan === 'string' ? o.plan : '',
      })
    }
    return out
  } catch {
    return []
  }
}

/** 按天分组（首次出现序）；非日期首列归「未标日期」 */
export function groupByDay(rows: readonly ItineraryRow[]): Array<{ date: string; rows: ItineraryRow[] }> {
  const groups: Array<{ date: string; rows: ItineraryRow[] }> = []
  const index = new Map<string, number>()
  for (const row of rows) {
    const date = dateValueOf(row.date) ? row.date : ''
    const at = index.get(date)
    if (at === undefined) {
      index.set(date, groups.length)
      groups.push({ date, rows: [row] })
    } else {
      groups[at]!.rows.push(row)
    }
  }
  return groups
}

/** 日期头文案：`09-20 周六`（非日期 → 「未标日期」） */
export function dayLabelOf(date: string): string {
  const d = dateValueOf(date)
  if (!d) return '未标日期'
  return `${date.slice(5)} 周${WEEK_LABEL[d.getDay()]}`
}

export function ItineraryCard({
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
  const rows = React.useMemo(() => parseItinerary(rowsRaw), [rowsRaw])
  const today = localDateOf()

  if (rows.length === 0) {
    return (
      <div className="md-itinerary">
        {raw ? <pre className="md-itinerary-static">{raw}</pre> : null}
        {children}
      </div>
    )
  }

  const groups = groupByDay(rows)

  return (
    <div className="md-itinerary" data-itinerary-card="">
      <div className="md-itinerary-head">
        <Plane className="size-3.5" aria-hidden />
        <span className="md-itinerary-title">{title || '行程安排'}</span>
        <span className="md-itinerary-count">{groups.length} 天</span>
      </div>
      <div className="md-itinerary-days">
        {groups.map((g) => {
          const isToday = g.date !== '' && g.date === today
          return (
            <div className={cn('md-itinerary-day', isToday && 'is-today')} key={g.date || 'undated'} data-itinerary-day={g.date}>
              <div className="md-itinerary-dayhead">
                <span className="md-itinerary-datelabel">{dayLabelOf(g.date)}</span>
                {isToday ? <span className="md-itinerary-today">今天</span> : null}
              </div>
              {g.rows.map((r, i) => (
                <div className="md-itinerary-row" key={i}>
                  {r.transport !== '' ? (
                    <span className="md-itinerary-cell">
                      <Plane className="size-3" aria-hidden />
                      {r.transport}
                    </span>
                  ) : null}
                  {r.stay !== '' ? (
                    <span className="md-itinerary-cell">
                      <BedDouble className="size-3" aria-hidden />
                      {r.stay}
                    </span>
                  ) : null}
                  {r.plan !== '' ? (
                    <span className="md-itinerary-cell">
                      <MapPin className="size-3" aria-hidden />
                      {r.plan}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          )
        })}
      </div>
      {children}
    </div>
  )
}

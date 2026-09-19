/**
 * M40（§104，HL-1，ADR 0172）：三轨打卡卡（`::: tracks`）——训练 / 饮食 / 睡眠计划 + 按天打卡。
 * - 数据：条目 `- 轨道 | 计划摘要`（data-rows）；打卡态为**本地**（localStorage `ma:habit:<sid>` 按天）；
 * - 交互：周网格任意日格可点（今日突出可补记历史）；streak 徽标（从今日 / 昨日起连续天数）；
 * - 周进度环 = 本周已打卡格 / （轨道数 × 7）；流式期间禁点；fail-safe → raw 兜底。
 */
import * as React from 'react'
import { CalendarCheck, Flame } from 'lucide-react'
import { localDateOf, streakOf, useHabit, weekDatesOf } from '../../../lib/habit'
import { cn } from '../../../lib/utils'
import { useMessageInfo } from './message-context'
import { useStreaming } from './streaming'
import { ProgressRing } from '../../scene/parts'
import type { TrackRow } from './remark-ext'

const TRACK_TONE: Record<string, string> = {
  训练: 'bg-sky-500/10 text-sky-700',
  饮食: 'bg-amber-500/10 text-amber-700',
  睡眠: 'bg-violet-500/10 text-violet-700',
}

/** data-rows JSON → 轨道行（非法 JSON / 形状不符 → 空数组，走 raw 回退） */
export function parseTracks(json: string | undefined): TrackRow[] {
  if (!json) return []
  try {
    const arr: unknown = JSON.parse(json)
    if (!Array.isArray(arr)) return []
    const out: TrackRow[] = []
    for (const v of arr) {
      if (!v || typeof v !== 'object') continue
      const o = v as { track?: unknown; plan?: unknown }
      if (typeof o.track !== 'string' || o.track === '') continue
      out.push({ track: o.track, plan: typeof o.plan === 'string' ? o.plan : '' })
    }
    return out
  } catch {
    return []
  }
}

export function TracksCard({
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
  const info = useMessageInfo()
  const streaming = useStreaming()
  const tracks = React.useMemo(() => parseTracks(rowsRaw), [rowsRaw])
  const [log, toggle] = useHabit(info?.sessionId ?? '')
  const today = localDateOf()
  const week = React.useMemo(() => weekDatesOf(today), [today])

  if (tracks.length === 0) {
    return (
      <div className="md-tracks">
        {raw ? <pre className="md-tracks-static">{raw}</pre> : null}
        {children}
      </div>
    )
  }

  const totalCells = tracks.length * week.length
  const doneCells = tracks.reduce((n, t) => n + week.filter((d) => (log[t.track] ?? []).includes(d)).length, 0)
  const pct = totalCells === 0 ? 0 : Math.round((doneCells / totalCells) * 100)

  return (
    <div className="md-tracks" data-tracks-card="">
      <div className="md-tracks-head">
        <CalendarCheck className="size-3.5" aria-hidden />
        <span className="md-tracks-title">{title || '三轨打卡'}</span>
        <span className="md-tracks-week">本周 {doneCells}/{totalCells}</span>
      </div>
      <div className="md-tracks-body">
        <div className="md-tracks-ring">
          <ProgressRing value={pct} size={64} label="本周" sublabel={`${pct}%`} />
        </div>
        <div className="md-tracks-list">
          {tracks.map((t) => {
            const dates = log[t.track] ?? []
            const streak = streakOf(dates, today)
            return (
              <div className="md-tracks-row" key={t.track} data-track={t.track}>
                <div className="md-tracks-meta">
                  <span className={cn('md-tracks-name', TRACK_TONE[t.track] ?? 'bg-muted text-muted-foreground')}>{t.track}</span>
                  {t.plan !== '' ? <span className="md-tracks-plan">{t.plan}</span> : null}
                  {streak > 0 ? (
                    <span className="md-tracks-streak" data-streak={streak} title={`连续打卡 ${streak} 天`}>
                      <Flame className="size-3" aria-hidden />
                      连续 {streak} 天
                    </span>
                  ) : null}
                </div>
                <div className="md-tracks-days" role="group" aria-label={`${t.track} 本周打卡`}>
                  {week.map((d) => {
                    const checked = dates.includes(d)
                    return (
                      <button
                        type="button"
                        key={d}
                        className={cn('md-tracks-day', checked && 'is-done', d === today && 'is-today')}
                        disabled={streaming}
                        aria-pressed={checked}
                        title={`${d}${checked ? '（已打卡，点击取消）' : '（点击打卡，可补记）'}`}
                        data-day-dot={d}
                        onClick={() => toggle(t.track, d)}
                      >
                        {d.slice(8)}
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      </div>
      {children}
    </div>
  )
}

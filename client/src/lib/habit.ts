/**
 * M40（§104，HL-1，ADR 0172）：打卡与 streak 本地口径（ADR 决策项「打卡 / streak 本地持久化」落地）。
 * - 存储：localStorage `ma:habit:<sessionId>` —— `{ [轨道]: ['YYYY-MM-DD', …] }`（按天勾选集合）；
 * - 跨天：一律以**本地日期**切算（`localDateOf`），不依赖 UTC；补记历史日允许（点任意日格）；
 * - streak：从今天（未打卡则从昨天）往前数连续天数——当天未打卡不因「还没到晚上」而断；
 * - 边界：仅本地可信（不进导出 / 不落库）；隐私模式静默降级（仅即时态）；会话删除后残留键不构成数据泄漏。
 */
import * as React from 'react'

export type HabitLog = Record<string, string[]>

export function habitKey(sessionId: string): string {
  return `ma:habit:${sessionId || '-'}`
}

/** 本地日期 `YYYY-MM-DD`（不依赖 UTC） */
export function localDateOf(d: Date = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** `YYYY-MM-DD` → 本地 Date（非法 → undefined） */
export function dateValueOf(iso: string): Date | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return undefined
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

/** iso 日 ± n 天（本地） */
export function shiftDate(iso: string, days: number): string {
  const d = dateValueOf(iso) ?? new Date()
  d.setDate(d.getDate() + days)
  return localDateOf(d)
}

/** 本周（周一 → 周日）的 7 个本地日期 */
export function weekDatesOf(today: string): string[] {
  const d = dateValueOf(today) ?? new Date()
  const dow = (d.getDay() + 6) % 7 // 周一 = 0
  const monday = shiftDate(today, -dow)
  return Array.from({ length: 7 }, (_, i) => shiftDate(monday, i))
}

export function loadHabit(sessionId: string): HabitLog {
  try {
    const raw = localStorage.getItem(habitKey(sessionId))
    if (!raw) return {}
    const obj: unknown = JSON.parse(raw)
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {}
    const out: HabitLog = {}
    for (const [track, dates] of Object.entries(obj as Record<string, unknown>)) {
      if (!Array.isArray(dates)) continue
      const clean = dates.filter((x): x is string => typeof x === 'string' && dateValueOf(x) !== undefined)
      if (clean.length > 0) out[track] = [...new Set(clean)].sort()
    }
    return out
  } catch {
    return {}
  }
}

export function saveHabit(sessionId: string, log: HabitLog): void {
  try {
    localStorage.setItem(habitKey(sessionId), JSON.stringify(log))
  } catch {
    // 配额 / 隐私模式：忽略（本会话仅即时态）
  }
}

/** 切换某轨道某天的打卡（不可变返回；空集合移除键） */
export function toggleHabitDay(log: HabitLog, track: string, date: string): HabitLog {
  const cur = new Set(log[track] ?? [])
  if (cur.has(date)) cur.delete(date)
  else cur.add(date)
  const next: HabitLog = { ...log }
  if (cur.size === 0) delete next[track]
  else next[track] = [...cur].sort()
  return next
}

/**
 * 连续打卡天数：从今天往前数（当天未打卡则从昨天起算）。
 * `dates` 为该轨道的已打卡日期集合。
 */
export function streakOf(dates: readonly string[], today: string): number {
  const set = new Set(dates)
  if (set.size === 0) return 0
  let cursor = set.has(today) ? today : shiftDate(today, -1)
  let n = 0
  while (set.has(cursor)) {
    n++
    cursor = shiftDate(cursor, -1)
  }
  return n
}

/** 打卡日志 hook：读 / 切换 / 落盘（key 含 sessionId；同会话内多实例由 caller 各自重读） */
export function useHabit(sessionId: string): [HabitLog, (track: string, date: string) => void] {
  const [log, setLog] = React.useState<HabitLog>(() => loadHabit(sessionId))
  React.useEffect(() => {
    setLog(loadHabit(sessionId))
  }, [sessionId])
  const toggle = React.useCallback(
    (track: string, date: string): void => {
      setLog((prev) => {
        const next = toggleHabitDay(prev, track, date)
        saveHabit(sessionId, next)
        return next
      })
    },
    [sessionId],
  )
  return [log, toggle]
}

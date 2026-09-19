/**
 * 通用 React hooks（M8）。
 */
import * as React from 'react'

/**
 * 节流值：value 高频变化时（流式 delta 40ms 批次），最多每 intervalMs 同步一次；
 * 尾沿保证最终值一定落地（intervalMs 内最后一次变更会被补发）。
 */
export function useThrottledValue<T>(value: T, intervalMs: number): T {
  const [throttled, setThrottled] = React.useState(value)
  const lastSyncRef = React.useRef(0)
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  React.useEffect(() => {
    const now = Date.now()
    const elapsed = now - lastSyncRef.current
    if (elapsed >= intervalMs) {
      lastSyncRef.current = now
      setThrottled(value)
      return
    }
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      lastSyncRef.current = Date.now()
      setThrottled(value)
    }, intervalMs - elapsed)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [value, intervalMs])

  return throttled
}

/** 媒体查询（M8 响应式）：<900px 折叠为「会话抽屉 + 主区 + 底部成员条」 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = React.useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(query).matches,
  )

  React.useEffect(() => {
    const mql = window.matchMedia(query)
    const onChange = (): void => setMatches(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])

  return matches
}

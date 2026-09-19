/**
 * M37-7：消息导航条——消息区右缘细轨：每行一块（按行下标等比定位）+ 视口窗口指示 +
 * hover 展开条目列表（点击跳转复用 ui-store.focusMessage 的定位闪光）。
 * 交付件块经 500ms 节流点亮；订阅隔离在组件内部，不拖累消息流渲染。
 */
import * as React from 'react'
import { useAgentStore } from '../../stores/agent-store'
import { useSessionStore } from '../../stores/session-store'
import type { RailItem } from '../../lib/chat-rows'
import { cn } from '../../lib/utils'

const THROTTLE_MS = 500

/** 两集合是否同一（避免节流刷新踩出无意义重渲染） */
function sameSet(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false
  for (const v of b) if (!a.has(v)) return false
  return true
}

export function MessageRail({
  items,
  total,
  vp,
  onJump,
}: {
  items: RailItem[]
  total: number
  vp: { first: number; last: number }
  onJump: (id: string) => void
}): React.JSX.Element | null {
  const agents = useAgentStore((s) => s.agents)
  const [dots, setDots] = React.useState<Set<number>>(() => new Set())
  const itemsRef = React.useRef(items)
  itemsRef.current = items

  // 500ms 节流：交付件到达时刷新「含交付件的行」标记
  React.useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null
    const unsub = useSessionStore.subscribe(() => {
      if (t) return
      t = setTimeout(() => {
        t = null
        const byId = useSessionStore.getState().byId
        const next = new Set<number>()
        for (const it of itemsRef.current) {
          if (it.kind === 'agent' && it.ids.some((id) => (byId.get(id)?.artifacts?.length ?? 0) > 0)) next.add(it.rowIndex)
        }
        setDots((prev) => (sameSet(prev, next) ? prev : next))
      }, THROTTLE_MS)
    })
    return () => {
      unsub()
      if (t) clearTimeout(t)
    }
  }, [])

  if (total === 0 || items.length === 0) return null
  const denom = Math.max(1, total)
  const winTop = (vp.first / denom) * 100
  const winH = (Math.max(1, vp.last - vp.first + 1) / denom) * 100

  const byId = useSessionStore.getState().byId
  const labelOf = (it: RailItem): string => {
    if (it.kind === 'user') return '你'
    const first = it.ids[0] ? byId.get(it.ids[0]) : undefined
    const wave =
      first && typeof first.turnIndex === 'number' && first.turnIndex >= 0 ? `第 ${first.turnIndex + 1} 波` : '发言'
    const names = it.ids
      .map((id) => {
        const agentId = byId.get(id)?.agentId
        return agentId ? (agents.find((a) => a.id === agentId)?.name ?? agentId) : ''
      })
      .filter(Boolean)
    return `${wave}${names.length > 0 ? ` · ${names.join('、')}` : ''}`
  }
  const entries = items.filter((it) => it.kind !== 'system')

  return (
    <div className="absolute right-1 top-1/2 z-30 hidden -translate-y-1/2 md:block">
      <div className="group/rail relative">
        {/* hover 展开：条目列表（点击跳转） */}
        <div className="pointer-events-none absolute right-4 top-1/2 hidden max-h-[min(60vh,420px)] w-56 -translate-y-1/2 overflow-y-auto rounded-lg border bg-card/95 p-1 shadow-xl backdrop-blur group-hover/rail:pointer-events-auto group-hover/rail:block">
          {entries.map((it) => (
            <button
              key={it.rowIndex}
              type="button"
              onClick={() => onJump(it.ids[0]!)}
              className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[11.5px] text-muted-foreground transition-colors hover:bg-primary/5 hover:text-foreground"
            >
              <span
                className={cn(
                  'size-1.5 shrink-0 rounded-full',
                  it.kind === 'user' ? 'bg-primary/70' : it.kind === 'agent' ? 'bg-primary/35' : 'bg-muted-foreground/30',
                  dots.has(it.rowIndex) && 'bg-amber-400',
                )}
              />
              <span className="min-w-0 truncate">{labelOf(it)}</span>
            </button>
          ))}
        </div>
        {/* 细轨：每行一块（等比定位，含交付件的块点亮为琥珀色） */}
        <div className="relative h-[min(50vh,360px)] w-1.5 rounded-full bg-border/60 transition-all group-hover/rail:w-2 group-hover/rail:bg-border">
          {items.map((it) => (
            <button
              key={it.rowIndex}
              type="button"
              onClick={() => onJump(it.ids[0]!)}
              aria-label={`跳到第 ${it.rowIndex + 1} 行`}
              className={cn(
                'absolute left-0 w-full rounded-full opacity-80 transition-opacity hover:opacity-100',
                it.kind === 'user'
                  ? 'h-[3px] bg-primary/70'
                  : it.kind === 'agent'
                    ? 'h-[3px] bg-primary/35'
                    : 'h-[2px] bg-muted-foreground/30',
                dots.has(it.rowIndex) && 'bg-amber-400/90',
              )}
              style={{ top: `${(it.rowIndex / denom) * 100}%` }}
            />
          ))}
          {/* 视口窗口指示 */}
          <span
            className="pointer-events-none absolute -left-0.5 w-2.5 rounded-full border border-primary/50 bg-primary/10"
            style={{ top: `${winTop}%`, height: `${winH}%`, minHeight: 8 }}
          />
        </div>
      </div>
    </div>
  )
}

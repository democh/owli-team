/**
 * M42（§71.5 / RT-5）：散会胶囊——会议收尾波交还用户后，消息流尾部给出「散会」事件条。
 * 派生条件（纯订阅，无副作用）：运行未活跃 && 末条成员消息含 `::: minutes` 纪要容器
 * （主持人收尾标志）。静态展示，无点击行为；入场一拍到位（handoff-in，
 * quiet-mode / reduced-motion 由全局收敛关闭）。
 * 订阅按「尾条指纹 id~role~status」隔离：流式 delta 不改指纹 → 本组件不随之重渲染。
 */
import * as React from 'react'
import { UsersRound } from 'lucide-react'
import { useRunStore } from '../../stores/run-store'
import { useSessionStore } from '../../stores/session-store'

/** 纪要容器开标记（行首 `::: minutes`；m 多行 + 后随空白 / 行尾边界） */
const MINUTES_OPEN_RE = /^:::[ \t]*minutes(?=[ \t]|$)/m

/** 尾条指纹 → 是否构成散会（导出供单测） */
export function adjournOfTail(content: string, role: string, status: string): boolean {
  if (role !== 'agent' || status !== 'complete') return false
  return MINUTES_OPEN_RE.test(content)
}

export function AdjournPill(): React.JSX.Element | null {
  const active = useRunStore((s) => !!s.active)
  // 尾条指纹：跳过 system 事件条（与 CloseoutCard 同口径）
  const tailKey = useSessionStore((s) => {
    for (let i = s.order.length - 1; i >= 0; i--) {
      const m = s.byId.get(s.order[i]!)
      if (!m || m.role === 'system') continue
      return `${m.id}~${m.role}~${m.status}`
    }
    return ''
  })

  const met = React.useMemo(() => {
    const [id, role, status] = tailKey.split('~')
    if (!id || !role || !status) return false
    const m = useSessionStore.getState().byId.get(id)
    return !!m && adjournOfTail(m.content, role, status)
  }, [tailKey])

  if (active || !met) return null
  return (
    <div
      data-adjourn-pill
      role="status"
      aria-label="散会"
      className="handoff-in flex items-center gap-3 px-8 py-3"
    >
      <span className="h-px flex-1 bg-border" aria-hidden />
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-[11.5px] text-muted-foreground shadow-sm">
        <UsersRound className="size-3.5 text-primary" aria-hidden />
        散会 · 会议已收尾
      </span>
      <span className="h-px flex-1 bg-border" aria-hidden />
    </div>
  )
}

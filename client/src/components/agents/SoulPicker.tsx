/**
 * 灵魂徽标与选择器（M16）：
 * - SoulBadge：只读徽标（icon + 灵魂名），名录页 / 候选卡复用；
 * - SoulPicker：点击徽标展开菜单切换灵魂或恢复默认（调用方负责 PATCH + toast + 事件条）；
 * - activeSoulOf：会话覆盖 > 角色默认的生效灵魂解析。
 * 无 souls 的角色渲染 null（非必配原则：不占位、不打扰）。
 */
import * as React from 'react'
import { Check, ChevronDown, Sparkles } from 'lucide-react'
import type { AgentDefinition, SoulMeta } from '@multi-agent/shared'
import { resolveIcon } from '../../lib/avatar-icons'
import { cn } from '../../lib/utils'

/** 生效灵魂：会话覆盖 soulId > 角色默认 defaultSoul；都没有 = 无灵魂 */
export function activeSoulOf(agent: AgentDefinition, override?: string): SoulMeta | undefined {
  const id = override ?? agent.defaultSoul
  return id ? agent.souls?.find((s) => s.id === id) : undefined
}

export function SoulBadge({
  soul,
  className,
  showIcon = true,
}: {
  soul: SoulMeta
  className?: string
  showIcon?: boolean
}): React.JSX.Element {
  const Icon = resolveIcon(soul.icon)
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-medium text-violet-700',
        className,
      )}
      title={`${soul.name} · ${soul.tagline}`}
    >
      {showIcon && <Icon className="size-2.5 shrink-0" />}
      {soul.name}
    </span>
  )
}

export function SoulPicker({
  agent,
  override,
  disabled,
  onPick,
}: {
  agent: AgentDefinition
  /** 会话覆盖 soulId（undefined = 使用角色默认） */
  override?: string
  disabled?: boolean
  onPick: (soul: string | null) => void
}): React.JSX.Element | null {
  const [open, setOpen] = React.useState(false)
  const ref = React.useRef<HTMLDivElement>(null)
  const souls = agent.souls ?? []

  React.useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  if (souls.length === 0) return null

  const active = activeSoulOf(agent, override)
  const ActiveIcon = resolveIcon(active?.icon)

  /** 点击当前生效项无操作；点击默认项 = 清除覆盖（恢复默认）；其余 = 覆盖 */
  const handlePick = (s: SoulMeta): void => {
    setOpen(false)
    if (s.id === (override ?? agent.defaultSoul)) return
    onPick(s.id === agent.defaultSoul ? null : s.id)
  }

  return (
    <div ref={ref} className="relative inline-flex" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        title={active ? `${active.name} · ${active.tagline}（点击切换灵魂）` : `为 ${agent.name} 选择灵魂变体`}
        className={cn(
          'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors',
          active
            ? 'bg-violet-500/10 text-violet-700 hover:bg-violet-500/20'
            : 'border border-dashed text-muted-foreground hover:border-violet-400/60 hover:text-violet-700',
        )}
      >
        {active ? <ActiveIcon className="size-2.5 shrink-0" /> : <Sparkles className="size-2.5 shrink-0" />}
        {active ? active.name : '灵魂'}
        <ChevronDown className="size-2.5 opacity-60" />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-56 rounded-lg border bg-popover p-1 shadow-xl shadow-slate-900/10">
          <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">灵魂变体</div>
          {override !== undefined && agent.defaultSoul && (
            <button
              type="button"
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[11.5px] transition-colors hover:bg-accent/70"
              onClick={() => {
                setOpen(false)
                onPick(null)
              }}
            >
              <Sparkles className="size-3 shrink-0 text-muted-foreground" />
              恢复默认（{agent.souls?.find((s) => s.id === agent.defaultSoul)?.name ?? agent.defaultSoul}）
            </button>
          )}
          {souls.map((s) => {
            const Icon = resolveIcon(s.icon)
            const effective = s.id === (override ?? agent.defaultSoul)
            return (
              <button
                key={s.id}
                type="button"
                className={cn(
                  'flex w-full items-start gap-1.5 rounded-md px-2 py-1.5 text-left text-[11.5px] transition-colors hover:bg-accent/70',
                  effective && 'bg-violet-500/[0.08] text-violet-700',
                )}
                onClick={() => handlePick(s)}
              >
                <Icon className="mt-0.5 size-3 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1 font-medium">
                    {s.name}
                    {s.id === agent.defaultSoul && (
                      <span className="rounded bg-muted px-1 text-[9px] font-normal text-muted-foreground">默认</span>
                    )}
                    {effective && <Check className="size-3 shrink-0" />}
                  </span>
                  <span className="mt-0.5 block truncate text-[10.5px] text-muted-foreground">{s.tagline}</span>
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

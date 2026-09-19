/**
 * 灵魂徽标与选择器（M16）：
 * - SoulBadge：只读徽标（icon + 灵魂名），名录页 / 候选卡复用；
 * - SoulPicker：点击徽标展开菜单切换灵魂或恢复默认（调用方负责 PATCH + toast + 事件条）；
 * - activeSoulOf：会话覆盖 > 角色默认的生效灵魂解析。
 * 无 souls 的角色渲染 null（非必配原则：不占位、不打扰）。
 * M77：弹层统一走 createPortal + fixed 定位（与 AgentPicker.PersonaMenu 同模式）——
 * 避开滚动容器 overflow 裁剪与 Radix modal Dialog 的 pointer-events 封锁。
 */
import * as React from 'react'
import * as ReactDOM from 'react-dom'
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

type MenuPlacement = { left: number; top: number; up: boolean }

/**
 * Portal 弹层锚点（与 AgentPicker.PersonaMenu 同模式）：fixed 定位挂 body ——
 * 避开滚动容器 overflow 裁剪与 Radix modal Dialog 的 pointer-events 封锁。
 * 仅监听 resize 关闭（不监听容器滚动：Playwright / 触摸滚动的滞后 scroll 事件会误收刚打开的菜单；
 * 菜单为短时操作，滚动期间保持原位可接受）。
 */
function usePortalMenu(): {
  wrapRef: React.RefObject<HTMLDivElement>
  menuRef: React.RefObject<HTMLDivElement>
  open: boolean
  placement: MenuPlacement | undefined
  toggle: (width: number, height: number, align?: 'left' | 'right') => void
  close: () => void
} {
  const [open, setOpen] = React.useState(false)
  const [placement, setPlacement] = React.useState<MenuPlacement>()
  const wrapRef = React.useRef<HTMLDivElement>(null)
  const menuRef = React.useRef<HTMLDivElement>(null)
  // 打开期间的锚点快照与估算参数（供漂移重算）
  const anchorRef = React.useRef<{ right: number; top: number; bottom: number }>()
  const argsRef = React.useRef({ w: 0, h: 0, align: 'left' as 'left' | 'right' })

  const place = (): void => {
    const rect = wrapRef.current?.getBoundingClientRect()
    if (!rect) return
    const { w, h, align } = argsRef.current
    const up = rect.bottom + h > window.innerHeight - 8
    const raw = align === 'right' ? rect.right - w : rect.left
    anchorRef.current = { right: rect.right, top: rect.top, bottom: rect.bottom }
    setPlacement({
      left: Math.max(8, Math.min(raw, window.innerWidth - w - 8)),
      top: up ? rect.top - 6 : rect.bottom + 6,
      up,
    })
  }

  React.useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node
      // 弹层走 Portal（不在触发钮 DOM 内）：外部判定需同时排除菜单自身，否则点击菜单项前即被收起
      if (wrapRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    const close = (): void => setOpen(false)
    document.addEventListener('mousedown', onDown)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('resize', close)
    }
  }, [open])

  // open 期间触发钮因行内重排（如参与人格增删致按钮变宽换行）漂移时跟随重算；滚动不触发 React 渲染故菜单不随滚动漂移
  React.useEffect(() => {
    if (!open) return
    const rect = wrapRef.current?.getBoundingClientRect()
    const anchor = anchorRef.current
    if (!rect || !anchor) return
    if (rect.right === anchor.right && rect.top === anchor.top && rect.bottom === anchor.bottom) return
    place()
  })

  const toggle = (width: number, height: number, align: 'left' | 'right' = 'left'): void => {
    if (open) {
      setOpen(false)
      return
    }
    argsRef.current = { w: width, h: height, align }
    place()
    setOpen(true)
  }

  return { wrapRef, menuRef, open, placement, toggle, close: () => setOpen(false) }
}

/** Portal 弹层容器：fixed 挂 body；显式恢复指针事件（Radix modal Dialog 会把 body 直系外部兄弟置 pointer-events:none） */
function PortalMenu({
  menuRef,
  placement,
  className,
  children,
}: {
  menuRef: React.RefObject<HTMLDivElement>
  placement: MenuPlacement
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return ReactDOM.createPortal(
    <div
      ref={menuRef}
      className={cn('fixed z-[70] rounded-lg border bg-popover p-1 shadow-xl shadow-slate-900/10', className)}
      style={{
        left: placement.left,
        top: placement.top,
        transform: placement.up ? 'translateY(-100%)' : undefined,
        pointerEvents: 'auto',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  )
}

export function SoulPicker({
  agent,
  override,
  disabled,
  pinned,
  onPick,
}: {
  agent: AgentDefinition
  /** 会话覆盖 soulId（undefined = 使用角色默认） */
  override?: string
  disabled?: boolean
  /** M77：分身实例（键内嵌灵魂；无「恢复默认」项，换装 = 键替换） */
  pinned?: boolean
  onPick: (soul: string | null) => void
}): React.JSX.Element | null {
  const { wrapRef, menuRef, open, placement, toggle, close } = usePortalMenu()
  const souls = agent.souls ?? []

  if (souls.length === 0) return null

  const active = activeSoulOf(agent, override)
  const ActiveIcon = resolveIcon(active?.icon)
  const MENU_W = 224
  // M77：分身实例无「恢复默认」项（换装 = 键替换）；经典实例存在覆盖时给出恢复入口
  const recoverable = !pinned && override !== undefined && Boolean(agent.defaultSoul)

  /** 点击当前生效项无操作；点击默认项 = 清除覆盖（恢复默认）；其余 = 覆盖 */
  const handlePick = (s: SoulMeta): void => {
    close()
    if (s.id === (override ?? agent.defaultSoul)) return
    onPick(s.id === agent.defaultSoul ? null : s.id)
  }

  return (
    <div ref={wrapRef} className="relative inline-flex" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => toggle(MENU_W, souls.length * 46 + 28 + (recoverable ? 34 : 0))}
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

      {open && placement && (
        <PortalMenu menuRef={menuRef} placement={placement} className="w-56">
          <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            {pinned ? '分身灵魂（切换 = 重塑该分身）' : '灵魂变体'}
          </div>
          {recoverable && (
            <button
              type="button"
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[11.5px] transition-colors hover:bg-accent/70"
              onClick={() => {
                close()
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
        </PortalMenu>
      )}
    </div>
  )
}

/**
 * M77「参与性格」多选器（建会话组队台编制行）：
 * - 勾选 = 该人格入编（多选 = 同角多魂同台，各说各话）；取消 = 移除该人格实例；
 * - 全部取消 = 以「默认」单人参与（无显式人格；灵魂仍由角色默认决定）；
 * - 触发钮文案 = 参与中的人格名（`狂野+禅意`）；菜单项为 role=button + aria-pressed（测试锚点）。
 */
export function SoulParticipantPicker({
  agent,
  value,
  onToggle,
  disabled,
}: {
  agent: AgentDefinition
  /** 参与中的灵魂 id 集合（空集 = 默认单人参与） */
  value: string[]
  onToggle: (soulId: string) => void
  disabled?: boolean
}): React.JSX.Element | null {
  const { wrapRef, menuRef, open, placement, toggle } = usePortalMenu()
  const souls = agent.souls ?? []

  if (souls.length === 0) return null
  const selected = new Set(value)
  const label = value.length === 0 ? '默认' : souls.filter((s) => selected.has(s.id)).map((s) => s.name).join('+')
  return (
    <div ref={wrapRef} className="relative inline-flex" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => toggle(240, souls.length * 46 + 68, 'right')}
        title={`参与性格：${label}（点击勾选参与的人格；多选 = 同角多魂同台）`}
        className={cn(
          'inline-flex max-w-28 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors',
          value.length > 0
            ? 'bg-violet-500/10 text-violet-700 hover:bg-violet-500/20'
            : 'border border-dashed text-muted-foreground hover:border-violet-400/60 hover:text-violet-700',
        )}
      >
        <Sparkles className="size-2.5 shrink-0" />
        <span className="truncate">{label}</span>
        <ChevronDown className="size-2.5 shrink-0 opacity-60" />
      </button>

      {open && placement && (
        <PortalMenu menuRef={menuRef} placement={placement} className="w-60">
          <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">参与性格（可多选）</div>
          {souls.map((s) => {
            const Icon = resolveIcon(s.icon)
            const on = selected.has(s.id)
            return (
              <button
                key={s.id}
                type="button"
                aria-pressed={on}
                className={cn(
                  'flex w-full items-start gap-1.5 rounded-md px-2 py-1.5 text-left text-[11.5px] transition-colors hover:bg-accent/70',
                  on && 'bg-violet-500/[0.08] text-violet-700',
                )}
                onClick={() => onToggle(s.id)}
              >
                <Icon className="mt-0.5 size-3 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1 font-medium">
                    {s.name}
                    {s.id === agent.defaultSoul && (
                      <span className="rounded bg-muted px-1 text-[9px] font-normal text-muted-foreground">默认</span>
                    )}
                    {on && <Check className="size-3 shrink-0" />}
                  </span>
                  <span className="mt-0.5 block truncate text-[10.5px] text-muted-foreground">{s.tagline}</span>
                </span>
              </button>
            )
          })}
          <div className="border-t px-2 py-1 text-[10px] leading-4 text-muted-foreground">
            勾选多个 = 同角多魂同台（如 卢娜·狂野 + 卢娜·禅意）；全部取消 = 以默认人格参与
          </div>
        </PortalMenu>
      )}
    </div>
  )
}

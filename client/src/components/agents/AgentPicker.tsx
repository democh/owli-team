/**
 * Agent 选择器（M16）：分组 Tab + 搜索 + 卡片式多选 + 已在场禁用。
 * 选中成员可展开灵魂选择（默认 = 角色默认灵魂）；建会话「组队台·角色池」与「邀请成员」两处复用。
 */
import * as React from 'react'
import { Check, Search, X } from 'lucide-react'
import { useAgentStore } from '../../stores/agent-store'
import { cn } from '../../lib/utils'
import { Input } from '../ui/input'
import { AgentAvatar } from './AgentAvatar'
import { GroupBadge } from './GroupBadge'
import { SoulPicker } from './SoulPicker'

export interface AgentPickerProps {
  /** 已选成员 id（受控） */
  value: string[]
  onChange: (ids: string[]) => void
  /** 已选成员的灵魂覆盖（受控；与 onSoulChange 同时提供才展示灵魂选择） */
  souls?: Record<string, string>
  onSoulChange?: (agentId: string, soul: string | null) => void
  /** 已在场成员：禁用点击并标注「已在场」 */
  disabledIds?: string[]
  /** M50：填满父容器高度（建会话组队台·角色池）；默认 false 保持 max-h-72（邀请对话框） */
  fill?: boolean
  className?: string
}

export function AgentPicker({
  value,
  onChange,
  souls,
  onSoulChange,
  disabledIds,
  fill = false,
  className,
}: AgentPickerProps): React.JSX.Element {
  const agents = useAgentStore((s) => s.agents)
  const groups = useAgentStore((s) => s.groups)
  const [tab, setTab] = React.useState<string>('all')
  const [query, setQuery] = React.useState('')

  const picked = React.useMemo(() => new Set(value), [value])
  const blocked = React.useMemo(() => new Set(disabledIds ?? []), [disabledIds])
  const soulEnabled = souls !== undefined && onSoulChange !== undefined

  const q = query.trim().toLowerCase()
  const list = React.useMemo(
    () =>
      agents.filter((a) => {
        if (tab !== 'all' && a.group !== tab) return false
        if (!q) return true
        return (
          a.name.toLowerCase().includes(q) ||
          a.role.toLowerCase().includes(q) ||
          a.id.toLowerCase().includes(q) ||
          a.description.toLowerCase().includes(q) ||
          a.capabilities.some((c) => c.toLowerCase().includes(q))
        )
      }),
    [agents, tab, q],
  )

  const toggle = (id: string): void => {
    if (blocked.has(id)) return
    onChange(picked.has(id) ? value.filter((x) => x !== id) : [...value, id])
  }

  const tabCls = (on: boolean): string =>
    cn(
      'shrink-0 rounded-full px-2 py-0.5 text-[11.5px] transition-colors',
      on ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground',
    )

  return (
    <div className={cn('flex min-h-0 flex-col gap-2', className)}>
      <div className="flex items-center gap-0.5 overflow-x-auto pb-0.5">
        <button type="button" className={tabCls(tab === 'all')} onClick={() => setTab('all')}>
          全部
        </button>
        {groups.map((g) => (
          <button key={g.id} type="button" className={tabCls(tab === g.id)} onClick={() => setTab(g.id)}>
            {g.name}
            <span className="ml-0.5 text-[10px] opacity-70">{agents.filter((a) => a.group === g.id).length}</span>
          </button>
        ))}
      </div>

      <div className="relative">
        <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索角色 / 能力…"
          className="h-7 pl-7 pr-7 text-[12px]"
        />
        {query && (
          <button
            type="button"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
            title="清空搜索"
            onClick={() => setQuery('')}
          >
            <X className="size-3" />
          </button>
        )}
      </div>

      <div
        className={cn(
          // content-start：fill 变体下容器被 flex-1 撑高，若走默认 align-content:stretch，
          // 自动行会被拉伸分摊剩余高度（卡片底部大块空白）；改为内容高度、行顶对齐
          'grid grid-cols-2 content-start gap-1.5 overflow-y-auto rounded-md border p-1.5',
          fill ? 'min-h-0 flex-1' : 'max-h-72',
        )}
      >
        {list.map((a) => {
          const on = picked.has(a.id)
          const off = blocked.has(a.id)
          const group = groups.find((g) => g.id === a.group)
          return (
            <div
              key={a.id}
              role="button"
              tabIndex={0}
              aria-pressed={on}
              onClick={() => toggle(a.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  toggle(a.id)
                }
              }}
              className={cn(
                'rounded-lg border p-2 transition-all',
                off
                  ? 'cursor-not-allowed border-transparent bg-muted/40 opacity-60'
                  : on
                    ? 'cursor-pointer border-primary/45 bg-primary/[0.05] shadow-sm'
                    : 'cursor-pointer border-border/70 hover:border-primary/30 hover:bg-accent/40',
              )}
            >
              <div className="flex items-center gap-2">
                <AgentAvatar agent={a} size={30} animated={false} className="rounded-md" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1">
                    <span className="truncate text-[12px] font-semibold">{a.name}</span>
                    {group && <GroupBadge group={group} showName={false} className="shrink-0 p-0.5" />}
                  </div>
                  <div className="truncate text-[10.5px] text-muted-foreground">{a.role}</div>
                </div>
                {off ? (
                  <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[9.5px] text-muted-foreground">已在场</span>
                ) : on ? (
                  <Check className="size-3.5 shrink-0 text-primary" />
                ) : null}
              </div>
              {on && !off && soulEnabled && (
                <div className="mt-1.5">
                  <SoulPicker agent={a} override={souls?.[a.id]} onPick={(soul) => onSoulChange?.(a.id, soul)} />
                </div>
              )}
            </div>
          )
        })}
        {list.length === 0 && (
          <div className="col-span-2 py-6 text-center text-[12px] text-muted-foreground">没有匹配的角色</div>
        )}
      </div>
    </div>
  )
}

/**
 * Agent 选择器（M16 / M77）：分组 Tab + 搜索 + 卡片式多选。
 * - M77：值域升级为「成员键」（经典 = agentId；分身 = `agentId~soulId`）——
 *   同角多魂同台：卡片点击 = 增删经典成员（并存时整体移除）；「+ 分身」= 以未占用灵魂追加实例；
 * - 选中成员可展开灵魂选择（默认 = 角色默认灵魂；经典键覆盖）；建会话「组队台·角色池」与「邀请成员」两处复用。
 */
import * as React from 'react'
import * as ReactDOM from 'react-dom'
import { Check, Plus, Search, X } from 'lucide-react'
import type { AgentDefinition } from '@multi-agent/shared'
import { baseAgentId, memberKeyOf, CATALOG_CATEGORIES, catalogCategory } from '@multi-agent/shared'
import { useAgentStore } from '../../stores/agent-store'
import { resolveIcon } from '../../lib/avatar-icons'
import { soulIdOf } from '../../lib/members'
import { buildCatalog, searchCatalog } from '../../lib/catalog'
import { CatalogDetail } from './CatalogDetail'
import { Button } from '../ui/button'
import { cn } from '../../lib/utils'
import { Input } from '../ui/input'
import { AgentAvatar } from './AgentAvatar'
import { GroupBadge } from './GroupBadge'
import { SoulPicker } from './SoulPicker'

/** 同角实例上限（与服务端 lineupError 一致） */
const MAX_INSTANCES = 4

export interface AgentPickerProps {
  initialGroup?: string
  recommendedIds?: string[]
  onDetail?: (id: string) => void
  /** 已选成员键（受控；创建 = 编制预览，邀请 = 拟邀请名单） */
  value: string[]
  onChange: (keys: string[]) => void
  /** 已选成员的灵魂覆盖（经典成员键 → soulId；与 onSoulChange 同时提供才展示灵魂切换） */
  souls?: Record<string, string>
  onSoulChange?: (memberKey: string, soul: string | null) => void
  /** M77：额外在场成员键（邀请场景传会话已有成员：显示「已在场」徽标并参与分身去重） */
  memberKeys?: string[]
  /** 完全禁用点击的角色 id（逃生门；默认不用） */
  disabledIds?: string[]
  /** M50：填满父容器高度（建会话组队台·角色池）；默认 false 保持 max-h-72（邀请对话框） */
  fill?: boolean
  className?: string
}

/**
 * 单卡「+ 分身」菜单：仅列出该角色尚未占用的灵魂（有效灵魂去重）。
 * 弹层走 createPortal + fixed 定位于触发钮（滚动容器 overflow 裁剪 / Dialog 遮罩层叠下仍可点击）。
 */
function PersonaMenu({
  agent,
  usedSoulIds,
  onAdd,
}: {
  agent: AgentDefinition
  usedSoulIds: Set<string>
  onAdd: (soulId: string) => void
}): React.JSX.Element | null {
  const [open, setOpen] = React.useState(false)
  const [placement, setPlacement] = React.useState<{ left: number; top: number; up: boolean }>()
  const ref = React.useRef<HTMLDivElement>(null)
  const menuRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node
      // 弹层走 Portal（不在触发钮 DOM 内）：外部判定需同时排除菜单自身，否则点击菜单项前即被收起
      if (ref.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    // 仅监听 resize（不监听容器滚动：Playwright / 触摸滚动的滞后 scroll 事件会把刚打开的菜单立即收起；
    // 菜单为短时操作，滚动期间保持原位可接受）
    const close = (): void => setOpen(false)
    document.addEventListener('mousedown', onDown)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('resize', close)
    }
  }, [open])

  const available = (agent.souls ?? []).filter((s) => !usedSoulIds.has(s.id))
  if (available.length === 0) return null

  const MENU_W = 224
  const toggle = (): void => {
    if (open) {
      setOpen(false)
      return
    }
    const rect = ref.current?.getBoundingClientRect()
    if (rect) {
      const height = Math.min(available.length * 46 + 28, 240)
      const up = rect.bottom + height > window.innerHeight - 8
      setPlacement({
        left: Math.max(8, Math.min(rect.right - MENU_W, window.innerWidth - MENU_W - 8)),
        top: up ? rect.top - 6 : rect.bottom + 6,
        up,
      })
    }
    setOpen(true)
  }

  return (
    <div ref={ref} className="relative inline-flex" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        aria-label="追加分身"
        title={`为 ${agent.name} 追加一位不同性格的分身（同台各说各话）`}
        onClick={toggle}
        className="inline-flex items-center gap-0.5 rounded border border-dashed px-1 py-0.5 text-[9.5px] text-muted-foreground transition-colors hover:border-violet-400/60 hover:text-violet-700"
      >
        <Plus className="size-2.5" />
        分身
      </button>
      {open &&
        placement &&
        ReactDOM.createPortal(
          <div
            ref={menuRef}
            className="fixed z-[70] w-56 rounded-lg border bg-popover p-1 shadow-xl shadow-slate-900/10"
            style={{
              left: placement.left,
              top: placement.top,
              transform: placement.up ? 'translateY(-100%)' : undefined,
              // Radix Dialog（modal）会把 body 直系外部兄弟置 pointer-events:none；本弹层为 body 级 Portal，
              // 必须显式恢复自身指针事件（否则菜单可见但不可点）
              pointerEvents: 'auto',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">以其他性格入编</div>
            {available.map((s) => {
              const Icon = resolveIcon(s.icon)
              return (
                <button
                  key={s.id}
                  type="button"
                  className="flex w-full items-start gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/70"
                  onClick={() => {
                    setOpen(false)
                    onAdd(s.id)
                  }}
                >
                  <Icon className="mt-0.5 size-3 shrink-0 text-violet-600" />
                  <span className="min-w-0">
                    <span className="block text-[11.5px] font-medium">{s.name}</span>
                    {s.tagline && <span className="block truncate text-[10px] text-muted-foreground">{s.tagline}</span>}
                  </span>
                </button>
              )
            })}
          </div>,
          document.body,
        )}
    </div>
  )
}

export function AgentPicker({
  value,
  onChange,
  souls,
  onSoulChange,
  memberKeys,
  disabledIds,
  fill = false,
  className,
  initialGroup,
  recommendedIds,
  onDetail,
}: AgentPickerProps): React.JSX.Element {
  const agents = useAgentStore((s) => s.agents)
  const groups = useAgentStore((s) => s.groups)
  const presets = useAgentStore((s) => s.presets)
  const [tab, setTab] = React.useState<string>(initialGroup ?? (recommendedIds?.length ? 'recommended' : 'all'))
  const [category, setCategory] = React.useState('all')
  const [sceneQuery, setSceneQuery] = React.useState('')
  const [query, setQuery] = React.useState('')
  const [detail, setDetail] = React.useState<string>()
  const detailOpener = React.useRef<HTMLElement | null>(null)
  const catalog = React.useMemo(() => buildCatalog(agents, groups, presets), [agents, groups, presets])
  const byKey = React.useMemo(() => new Map(catalog.map((e) => [e.key, e])), [catalog])
  const groupById = React.useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups])

  const blocked = React.useMemo(() => new Set(disabledIds ?? []), [disabledIds])
  const soulEnabled = souls !== undefined && onSoulChange !== undefined

  /** 某角色在「已选 + 已在场」视角下的既有成员键（分身去重与计数依据） */
  const keysOfAgent = React.useCallback(
    (agentId: string): string[] =>
      [...(memberKeys ?? []), ...value].filter((key) => baseAgentId(key) === agentId),
    [memberKeys, value],
  )

  const list = React.useMemo(() => searchCatalog(catalog, query, category, 'agent')
    .filter((e) => tab === 'all' || (tab === 'recommended' ? recommendedIds?.includes(e.id) : e.agent?.group === tab))
    .map((e) => e.agent!), [catalog, query, category, tab, recommendedIds])
  const sceneList = groups.filter((g) => (category === 'all' || catalogCategory(g.category) === category) && (g.id === tab || g.name.includes(sceneQuery) || g.id.includes(sceneQuery)))

  /** 卡片点击：已选（含分身）→ 整体移除；未选 → 追加经典成员 */
  const toggle = (agent: AgentDefinition): void => {
    if (blocked.has(agent.id)) return
    const picked = value.some((key) => baseAgentId(key) === agent.id)
    onChange(picked ? value.filter((key) => baseAgentId(key) !== agent.id) : [...value, agent.id])
  }

  const detailEntry = detail ? byKey.get(detail) : undefined
  if (detailEntry) return <div className="min-h-0 overflow-auto p-3"><Button autoFocus variant="outline" onClick={() => { setDetail(undefined); requestAnimationFrame(() => detailOpener.current?.focus()) }}>返回角色池</Button><h3 className="my-3 font-semibold">{detailEntry.name}</h3><CatalogDetail key={detailEntry.key} entry={detailEntry} entries={catalog} onNavigate={setDetail} onUse={(source) => { if (source.kind === 'agent' && !blocked.has(source.id) && !value.some((key) => baseAgentId(key) === source.id)) onChange([...value, source.id]); setDetail(undefined) }} /></div>

  return (
    <div className={cn('flex min-h-0 flex-col gap-2', className)}>
      <div className="grid grid-cols-2 gap-2 text-[13px]">
        <select aria-label="角色分类" value={category} onChange={(e) => { setCategory(e.target.value); setTab('all') }} className="min-w-0 rounded border bg-card p-2"><option value="all">全部分类</option>{Object.entries(CATALOG_CATEGORIES).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
        <select aria-label="选择角色场景" value={tab} onChange={(e) => setTab(e.target.value)} className="min-w-0 rounded border bg-card p-2"><option value="all">全部角色</option>{!!recommendedIds?.length && <option value="recommended">推荐成员</option>}{sceneList.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select>
      </div>
      <Input aria-label="搜索场景选项" value={sceneQuery} onChange={(e) => setSceneQuery(e.target.value)} placeholder="查找场景…" className="h-8 text-[13px]" />

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
          const off = blocked.has(a.id)
          const keys = keysOfAgent(a.id)
          const pickedKeys = value.filter((key) => baseAgentId(key) === a.id)
          const presentKeys = (memberKeys ?? []).filter((key) => baseAgentId(key) === a.id)
          const on = pickedKeys.length > 0
          const absent = presentKeys.length > 0
          const group = groupById.get(a.group)
          const usedSoulIds = new Set<string>()
          for (const key of keys) {
            const soulId = soulIdOf(a, key, souls)
            if (soulId) usedSoulIds.add(soulId)
          }
          const totalInstances = keys.length
          const classicKey = pickedKeys.find((key) => key === a.id)
          return (
            <div
              key={a.id}
              role="button"
              tabIndex={0}
              aria-pressed={on}
              aria-disabled={off}
              onClick={() => toggle(a)}
              onKeyDown={(e) => {
                if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault()
                  toggle(a)
                }
              }}
              className={cn(
                'rounded-lg border p-2 transition-all',
                off
                  ? 'cursor-not-allowed border-transparent bg-muted/40 opacity-60'
                  : on
                    ? 'cursor-pointer border-primary/45 bg-primary/[0.05] shadow-sm'
                    : absent
                      ? 'cursor-pointer border-border/70 bg-muted/20 hover:border-primary/30 hover:bg-accent/40'
                      : 'cursor-pointer border-border/70 hover:border-primary/30 hover:bg-accent/40',
              )}
            >
              <div className="flex items-center gap-2">
                <AgentAvatar agent={a} size={30} animated={false} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1">
                    <span className="truncate text-[12px] font-semibold">{a.name}</span>
                    {group && <GroupBadge group={group} showName={false} className="shrink-0 p-0.5" />}
                  </div>
                  <div className="truncate text-[13px] text-muted-foreground">{a.role}</div>
                </div>
                {off ? (
                  <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[9.5px] text-muted-foreground">已在场</span>
                ) : (
                  <span className="flex shrink-0 items-center gap-1">
                    {absent && (
                      <span className="rounded bg-muted px-1 py-0.5 text-[9.5px] text-muted-foreground">
                        已在场{totalInstances > 1 ? `×${totalInstances}` : ''}
                      </span>
                    )}
                    {on && <Check className="size-3.5 shrink-0 text-primary" />}
                  </span>
                )}
              </div>
              <p className="mt-2 line-clamp-2 text-[13px] leading-5 text-muted-foreground">{a.description}</p>
              <p className="mt-1 text-[13px] text-muted-foreground">{a.capabilities.slice(0, 3).join(' · ')}</p>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[13px]"><span>{byKey.get(`agent:${a.id}`)?.isDefault ? '默认成员' : '扩展专家'}</span><button type="button" aria-label="查看角色详情" title={`查看 ${a.name} 的职责、能力与交接对象`} className="rounded px-2 py-1 text-primary hover:bg-accent focus-visible:ring-2" onClick={(e) => { e.stopPropagation(); if (onDetail) onDetail(a.id); else { detailOpener.current = e.currentTarget; setDetail(`agent:${a.id}`) } }}>详情</button></div>
              {(on || absent) && !off && (
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                  {classicKey && soulEnabled && (
                    <SoulPicker
                      agent={a}
                      override={souls?.[classicKey]}
                      onPick={(soul) => onSoulChange?.(classicKey, soul)}
                    />
                  )}
                  {totalInstances > 1 && (
                    <span className="rounded bg-violet-500/10 px-1 py-0.5 text-[9.5px] font-medium text-violet-700">
                      同角 {totalInstances} 位
                    </span>
                  )}
                  {totalInstances < MAX_INSTANCES && (
                    <PersonaMenu
                      agent={a}
                      usedSoulIds={usedSoulIds}
                      onAdd={(soulId) => onChange([...value, memberKeyOf(a.id, soulId)])}
                    />
                  )}
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

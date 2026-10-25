/**
 * 建会话「组队台」（M50）：左「来源」→ 中「角色池」→ 右「编制」，一次成局（取代 M16 两步向导）。
 * 桌面（≥1024px）三栏常驻；窄屏收敛为「来源 / 角色池 / 编制」三页签（条件渲染单面板，桌面/窄屏共享同一份 pane JSX）。
 * 行为等价不变量：空编制合法（M48）、preset.prompt 创建后写入 `ma:draft:<id>` 草稿键（M21）、
 * souls 仅保留最终编制（M46）、点来源行 = 以推荐编制整体替换并清 souls；
 * pendingCreate 通道由 SessionList 消费后经 initialSource 传入（无效 id 回退无来源）。
 */
import * as React from 'react'
import { toast } from 'sonner'
import { Check, Layers, Loader2, Search, Sparkles, Users, X, Zap } from 'lucide-react'
import type { AgentDefinition, Session } from '@multi-agent/shared'
import { BLANK_SCENE_ID, DEFAULT_SPACE_ID, baseAgentId } from '@multi-agent/shared'
import { apiPatch } from '../../lib/api'
import { useAgentStore } from '../../stores/agent-store'
import { useAuthStore } from '../../stores/auth-store'
import { useFriendsStore } from '../../stores/friends-store'
import { useSessionStore } from '../../stores/session-store'
import { useShareStore } from '../../stores/share-store'
import { useSpaceStore } from '../../stores/space-store'
import { useMediaQuery } from '../../lib/hooks'
import { resolveIcon } from '../../lib/avatar-icons'
import { encodeParticipation, participationOf } from '../../lib/members'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog'
import { AgentAvatar } from '../agents/AgentAvatar'
import { AgentPicker } from '../agents/AgentPicker'
import { GroupBadge } from '../agents/GroupBadge'
import { SoulParticipantPicker } from '../agents/SoulPicker'
import { HumanAvatar } from '../chat/HumanAvatar'

/** 组队来源（快速组队 preset / 场景 scene 二选一；命令面板 pendingCreate 与此共用） */
export interface CreateSource {
  kind: 'preset' | 'scene'
  id: string
}

export interface CreateSessionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** M21/M48：命令面板入口预选来源（无效 id 回退无来源） */
  initialSource?: CreateSource
  /** 创建成功（草稿键已写入）：切换进入新会话 */
  onCreated: (sessionId: string) => void
}

type Pane = 'source' | 'pool' | 'lineup'

export function CreateSessionDialog({
  open,
  onOpenChange,
  initialSource,
  onCreated,
}: CreateSessionDialogProps): React.JSX.Element {
  const agents = useAgentStore((s) => s.agents)
  const groups = useAgentStore((s) => s.groups)
  const presets = useAgentStore((s) => s.presets)

  const [picked, setPicked] = React.useState<string[]>([])
  const [souls, setSouls] = React.useState<Record<string, string>>({})
  const [titleInput, setTitleInput] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  // M79-O：协作成员（真人）——创建时一步邀请（免「先建后共享」两步）
  const [humanIds, setHumanIds] = React.useState<string[]>([])
  const multiUser = useAuthStore((s) => s.status.multiUser)
  const friends = useFriendsStore((s) => s.friends)
  const [source, setSource] = React.useState<CreateSource>()
  const [query, setQuery] = React.useState('')
  const [pane, setPane] = React.useState<Pane>('source')
  const narrow = useMediaQuery('(max-width: 1023px)')
  // 打开重置 effect 读取当前窄屏态但不以其为依赖（避免视口变化重跑重置）
  const narrowRef = React.useRef(narrow)
  narrowRef.current = narrow

  // 打开时重置：按 initialSource 预填（无效 id 回退无来源）；窄屏有来源直达「编制」页
  React.useEffect(() => {
    if (!open) return
    const known = new Set(useAgentStore.getState().agents.map((a) => a.id))
    const preset =
      initialSource?.kind === 'preset'
        ? useAgentStore.getState().presets.find((p) => p.id === initialSource.id)
        : undefined
    const group =
      initialSource?.kind === 'scene'
        ? useAgentStore.getState().groups.find((g) => g.id === initialSource.id)
        : undefined
    setTitleInput('')
    setQuery('')
    setBusy(false)
    setSouls({})
    setHumanIds([])
    if (preset) {
      setSource({ kind: 'preset', id: preset.id })
      setPicked(preset.members.filter((id) => known.has(id)))
    } else if (group) {
      setSource({ kind: 'scene', id: group.id })
      setPicked((group.chain ?? []).filter((id) => known.has(id)))
    } else {
      setSource(undefined)
      setPicked([])
    }
    setPane(preset || group ? (narrowRef.current ? 'lineup' : 'source') : 'source')
  }, [open, initialSource])

  // M79-O：打开时拉好友（协作成员候选；多用户模式）
  React.useEffect(() => {
    if (open && multiUser) void useFriendsStore.getState().load()
  }, [open, multiUser])

  const toggleHuman = (userId: string): void =>
    setHumanIds((prev) => (prev.includes(userId) ? prev.filter((x) => x !== userId) : [...prev, userId]))

  const preset = source?.kind === 'preset' ? presets.find((p) => p.id === source.id) : undefined
  const group = source?.kind === 'scene' ? groups.find((g) => g.id === source.id) : undefined
  // M77：编制按「成员键」组织（分身 = `agentId~soulId`）；行视图按角色聚合（一角色一行，行内选参与性格）
  const lineupItems = React.useMemo(() => {
    const byAgent = new Map<string, { agent: AgentDefinition; keys: string[] }>()
    const order: string[] = []
    for (const key of picked) {
      const agent = agents.find((a) => a.id === baseAgentId(key))
      if (!agent) continue
      let item = byAgent.get(agent.id)
      if (!item) {
        item = { agent, keys: [] }
        byAgent.set(agent.id, item)
        order.push(agent.id)
      }
      item.keys.push(key)
    }
    return order.map((id) => byAgent.get(id)!)
  }, [picked, agents])
  const q = query.trim().toLowerCase()
  const presetList = q
    ? presets.filter((p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q))
    : presets
  // M50：空场景走独立入口卡（单 Agent 语义），「按场景组队」列表过滤 blank 避免双入口
  const blankGroup = groups.find((g) => g.id === BLANK_SCENE_ID)
  const blankHit = Boolean(
    blankGroup && (!q || blankGroup.name.toLowerCase().includes(q) || blankGroup.description.toLowerCase().includes(q)),
  )
  const groupList = (
    q ? groups.filter((g) => g.name.toLowerCase().includes(q) || g.description.toLowerCase().includes(q)) : groups
  ).filter((g) => g.id !== BLANK_SCENE_ID)
  // 「已微调」提示：编制与来源推荐不一致（仅比较成员集合；顺序语义 = 链序，本期不排序）
  const recommended = preset?.members ?? group?.chain ?? []
  const tuned = Boolean(source) && (picked.length !== recommended.length || picked.some((id) => !recommended.includes(id)))
  const PresetIcon = preset ? resolveIcon(preset.icon) : undefined

  /** 选来源：以推荐编制整体替换并清 souls（空推荐 = 空编制，合法） */
  const pickSource = (next: CreateSource): void => {
    const known = new Set(agents.map((a) => a.id))
    if (next.kind === 'preset') {
      const p = presets.find((x) => x.id === next.id)
      setPicked((p?.members ?? []).filter((id) => known.has(id)))
    } else {
      const g = groups.find((x) => x.id === next.id)
      setPicked((g?.chain ?? []).filter((id) => known.has(id)))
    }
    setSource(next)
    setSouls({})
    if (narrowRef.current) setPane('lineup')
  }

  /** 自由组合：清来源与编制（窄屏切「角色池」以便直接挑人） */
  const clearAll = (): void => {
    setSource(undefined)
    setPicked([])
    setSouls({})
    if (narrowRef.current) setPane('pool')
  }

  /** 清空编制（保留来源；来源徽标随后呈「已微调」态） */
  const clearLineup = (): void => {
    setPicked([])
    setSouls({})
  }

  const unpick = (agentId: string): void => {
    setPicked((prev) => prev.filter((key) => baseAgentId(key) !== agentId))
    setSouls((prev) => {
      const next = { ...prev }
      delete next[agentId]
      return next
    })
  }

  /**
   * M77：勾选/取消一个「参与性格」（灵魂维度）——重算该角色成员键（确定性编码）：
   * 集合首个人格走经典键（= 默认灵魂则免覆盖），其余为分身键；全部取消 = 默认单人参与。
   */
  const toggleSoul = (agent: AgentDefinition, soulId: string): void => {
    const current = participationOf(agent, picked, souls)
    const next = current.includes(soulId) ? current.filter((s) => s !== soulId) : [...current, soulId]
    const { keys, soulOverrides } = encodeParticipation(agent, next)
    setPicked((prev) => {
      const firstIdx = prev.findIndex((key) => baseAgentId(key) === agent.id)
      const kept = prev.filter((key) => baseAgentId(key) !== agent.id)
      if (firstIdx < 0) return [...kept, ...keys]
      return [...kept.slice(0, firstIdx), ...keys, ...kept.slice(firstIdx)]
    })
    setSouls((prev) => {
      const nextSouls = { ...prev }
      delete nextSouls[agent.id]
      for (const [key, soul] of Object.entries(soulOverrides)) nextSouls[key] = soul
      return nextSouls
    })
  }

  const submitCreate = async (): Promise<void> => {
    // M48：0 人提交 = 空编制创建，首条消息由平台路由自动组队（引擎 PRS）
    setBusy(true)
    try {
      // M46：souls 仅保留最终编制（取消勾选的成员不携带灵魂覆盖）
      const pickedSouls = Object.fromEntries(Object.entries(souls).filter(([id]) => picked.includes(id)))
      // 空间归属：default 之外的当前空间才随行（缺省 = 我的空间；default 不入 body，保持既有契约）
      const spaceId = useSpaceStore.getState().currentId
      const session = await useSessionStore.getState().createSession(
        picked,
        titleInput.trim() || undefined,
        pickedSouls,
        spaceId === DEFAULT_SPACE_ID ? undefined : spaceId,
      )
      // M79-O：协作成员（真人）一步邀请（editor；失败不阻塞会话创建，汇总提示）
      let invited = 0
      const failed: string[] = []
      if (humanIds.length > 0) {
        const pickedFriends = friends.filter((f) => humanIds.includes(f.userId))
        const results = await Promise.allSettled(
          pickedFriends.map((f) => useShareStore.getState().invite(session.id, f.username, 'editor')),
        )
        results.forEach((r, i) => {
          if (r.status === 'fulfilled') invited += 1
          else failed.push(pickedFriends[i]!.displayName)
        })
        // 纯真人（无 agent 编制）→ 自动「仅点名唤起」：防未 @ 消息触发 PRS 组队（可在会话头部切回）
        if (picked.length === 0 && invited > 0) {
          try {
            const res = await apiPatch<{ session: Session }>(`/api/sessions/${session.id}`, { routeMode: 'mention' })
            useSessionStore.getState().applySession(res.session)
          } catch {
            // 失败不阻塞（会话头部可手动切换）
          }
        }
      }
      // M21：预设开场指令预填为 Composer 草稿（须在 onSelect 前写入，切会话时读取恢复；键与 Composer.draftKey 一致）
      if (preset?.prompt) localStorage.setItem(`ma:draft:${session.id}`, preset.prompt)
      onOpenChange(false)
      onCreated(session.id)
      const invitedNote = invited > 0 ? `（已邀请 ${invited} 位好友）` : failed.length > 0 ? `；邀请失败：${failed.join('、')}` : ''
      toast(
        preset?.prompt
          ? `会话「${session.title}」已创建，开场指令已预填${invitedNote}`
          : `会话「${session.title}」已创建${invitedNote}`,
      )
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // ---------- 左栏：来源 ----------
  const sourcePane = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-2 pt-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索模板 / 场景…"
            className="h-7 pl-7 pr-7 text-[12px]"
          />
          {query && (
            <button
              type="button"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
              title="清空来源搜索"
              onClick={() => setQuery('')}
            >
              <X className="size-3" />
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-2 py-2">
        {/* M50：空场景独立入口——单助手直聊（不引入任何角色）；与「按场景组队」互斥展示 */}
        {blankGroup &&
          blankHit &&
          (() => {
            const Icon = resolveIcon(blankGroup.icon)
            const on = source?.kind === 'scene' && source.id === blankGroup.id
            return (
              <button
                type="button"
                aria-label={`组队来源：${blankGroup.name}`}
                aria-pressed={on}
                onClick={() => pickSource({ kind: 'scene', id: blankGroup.id })}
                className={cn(
                  'w-full rounded-xl border p-2.5 text-left transition-all',
                  on ? 'border-primary/45 bg-primary/[0.05] shadow-sm' : 'hover:border-primary/25 hover:bg-accent/40',
                )}
                style={on ? undefined : { borderColor: `${blankGroup.theme[0]}55` }}
              >
                <div className="flex items-center gap-2">
                  <span
                    className="flex size-6 shrink-0 items-center justify-center rounded-lg"
                    style={{ backgroundColor: `${blankGroup.theme[0]}1f`, color: blankGroup.theme[0] }}
                  >
                    <Icon className="size-3.5" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{blankGroup.name}</span>
                  {on && <Check className="size-3.5 shrink-0 text-primary" />}
                  <span className="shrink-0 text-[10.5px] text-muted-foreground">单 Agent · 1 位成员</span>
                </div>
                <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">{blankGroup.description}</p>
              </button>
            )
          })()}
        {presetList.length > 0 && (
          <div>
            <div className="mb-1 flex items-center gap-1.5 px-0.5 text-[11px] font-medium text-muted-foreground">
              <Zap className="size-3.5 text-amber-500" />
              快速组队
            </div>
            <div className="space-y-1">
              {presetList.map((p) => {
                const Icon = resolveIcon(p.icon)
                const on = source?.kind === 'preset' && source.id === p.id
                const memberAgents = p.members
                  .map((id) => agents.find((a) => a.id === id))
                  .filter((a): a is NonNullable<typeof a> => Boolean(a))
                return (
                  <button
                    key={p.id}
                    type="button"
                    aria-label={`组队来源：${p.name}`}
                    aria-pressed={on}
                    onClick={() => pickSource({ kind: 'preset', id: p.id })}
                    className={cn(
                      'w-full rounded-lg border px-2 py-1.5 text-left transition-all',
                      on ? 'border-primary/45 bg-primary/[0.05] shadow-sm' : 'hover:border-primary/25 hover:bg-accent/40',
                    )}
                    style={on ? undefined : { borderColor: `${p.theme[0]}55` }}
                  >
                    <div className="flex items-center gap-1.5">
                      <span
                        className="flex size-5 shrink-0 items-center justify-center rounded"
                        style={{ backgroundColor: `${p.theme[0]}1f`, color: p.theme[0] }}
                      >
                        <Icon className="size-3" />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{p.name}</span>
                      {on && <Check className="size-3.5 shrink-0 text-primary" />}
                      <span className="shrink-0 text-[10px] text-muted-foreground">{p.members.length} 人</span>
                    </div>
                    <p className="mt-0.5 line-clamp-1 text-[10.5px] leading-4 text-muted-foreground">{p.description}</p>
                    {memberAgents.length > 0 && (
                      <span className="mt-1 flex -space-x-1.5">
                        {memberAgents.slice(0, 4).map((a) => (
                          <AgentAvatar
                            key={a.id}
                            agent={a}
                            size={13}
                            animated={false}
                            className="ring-1 ring-background"
                          />
                        ))}
                        {memberAgents.length > 4 && (
                          <span className="flex size-[13px] items-center justify-center rounded-full bg-muted text-[7.5px] text-muted-foreground ring-1 ring-background">
                            +{memberAgents.length - 4}
                          </span>
                        )}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {groupList.length > 0 && (
          <div>
            <div className="mb-1 flex items-center gap-1.5 px-0.5 text-[11px] font-medium text-muted-foreground">
              <Layers className="size-3.5" />
              按场景组队
            </div>
            <div className="space-y-1">
              {groupList.map((g) => {
                const Icon = resolveIcon(g.icon)
                const on = source?.kind === 'scene' && source.id === g.id
                const chainAgents = g.chain
                  .map((id) => agents.find((a) => a.id === id))
                  .filter((a): a is NonNullable<typeof a> => Boolean(a))
                return (
                  <div key={g.id} className="flex items-start gap-1">
                  <button
                    type="button"
                    aria-label={`组队来源：${g.name}`}
                    aria-pressed={on}
                    onClick={() => pickSource({ kind: 'scene', id: g.id })}
                    className={cn(
                      'w-full flex-1 rounded-lg border px-2 py-1.5 text-left transition-all',
                      on ? 'border-primary/45 bg-primary/[0.05] shadow-sm' : 'hover:border-primary/25 hover:bg-accent/40',
                    )}
                    style={on ? undefined : { borderColor: `${g.theme[0]}55` }}
                  >
                    <div className="flex items-center gap-1.5">
                      <span
                        className="flex size-5 shrink-0 items-center justify-center rounded"
                        style={{ backgroundColor: `${g.theme[0]}1f`, color: g.theme[0] }}
                      >
                        <Icon className="size-3" />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{g.name}</span>
                      {on && <Check className="size-3.5 shrink-0 text-primary" />}
                    </div>
                    <div className="mt-0.5 text-[10px] text-muted-foreground">
                      {g.parallel ? '∥ 并行协作 · ' : ''}
                      {chainAgents.length} 位推荐
                    </div>
                    <p className="mt-0.5 line-clamp-1 text-[10.5px] leading-4 text-muted-foreground">{g.description}</p>
                    {g.objective && (
                      <p className="mt-0.5 line-clamp-1 text-[10px] leading-4 text-muted-foreground/80">
                        目标：{g.objective}
                      </p>
                    )}
                    {chainAgents.length > 0 && (
                      <span className="mt-1 flex -space-x-1.5">
                        {chainAgents.slice(0, 6).map((a) => (
                          <AgentAvatar
                            key={a.id}
                            agent={a}
                            size={13}
                            animated={false}
                            className="ring-1 ring-background"
                          />
                        ))}
                        {chainAgents.length > 6 && (
                          <span className="flex size-[13px] items-center justify-center rounded-full bg-muted text-[7.5px] text-muted-foreground ring-1 ring-background">
                            +{chainAgents.length - 6}
                          </span>
                        )}
                      </span>
                    )}
                  </button>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {presetList.length === 0 && groupList.length === 0 && !(blankGroup && blankHit) && (
          <div className="py-10 text-center text-[12px] text-muted-foreground">没有匹配的来源</div>
        )}
      </div>

      <div className="shrink-0 border-t p-2">
        <button
          type="button"
          onClick={clearAll}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed py-1.5 text-[12px] text-muted-foreground transition-all hover:border-primary/40 hover:text-foreground"
        >
          <Sparkles className="size-3.5 shrink-0 text-primary/70" />
          自由组合
        </button>
      </div>
    </div>
  )

  // ---------- 中栏：角色池（AgentPicker 填满列高；卡点击 = 编制增删） ----------
  const poolPane = (
    <div className="flex h-full min-h-0 flex-col p-2">
      <AgentPicker value={picked} onChange={setPicked} fill className="flex-1" />
    </div>
  )

  // ---------- 右栏：编制 ----------
  const lineupPane = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b px-2.5 py-2">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <span className="text-[12px] font-semibold">当前编制</span>
          {preset && PresetIcon && (
            <span
              className="inline-flex min-w-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10.5px]"
              style={{
                borderColor: `${preset.theme[0]}66`,
                color: preset.theme[0],
                backgroundColor: `${preset.theme[0]}14`,
              }}
            >
              <PresetIcon className="size-3 shrink-0" />
              快速组队 · {preset.name}
            </span>
          )}
          {group && <GroupBadge group={group} />}
          {tuned && (
            <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600">
              已微调
            </span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-0.5">
            <span key={picked.length} className="badge-pop text-[11.5px] text-muted-foreground">
              已选 {picked.length} 位
            </span>
            {picked.length > 0 && (
              <button
                type="button"
                title="清空编制"
                onClick={clearLineup}
                className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            )}
          </span>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2.5 py-2">
        {lineupItems.map(({ agent, keys }) => {
          const participating = participationOf(agent, keys, souls)
          const multi = keys.length > 1
          return (
            <div
              key={agent.id}
              className="lineup-enter grid grid-cols-[26px_minmax(0,1fr)_auto] items-center gap-x-2 rounded-lg border border-border/70 bg-card px-2 py-1.5"
            >
              <AgentAvatar agent={agent} size={26} animated={false} />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5">
                  <span className="truncate text-[12px] font-medium">{agent.name}</span>
                  {multi && (
                    <span
                      className="shrink-0 rounded bg-violet-500/10 px-1 text-[9.5px] font-medium text-violet-700"
                      title="同一角色的多个性格分身同台协作"
                    >
                      ×{keys.length} 分身同台
                    </span>
                  )}
                </div>
                <div className="truncate text-[10.5px] text-muted-foreground">{agent.role}</div>
              </div>
              {/* 右侧组：参与性格（无 souls 则不占位）+ 移出编制 X 恒贴行右缘，跨行对齐不随内容漂移 */}
              <div className="flex items-center gap-2 justify-self-end">
                <SoulParticipantPicker
                  agent={agent}
                  value={participating}
                  onToggle={(soulId) => toggleSoul(agent, soulId)}
                />
                <button
                  type="button"
                  aria-label="移出编制"
                  title={`移出 ${agent.name}`}
                  onClick={() => unpick(agent.id)}
                  className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-destructive"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            </div>
          )
        })}
      </div>

      <div className="shrink-0 space-y-2 border-t px-2.5 py-2">
        {preset?.prompt && (
          <details className="rounded-lg border bg-muted/30 px-2.5 py-1.5 text-[11.5px]">
            <summary className="cursor-pointer select-none text-muted-foreground">
              开场指令将预填为草稿（点击预览）
            </summary>
            <p className="mt-1.5 max-h-24 overflow-y-auto whitespace-pre-wrap leading-5 text-foreground/85">
              {preset.prompt}
            </p>
          </details>
        )}
        {picked.length === 0 && (
          <p className="flex items-start gap-1.5 rounded-lg border border-primary/25 bg-primary/[0.04] px-2 py-1.5 text-[11px] text-muted-foreground">
            <Sparkles className="mt-0.5 size-3 shrink-0 text-primary/70" />
            未选成员：首条消息将由平台自动组队并派发任务
          </p>
        )}
        {/* M79-O：协作成员（真人）——创建时一步邀请（好友多选；多用户模式） */}
        {multiUser && (
          <div className="rounded-lg border bg-muted/20 px-2 py-1.5">
            <div className="mb-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Users className="size-3" />
              协作成员（真人）
              {humanIds.length > 0 && <span className="font-medium text-primary">已选 {humanIds.length} 位</span>}
            </div>
            {friends.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">还没有好友——在联系人页添加后可选</p>
            ) : (
              <div className="flex max-h-24 flex-wrap gap-1 overflow-y-auto">
                {friends.map((f) => {
                  const active = humanIds.includes(f.userId)
                  return (
                    <button
                      key={f.userId}
                      type="button"
                      title={active ? `取消 ${f.displayName}` : `邀请 ${f.displayName} 加入`}
                      onClick={() => toggleHuman(f.userId)}
                      className={cn(
                        'flex items-center gap-1 rounded-full border py-0.5 pl-0.5 pr-2 text-[11.5px] transition-all',
                        active
                          ? 'border-primary/40 bg-primary/[0.08] text-primary'
                          : 'border-transparent bg-muted/70 text-muted-foreground hover:border-primary/25 hover:bg-primary/5 hover:text-primary',
                      )}
                    >
                      <HumanAvatar avatar={f.avatar} name={f.displayName} size={16} />
                      <span className="max-w-24 truncate">{f.displayName}</span>
                    </button>
                  )
                })}
              </div>
            )}
            {picked.length === 0 && humanIds.length > 0 && (
              <p className="mt-1 text-[10.5px] leading-4 text-amber-700">
                编制为空：将自动设为「仅点名唤起」，未 @ 的消息 AI 不响应（可在会话头部切换）
              </p>
            )}
          </div>
        )}
        <Input
          value={titleInput}
          onChange={(e) => setTitleInput(e.target.value)}
          placeholder="会话标题（可选，默认自动生成）"
          className="h-8 px-2.5 text-[12px]"
        />
        <Button
          size="sm"
          className="w-full text-[12px] [&_svg]:size-3.5"
          disabled={busy}
          onClick={() => void submitCreate()}
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
          {picked.length + humanIds.length > 0
            ? `创建并进入（${picked.length + humanIds.length} 位成员）`
            : '空编制创建 · 交给平台组队'}
        </Button>
      </div>
    </div>
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl overflow-hidden p-0" aria-describedby={undefined}>
        <div className="flex h-[min(86vh,760px)] min-h-0 flex-col">
          <div className="flex h-12 shrink-0 items-center gap-2 border-b pl-4 pr-12">
            <Sparkles className="size-4 shrink-0 text-primary" />
            <DialogTitle className="text-[13.5px] font-semibold">新建会话</DialogTitle>
          </div>

          {narrow ? (
            <>
              <div className="flex shrink-0 gap-1 border-b px-2 py-1.5" role="tablist" aria-label="组队台视图">
                {(
                  [
                    ['source', '来源'],
                    ['pool', '角色池'],
                    ['lineup', '编制'],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={pane === key}
                    onClick={() => setPane(key)}
                    className={cn(
                      'flex-1 rounded-md px-2 py-1 text-[12px] transition-colors',
                      pane === key
                        ? 'bg-primary/10 font-medium text-primary'
                        : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="min-h-0 flex-1">{pane === 'source' ? sourcePane : pane === 'pool' ? poolPane : lineupPane}</div>
            </>
          ) : (
            <div className="flex min-h-0 flex-1">
              <div className="w-[236px] shrink-0 border-r">{sourcePane}</div>
              <div className="min-w-0 flex-1 border-r">{poolPane}</div>
              <div className="w-[280px] shrink-0">{lineupPane}</div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

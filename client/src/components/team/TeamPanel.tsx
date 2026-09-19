/**
 * 右栏团队面板（§20）：成员 / 接力 / 图谱 / 战绩 / 任务 / 记忆 / 指标 多视图。
 * - 成员：两行紧凑成员卡（首行 头像 / 姓名角色 / 状态或排队位次 / @·拍一拍·移出，次行 灵魂 / 能力 / 技能 / 工具数 / 会话战绩）；
 * - 接力：交接任务流（头像流 + 任务摘要 + 交接物 chips，点击定位消息）+ 进行中队列；
 * - 图谱（M17）：协作拓扑（React Flow 懒加载，独立 chunk）；
 * - 战绩（StatsView）：指标卡切换排序的战力榜（金银铜名次 / 贡献进度条 / 成就进度）+ 完成彩纸 + 运行轨迹入口（M9）；
 * - 任务/记忆：M8 落盘视图；指标：M9 运行健康度与成本；
 * - M12：成员卡单击迷你档案浮层；接力视图顶部进度链（已出手打勾 / 当前高亮 / 排队置灰）。
 * - M22：视图清单改为面板注册表（components/panels/registry）驱动，新增「连接」「浏览器」。
 * - M49（ADR 0100）：头部两级导航——一级 团队 / 运行 / 实况（聚合徽标：待批准计划 / 活动点），
 *   二级为组内子面板 chips（实况组单子项，face 条在面板内）；lastOf 组记忆回上次子面板。
 * - 头部维护：安静模式开关与连接状态灯上移至全局顶栏（AppLayout.HeaderBar），页签区不再挤占开关位。
 * - 面板显隐：显隐收敛于主区（AppLayout：左钮 = 左缘悬浮把手 / 右钮 = 头部最右端），
 *   本面板头部不内嵌收起钮（窄屏为抽屉形态，入口在底部成员条）。
 */
import * as React from 'react'
import { toast } from 'sonner'
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  AtSign,
  Check,
  ClipboardList,
  FileText,
  Hand,
  Loader2,
  MousePointerClick,
  Send,
  Sparkles,
  UserMinus,
  UserPlus,
  Wrench,
} from 'lucide-react'
import type { AgentDefinition, AgentRunState, ChatMessage, Plan, SessionSummary, SkillMeta } from '@multi-agent/shared'
import { useAgentStore } from '../../stores/agent-store'
import { useLivePanelStore } from '../../stores/live-panel-store'
import { usePlanStore } from '../../stores/plan-store'
import { useRunStore } from '../../stores/run-store'
import { messagesOf, useSessionStore } from '../../stores/session-store'
import {
  GROUP_LABELS,
  GROUP_ORDER,
  RIGHT_GROUPS,
  groupOf,
  useUiStore,
  type RightGroup,
  type RightView,
} from '../../stores/ui-store'
import { formatClock } from '../../lib/time'
import { useBusyOpFaces } from '../../lib/use-busy-ops'
import { cn } from '../../lib/utils'
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { AgentAvatar } from '../agents/AgentAvatar'
import { AgentPicker } from '../agents/AgentPicker'
import { GroupBadge } from '../agents/GroupBadge'
import { SoulPicker } from '../agents/SoulPicker'
import { StatsView } from './StatsView'
import { PANEL_DEFS, GROUPS, PanelBadge, type PanelSlots } from '../panels/registry'
import { patAgent } from '../../lib/agent-actions'

/** 计划为空时的稳定引用（避免选择器每帧返回新数组导致重渲染） */
const EMPTY_PLANS: Plan[] = []

const STATE_TEXT: Record<AgentRunState, string> = {
  idle: '待命',
  speaking: '发言中',
  thinking: '思考中',
  done: '产出完毕',
  error: '出错了',
}

const STATE_DOT: Record<AgentRunState, string> = {
  idle: 'bg-slate-300',
  speaking: 'bg-primary',
  thinking: 'bg-amber-400',
  done: 'bg-emerald-500',
  error: 'bg-destructive',
}

// 状态文字色调：进行中 / 完成 / 出错各自成色，一目十行可扫（idle 保持中性）
const STATE_TONE: Record<AgentRunState, string> = {
  idle: 'text-muted-foreground/80',
  speaking: 'text-primary',
  thinking: 'text-amber-600',
  done: 'text-emerald-600',
  error: 'text-destructive',
}

// ---------- 成员视图 ----------

/** 小节内全体成员共有的技能（≥ 2 人时才上提到小节头；卡内只留个性技能，避免每张卡重复长 chip） */
function sharedSkills(members: AgentDefinition[]): string[] {
  const first = members[0]
  if (!first || members.length < 2) return []
  return (first.skills ?? []).filter((sk) => members.every((m) => m.skills?.includes(sk)))
}

/** 技能 hover 说明：优先取技能库描述，未加载时回退技能名 */
function skillTitle(skillMeta: SkillMeta[], id: string): string {
  const meta = skillMeta.find((s) => s.name === id)
  return meta ? `${id} · ${meta.description}` : `${id}（技能）`
}

/** M12：迷你档案浮层 —— 人设一句话 / 能力 / 最近 3 次出手 / 常用交接对象（会话统计，空时回退预设路线） */
function MiniDossier({
  agent,
  messages,
  onClose,
}: {
  agent: AgentDefinition
  messages: ChatMessage[]
  onClose: () => void
}): React.JSX.Element {
  const agents = useAgentStore((s) => s.agents)
  const focusMessage = useUiStore((s) => s.focusMessage)

  const own = React.useMemo(
    () => messages.filter((m) => m.role === 'agent' && m.agentId === agent.id),
    [messages, agent.id],
  )
  const recent = own.slice(-3).reverse()
  const frequent = React.useMemo(() => {
    const count = new Map<string, number>()
    for (const m of own) {
      for (const t of m.mentions) {
        if (t === 'user' || t === agent.id) continue
        count.set(t, (count.get(t) ?? 0) + 1)
      }
    }
    return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
  }, [own, agent.id])
  const handoffList: { id: string; n: number; preset: boolean }[] =
    frequent.length > 0 ? frequent.map(([id, n]) => ({ id, n, preset: false })) : agent.handoff.map((id) => ({ id, n: 0, preset: true }))
  const nameOf = (id: string): string => agents.find((a) => a.id === id)?.name ?? id

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[80vh] max-w-sm overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5 pr-6 text-[14px]">
            <AgentAvatar agent={agent} size={40} animated={false} className="shrink-0 rounded-lg ring-1 ring-primary/15" />
            <span className="min-w-0">
              <span className="block truncate">{agent.name}</span>
              <span className="block truncate text-[11px] font-normal text-muted-foreground">
                {agent.role} · {agent.title}
              </span>
            </span>
          </DialogTitle>
          <DialogDescription className="pt-1 text-[12px] leading-5">{agent.description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3.5">
          <section>
            <h4 className="mb-1 text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">最近出手</h4>
            {recent.length > 0 ? (
              <ul className="space-y-1">
                {recent.map((m) => (
                  <li key={m.id}>
                    <button
                      type="button"
                      title="点击定位到对话中的这条消息"
                      onClick={() => {
                        focusMessage(m.id)
                        onClose()
                      }}
                      className="group w-full rounded-lg border bg-card px-2.5 py-1.5 text-left transition-colors hover:border-primary/30"
                    >
                      <p className="line-clamp-2 text-[11.5px] leading-5 text-muted-foreground group-hover:text-foreground">
                        {excerptOf(m.content) || '（非文本内容）'}
                      </p>
                      <span className="mt-0.5 block text-[10px] text-muted-foreground/80">
                        {formatClock(m.createdAt)} · 点击定位
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rounded-lg bg-muted/60 px-2.5 py-1.5 text-[11.5px] text-muted-foreground">
                还没出过手 —— 输入 <span className="font-medium text-foreground">@{agent.name}</span> 开启第一棒。
              </p>
            )}
          </section>

          <section>
            <h4 className="mb-1 text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">
              常用交接{frequent.length > 0 ? ' · 会话统计' : handoffList.length > 0 ? ' · 预设路线' : ''}
            </h4>
            {handoffList.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {handoffList.map(({ id, n, preset }) => (
                  <span
                    key={id}
                    title={preset ? '预设交接路线（本会话尚未出现）' : `交棒 ${n} 次`}
                    className={cn(
                      'inline-flex items-center gap-1 rounded-full border py-0.5 pl-0.5 pr-2 text-[10.5px]',
                      preset ? 'text-muted-foreground' : 'text-foreground',
                    )}
                  >
                    <AgentAvatar
                      agent={agents.find((a) => a.id === id)}
                      size={16}
                      animated={false}
                      className="rounded-full"
                    />
                    {nameOf(id)}
                    {!preset && <span className="text-primary">×{n}</span>}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-[11.5px] text-muted-foreground">未配置预设交接。</p>
            )}
          </section>

          <section>
            <h4 className="mb-1 text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">能力</h4>
            <div className="flex flex-wrap gap-1">
              {agent.capabilities.map((c) => (
                <span key={c} className="rounded bg-muted px-1.5 py-0.5 text-[10.5px] text-muted-foreground">
                  {c}
                </span>
              ))}
              {(agent.skills ?? []).map((sk) => (
                <span
                  key={sk}
                  className="inline-flex items-center gap-0.5 rounded bg-violet-500/10 px-1.5 py-0.5 text-[10.5px] text-violet-700"
                >
                  <Sparkles className="size-2.5" />
                  {sk}
                </span>
              ))}
              <span className="rounded bg-primary/[0.08] px-1.5 py-0.5 text-[10.5px] text-primary">
                工具 {agent.tools ? agent.tools.length : '全部'}
              </span>
            </div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function MembersView({
  participants,
  messages,
}: {
  participants: AgentDefinition[]
  messages: ChatMessage[]
}): React.JSX.Element {
  const groups = useAgentStore((s) => s.groups)
  const skillMeta = useAgentStore((s) => s.skills)
  const currentId = useSessionStore((s) => s.currentId)
  const session = useSessionStore((s) => s.sessions.find((x) => x.id === s.currentId))
  const setInviteOpen = useUiStore((s) => s.setInviteOpen)
  // M12：单击成员卡打开迷你档案
  const [dossier, setDossier] = React.useState<AgentDefinition>()
  // M16：新成员入场高亮（participantIds diff 一次性脉冲；安静模式由 CSS 关闭动画）
  const [freshIds, setFreshIds] = React.useState<Set<string>>(new Set())
  const participantKey = session?.participantIds.join(',') ?? ''
  const prevIdsRef = React.useRef<string[]>([])

  React.useEffect(() => {
    const ids = participantKey ? participantKey.split(',') : []
    const prev = prevIdsRef.current
    prevIdsRef.current = ids
    if (prev.length === 0) return
    const added = ids.filter((id) => !prev.includes(id))
    if (added.length === 0) return
    setFreshIds(new Set(added))
    const t = setTimeout(() => setFreshIds(new Set()), 2600)
    return () => clearTimeout(t)
  }, [participantKey])

  // M16：成员按场景分组小节（groups 顺序；未注册组殿后），组内保持编制顺序；组内共有技能上提到小节头
  const sections = React.useMemo(() => {
    const byGroup = new Map<string, AgentDefinition[]>()
    for (const a of participants) {
      const list = byGroup.get(a.group) ?? []
      list.push(a)
      byGroup.set(a.group, list)
    }
    const out: Array<{ group?: (typeof groups)[number]; members: AgentDefinition[]; common: string[] }> = []
    const seen = new Set<string>()
    for (const g of groups) {
      const members = byGroup.get(g.id)
      if (members?.length) {
        out.push({ group: g, members, common: sharedSkills(members) })
        seen.add(g.id)
      }
    }
    for (const [gid, members] of byGroup) if (!seen.has(gid)) out.push({ members, common: sharedSkills(members) })
    return out
  }, [participants, groups])

  /** 会话战绩：本会话发言条数 / 交付件数（卡片次行右对齐收口；无记录 = 未出手） */
  const stats = React.useMemo(() => {
    const m = new Map<string, { speaks: number; artifacts: number }>()
    for (const msg of messages) {
      if (msg.role !== 'agent' || !msg.agentId) continue
      const cur = m.get(msg.agentId) ?? { speaks: 0, artifacts: 0 }
      cur.speaks += 1
      cur.artifacts += msg.artifacts?.length ?? 0
      m.set(msg.agentId, cur)
    }
    return m
  }, [messages])

  if (participants.length === 0) {
    return <div className="px-3 py-8 text-center text-[12.5px] text-muted-foreground">选择一个会话查看出战成员</div>
  }

  return (
    <div className="space-y-2.5 p-2">
      {sections.map(({ group, members, common }, idx) => (
        <div key={group?.id ?? `other-${idx}`}>
          <div className="mb-1 flex flex-wrap items-center gap-1.5 px-0.5">
            {group ? (
              <GroupBadge group={group} />
            ) : (
              <span className="text-[10.5px] font-medium text-muted-foreground">其他</span>
            )}
            <span className="text-[10.5px] text-muted-foreground">{members.length} 位</span>
            {group?.parallel && (
              <span className="rounded bg-muted px-1 py-0.5 text-[9.5px] text-muted-foreground" title="该场景支持自动成波并行">
                ∥ 并行场景
              </span>
            )}
            {common.map((sk) => (
              <span
                key={sk}
                title={`本场景通用技能 · ${skillTitle(skillMeta, sk)}`}
                className="inline-flex items-center gap-0.5 rounded bg-violet-500/10 px-1.5 py-px text-[10px] text-violet-700"
              >
                <Sparkles className="size-2.5" />
                {sk}
              </span>
            ))}
          </div>
          <div className="space-y-1.5">
            {members.map((a) => (
              <MemberCard
                key={a.id}
                agent={a}
                fresh={freshIds.has(a.id)}
                canRemove={participants.length > 1}
                stat={stats.get(a.id)}
                extraSkills={(a.skills ?? []).filter((sk) => !common.includes(sk))}
                onOpenDossier={setDossier}
              />
            ))}
          </div>
        </div>
      ))}

      {/* M16：底部邀请入口（运行中也可邀请，新成员下一回合生效）；虚线弱化为「补充编制」通道，不抢成员卡视觉重心 */}
      <Button
        variant="outline"
        size="sm"
        className="h-7 w-full border-dashed text-[12px] font-normal text-muted-foreground hover:text-foreground"
        disabled={!currentId}
        onClick={() => setInviteOpen(true)}
      >
        <UserPlus className="size-3.5" />
        邀请成员
      </Button>

      {dossier && <MiniDossier agent={dossier} messages={messages} onClose={() => setDossier(undefined)} />}
    </div>
  )
}

/**
 * M16：成员卡（分组小节内）——两行紧凑布局，左侧竖线为场景主题色：
 * 首行：头像 + 姓名/角色 + 状态（仅非待命时展示：发言中 / 排队位次 / 产出完毕 / 出错了）+ 快捷操作（@ / 拍一拍 / 移出，悬停提亮）；
 * 次行：灵魂切换 + 能力（前 3 + 余量）+ 个性技能（场景通用技能已上提到小节头）+ 工具数 + 会话战绩（发言 / 交付），右对齐收口。
 */
function MemberCard({
  agent: a,
  fresh,
  canRemove,
  stat,
  extraSkills,
  onOpenDossier,
}: {
  agent: AgentDefinition
  fresh: boolean
  canRemove: boolean
  /** 会话战绩（发言条数 / 交付件数；未出手 = undefined） */
  stat?: { speaks: number; artifacts: number }
  /** 个性技能（已扣除小节头展示的通用技能） */
  extraSkills: string[]
  onOpenDossier: (a: AgentDefinition) => void
}): React.JSX.Element {
  const state = useAgentStore((s) => s.statuses[a.id] ?? 'idle')
  const groups = useAgentStore((s) => s.groups)
  const skillMeta = useAgentStore((s) => s.skills)
  const currentId = useSessionStore((s) => s.currentId)
  const soulOverride = useSessionStore((s) => s.sessions.find((x) => x.id === s.currentId)?.memberSouls?.[a.id])
  const setMemberSoul = useSessionStore((s) => s.setMemberSoul)
  const removeMember = useSessionStore((s) => s.removeMember)
  const insertToComposer = useUiStore((s) => s.insertToComposer)
  // M14：指挥台队列位次（发言中由状态表达；等待者提示「排队第 N 位」，与 Composer 成员条同口径）
  const queueIdx = useRunStore((s) => s.queue.indexOf(a.id))
  // M24：计划徽章（本会话与本人相关的计划：待批准 / 执行中步骤进度）
  const plans = usePlanStore((s) => (s.sessionId === currentId ? s.plans : EMPTY_PLANS))
  const [removing, setRemoving] = React.useState(false)

  const active = state === 'speaking' || state === 'thinking'
  const group = groups.find((g) => g.id === a.group)
  const queued = !active && queueIdx > 0
  const statusText = queued ? `排队第 ${queueIdx + 1} 位` : STATE_TEXT[state]
  // 能力 chip 收敛展示：前 3 项 + 余量，hover 提示完整清单（窄栏下少占一行）
  const shownCaps = a.capabilities.slice(0, 3)
  const restCaps = a.capabilities.slice(3)
  const planBadge = React.useMemo(() => {
    let pending = 0
    let done = 0
    let total = 0
    for (const plan of plans) {
      if (plan.status === 'submitted' && (plan.agentId === a.id || plan.steps.some((s) => (s.ownerAgentId ?? plan.agentId) === a.id))) {
        pending++
      }
      if (plan.status === 'executing' || plan.status === 'approved') {
        for (const s of plan.steps) {
          if ((s.ownerAgentId ?? plan.agentId) !== a.id) continue
          total++
          if (s.status === 'done' || s.status === 'skipped') done++
        }
      }
    }
    if (pending > 0) {
      return { label: `待批准 ${pending}`, className: 'bg-amber-500/10 text-amber-700', title: `与本成员相关：${pending} 份计划待批准` }
    }
    if (total > 0) {
      return { label: `计划 ${done}/${total}`, className: 'bg-violet-500/10 text-violet-700', title: `派发步骤进度：${done}/${total}（完成后用 update_plan_step 汇报）` }
    }
    return undefined
  }, [plans, a.id])

  /** M16：切换灵魂（会话覆盖；null = 恢复默认）——成功 toast，事件条由服务端 system 消息广播回放 */
  const changeSoul = async (soul: string | null): Promise<void> => {
    if (!currentId) return
    try {
      await setMemberSoul(currentId, a.id, soul)
      const meta = soul ? a.souls?.find((s) => s.id === soul) : undefined
      toast(meta ? `${a.name} 换上了『${meta.name}』灵魂` : `${a.name} 恢复了默认灵魂`)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  /** M16：移出成员（正在发言时服务端拒绝，错误直通 toast） */
  const confirmRemove = async (): Promise<void> => {
    if (!currentId) return
    try {
      await removeMember(currentId, a.id)
      setRemoving(false)
      toast(`${a.name} 离开了协作`)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      title={`查看 ${a.name} 的档案`}
      onClick={() => onOpenDossier(a)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpenDossier(a)
        }
      }}
      style={group ? { borderLeftColor: group.theme[0], borderLeftWidth: 2 } : undefined}
      className={cn(
        'group cursor-pointer rounded-lg border bg-card px-2 py-1.5 transition-all',
        active ? 'card-glow border-primary/40' : 'hover:border-primary/25 hover:shadow-soft',
        fresh && 'member-enter',
      )}
    >
      <div className="flex items-center gap-2">
        <AgentAvatar agent={a} size={32} state={state} className="rounded-md" />
        <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="truncate text-[12.5px] font-semibold">{a.name}</span>
          <span className="truncate text-[10.5px] text-muted-foreground">{a.role}</span>
        </div>
        {state !== 'idle' && (
          <span
            title={queued ? `指挥台队列：${a.name} 排队第 ${queueIdx + 1} 位` : `${a.name} · ${STATE_TEXT[state]}`}
            className={cn(
              'flex shrink-0 items-center gap-1 text-[10px] tabular-nums',
              queued ? 'text-amber-600' : STATE_TONE[state],
            )}
          >
            <span
              className={cn(
                'size-1.5 rounded-full',
                queued ? 'bg-amber-400' : STATE_DOT[state],
                active && 'animate-pulse',
              )}
            />
            {statusText}
          </span>
        )}
        <div className="flex shrink-0 items-center gap-0.5 opacity-70 transition-opacity group-hover:opacity-100">
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-6 text-muted-foreground hover:text-primary"
            title={`@ 召唤 ${a.name}`}
            disabled={!currentId}
            onClick={(e) => {
              e.stopPropagation()
              insertToComposer(`@${a.name} `)
            }}
          >
            <AtSign className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-6 text-muted-foreground hover:text-primary"
            title={`拍一拍 ${a.name}`}
            disabled={!currentId}
            onClick={(e) => {
              e.stopPropagation()
              void patAgent(a)
            }}
          >
            <Hand className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-6 text-muted-foreground hover:text-destructive"
            title={canRemove ? `移出 ${a.name}` : '会话至少保留 1 名成员'}
            disabled={!currentId || !canRemove}
            onClick={(e) => {
              e.stopPropagation()
              setRemoving((v) => !v)
            }}
          >
            <UserMinus className="size-3.5" />
          </Button>
        </div>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {(a.souls?.length ?? 0) > 0 && (
          <>
            <SoulPicker agent={a} override={soulOverride} onPick={(soul) => void changeSoul(soul)} />
            {soulOverride !== undefined && (
              <span className="text-[9.5px] text-muted-foreground" title="本会话已覆盖角色默认灵魂">
                会话覆盖
              </span>
            )}
          </>
        )}
        {shownCaps.map((c) => (
          <span key={c} className="rounded bg-muted px-1.5 py-px text-[10px] text-muted-foreground">
            {c}
          </span>
        ))}
        {restCaps.length > 0 && (
          <span
            title={`全部能力：${a.capabilities.join('、')}`}
            className="rounded bg-muted px-1.5 py-px text-[10px] text-muted-foreground/80"
          >
            +{restCaps.length}
          </span>
        )}
        {extraSkills.map((sk) => (
          <span
            key={sk}
            title={skillTitle(skillMeta, sk)}
            className="inline-flex items-center gap-0.5 rounded bg-violet-500/10 px-1.5 py-px text-[10px] text-violet-700"
          >
            <Sparkles className="size-2.5" />
            {sk}
          </span>
        ))}
        <span
          title={a.tools ? `工具白名单 ${a.tools.length} 项：${a.tools.join('、')}` : '工具：全部可用'}
          className="inline-flex items-center gap-0.5 rounded bg-primary/[0.07] px-1.5 py-px text-[10px] text-primary/90"
        >
          <Wrench className="size-2.5" />
          {a.tools ? a.tools.length : '全部'}
        </span>
        {planBadge && (
          <span
            title={planBadge.title}
            className={cn('inline-flex items-center gap-0.5 rounded px-1.5 py-px text-[10px]', planBadge.className)}
          >
            <ClipboardList className="size-2.5" />
            {planBadge.label}
          </span>
        )}
        <span
          title={stat ? `本会话：发言 ${stat.speaks} 条 · 交付 ${stat.artifacts} 件` : '本会话尚未出手'}
          className="ml-auto shrink-0 pl-1 text-[9.5px] tabular-nums text-muted-foreground/80"
        >
          {stat && stat.speaks > 0 ? `发言 ${stat.speaks}${stat.artifacts > 0 ? ` · 交付 ${stat.artifacts}` : ''}` : '未出手'}
        </span>
      </div>

      {removing && (
        <div className="mt-1.5 flex items-center gap-1.5 rounded-md bg-destructive/5 px-2 py-1.5 text-[11px]">
          <span className="min-w-0 flex-1 truncate text-destructive">移出「{a.name}」？历史发言会保留</span>
          <Button
            size="xs"
            variant="destructive"
            onClick={(e) => {
              e.stopPropagation()
              void confirmRemove()
            }}
          >
            确认移出
          </Button>
          <Button
            size="xs"
            variant="outline"
            onClick={(e) => {
              e.stopPropagation()
              setRemoving(false)
            }}
          >
            取消
          </Button>
        </div>
      )}
    </div>
  )
}

// ---------- 邀请成员（M16） ----------

/** 邀请对话框：AgentPicker（已在场禁用）+ 灵魂预选；运行中允许，新成员下一回合生效 */
function InviteDialog({ session }: { session: SessionSummary }): React.JSX.Element {
  const open = useUiStore((s) => s.inviteOpen)
  const setOpen = useUiStore((s) => s.setInviteOpen)
  const addMembers = useSessionStore((s) => s.addMembers)
  const [picked, setPicked] = React.useState<string[]>([])
  const [souls, setSouls] = React.useState<Record<string, string>>({})
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (open) {
      setPicked([])
      setSouls({})
    }
  }, [open])

  const handleSoul = (agentId: string, soul: string | null): void => {
    setSouls((prev) => {
      const next = { ...prev }
      if (soul) next[agentId] = soul
      else delete next[agentId]
      return next
    })
  }

  const submit = async (): Promise<void> => {
    if (picked.length === 0) {
      toast.error('请选择要邀请的成员')
      return
    }
    setBusy(true)
    try {
      await addMembers(session.id, picked, souls)
      const names = picked
        .map((id) => useAgentStore.getState().agents.find((x) => x.id === id)?.name ?? id)
        .join('、')
      toast(`${names} 加入协作，@TA 开麦`)
      setOpen(false)
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>邀请成员</DialogTitle>
        </DialogHeader>
        <div className="mt-3">
          <AgentPicker
            value={picked}
            onChange={setPicked}
            souls={souls}
            onSoulChange={handleSoul}
            disabledIds={session.participantIds}
          />
        </div>
        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="outline" onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button disabled={busy || picked.length === 0} onClick={() => void submit()}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <UserPlus className="size-3.5" />}
            邀请{picked.length > 0 ? ` ${picked.length} 位` : ''}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ---------- 接力视图 ----------

interface RelayStep {
  message: ChatMessage
  agent?: AgentDefinition
}

/** 消息正文 → 单行任务摘要（清洗 Markdown 标记与 @token） */
function excerptOf(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/@[\p{L}\p{N}_]+/gu, ' ')
    .replace(/[#>*`_[\]()!|~-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 68)
}

/** 交接任务卡：头像流（from → to）+ 任务摘要 + 交接物 chips，点击定位对话中的消息 */
function RelayCard({ step, showLink }: { step: RelayStep; showLink: boolean }): React.JSX.Element {
  const agents = useAgentStore((s) => s.agents)
  const focusMessage = useUiStore((s) => s.focusMessage)
  const m = step.message
  const handedToUser = m.mentions.includes('user')
  const targets = m.mentions.filter((x) => x !== 'user')
  const nameOf = (id: string): string => agents.find((a) => a.id === id)?.name ?? id
  const excerpt = excerptOf(m.content)
  const artifactNames = (m.artifacts ?? []).map((p) => p.split('/').pop() ?? p)
  const toolCount = m.toolCalls?.length ?? 0
  const toLabel = handedToUser ? '你' : targets.map(nameOf).join('、')

  return (
    <li className="relative">
      <button
        type="button"
        onClick={() => focusMessage(m.id)}
        title="点击定位到对话中的这条消息"
        className="group w-full rounded-xl border bg-card p-2.5 text-left transition-all hover:border-primary/30 hover:shadow-lift"
      >
        <div className="flex items-center gap-1.5">
          <AgentAvatar agent={step.agent} size={26} animated={false} className="rounded-full ring-2 ring-primary/10" />
          <ArrowRight className="size-3 shrink-0 text-primary/40" />
          {!handedToUser && (
            <div className="flex -space-x-1.5">
              {targets.map((id) => (
                <AgentAvatar
                  key={id}
                  agent={agents.find((a) => a.id === id)}
                  size={26}
                  animated={false}
                  className="rounded-full ring-2 ring-card"
                />
              ))}
            </div>
          )}
          <span className="ml-1 min-w-0 flex-1 truncate text-[12px] font-medium">
            {step.agent?.name ?? m.agentId}
            <span className="mx-1 text-muted-foreground/70">→</span>
            <span className={handedToUser ? 'text-primary' : ''}>{toLabel}</span>
          </span>
          <span className="shrink-0 text-[10px] text-muted-foreground">{formatClock(m.createdAt)}</span>
          <MousePointerClick className="size-3 shrink-0 text-transparent transition-colors group-hover:text-primary/60" />
        </div>

        {excerpt && <p className="mt-1.5 line-clamp-2 text-[11.5px] leading-5 text-muted-foreground">{excerpt}</p>}

        {(artifactNames.length > 0 || toolCount > 0) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {artifactNames.slice(0, 3).map((n) => (
              <span
                key={n}
                title={n}
                className="inline-flex max-w-36 items-center gap-0.5 rounded bg-primary/[0.08] px-1.5 py-0.5 text-[10px] text-primary"
              >
                <FileText className="size-2.5 shrink-0" />
                <span className="truncate">{n}</span>
              </span>
            ))}
            {artifactNames.length > 3 && (
              <span className="text-[10px] text-muted-foreground">+{artifactNames.length - 3}</span>
            )}
            {toolCount > 0 && (
              <span className="inline-flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                <Wrench className="size-2.5" />
                {toolCount}
              </span>
            )}
          </div>
        )}
      </button>
      {showLink && <div className="ml-[23px] my-1 h-3 w-px bg-gradient-to-b from-primary/40 to-primary/5" aria-hidden />}
    </li>
  )
}

/** M12：接力链进度链 —— 已出手（打勾）+ 队列待出手（置灰）+ 链尾「你」；当前发言者脉冲高亮 */
function RelayChain({ steps }: { steps: RelayStep[] }): React.JSX.Element | null {
  const queue = useRunStore((s) => s.queue)
  const active = useRunStore((s) => s.active)
  const agents = useAgentStore((s) => s.agents)

  const nodes = React.useMemo(() => {
    const seen = new Set<string>()
    const list: { id: string; done: boolean }[] = []
    for (const st of steps) {
      const id = st.agent?.id
      if (!id || seen.has(id)) continue
      seen.add(id)
      list.push({ id, done: true })
    }
    for (const id of queue) {
      if (id === 'user' || seen.has(id)) continue
      seen.add(id)
      list.push({ id, done: false })
    }
    return list
  }, [steps, queue])

  if (nodes.length === 0) return null
  const current = active ? queue[0] : undefined
  const last = steps[steps.length - 1]
  const handedToUser = !active && (last?.message.mentions.includes('user') ?? false)

  return (
    <div
      className="mb-2 flex items-center overflow-x-auto rounded-xl border bg-card/70 px-2 py-1.5"
      aria-label="接力进度链"
    >
      {nodes.map((n, i) => {
        const a = agents.find((x) => x.id === n.id)
        const isCurrent = n.id === current
        return (
          <React.Fragment key={n.id}>
            {i > 0 && <ArrowRight className="mx-0.5 size-3 shrink-0 text-muted-foreground/40" />}
            <span className="relative shrink-0" title={`${a?.name ?? n.id}${n.done ? ' · 已出手' : ' · 排队中'}`}>
              <AgentAvatar
                agent={a}
                size={22}
                animated={false}
                className={cn(
                  'rounded-full',
                  isCurrent
                    ? 'ring-2 ring-primary'
                    : n.done
                      ? 'ring-2 ring-emerald-400/40'
                      : 'opacity-45 grayscale',
                )}
              />
              {n.done && (
                <span className="absolute -bottom-0.5 -right-0.5 flex size-3 items-center justify-center rounded-full bg-emerald-500 text-white ring-1 ring-card">
                  <Check className="size-2" />
                </span>
              )}
              {isCurrent && (
                <span className="pa-dot absolute -right-0.5 -top-0.5 size-2 rounded-full bg-primary ring-1 ring-card" />
              )}
            </span>
          </React.Fragment>
        )
      })}
      <ArrowRight className="mx-0.5 size-3 shrink-0 text-muted-foreground/40" />
      <span
        title={handedToUser ? '已交还给你，等待你的输入' : '最终交付给你'}
        className={cn(
          'flex size-[22px] shrink-0 items-center justify-center rounded-full border bg-card text-[10px] font-medium',
          handedToUser ? 'border-primary/60 text-primary ring-2 ring-primary/30' : 'text-muted-foreground',
        )}
      >
        你
      </span>
    </div>
  )
}

/** M14：指挥台排队区 —— 实时显示未出手棒次，↑↓ 调序立即生效（乐观更新 + 服务端 queue:updated 广播对齐） */
export function RelayQueue(): React.JSX.Element | null {
  const active = useRunStore((s) => s.active)
  const queue = useRunStore((s) => s.queue)
  const reorder = useRunStore((s) => s.reorderQueue)
  const agents = useAgentStore((s) => s.agents)
  // M24：计划派发提示（队列成员名下最近的未完成步骤 → chip title）
  const plans = usePlanStore((s) => s.plans)

  const items = React.useMemo(() => queue.filter((id) => id !== 'user'), [queue])

  /** 该成员在活跃计划中最近的未完成步骤（步骤序优先） */
  const stepHintOf = React.useCallback(
    (agentId: string): string | undefined => {
      for (const plan of plans) {
        if (plan.status !== 'executing' && plan.status !== 'approved') continue
        const step = plan.steps.find(
          (s) => (s.ownerAgentId ?? plan.agentId) === agentId && s.status !== 'done' && s.status !== 'skipped',
        )
        if (step) return step.content
      }
      return undefined
    },
    [plans],
  )

  if (!active) return null

  const move = (index: number, delta: -1 | 1): void => {
    const target = index + delta
    if (target < 0 || target >= items.length) return
    const next = [...items]
    ;[next[index], next[target]] = [next[target]!, next[index]!]
    void reorder(next)
  }

  const firstName = agents.find((a) => a.id === items[0])?.name ?? items[0]

  return (
    <li className="rounded-xl border border-dashed border-primary/40 bg-primary/5 p-2.5 shadow-sm shadow-primary/10">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-primary">
        <span className="flex items-end gap-[3px]">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="pa-dot size-1 rounded-full bg-primary"
              style={{ animationDelay: `${i * 0.18}s` }}
            />
          ))}
        </span>
        指挥台
        {items.length > 0 ? (
          <span className="text-[11px] text-muted-foreground">
            下一棒 · <span className="font-medium text-primary">{firstName}</span>
          </span>
        ) : (
          <span className="text-[11px] text-muted-foreground">队列即将收束…</span>
        )}
      </div>
      {items.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1" aria-label="指挥台排队">
          {items.map((id, i) => {
            const a = agents.find((x) => x.id === id)
            const name = a?.name ?? id
            const planStep = stepHintOf(id)
            return (
              <span
                key={id}
                className={cn(
                  'flex items-center gap-0.5 rounded-full border bg-card py-0.5 pl-0.5 pr-1 text-[11.5px]',
                  i === 0 ? 'border-primary/50 shadow-sm shadow-primary/10' : 'border-border',
                )}
                title={
                  i === 0
                    ? `下一棒：${name}${planStep ? ` · 计划步骤：${planStep}` : ''}`
                    : `${name}（第 ${i + 1} 棒）${planStep ? ` · 计划步骤：${planStep}` : ''}`
                }
              >
                <span
                  className={cn(
                    'flex size-4 shrink-0 items-center justify-center rounded-full text-[9.5px] font-semibold',
                    i === 0 ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
                  )}
                >
                  {i + 1}
                </span>
                <AgentAvatar agent={a} size={16} animated={false} className="rounded-full" />
                <span className="max-w-[72px] truncate font-medium">{name}</span>
                {planStep && <ClipboardList className="size-3 shrink-0 text-violet-500/80" aria-label="有计划派发步骤" />}
                <button
                  type="button"
                  title={`${name} 提前一位`}
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                  className="rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
                >
                  <ArrowUp className="size-3" />
                </button>
                <button
                  type="button"
                  title={`${name} 延后一位`}
                  disabled={i === items.length - 1}
                  onClick={() => move(i, 1)}
                  className="rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
                >
                  <ArrowDown className="size-3" />
                </button>
              </span>
            )
          })}
        </div>
      )}
    </li>
  )
}

function RelayView({
  steps,
  participants,
}: {
  steps: RelayStep[]
  participants: AgentDefinition[]
}): React.JSX.Element {
  const active = useRunStore((s) => s.active)
  return (
    <div className="p-2">
      <RelayChain steps={steps} />
      {steps.length === 0 && !active && (
        <div className="px-2 py-8 text-center text-[12.5px] text-muted-foreground">
          <Send className="float-soft mx-auto mb-2 size-6 text-primary/40" />
          在对话里 @ 一位成员，见证一场接力
        </div>
      )}

      <ol className="relative space-y-0">
        {steps.map((step, i) => (
          <RelayCard key={step.message.id} step={step} showLink={i < steps.length - 1 || active} />
        ))}

        {active && <RelayQueue />}
      </ol>

      {participants.length > 0 && steps.length > 0 && !active && (
        <div className="mt-3 rounded-md bg-muted/60 px-2.5 py-2 text-[11px] text-muted-foreground">
          想继续接力？在输入框 @ 任意成员，或点右上的「拍一拍」催更。
        </div>
      )}
    </div>
  )
}

// 战绩视图（战力榜）已拆分至 ./StatsView.tsx：指标卡切换排序 / 排行 / 成就进度 / 彩纸 / 轨迹入口

// ---------- 面板外壳 ----------

/** M49：一级「运行」聚合徽标 = 待批准计划数（与任务子面板徽标同源） */
function OpsGroupBadge(): React.JSX.Element | null {
  const currentId = useSessionStore((s) => s.currentId)
  const pendingPlans = usePlanStore((s) =>
    s.sessionId && s.sessionId === currentId ? s.plans.filter((plan) => plan.status === 'submitted').length : 0,
  )
  if (pendingPlans <= 0) return null
  return (
    <span
      className="ml-1 rounded-full bg-amber-500/15 px-1 text-[10px] font-semibold tabular-nums text-amber-700"
      title={`${pendingPlans} 份计划待批准`}
    >
      {pendingPlans}
    </span>
  )
}

/** M49：一级「实况」活动点（未读交付件 / 运行中操作面；正在看实况时不显示，face 条自带指示） */
function LiveGroupDot(): React.JSX.Element | null {
  const active = useUiStore((s) => s.rightView === 'live')
  const newArtifactCount = useUiStore((s) => s.newArtifactCount)
  const running = useBusyOpFaces().size > 0
  if (active || (newArtifactCount <= 0 && !running)) return null
  return <span className="ml-1 size-1.5 shrink-0 rounded-full bg-sky-500" title="实况有新活动" />
}

/** 宽屏右栏（显隐收敛于主区：AppLayout 头部最右端钮；窄屏为抽屉形态）。 */
export function TeamPanel(): React.JSX.Element {
  const rightView = useUiStore((s) => s.rightView)
  const setRightView = useUiStore((s) => s.setRightView)
  const lastOf = useUiStore((s) => s.lastOf)

  const agents = useAgentStore((s) => s.agents)
  const sessions = useSessionStore((s) => s.sessions)
  const currentId = useSessionStore((s) => s.currentId)
  // M8：消息为 byId+order 结构，右栏按需派生数组（接力/战绩视图消费）
  const byId = useSessionStore((s) => s.byId)
  const order = useSessionStore((s) => s.order)
  const messages = React.useMemo(() => messagesOf({ byId, order }), [byId, order])

  const session = sessions.find((s) => s.id === currentId)
  const participants = React.useMemo(() => {
    const ids = new Set(session?.participantIds ?? [])
    return agents.filter((a) => ids.has(a.id))
  }, [agents, session])

  const steps = React.useMemo<RelayStep[]>(
    () =>
      messages
        .filter((m) => m.role === 'agent' && m.status !== 'streaming')
        .map((m) => ({ message: m, agent: agents.find((a) => a.id === m.agentId) })),
    [messages, agents],
  )

  // M22：既有视图以插槽形式交给面板注册表（其余面板自取数据）
  const slots = React.useMemo<PanelSlots>(() => ({
    members: <MembersView participants={participants} messages={messages} />,
    relay: <RelayView steps={steps} participants={participants} />,
    stats: <StatsView participants={participants} messages={messages} />,
  }), [participants, messages, steps])
  const group = groupOf(rightView)
  const groupDefs = GROUPS[group]
  const activePanel = PANEL_DEFS.find((panel) => panel.id === rightView)

  /** 一级页签切换：回到该组上次子面板（首次 = 首子项） */
  const switchGroup = (g: RightGroup): void => {
    setRightView(lastOf[g] ?? RIGHT_GROUPS[g][0]!)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 一级页签：团队 / 运行 / 实况（免横向滚动；聚合徽标：待批准计划 / 活动点） */}
      <div className="flex h-11 shrink-0 items-center border-b px-3">
        <Tabs value={group} onValueChange={(v) => switchGroup(v as RightGroup)}>
          <TabsList>
            {GROUP_ORDER.map((g) => (
              <TabsTrigger
                key={g}
                value={g}
                className="px-2.5 text-[11.5px]"
                onClick={() => {
                  // 已停留「实况」时 Radix 不触发 onValueChange：点它仍应恢复跟随
                  if (g === 'live' && rightView === 'live') useLivePanelStore.getState().resumeFollow()
                }}
              >
                {GROUP_LABELS[g]}
                {g === 'ops' ? <OpsGroupBadge /> : g === 'live' ? <LiveGroupDot /> : null}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      {/* 二级条：组内多子项才渲染（实况组为单子项，其 face 条即二级）；与实况 face 条同构 */}
      {groupDefs.length > 1 && (
        <div className="flex h-9 shrink-0 items-center border-b px-3">
          <div className="min-w-0 flex-1 overflow-x-auto">
            <Tabs value={rightView} onValueChange={(v) => setRightView(v as RightView)}>
              <TabsList className="h-7 gap-0 bg-muted/60 px-0.5">
                {groupDefs.map((panel) => (
                  <TabsTrigger key={panel.id} value={panel.id} className="px-1.5 py-0 text-[11px]">
                    {panel.label}
                    <PanelBadge def={panel} />
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>
        </div>
      )}

      <div className={cn('min-h-0 flex-1', activePanel?.fill ? 'overflow-hidden' : 'overflow-y-auto')}>
        {activePanel?.render(slots)}
      </div>

      {/* M16：邀请成员对话框（成员视图 / CommandPalette 共用入口） */}
      {session && <InviteDialog session={session} />}
    </div>
  )
}

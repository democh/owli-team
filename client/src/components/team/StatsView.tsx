/**
 * 战绩视图「战力榜」：指标总览 → 成员排行 → 成就体系 → 运行轨迹。
 * - 指标总览：发言 / 交付件 / 被 cue / 工具调用 / 交接 / 完成回合 六卡；
 *   除「完成回合」外点击即切换排行维度（再点一次恢复综合）；
 * - 战力榜：默认按综合贡献分降序（发言×10 + 交付×30 + 交接×15 + 工具×5），
 *   前三名金银铜徽记、榜首金签 + 皇冠；行内进度条按当前维度归一化；同值并列名次；
 * - 成就体系：六枚徽记（破冰者 / 交付官 / 人气王 / 主力担当 / 接力王 / 实干家）——
 *   已达成为琥珀 chip（badge-pop，tooltip 说明条件），未达成展示最接近解锁的一枚进度；
 * - 趣味层：completed 彩纸 + 「查看本次运行轨迹」入口（M9）；安静模式 / reduced-motion 下全部收敛。
 */
import * as React from 'react'
import {
  Activity,
  AtSign,
  Award,
  Crown,
  Flame,
  Flag,
  HeartHandshake,
  MessageSquare,
  Package,
  PackageOpen,
  Snowflake,
  Target,
  Trophy,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import type { AgentDefinition, ChatMessage } from '@multi-agent/shared'
import { useRunStore } from '../../stores/run-store'
import { useUiStore } from '../../stores/ui-store'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { AgentAvatar } from '../agents/AgentAvatar'
import { ConfettiBurst } from '../ui/confetti'

// ---------- 数据派生 ----------

export interface AgentStat {
  agent: AgentDefinition
  /** 本人发言条数 */
  messages: number
  /** 交付件总数（本人消息产出） */
  artifacts: number
  /** 被其他消息 cue 的条数（含用户 @） */
  mentioned: number
  /** 发起交接次数（发言 @ 到非 user 目标） */
  handoffs: number
  /** 工具调用次数 */
  tools: number
  /** 本会话首位发言（破冰者判定） */
  first: boolean
  /** 综合贡献分：发言×10 + 交付×30 + 交接×15 + 工具×5 */
  score: number
}

export interface StatsTotals {
  messages: number
  artifacts: number
  mentioned: number
  tools: number
  handoffs: number
  turns: number
}

/** 贡献分公式文案（榜单头部 tooltip 用，与 computeStats 保持同步） */
export const SCORE_FORMULA = '发言×10 + 交付×30 + 交接×15 + 工具×5'

/** 单遍扫描聚合本会话战绩（O(messages)，避免按成员重复过滤） */
export function computeStats(
  participants: AgentDefinition[],
  messages: ChatMessage[],
): { stats: AgentStat[]; totals: StatsTotals } {
  const acc = new Map<string, Omit<AgentStat, 'agent' | 'first' | 'score'>>()
  for (const p of participants) acc.set(p.id, { messages: 0, artifacts: 0, mentioned: 0, handoffs: 0, tools: 0 })

  const totals: StatsTotals = { messages: 0, artifacts: 0, mentioned: 0, tools: 0, handoffs: 0, turns: 0 }
  let firstSpeaker: string | undefined

  for (const m of messages) {
    totals.artifacts += m.artifacts?.length ?? 0
    totals.tools += m.toolCalls?.length ?? 0
    // M77：发言归属按成员键（同角多魂下分身各自计数；存量消息缺省 = agentId）
    const owner = m.role === 'agent' ? (m.memberKey ?? m.agentId) : undefined
    if (m.role === 'agent') {
      totals.messages += 1
      if (m.status !== 'streaming') totals.turns += 1
      firstSpeaker ??= owner
      const own = owner ? acc.get(owner) : undefined
      if (own) {
        own.messages += 1
        own.artifacts += m.artifacts?.length ?? 0
        own.tools += m.toolCalls?.length ?? 0
        if (m.mentions.some((x) => x !== 'user')) own.handoffs += 1
      }
    }
    for (const target of m.mentions) {
      if (target === 'user' || target === owner) continue
      const t = acc.get(target)
      if (t) t.mentioned += 1
    }
  }

  const stats = participants.map((agent) => {
    const a = acc.get(agent.id)!
    return {
      agent,
      messages: a.messages,
      artifacts: a.artifacts,
      mentioned: a.mentioned,
      handoffs: a.handoffs,
      tools: a.tools,
      first: firstSpeaker === agent.id,
      score: a.messages * 10 + a.artifacts * 30 + a.handoffs * 15 + a.tools * 5,
    }
  })
  totals.mentioned = stats.reduce((n, s) => n + s.mentioned, 0)
  totals.handoffs = stats.reduce((n, s) => n + s.handoffs, 0)
  return { stats, totals }
}

// ---------- 成就体系 ----------

export interface AchievementDef {
  id: string
  label: string
  /** 达成条件（chip tooltip） */
  desc: string
  icon: LucideIcon
  /** 达成阈值 */
  target: number
  /** 进度单位（「还差 2 次发言」） */
  unit: string
  /** 当前进度取值 */
  value: (s: AgentStat) => number
}

export const ACHIEVEMENTS: AchievementDef[] = [
  { id: 'icebreaker', label: '破冰者', desc: '本会话首位发言', icon: Snowflake, target: 1, unit: '次发言', value: (s) => (s.first ? 1 : 0) },
  { id: 'deliverer', label: '交付官', desc: '产出至少 1 个交付件', icon: Package, target: 1, unit: '件交付', value: (s) => s.artifacts },
  { id: 'popular', label: '人气王', desc: '被同事 cue 满 3 次', icon: Flame, target: 3, unit: '次被 cue', value: (s) => s.mentioned },
  { id: 'workhorse', label: '主力担当', desc: '累计发言满 4 次', icon: Award, target: 4, unit: '次发言', value: (s) => s.messages },
  { id: 'relay-king', label: '接力王', desc: '发起交接满 3 次', icon: HeartHandshake, target: 3, unit: '次交接', value: (s) => s.handoffs },
  { id: 'doer', label: '实干家', desc: '工具调用满 6 次', icon: Wrench, target: 6, unit: '次调用', value: (s) => s.tools },
]

/** 最接近解锁的一枚徽记（比率最高且已有进展；全员已解锁或未起步时返回 undefined） */
function nearestAchievement(s: AgentStat): { def: AchievementDef; cur: number } | undefined {
  let best: { def: AchievementDef; cur: number; ratio: number } | undefined
  for (const def of ACHIEVEMENTS) {
    const cur = def.value(s)
    if (cur <= 0 || cur >= def.target) continue
    const ratio = cur / def.target
    if (!best || ratio > best.ratio) best = { def, cur, ratio }
  }
  return best ? { def: best.def, cur: best.cur } : undefined
}

// ---------- 排序维度 ----------

type SortKey = 'score' | 'messages' | 'artifacts' | 'mentioned' | 'tools' | 'handoffs'

interface MetricDef {
  key: Exclude<SortKey, 'score'>
  label: string
  icon: LucideIcon
  /** 进度条主色 */
  bar: string
  value: (s: AgentStat) => number
}

const METRICS: MetricDef[] = [
  { key: 'messages', label: '发言', icon: MessageSquare, bar: 'bg-primary', value: (s) => s.messages },
  { key: 'artifacts', label: '交付件', icon: PackageOpen, bar: 'bg-emerald-500', value: (s) => s.artifacts },
  { key: 'mentioned', label: '被 cue', icon: AtSign, bar: 'bg-rose-400', value: (s) => s.mentioned },
  { key: 'tools', label: '工具调用', icon: Wrench, bar: 'bg-violet-500', value: (s) => s.tools },
  { key: 'handoffs', label: '交接', icon: HeartHandshake, bar: 'bg-sky-500', value: (s) => s.handoffs },
]

// ---------- 指标卡 ----------

function StatCard({
  icon: Icon,
  label,
  value,
  active,
  onClick,
}: {
  icon: LucideIcon
  label: string
  value: number
  active?: boolean
  onClick?: () => void
}): React.JSX.Element {
  const body = (
    <>
      <div className="flex items-center gap-1 text-[10.5px] text-muted-foreground">
        <Icon className="size-3 shrink-0" />
        <span className="truncate">{label}</span>
      </div>
      <div key={value} className="badge-pop text-[15px] font-semibold leading-5 tabular-nums text-primary">
        {value}
      </div>
    </>
  )
  if (!onClick) {
    return (
      <div className="rounded-xl border bg-gradient-to-b from-card to-muted/50 px-2 py-1.5 shadow-soft">{body}</div>
    )
  }
  return (
    <button
      type="button"
      aria-pressed={active}
      title={`按「${label}」排名${active ? '（点击恢复综合）' : ''}`}
      onClick={onClick}
      className={cn(
        'rounded-xl border bg-gradient-to-b from-card to-muted/50 px-2 py-1.5 text-left shadow-soft transition-all',
        active
          ? 'border-primary/40 from-primary/[0.08] to-primary/[0.02] ring-1 ring-primary/30'
          : 'hover:border-primary/30 hover:shadow',
      )}
    >
      {body}
    </button>
  )
}

// ---------- 排行行 ----------

const RANK_BADGE: Record<number, string> = {
  1: 'bg-gradient-to-br from-amber-300 to-amber-500 text-white shadow-sm',
  2: 'bg-gradient-to-br from-slate-300 to-slate-400 text-white',
  3: 'bg-gradient-to-br from-orange-300 to-orange-500 text-white',
}

function RankRow({
  stat,
  rank,
  value,
  maxValue,
  bar,
}: {
  stat: AgentStat
  rank: number
  /** 当前排序维度的取值 */
  value: number
  maxValue: number
  bar: string
}): React.JSX.Element {
  const achieved = ACHIEVEMENTS.filter((a) => a.value(stat) >= a.target)
  const next = nearestAchievement(stat)
  const idle = stat.messages === 0 && stat.mentioned === 0
  const ratio = maxValue > 0 ? value / maxValue : 0
  const width = value > 0 ? Math.max(6, Math.round(ratio * 100)) : 0
  const top = rank === 1 && value > 0

  return (
    <li
      title={`${stat.agent.name} · 发言 ${stat.messages} · 交付 ${stat.artifacts} · 被 cue ${stat.mentioned} · 工具 ${stat.tools} · 交接 ${stat.handoffs} · 战力 ${stat.score}`}
      className={cn(
        'rounded-xl border px-2.5 py-2 transition-all',
        top
          ? 'border-amber-300/80 bg-gradient-to-br from-amber-50/90 to-card shadow-[0_2px_12px_-6px_rgba(245,158,11,0.5)]'
          : 'bg-card hover:border-primary/25 hover:shadow-soft',
        idle && 'opacity-70',
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'flex size-[18px] shrink-0 items-center justify-center rounded-md text-[10px] font-semibold tabular-nums',
            RANK_BADGE[rank] ?? 'bg-muted text-muted-foreground',
          )}
        >
          {rank}
        </span>
        <AgentAvatar agent={stat.agent} size={28} animated={false} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 truncate text-[12.5px] font-medium">{stat.agent.name}</span>
            {top && <Crown className="size-3 shrink-0 text-amber-500" aria-label="榜首" />}
            <span
              className="ml-auto shrink-0 text-[11px] font-semibold tabular-nums text-primary"
              title={`综合贡献分 = ${SCORE_FORMULA}`}
            >
              战力 {stat.score}
            </span>
          </div>

          {(achieved.length > 0 || next) && (
            <div className="mt-1 flex flex-wrap gap-1">
              {achieved.map((a) => {
                const Icon = a.icon
                return (
                  <span
                    key={a.id}
                    title={`${a.label} · ${a.desc}`}
                    className="badge-pop inline-flex items-center gap-0.5 rounded bg-amber-500/10 px-1 py-0.5 text-[10px] text-amber-700"
                  >
                    <Icon className="size-3" />
                    {a.label}
                  </span>
                )
              })}
              {next && (
                <span
                  title={`距解锁「${next.def.label}」还差 ${next.def.target - next.cur} ${next.def.unit}`}
                  className="inline-flex items-center gap-0.5 rounded border border-dashed px-1 py-0.5 text-[10px] text-muted-foreground"
                >
                  <Target className="size-3" />
                  {next.def.label} {next.cur}/{next.def.target}
                </span>
              )}
            </div>
          )}

          <div className="mt-1 h-1 overflow-hidden rounded-full bg-border/70" aria-hidden>
            {width > 0 && (
              <span
                className={cn('block h-full rounded-full transition-[width] duration-500 ease-out', bar)}
                style={{ width: `${width}%` }}
              />
            )}
          </div>

          <div className="mt-0.5 text-[10.5px] text-muted-foreground">
            {idle ? (
              <span>尚未出战</span>
            ) : (
              <span className="tabular-nums">
                发言 {stat.messages} · 交付 {stat.artifacts} · 被 cue {stat.mentioned}
              </span>
            )}
          </div>
        </div>
      </div>
    </li>
  )
}

// ---------- 战绩视图 ----------

export function StatsView({
  participants,
  messages,
}: {
  participants: AgentDefinition[]
  messages: ChatMessage[]
}): React.JSX.Element {
  const active = useRunStore((s) => s.active)
  const lastEndReason = useRunStore((s) => s.lastEndReason)
  const runId = useRunStore((s) => s.runId)
  const openTrace = useUiStore((s) => s.openTrace)
  const quiet = useUiStore((s) => s.quietMode)

  const [sort, setSort] = React.useState<SortKey>('score')
  const [confettiBurst, setConfettiBurst] = React.useState(0)
  const prevReason = React.useRef(lastEndReason)

  React.useEffect(() => {
    if (prevReason.current !== lastEndReason) {
      prevReason.current = lastEndReason
      if (lastEndReason === 'completed' && !quiet) setConfettiBurst((n) => n + 1)
    }
  }, [lastEndReason, quiet])

  const { stats, totals } = React.useMemo(() => computeStats(participants, messages), [participants, messages])
  /** 当前排序维度取值 + 榜单（降序；同值按发言量、名字稳定排序）+ 竞争排名 */
  const { ranked, ranks, maxValue, bar } = React.useMemo(() => {
    const metric = sort === 'score' ? undefined : METRICS.find((m) => m.key === sort)
    const valueOf = metric?.value ?? ((s: AgentStat) => s.score)
    const list = [...stats].sort(
      (a, b) => valueOf(b) - valueOf(a) || b.messages - a.messages || a.agent.name.localeCompare(b.agent.name),
    )
    const rk = list.map((s, i) => (i > 0 && valueOf(s) === valueOf(list[i - 1]!) ? 0 : i + 1))
    for (let i = 1; i < rk.length; i++) if (rk[i] === 0) rk[i] = rk[i - 1]!
    return { ranked: list, ranks: rk, maxValue: Math.max(1, ...list.map(valueOf)), bar: metric?.bar ?? 'bg-primary' }
  }, [stats, sort])

  if (participants.length === 0) {
    return (
      <div className="px-3 py-10 text-center text-[12.5px] text-muted-foreground">
        <Trophy className="float-soft mx-auto mb-2 size-6 text-amber-400/70" />
        选择一个会话查看战力榜
      </div>
    )
  }

  const sortLabel = sort === 'score' ? '综合贡献' : (METRICS.find((m) => m.key === sort)?.label ?? '综合贡献')
  const valueOf = sort === 'score' ? undefined : METRICS.find((m) => m.key === sort)?.value

  return (
    <div className="relative p-2">
      <ConfettiBurst burst={confettiBurst} />

      {/* 指标总览：点击指标卡切换排行维度（再点恢复综合） */}
      <div className="mb-2 grid grid-cols-3 gap-1.5">
        {METRICS.map((m) => (
          <StatCard
            key={m.key}
            icon={m.icon}
            label={m.label}
            value={totals[m.key]}
            active={sort === m.key}
            onClick={() => setSort((cur) => (cur === m.key ? 'score' : m.key))}
          />
        ))}
        <StatCard icon={Flag} label="完成回合" value={totals.turns} />
      </div>

      {/* 战力榜 */}
      {totals.messages === 0 ? (
        <div className="rounded-xl border border-dashed px-3 py-6 text-center">
          <Trophy className="float-soft mx-auto mb-2 size-6 text-amber-400/60" />
          <p className="text-[12.5px] font-medium text-foreground">战绩册还是空的</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">在对话里 @ 一位成员，开启第一轮协作</p>
        </div>
      ) : (
        <>
          <div className="mb-1.5 flex items-center gap-1.5 px-0.5">
            <Trophy className="size-3.5 shrink-0 text-amber-500" />
            <span className="text-[11.5px] font-medium">战力榜</span>
            <span className="text-[10.5px] text-muted-foreground" title={sort === 'score' ? `综合贡献分 = ${SCORE_FORMULA}` : undefined}>
              按 {sortLabel} 排名
            </span>
            {active && (
              <span className="flex items-center gap-1 text-[10.5px] text-primary">
                <span className="size-1.5 animate-pulse rounded-full bg-primary" />
                实时
              </span>
            )}
            {sort !== 'score' && (
              <button
                type="button"
                className="ml-auto text-[10.5px] text-primary hover:underline"
                onClick={() => setSort('score')}
              >
                返回综合
              </button>
            )}
          </div>

          <ol className="space-y-1.5">
            {ranked.map((s, i) => (
              <RankRow
                key={s.agent.id}
                stat={s}
                rank={ranks[i]!}
                value={valueOf ? valueOf(s) : s.score}
                maxValue={maxValue}
                bar={bar}
              />
            ))}
          </ol>
        </>
      )}

      {runId && (
        <Button variant="outline" size="xs" className="mt-2 w-full" onClick={() => openTrace(runId)}>
          <Activity className="size-3" />
          查看本次运行轨迹
        </Button>
      )}
    </div>
  )
}

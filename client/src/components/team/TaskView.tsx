/**
 * 任务视图（M8 / M24 2.0）：双形态数据源 —— 有计划看「计划板」，无计划看「待办清单」。
 * - 计划板（M24）：计划卡（状态徽章 / 进度条 / 作者 / 版本）；步骤行（状态图标 / 负责人 / 范式标 / 验收 / 评审）；
 *   按「计划 / 成员」两种视角分组；待批准计划可就地改指派 + 批准执行 / 驳回带反馈；执行中步骤实时更新；
 * - 待办清单（M8，无计划会话保持原样）：`write_todos` 落盘的任务清单；
 * - 顶部：「规划先行」会话开关（PATCH /sessions/:id）—— 开启后未显式选范式的新消息默认规划范式。
 * 数据通道：task-store（SSE task:updated + WS notify:task-updated）+ plan-store（SSE plan:* + WS notify:plan-*）+ 会话切换拉取。
 */
import * as React from 'react'
import { toast } from 'sonner'
import {
  Check,
  CheckCircle2,
  CircleDashed,
  ClipboardList,
  ListOrdered,
  ListTodo,
  Loader2,
  Quote,
  RefreshCw,
  X,
} from 'lucide-react'
import type { AgentDefinition, Plan, PlanStep, Session, TaskItem, TaskStatus } from '@multi-agent/shared'
import { apiPatch } from '../../lib/api'
import { useAgentStore } from '../../stores/agent-store'
import { usePlanStore } from '../../stores/plan-store'
import { useSessionStore } from '../../stores/session-store'
import { useTaskStore } from '../../stores/task-store'
import { useUiStore } from '../../stores/ui-store'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Badge } from '../ui/badge'
import { AgentAvatar } from '../agents/AgentAvatar'
import { PLAN_STATUS_META, STEP_META, VERDICT_META } from '../chat/PlanReviewCard'

const STATUS_ICON: Record<TaskStatus, React.JSX.Element> = {
  pending: <CircleDashed className="size-3.5 shrink-0 text-muted-foreground" />,
  in_progress: <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />,
  done: <CheckCircle2 className="size-3.5 shrink-0 text-emerald-600" />,
}

const STATUS_TEXT: Record<TaskStatus, string> = {
  pending: '待办',
  in_progress: '进行中',
  done: '已完成',
}

/** 计划为空时的稳定引用（避免选择器每帧返回新数组） */
const EMPTY_PLANS: Plan[] = []

/** 计划排序：活跃优先（待批准 → 执行中 → 已批准 → 受阻 → 驳回 → 完成 → 取代），同期按时间倒序 */
const PLAN_RANK: Record<Plan['status'], number> = {
  submitted: 0,
  executing: 1,
  approved: 2,
  blocked: 3,
  rejected: 4,
  done: 5,
  superseded: 6,
}

function sortPlans(plans: Plan[]): Plan[] {
  return [...plans].sort(
    (a, b) => PLAN_RANK[a.status] - PLAN_RANK[b.status] || (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0),
  )
}

function planProgress(plan: Plan): { done: number; total: number } {
  const total = plan.steps.length
  const done = plan.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length
  return { done, total }
}

/** 计划卡（任务面板 2.0）：待批准可就地改指派 + 批准执行 / 驳回带反馈；其余状态只读跟踪实时进度 */
function PlanBoardCard({ plan, members }: { plan: Plan; members: AgentDefinition[] }): React.JSX.Element {
  const updatePlan = usePlanStore((s) => s.updatePlan)
  const resolve = usePlanStore((s) => s.resolve)
  const reviews = usePlanStore((s) => s.reviews)
  const [busy, setBusy] = React.useState<string>()
  const [rejectOpen, setRejectOpen] = React.useState(false)
  const [feedback, setFeedback] = React.useState('')

  const author = members.find((m) => m.id === plan.agentId)
  const meta = PLAN_STATUS_META[plan.status]
  const { done, total } = planProgress(plan)
  const pending = plan.status === 'submitted'

  /** M24：就地改指派（仅 submitted；整体回传步骤数组，携带其余字段避免丢失） */
  const patchOwner = async (stepId: string, ownerAgentId: string): Promise<void> => {
    if (busy) return
    setBusy(`owner:${stepId}`)
    try {
      await updatePlan(plan.id, {
        steps: plan.steps.map((s) => ({
          id: s.id,
          content: s.content,
          ownerAgentId: s.id === stepId ? ownerAgentId || undefined : s.ownerAgentId,
          mode: s.mode,
          expectedOutput: s.expectedOutput,
          acceptance: s.acceptance,
        })),
      })
      toast('已更新步骤负责人')
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(undefined)
    }
  }

  const approve = async (): Promise<void> => {
    if (busy) return
    setBusy('approve')
    try {
      await resolve(plan.id, 'approve')
      toast('已批准，开始执行')
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(undefined)
    }
  }

  const reject = async (): Promise<void> => {
    if (busy) return
    setBusy('reject')
    try {
      const text = feedback.trim()
      await resolve(plan.id, 'reject', text || undefined)
      toast(text ? '已驳回：反馈已回灌作者修订' : '已驳回：作者将重新规划')
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <div className="rounded-lg border bg-card px-2.5 py-2 shadow-soft">
      <div className="flex flex-wrap items-center gap-1.5">
        {author && <AgentAvatar agent={author} size={16} animated={false} className="rounded" />}
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold" title={plan.title}>
          {plan.title}
        </span>
        {plan.version > 1 && <span className="text-[10px] text-muted-foreground">v{plan.version}</span>}
        <Badge variant={meta.variant}>{meta.label}</Badge>
      </div>

      <p className="mt-1 max-h-8 overflow-hidden text-[11px] leading-4 text-muted-foreground" title={plan.goal}>
        {plan.goal}
      </p>

      <div className="mt-1 flex items-center gap-1.5">
        <span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-border">
          <span
            className={cn('absolute inset-y-0 left-0 rounded-full transition-all', plan.status === 'blocked' ? 'bg-destructive/70' : 'bg-emerald-500')}
            style={{ width: `${Math.round((done / Math.max(1, total)) * 100)}%` }}
          />
        </span>
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
          {done}/{total}
        </span>
      </div>

      <div className="mt-1.5 space-y-0.5 border-t pt-1.5">
        {plan.steps.map((s: PlanStep, i) => {
          const ownerId = s.ownerAgentId ?? plan.agentId
          const owner = members.find((m) => m.id === ownerId)
          const stepReviews = reviews.filter((r) => r.stepId === s.id)
          const review = stepReviews[stepReviews.length - 1]
          return (
            <div key={s.id} className="flex items-start gap-1.5 rounded-md px-1 py-0.5">
              <span className="mt-0.5 flex items-center gap-1">
                {STEP_META[s.status].icon}
                <span className="w-3.5 text-right text-[9.5px] tabular-nums text-muted-foreground">{i + 1}</span>
              </span>
              <div className="min-w-0 flex-1">
                <p className={cn('text-[11.5px] leading-4', s.status === 'done' && 'text-muted-foreground')}>{s.content}</p>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] text-muted-foreground">
                  <span>{STEP_META[s.status].label}</span>
                  {pending ? (
                    <select
                      value={ownerId}
                      disabled={busy === `owner:${s.id}`}
                      onChange={(e) => void patchOwner(s.id, e.target.value)}
                      title="就地改指派（仅「待批准」可编辑）"
                      className="h-5 max-w-28 rounded border bg-background px-0.5 text-[10px] focus:border-primary/40 focus:outline-none disabled:opacity-50"
                    >
                      <option value={plan.agentId}>{author?.name ?? plan.agentId}（作者）</option>
                      {members
                        .filter((m) => m.id !== plan.agentId)
                        .map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                    </select>
                  ) : (
                    owner && (
                      <span className="flex items-center gap-1">
                        <AgentAvatar agent={owner} size={12} animated={false} className="rounded" />
                        {owner.name}
                      </span>
                    )
                  )}
                  {s.mode === 'review' && (
                    <Badge variant="outline" className="px-1 py-0 text-[9.5px]">
                      评审
                    </Badge>
                  )}
                  {review && (
                    <Badge
                      variant={VERDICT_META[review.verdict].variant}
                      className="px-1 py-0 text-[9.5px]"
                      title={review.findings.join('；') || undefined}
                    >
                      {VERDICT_META[review.verdict].label}
                    </Badge>
                  )}
                </div>
                {s.acceptance && <p className="mt-0.5 text-[10px] text-muted-foreground/80">验收：{s.acceptance}</p>}
                {s.expectedOutput && (
                  <p className="mt-0.5 truncate text-[10px] text-muted-foreground/80" title={s.expectedOutput}>
                    产出：{s.expectedOutput}
                  </p>
                )}
                {s.note && <p className="mt-0.5 text-[10px] text-amber-600">备注：{s.note}</p>}
              </div>
            </div>
          )
        })}
      </div>

      {plan.status === 'rejected' && plan.feedback && (
        <p className="mt-1 rounded bg-destructive/5 px-1.5 py-1 text-[10.5px] leading-4 text-destructive">
          驳回反馈：{plan.feedback}
        </p>
      )}

      {pending && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1 border-t pt-1.5">
          <Button size="sm" className="h-6 px-2 text-[11px]" disabled={!!busy} onClick={() => void approve()}>
            {busy === 'approve' ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
            批准执行
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-[11px]"
            disabled={!!busy}
            onClick={() => setRejectOpen((v) => !v)}
          >
            <X className="size-3" />
            驳回
          </Button>
          {rejectOpen && (
            <>
              <input
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                placeholder="反馈（可选）…"
                className="h-6 min-w-0 flex-1 rounded-md border bg-background px-1.5 text-[11px] focus:border-primary/40 focus:outline-none"
              />
              <Button variant="destructive" size="sm" className="h-6 px-2 text-[11px]" disabled={!!busy} onClick={() => void reject()}>
                {busy === 'reject' ? <Loader2 className="size-3 animate-spin" /> : null}
                确认驳回
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

interface MemberEntry {
  plan: Plan
  step: PlanStep
}

/** 成员视角卡：一人一卡 —— 「已规划 · 步骤 x/y」+ 该成员的全部计划步骤 */
function MemberPlanCard({ member, memberId, entries }: { member?: AgentDefinition; memberId: string; entries: MemberEntry[] }): React.JSX.Element {
  const reviews = usePlanStore((s) => s.reviews)
  const done = entries.filter((e) => e.step.status === 'done' || e.step.status === 'skipped').length
  return (
    <div className="rounded-lg border bg-card px-2.5 py-2 shadow-soft">
      <div className="flex items-center gap-1.5">
        <AgentAvatar agent={member} size={16} animated={false} className="rounded" />
        <span className="text-[12px] font-semibold">{member?.name ?? memberId}</span>
        <span className="ml-auto text-[10.5px] text-muted-foreground">
          已规划 · 步骤 {done}/{entries.length}
        </span>
      </div>
      <div className="mt-1 space-y-0.5">
        {entries.map(({ plan, step }) => {
          const stepReviews = reviews.filter((r) => r.stepId === step.id)
          const review = stepReviews[stepReviews.length - 1]
          return (
            <div key={step.id} className="flex items-start gap-1.5">
              <span className="mt-0.5">{STEP_META[step.status].icon}</span>
              <div className="min-w-0 flex-1">
                <p className={cn('text-[11.5px] leading-4', step.status === 'done' && 'text-muted-foreground')}>{step.content}</p>
                <div className="flex flex-wrap items-center gap-x-1.5 text-[10px] text-muted-foreground">
                  <span className="truncate" title={plan.title}>
                    {plan.title}
                  </span>
                  <Badge variant={PLAN_STATUS_META[plan.status].variant} className="px-1 py-0 text-[9.5px]">
                    {PLAN_STATUS_META[plan.status].label}
                  </Badge>
                  {step.mode === 'review' && (
                    <Badge variant="outline" className="px-1 py-0 text-[9.5px]">
                      评审
                    </Badge>
                  )}
                  {review && (
                    <Badge variant={VERDICT_META[review.verdict].variant} className="px-1 py-0 text-[9.5px]">
                      {VERDICT_META[review.verdict].label}
                    </Badge>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** 按成员分组：编制顺序优先，离职成员（不在会话编制）兜底追加 */
function MemberBoard({ members, plans }: { members: AgentDefinition[]; plans: Plan[] }): React.JSX.Element {
  const entries = React.useMemo(() => {
    const map = new Map<string, MemberEntry[]>()
    for (const plan of plans) {
      for (const step of plan.steps) {
        const owner = step.ownerAgentId ?? plan.agentId
        const list = map.get(owner) ?? []
        list.push({ plan, step })
        map.set(owner, list)
      }
    }
    return map
  }, [plans])

  const rows = members.filter((m) => (entries.get(m.id)?.length ?? 0) > 0)
  const orphans = [...entries.keys()].filter((id) => !members.some((m) => m.id === id))

  return (
    <div className="space-y-2">
      {rows.map((m) => (
        <MemberPlanCard key={m.id} member={m} memberId={m.id} entries={entries.get(m.id)!} />
      ))}
      {orphans.map((id) => (
        <MemberPlanCard key={id} memberId={id} entries={entries.get(id)!} />
      ))}
    </div>
  )
}

export function TaskView(): React.JSX.Element {
  const currentId = useSessionStore((s) => s.currentId)
  const session = useSessionStore((s) => s.sessions.find((x) => x.id === s.currentId))
  const tasks = useTaskStore((s) => s.tasks)
  const boundSessionId = useTaskStore((s) => s.sessionId)
  const loading = useTaskStore((s) => s.loading)
  const load = useTaskStore((s) => s.load)
  const agents = useAgentStore((s) => s.agents)
  const insertToComposer = useUiStore((s) => s.insertToComposer)
  // M24：计划快照（绑定到当前会话时随事件流实时更新）
  const plans = usePlanStore((s) => (s.sessionId === currentId ? s.plans : EMPTY_PLANS))
  const plansBoundSessionId = usePlanStore((s) => s.sessionId)
  const loadPlans = usePlanStore((s) => s.load)
  const [groupBy, setGroupBy] = React.useState<'plan' | 'member'>('plan')
  const [savingPlanFirst, setSavingPlanFirst] = React.useState(false)
  const [savingSerial, setSavingSerial] = React.useState(false)

  React.useEffect(() => {
    if (currentId) void load(currentId)
  }, [currentId, load])

  // M24：未绑定 / 切换会话时拉取计划快照（已绑定则保持 SSE/WS 实时归约，不重复拉取）
  React.useEffect(() => {
    if (currentId && plansBoundSessionId !== currentId) void loadPlans(currentId)
  }, [currentId, plansBoundSessionId, loadPlans])

  const bound = boundSessionId === currentId
  const list = bound ? tasks : []
  const done = list.filter((t) => t.status === 'done').length
  const running = list.some((t) => t.status === 'in_progress')

  const hasPlans = plansBoundSessionId === currentId && plans.length > 0
  const sortedPlans = React.useMemo(() => sortPlans(plans), [plans])
  const pendingCount = plans.filter((p) => p.status === 'submitted').length

  const members = React.useMemo(
    () =>
      (session?.participantIds ?? [])
        .map((id) => agents.find((a) => a.id === id))
        .filter(Boolean) as AgentDefinition[],
    [session, agents],
  )

  const refresh = (): void => {
    if (!currentId) return
    void load(currentId)
    void loadPlans(currentId)
  }

  /** M24：「规划先行」会话开关（PATCH /sessions/:id；默认关闭） */
  const togglePlanFirst = async (): Promise<void> => {
    if (!currentId || !session || savingPlanFirst) return
    setSavingPlanFirst(true)
    try {
      const res = await apiPatch<{ session: Session }>(`/api/sessions/${currentId}`, { planFirst: !session.planFirst })
      useSessionStore.getState().applySession(res.session)
      toast(res.session.planFirst ? '已开启「规划先行」：新消息默认进入规划范式' : '已关闭「规划先行」')
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSavingPlanFirst(false)
    }
  }

  /** M46-2：「串行执行」会话开关（PATCH /sessions/:id；默认开启：波次逐位出场，便于跟进查看） */
  const toggleSerial = async (): Promise<void> => {
    if (!currentId || !session || savingSerial) return
    setSavingSerial(true)
    try {
      const res = await apiPatch<{ session: Session }>(`/api/sessions/${currentId}`, { serial: !session.serial })
      useSessionStore.getState().applySession(res.session)
      toast(
        res.session.serial
          ? '已开启「串行执行」：成员逐位出场，便于跟进查看'
          : '已关闭「串行执行」：同场景成员可并行成波（推进更快）',
      )
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSavingSerial(false)
    }
  }

  if (!currentId) {
    return <div className="flex h-full items-center justify-center text-[12.5px] text-muted-foreground">先选择一个会话</div>
  }

  const planFirstChip = session && (
    <button
      type="button"
      disabled={savingPlanFirst}
      onClick={() => void togglePlanFirst()}
      title={
        session.planFirst
          ? '规划先行已开启：未显式选择范式的新消息默认规划（规划 → 批准 → 执行）；点按关闭'
          : '开启后：未显式选择范式的新消息默认进入规划范式（规划 → 批准 → 执行）'
      }
      className={cn(
        'flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10.5px] transition-colors disabled:opacity-50',
        session.planFirst
          ? 'border-primary/40 bg-primary/10 font-medium text-primary'
          : 'text-muted-foreground hover:border-primary/30 hover:text-foreground',
      )}
    >
      <ClipboardList className="size-3" />
      规划先行{session.planFirst ? '已开' : ''}
    </button>
  )

  const serialChip = session && (
    <button
      type="button"
      disabled={savingSerial}
      onClick={() => void toggleSerial()}
      title={
        session.serial
          ? '串行执行已开启：波次内成员逐位出场（一次一位），便于跟进与查看；点按关闭以允许同场景并行'
          : '串行执行已关闭：同场景成员可并行成波，推进更快但过程不易跟进；点按开启'
      }
      className={cn(
        'flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10.5px] transition-colors disabled:opacity-50',
        session.serial
          ? 'border-primary/40 bg-primary/10 font-medium text-primary'
          : 'text-muted-foreground hover:border-primary/30 hover:text-foreground',
      )}
    >
      <ListOrdered className="size-3" />
      串行执行{session.serial ? '已开' : ''}
    </button>
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      {hasPlans ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-2 text-[11.5px] text-muted-foreground">
          <ClipboardList className="size-3.5" />
          <span>计划 {plans.length}</span>
          {pendingCount > 0 && <span className="font-medium text-amber-600">{pendingCount} 份待批准</span>}
          {planFirstChip}
          {serialChip}
          <span className="flex overflow-hidden rounded-full border text-[10.5px]">
            <button
              type="button"
              onClick={() => setGroupBy('plan')}
              className={cn('px-1.5 py-0.5 transition-colors', groupBy === 'plan' ? 'bg-primary/10 font-medium text-primary' : 'hover:text-foreground')}
            >
              按计划
            </button>
            <button
              type="button"
              onClick={() => setGroupBy('member')}
              className={cn('border-l px-1.5 py-0.5 transition-colors', groupBy === 'member' ? 'bg-primary/10 font-medium text-primary' : 'hover:text-foreground')}
            >
              按成员
            </button>
          </span>
          <Button variant="ghost" size="icon-sm" className="ml-auto" title="刷新任务与计划" disabled={loading} onClick={refresh}>
            {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2 border-b px-3 py-2 text-[11.5px] text-muted-foreground">
          <ListTodo className="size-3.5" />
          <span>
            任务 {done}/{list.length}
          </span>
          {list.length > 0 && (
            <span className="relative h-1.5 w-24 overflow-hidden rounded-full bg-border">
              <span
                className="absolute inset-y-0 left-0 rounded-full bg-emerald-500 transition-all"
                style={{ width: `${Math.round((done / Math.max(1, list.length)) * 100)}%` }}
              />
            </span>
          )}
          {running && <span className="text-primary">执行中…</span>}
          {planFirstChip}
          {serialChip}
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            title="刷新任务"
            disabled={loading}
            onClick={() => void load(currentId)}
          >
            {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {hasPlans ? (
          groupBy === 'plan' ? (
            <div className="space-y-2">
              {sortedPlans.map((plan) => (
                <PlanBoardCard key={plan.id} plan={plan} members={members} />
              ))}
            </div>
          ) : (
            <MemberBoard members={members} plans={plans} />
          )
        ) : (
          <>
            {list.length === 0 && (
              <div className="px-3 py-10 text-center text-[12px] leading-5 text-muted-foreground">
                <ListTodo className="mx-auto mb-2 size-6 opacity-50" />
                暂无任务
                <br />
                成员调用 write_todos 后会实时出现在这里
              </div>
            )}
            <div className="space-y-1">
              {list.map((task: TaskItem, i) => {
                const owner = task.ownerAgentId ? agents.find((a) => a.id === task.ownerAgentId) : undefined
                return (
                  <div
                    key={task.id}
                    className={cn(
                      'group flex items-start gap-2 rounded-lg border bg-card px-2.5 py-2 text-[12px] shadow-soft transition-colors',
                      task.status === 'done' && 'opacity-70',
                    )}
                  >
                    <span className="mt-0.5 flex items-center gap-1.5">
                      {STATUS_ICON[task.status]}
                      <span className="w-4 text-right text-[10.5px] tabular-nums text-muted-foreground">{i + 1}</span>
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className={cn('leading-5', task.status === 'done' && 'line-through decoration-muted-foreground/50')}>
                        {task.content}
                      </p>
                      <div className="mt-1 flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
                        <span>{STATUS_TEXT[task.status]}</span>
                        {owner && (
                          <span className="flex items-center gap-1">
                            <AgentAvatar agent={owner} size={13} animated={false} className="rounded" />
                            {owner.name}
                          </span>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      title="引用到输入框"
                      onClick={() => insertToComposer(`[任务] ${task.content}\n`)}
                      className="rounded p-1 text-muted-foreground/60 opacity-0 transition-opacity hover:bg-accent/70 hover:text-foreground group-hover:opacity-100"
                    >
                      <Quote className="size-3" />
                    </button>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

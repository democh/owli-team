/**
 * 计划评审卡（M24）：聊天内的协作计划卡 —— 与 ApprovalPanel 同区渲染（Composer 上方）。
 * - 待批准（submitted）：步骤表 + 就地编辑（标题 / 指派 / 调序 / 增删）+「批准并执行 / 驳回带反馈」
 *   （无挂起时服务端自动新起执行 Run，由 plan-store 挂接流转）；
 * - 其余活跃态（approved / executing / blocked / rejected）：紧凑进度卡（实时步骤状态 + 评审标记）；
 * - 数据源：plan-store（SSE plan:* + WS notify:plan-* 双通道）；会话无计划时不渲染（默认路径零差异）。
 */
import * as React from 'react'
import { toast } from 'sonner'
import {
  ArrowDown,
  ArrowUp,
  Check,
  CheckCircle2,
  CircleDashed,
  CircleMinus,
  ClipboardList,
  Loader2,
  OctagonAlert,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react'
import type { AgentDefinition, Plan, PlanStatus, PlanStep, ReviewRecord, ReviewVerdict } from '@multi-agent/shared'
import { useAgentStore } from '../../stores/agent-store'
import { usePlanStore } from '../../stores/plan-store'
import { useSessionStore } from '../../stores/session-store'
import { cn } from '../../lib/utils'
import { memberDisplayList } from '../../lib/members'
import { formatClock } from '../../lib/time'
import { Button } from '../ui/button'
import { Badge } from '../ui/badge'
import { AgentAvatar } from '../agents/AgentAvatar'

type BadgeVariant = 'default' | 'secondary' | 'outline' | 'success' | 'warning' | 'destructive'

/** 计划状态元数据（任务面板 2.0 复用） */
export const PLAN_STATUS_META: Record<PlanStatus, { label: string; variant: BadgeVariant }> = {
  submitted: { label: '待批准', variant: 'warning' },
  approved: { label: '已批准', variant: 'default' },
  executing: { label: '执行中', variant: 'default' },
  done: { label: '已完成', variant: 'success' },
  rejected: { label: '已驳回', variant: 'destructive' },
  superseded: { label: '已被取代', variant: 'outline' },
  blocked: { label: '受阻', variant: 'destructive' },
}

/** 步骤状态元数据（任务面板 2.0 复用） */
export const STEP_META: Record<PlanStep['status'], { icon: React.JSX.Element; label: string }> = {
  pending: { icon: <CircleDashed className="size-3.5 shrink-0 text-muted-foreground" />, label: '待办' },
  in_progress: { icon: <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />, label: '进行中' },
  done: { icon: <CheckCircle2 className="size-3.5 shrink-0 text-emerald-600" />, label: '已完成' },
  blocked: { icon: <OctagonAlert className="size-3.5 shrink-0 text-destructive" />, label: '受阻' },
  skipped: { icon: <CircleMinus className="size-3.5 shrink-0 text-muted-foreground" />, label: '已跳过' },
}

/** 评审判定元数据（任务面板 2.0 复用） */
export const VERDICT_META: Record<ReviewVerdict, { label: string; variant: BadgeVariant }> = {
  pass: { label: '评审通过', variant: 'success' },
  conditional: { label: '有条件通过', variant: 'warning' },
  fail: { label: '评审未通过', variant: 'destructive' },
}

/** 编辑草稿步骤（id 缺省 = 新增；expectedOutput / acceptance 仅携带不改） */
interface DraftStep {
  id?: string
  content: string
  ownerAgentId: string
  mode: 'execute' | 'review'
  expectedOutput?: string
  acceptance?: string
}

function toDraft(plan: Plan): DraftStep[] {
  return plan.steps.map((s) => ({
    id: s.id,
    content: s.content,
    ownerAgentId: s.ownerAgentId ?? '',
    mode: s.mode === 'review' ? 'review' : 'execute',
    expectedOutput: s.expectedOutput,
    acceptance: s.acceptance,
  }))
}

/** 步骤行 · 只读（执行态实时进度 + 评审标记 + 验收 / 产出） */
function StepRow({
  step,
  index,
  member,
  review,
}: {
  step: PlanStep
  index: number
  member?: AgentDefinition
  review?: ReviewRecord
}): React.JSX.Element {
  const meta = STEP_META[step.status]
  return (
    <div className="flex items-start gap-2 py-1">
      <span className="mt-0.5 flex items-center gap-1.5">
        {meta.icon}
        <span className="w-4 text-right text-[10.5px] tabular-nums text-muted-foreground">{index + 1}</span>
      </span>
      <div className="min-w-0 flex-1">
        <p className={cn('text-[12.5px] leading-5', step.status === 'done' && 'text-muted-foreground')}>{step.content}</p>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] text-muted-foreground">
          <span>{meta.label}</span>
          {member && (
            <span className="flex items-center gap-1">
              <AgentAvatar agent={member} size={13} animated={false} />
              {member.name}
            </span>
          )}
          {step.mode === 'review' && <Badge variant="outline" className="px-1.5 py-0 text-[10px]">评审</Badge>}
          {review && (
            <Badge
              variant={VERDICT_META[review.verdict].variant}
              className="px-1.5 py-0 text-[10px]"
              title={review.findings.join('；') || undefined}
            >
              {VERDICT_META[review.verdict].label}
            </Badge>
          )}
        </div>
        {step.acceptance && <p className="mt-0.5 text-[10.5px] text-muted-foreground/80">验收：{step.acceptance}</p>}
        {step.expectedOutput && (
          <p className="mt-0.5 truncate text-[10.5px] text-muted-foreground/80" title={step.expectedOutput}>
            产出：{step.expectedOutput}
          </p>
        )}
        {step.note && <p className="mt-0.5 text-[10.5px] text-amber-600">备注：{step.note}</p>}
      </div>
    </div>
  )
}

/** 计划头（作者 / 标题 / 版本 / 状态 / 进度） */
function CardHeader({ plan, author }: { plan: Plan; author?: AgentDefinition }): React.JSX.Element {
  const done = plan.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length
  const meta = PLAN_STATUS_META[plan.status]
  const showProgress = plan.status === 'executing' || plan.status === 'approved'
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2 text-[12px]">
      <ClipboardList className="size-4 shrink-0 text-primary" />
      {author && (
        <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <AgentAvatar agent={author} size={15} animated={false} />
          {author.name}
        </span>
      )}
      <span className="text-[11px] text-muted-foreground">{plan.status === 'submitted' ? '提交了协作计划' : plan.title}</span>
      {plan.status === 'submitted' && <span className="max-w-56 truncate font-semibold">{plan.title}</span>}
      {plan.version > 1 && <span className="text-[10.5px] text-muted-foreground">v{plan.version}</span>}
      <Badge variant={meta.variant}>{meta.label}</Badge>
      {showProgress && (
        <span className="flex items-center gap-1 text-[10.5px] text-muted-foreground">
          <span className="relative h-1.5 w-16 overflow-hidden rounded-full bg-border">
            <span
              className="absolute inset-y-0 left-0 rounded-full bg-primary transition-all"
              style={{ width: `${Math.round((done / Math.max(1, plan.steps.length)) * 100)}%` }}
            />
          </span>
          {done}/{plan.steps.length}
        </span>
      )}
      <span className="ml-auto text-[10.5px] text-muted-foreground/70">{formatClock(plan.updatedAt)}</span>
    </div>
  )
}

/** 待批准卡：就地编辑 + 批准并执行 / 驳回带反馈 */
function PlanApprovalCard({ plan, members }: { plan: Plan; members: AgentDefinition[] }): React.JSX.Element {
  const updatePlan = usePlanStore((s) => s.updatePlan)
  const resolve = usePlanStore((s) => s.resolve)
  const [busy, setBusy] = React.useState<string>()
  const [rejectOpen, setRejectOpen] = React.useState(false)
  const [feedback, setFeedback] = React.useState('')
  const [title, setTitle] = React.useState(plan.title)
  const [draft, setDraft] = React.useState<DraftStep[]>(() => toDraft(plan))

  // 外部版本变化（保存回执 / WS 同步 / 驳回后 v2 重提）：静默重置草稿
  React.useEffect(() => {
    setTitle(plan.title)
    setDraft(toDraft(plan))
  }, [plan.id, plan.version, plan.updatedAt])

  const baseSteps = React.useMemo(() => JSON.stringify(toDraft(plan)), [plan])
  const dirty = title.trim() !== plan.title || JSON.stringify(draft) !== baseSteps

  const author = members.find((m) => m.id === plan.agentId)
  const defaultOwner = members[0]?.id ?? plan.agentId

  const patchStep = (index: number, patch: Partial<DraftStep>): void =>
    setDraft((list) => list.map((s, i) => (i === index ? { ...s, ...patch } : s)))

  const moveStep = (index: number, delta: -1 | 1): void =>
    setDraft((list) => {
      const target = index + delta
      if (target < 0 || target >= list.length) return list
      const next = [...list]
      const [moved] = next.splice(index, 1)
      next.splice(target, 0, moved)
      return next
    })

  const removeStep = (index: number): void => setDraft((list) => list.filter((_, i) => i !== index))

  const addStep = (): void =>
    setDraft((list) => [...list, { content: '', ownerAgentId: defaultOwner, mode: 'execute' }])

  /** 保存草稿（返回最新计划；驳回校验失败返回 null） */
  const save = async (): Promise<Plan | null> => {
    if (draft.length === 0) {
      toast.error('至少保留一个步骤')
      return null
    }
    if (draft.some((s) => !s.content.trim())) {
      toast.error('步骤内容不能为空')
      return null
    }
    const updated = await updatePlan(plan.id, {
      title: title.trim() || plan.title,
      steps: draft.map((s) => ({
        id: s.id,
        content: s.content.trim(),
        ownerAgentId: s.ownerAgentId || undefined,
        mode: s.mode,
        expectedOutput: s.expectedOutput,
        acceptance: s.acceptance,
      })),
    })
    toast('计划已更新')
    return updated
  }

  const onSave = async (): Promise<void> => {
    if (busy) return
    setBusy('save')
    try {
      await save()
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
      if (dirty && !(await save())) return
      const resolved = await resolve(plan.id, 'approve')
      toast(resolved.status === 'rejected' ? '计划已处理' : '已批准，开始执行')
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
      // 结算后主动收起表单：驳回→作者即时重提 v2 可能与 rejected 同批到达（组件不卸载），
      // 不能依赖「切紧凑态卸载」清理，否则 v2 卡会卡在确认驳回态
      setRejectOpen(false)
      setFeedback('')
      toast(text ? '已驳回：反馈已回灌作者现场修订' : '已驳回：作者将重新规划')
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <div className="flex max-h-[60vh] flex-col overflow-hidden rounded-xl border border-amber-300/70 bg-amber-50/60 shadow-soft">
      <CardHeader plan={plan} author={author} />

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-2">
        <div className="flex items-start gap-2">
          <span className="mt-1.5 shrink-0 text-[10.5px] text-muted-foreground">标题</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="h-7 min-w-0 flex-1 rounded-md border border-amber-200/70 bg-background/70 px-2 text-[12.5px] font-medium focus:border-primary/40 focus:outline-none focus:ring-[3px] focus:ring-primary/10"
          />
        </div>
        <p className="text-[11.5px] leading-5 text-muted-foreground">
          <span className="text-amber-800">目标：</span>
          {plan.goal}
        </p>

        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-[10.5px] uppercase tracking-wide text-muted-foreground">
            步骤（{draft.length}）
            <button
              type="button"
              onClick={addStep}
              className="ml-auto flex items-center gap-0.5 rounded px-1 py-0.5 text-[10.5px] text-primary transition-colors hover:bg-primary/10"
            >
              <Plus className="size-3" />
              添加步骤
            </button>
          </div>
          {draft.map((step, i) => (
            <div key={step.id ?? `new-${i}`} className="rounded-lg border border-amber-200/70 bg-background/60 p-1.5">
              <div className="flex items-start gap-1.5">
                <div className="flex shrink-0 flex-col items-center gap-0.5 pt-0.5">
                  <span className="text-[10px] tabular-nums text-muted-foreground">{i + 1}</span>
                  <button
                    type="button"
                    title="上移"
                    disabled={i === 0}
                    onClick={() => moveStep(i, -1)}
                    className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground disabled:opacity-30"
                  >
                    <ArrowUp className="size-3" />
                  </button>
                  <button
                    type="button"
                    title="下移"
                    disabled={i === draft.length - 1}
                    onClick={() => moveStep(i, 1)}
                    className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground disabled:opacity-30"
                  >
                    <ArrowDown className="size-3" />
                  </button>
                </div>
                <div className="min-w-0 flex-1 space-y-1">
                  <textarea
                    value={step.content}
                    rows={2}
                    onChange={(e) => patchStep(i, { content: e.target.value })}
                    placeholder="步骤内容…"
                    className="block w-full resize-none rounded-md border bg-background px-2 py-1 text-[12px] leading-5 focus:border-primary/40 focus:outline-none focus:ring-[3px] focus:ring-primary/10"
                  />
                  <div className="flex flex-wrap items-center gap-1.5">
                    <select
                      value={step.ownerAgentId}
                      onChange={(e) => patchStep(i, { ownerAgentId: e.target.value })}
                      title="步骤负责人（必须为会话成员）"
                      className="h-6 rounded-md border bg-background px-1 text-[11px] focus:border-primary/40 focus:outline-none"
                    >
                      <option value="">作者（默认）</option>
                      {members.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                    <span className="flex overflow-hidden rounded-md border text-[10.5px]">
                      <button
                        type="button"
                        title="执行范式（正常工具集）"
                        onClick={() => patchStep(i, { mode: 'execute' })}
                        className={cn(
                          'px-1.5 py-0.5 transition-colors',
                          step.mode === 'execute' ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:text-foreground',
                        )}
                      >
                        执行
                      </button>
                      <button
                        type="button"
                        title="评审范式（只读工具 + 结构化判定产出）"
                        onClick={() => patchStep(i, { mode: 'review' })}
                        className={cn(
                          'border-l px-1.5 py-0.5 transition-colors',
                          step.mode === 'review' ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:text-foreground',
                        )}
                      >
                        评审
                      </button>
                    </span>
                    {step.acceptance && <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground/80">验收：{step.acceptance}</span>}
                    <button
                      type="button"
                      title="删除步骤"
                      onClick={() => removeStep(i)}
                      className="ml-auto rounded p-0.5 text-muted-foreground/70 transition-colors hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 className="size-3" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        {plan.risks.length > 0 && (
          <div className="text-[10.5px] leading-4 text-amber-800/80">
            <span className="font-medium">风险与依赖：</span>
            {plan.risks.join('；')}
          </div>
        )}

        {rejectOpen && (
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            rows={2}
            autoFocus
            placeholder="驳回反馈（可选；填写后作者将据反馈就地修订 v2）…"
            className="block w-full resize-none rounded-lg border bg-background px-2.5 py-2 text-[12.5px] leading-5 focus:border-primary/40 focus:outline-none focus:ring-[3px] focus:ring-primary/12"
          />
        )}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-amber-200/70 px-3 py-1.5">
        {rejectOpen ? (
          <>
            <Button variant="destructive" size="sm" className="h-7 text-[12px]" disabled={!!busy} onClick={() => void reject()}>
              {busy === 'reject' ? <Loader2 className="size-3 animate-spin" /> : <X className="size-3.5" />}
              确认驳回
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[12px]"
              disabled={!!busy}
              onClick={() => {
                setRejectOpen(false)
                setFeedback('')
              }}
            >
              取消
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" className="h-7 text-[12px]" disabled={!!busy} onClick={() => void approve()}>
              {busy === 'approve' ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3.5" />}
              批准并执行
            </Button>
            <Button variant="outline" size="sm" className="h-7 text-[12px]" disabled={!!busy} onClick={() => setRejectOpen(true)}>
              <X className="size-3.5" />
              驳回
            </Button>
          </>
        )}
        {dirty && (
          <>
            <Button variant="outline" size="sm" className="h-7 text-[12px]" disabled={!!busy} onClick={() => void onSave()}>
              {busy === 'save' ? <Loader2 className="size-3 animate-spin" /> : null}
              保存修改
            </Button>
            <button
              type="button"
              title="放弃编辑"
              onClick={() => {
                setTitle(plan.title)
                setDraft(toDraft(plan))
              }}
              className="flex items-center gap-0.5 rounded px-1 py-0.5 text-[10.5px] text-muted-foreground transition-colors hover:text-foreground"
            >
              <RotateCcw className="size-3" />
              重置
            </button>
          </>
        )}
      </div>
    </div>
  )
}

/** 执行 / 驳回 / 受阻等活跃态：紧凑进度卡（实时步骤状态） */
function PlanProgressCard({ plan, members, reviews }: { plan: Plan; members: AgentDefinition[]; reviews: ReviewRecord[] }): React.JSX.Element {
  const author = members.find((m) => m.id === plan.agentId)
  const planReviews = reviews.filter((r) => r.planId === plan.id).slice(-2)
  return (
    <div
      className={cn(
        'overflow-hidden rounded-xl border bg-card/80 shadow-soft',
        plan.status === 'rejected' || plan.status === 'blocked' ? 'border-destructive/35' : 'border-primary/25',
      )}
    >
      <CardHeader plan={plan} author={author} />
      <div className="space-y-1.5 px-3 py-2">
        <p className="text-[11.5px] leading-5 text-muted-foreground">
          <span className="text-foreground/70">目标：</span>
          {plan.goal}
        </p>
        <div className="divide-y divide-border/60">
          {plan.steps.map((step, i) => {
            const stepReviews = reviews.filter((r) => r.stepId === step.id)
            return (
              <StepRow
                key={step.id}
                step={step}
                index={i}
                member={members.find((m) => m.id === (step.ownerAgentId ?? plan.agentId))}
                review={stepReviews[stepReviews.length - 1]}
              />
            )
          })}
        </div>
        {plan.status === 'rejected' && plan.feedback && (
          <p className="rounded-lg bg-destructive/5 px-2 py-1.5 text-[11px] leading-5 text-destructive">
            驳回反馈：{plan.feedback}
          </p>
        )}
        {plan.status === 'blocked' && (
          <p className="rounded-lg bg-destructive/5 px-2 py-1.5 text-[11px] leading-5 text-destructive">
            评审未通过 / 步骤受阻：请检查受阻步骤备注，处理后可继续执行。
          </p>
        )}
        {planReviews.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t pt-1.5 text-[10.5px] text-muted-foreground">
            <span className="uppercase tracking-wide">评审</span>
            {planReviews.map((r) => {
              const reviewer = members.find((m) => m.id === r.agentId)
              return (
                <span key={r.id} className="flex items-center gap-1" title={r.findings.join('；') || r.target}>
                  {reviewer && <AgentAvatar agent={reviewer} size={12} animated={false} />}
                  {reviewer?.name ?? r.agentId}
                  <Badge variant={VERDICT_META[r.verdict].variant} className="px-1.5 py-0 text-[10px]">
                    {VERDICT_META[r.verdict].label}
                  </Badge>
                </span>
              )
            })}
          </div>
        )}
        {plan.status === 'rejected' && (
          <p className="text-[10.5px] text-muted-foreground/70">等待作者修订重提</p>
        )}
      </div>
    </div>
  )
}

export function PlanReviewCard(): React.JSX.Element | null {
  const currentId = useSessionStore((s) => s.currentId)
  const sessions = useSessionStore((s) => s.sessions)
  const agents = useAgentStore((s) => s.agents)
  const plans = usePlanStore((s) => s.plans)
  const reviews = usePlanStore((s) => s.reviews)
  const boundSessionId = usePlanStore((s) => s.sessionId)
  const load = usePlanStore((s) => s.load)

  React.useEffect(() => {
    if (currentId) void load(currentId)
  }, [currentId, load])

  const session = sessions.find((s) => s.id === currentId)
  const bound = boundSessionId === currentId
  // 活跃计划（done / superseded 不占聊天区，任务面板可见）；最多并列 2 张，避免堆叠
  const visible = React.useMemo(
    () => (bound ? plans.filter((p) => p.status !== 'done' && p.status !== 'superseded').slice(0, 2) : []),
    [bound, plans],
  )

  if (!currentId || visible.length === 0) return null

  // M77：成员实例投影（id = 成员键、name = 展示标签）+ 幽灵补位（作者/负责人/评审人已离场时仍可读）
  // 注：早退之后不得引入 hook（保持 hook 调用顺序不变）
  const members = memberDisplayList(agents, session, [
    ...visible.flatMap((p) => [p.agentId, ...p.steps.map((s) => s.ownerAgentId ?? p.agentId)]),
    ...reviews.map((r) => r.agentId),
  ])

  return (
    <div className="min-h-[80px] max-h-[62vh] space-y-2 overflow-y-auto px-4 pb-1">
      {visible.map((plan) =>
        plan.status === 'submitted' ? (
          <PlanApprovalCard key={plan.id} plan={plan} members={members} />
        ) : (
          <PlanProgressCard key={plan.id} plan={plan} members={members} reviews={reviews} />
        ),
      )}
    </div>
  )
}

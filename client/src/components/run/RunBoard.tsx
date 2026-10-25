/**
 * M88：运行面板（Run Board）—— 计划与编排判定的唯一权威视图。
 *
 * 信息架构（自上而下）：
 * 1. 阶段条：研判 → 规划 → 待批准 → 执行 → 评审 → 收口（当前阶段高亮，一眼看到"现在在哪"）；
 * 2. 判定依据：为什么进入规划（intent.reasons + 置信度 + 来源）+ 运行期纠偏建议；
 * 3. 计划卡：目标 / 状态 / 进度 / 版本；待批准时就地批准 / 驳回；
 * 4. 步骤表：状态 / 负责人 / 验收 / 评审 fail 阻塞；证据链见任务面板与聊天卡；
 * 5. 决策收件箱：待批准计划 + 工具审批 + 评审未通过，收敛成"需要你动手"的计数。
 *
 * 交互原则：本面板不抢视图（plan 提交只加徽章）；状态以 plan-store 为唯一事实源（updatedAt 守卫已在 store 内）。
 */
import * as React from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  Hand,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  XCircle,
} from 'lucide-react'
import type { Plan, PlanStatus, ReviewRecord, TurnIntent } from '@multi-agent/shared'
import { toast } from 'sonner'
import { labelOfMemberKey } from '../../lib/members'
import { cn } from '../../lib/utils'
import { useAgentStore } from '../../stores/agent-store'
import { usePlanStore } from '../../stores/plan-store'
import { useRunStore } from '../../stores/run-store'
import { useCurrentSession, useSessionStore } from '../../stores/session-store'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { PLAN_STATUS_META, STEP_META } from '../chat/PlanReviewCard'

const PHASES = ['研判', '规划', '待批准', '执行', '评审', '收口'] as const

/** 计划状态 → 阶段序号（0 基） */
const PHASE_OF_STATUS: Record<PlanStatus, number> = {
  submitted: 2,
  approved: 3,
  executing: 3,
  blocked: 3,
  done: 5,
  rejected: 1,
  superseded: 5,
}

function phaseIndex(plan: Plan | undefined, active: boolean): number {
  if (!plan) return active ? 3 : 0
  const idx = PHASE_OF_STATUS[plan.status]
  // 执行中且意图要求验收 → 停在「评审」（收口评审门尚未开始）
  return idx
}

function planProgress(plan: Plan): { done: number; total: number } {
  const total = plan.steps.length
  const done = plan.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length
  return { done, total }
}

function PhaseBar({ active }: { active: number }): React.JSX.Element {
  return (
    <div className="flex items-center gap-1">
      {PHASES.map((label, i) => {
        const state = i < active ? 'done' : i === active ? 'now' : 'todo'
        return (
          <React.Fragment key={label}>
            {i > 0 && <span className={cn('h-px flex-1', i <= active ? 'bg-primary/50' : 'bg-border')} />}
            <span
              className={cn(
                'flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px]',
                state === 'done' && 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700',
                state === 'now' && 'border-primary/50 bg-primary/10 font-medium text-primary',
                state === 'todo' && 'border-border text-muted-foreground',
              )}
              title={`阶段 ${i + 1}/${PHASES.length}：${label}`}
            >
              {state === 'done' ? <CheckCircle2 className="size-2.5" /> : null}
              {state === 'now' ? <Loader2 className="size-2.5 animate-spin" /> : null}
              {label}
            </span>
          </React.Fragment>
        )
      })}
    </div>
  )
}

function IntentCard({
  intent,
  suggestion,
}: {
  intent?: TurnIntent
  suggestion?: { writes: number; agents: string[] }
}): React.JSX.Element | null {
  if (!intent && !suggestion) return null
  const sourceLabel: Record<string, string> = {
    user: '你选择',
    rule: '规则判定',
    router: '平台判定',
    policy: '会话策略',
    default: '默认',
  }
  return (
    <div className="rounded-lg border bg-muted/20 px-2.5 py-2">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Sparkles className="size-3.5 text-primary" />
        <span>编排判定</span>
        {intent && (
          <>
            <span className="text-[10px]">· {sourceLabel[intent.source] ?? intent.source}</span>
            <span className="text-[10px]">· 置信 {Math.round(intent.confidence * 100)}%</span>
            {intent.risk !== 'low' && (
              <Badge variant={intent.risk === 'high' ? 'destructive' : 'warning'} className="h-4 px-1 text-[9.5px]">
                {intent.risk === 'high' ? '高风险' : '中风险'}
              </Badge>
            )}
          </>
        )}
      </div>
      {intent && intent.reasons.length > 0 && (
        <p className="mt-1 text-[11px] leading-4 text-foreground/80">{intent.reasons.join('；')}</p>
      )}
      {intent && (
        <div className="mt-1 flex flex-wrap gap-1">
          <span
            className={cn(
              'rounded-full px-1.5 py-px text-[10px]',
              intent.needsPlan ? 'bg-violet-500/10 text-violet-700' : 'bg-muted text-muted-foreground',
            )}
          >
            规划门 {intent.needsPlan ? '开' : '关'}
          </span>
          <span
            className={cn(
              'rounded-full px-1.5 py-px text-[10px]',
              intent.needsReview ? 'bg-sky-500/10 text-sky-700' : 'bg-muted text-muted-foreground',
            )}
          >
            评审门 {intent.needsReview ? '开' : '关'}
          </span>
        </div>
      )}
      {suggestion && (
        <p className="mt-1.5 flex items-start gap-1 rounded-md bg-amber-500/10 px-1.5 py-1 text-[10.5px] leading-4 text-amber-800">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
          本轮已改动 {suggestion.writes} 处、涉及 {suggestion.agents.length} 位成员：建议下一条消息先选「规划」对齐方案。
        </p>
      )}
    </div>
  )
}

function StepRow({
  step,
  plan,
  reviews,
  members,
}: {
  step: Plan['steps'][number]
  plan: Plan
  reviews: ReviewRecord[]
  members: Array<{ id: string; name: string }>
}): React.JSX.Element {
  const meta = STEP_META[step.status]
  const ownerId = step.ownerAgentId ?? plan.agentId
  const owner = members.find((m) => m.id === ownerId)
  const failed = reviews.find(
    (r) =>
      r.planId === plan.id &&
      r.verdict === 'fail' &&
      (r.stepId === step.id || r.target === `step:${step.id}` || r.target === `step:${plan.id}/${step.id}`),
  )
  return (
    <div className="rounded-md border bg-card px-2 py-1.5">
      <div className="flex items-start gap-1.5">
        <span className="mt-0.5 shrink-0 text-[11px]" title={meta.label}>
          {meta.icon}
        </span>
        <span className={cn('min-w-0 flex-1 text-[11.5px] leading-4', step.status === 'done' && 'text-muted-foreground line-through')}>
          {step.content}
        </span>
        {step.mode === 'review' && (
          <span className="shrink-0 rounded bg-sky-500/10 px-1 text-[9.5px] text-sky-700">评审</span>
        )}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-5 text-[10px] text-muted-foreground">
        <span title="负责人">{owner?.name ?? ownerId}</span>
        {step.acceptance && <span className="truncate" title={`验收：${step.acceptance}`}>验收：{step.acceptance}</span>}
        {step.note && <span className="text-amber-700">{step.note}</span>}
      </div>
      {failed && (
        <p className="mt-1 flex items-start gap-1 rounded bg-destructive/10 px-1.5 py-1 text-[10px] leading-4 text-destructive">
          <XCircle className="mt-0.5 size-3 shrink-0" />
          评审未通过：{failed.findings[0] ?? '见评审详情'}
        </p>
      )}
    </div>
  )
}

function PlanSection({
  plan,
  reviews,
  members,
  onResolve,
}: {
  plan: Plan
  reviews: ReviewRecord[]
  members: Array<{ id: string; name: string }>
  onResolve: (planId: string, decision: 'approve' | 'reject') => Promise<void>
}): React.JSX.Element {
  const [busy, setBusy] = React.useState(false)
  const [rejecting, setRejecting] = React.useState(false)
  const [feedback, setFeedback] = React.useState('')
  const meta = PLAN_STATUS_META[plan.status]
  const { done, total } = planProgress(plan)
  const pct = total === 0 ? 0 : Math.round((done / total) * 100)
  const author = members.find((m) => m.id === plan.agentId)

  const run = async (decision: 'approve' | 'reject'): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await onResolve(plan.id, decision)
      setRejecting(false)
      setFeedback('')
      toast(decision === 'approve' ? '已批准，开始执行' : '已驳回：作者将据反馈修订')
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-lg border bg-card shadow-soft">
      <header className="flex flex-wrap items-center gap-1.5 border-b px-2.5 py-1.5">
        <ClipboardList className="size-3.5 text-primary" />
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold" title={plan.title}>
          {plan.title}
        </span>
        {plan.version > 1 && <span className="text-[10px] text-muted-foreground">v{plan.version}</span>}
        <Badge variant={meta.variant}>{meta.label}</Badge>
      </header>

      <div className="px-2.5 py-1.5">
        <p className="text-[11px] leading-4 text-muted-foreground">{plan.goal}</p>
        <div className="mt-1 flex items-center gap-1.5">
          <span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-border">
            <span
              className={cn('absolute inset-y-0 left-0 rounded-full transition-all', plan.status === 'blocked' ? 'bg-destructive/70' : 'bg-emerald-500')}
              style={{ width: `${pct}%` }}
            />
          </span>
          <span className="text-[10px] tabular-nums text-muted-foreground">
            {done}/{total}
          </span>
         {author && <span className="text-[10px] text-muted-foreground">{author.name}</span>}
        </div>
      </div>

      <div className="space-y-1 px-2.5 pb-2">
        {plan.steps.map((step) => (
          <StepRow key={step.id} step={step} plan={plan} reviews={reviews} members={members} />
        ))}
      </div>

      {plan.risks.length > 0 && (
        <p className="px-2.5 pb-2 text-[10px] leading-4 text-amber-800/90">风险与依赖：{plan.risks.join('；')}</p>
      )}

      {plan.status === 'submitted' && (
        <div className="sticky bottom-0 space-y-1.5 border-t bg-card/95 px-2.5 py-1.5 backdrop-blur">
          {rejecting && (
            <textarea
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              rows={2}
              autoFocus
              placeholder="驳回反馈（可选；填写后作者会据反馈修订）…"
              className="block w-full resize-none rounded-md border bg-background px-2 py-1.5 text-[11px] leading-4 focus:border-primary/40 focus:outline-none"
            />
          )}
          <div className="flex items-center gap-1.5">
            {rejecting ? (
              <>
                <Button size="sm" variant="destructive" className="h-6 text-[11px]" disabled={busy} onClick={() => void run('reject')}>
                  确认驳回
                </Button>
                <Button size="sm" variant="outline" className="h-6 text-[11px]" disabled={busy} onClick={() => setRejecting(false)}>
                  取消
                </Button>
              </>
            ) : (
              <>
                <Button size="sm" className="h-6 text-[11px]" disabled={busy} onClick={() => void run('approve')}>
                  {busy ? <Loader2 className="size-3 animate-spin" /> : <CheckCircle2 className="size-3" />}
                  批准并执行
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 text-[11px]"
                  disabled={busy}
                  onClick={() => setRejecting(true)}
                >
                  <XCircle className="size-3" />
                  驳回
                </Button>
                <span className="ml-auto text-[9.5px] text-muted-foreground">批准后按步骤负责人派发</span>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

export function RunBoard(): React.JSX.Element {
  const currentId = useSessionStore((s) => s.currentId)
  const session = useCurrentSession()
  const agents = useAgentStore((s) => s.agents)
  const plans = usePlanStore((s) => s.plans)
  const reviews = usePlanStore((s) => s.reviews)
  const boundSessionId = usePlanStore((s) => s.sessionId)
  const load = usePlanStore((s) => s.load)
  const resolve = usePlanStore((s) => s.resolve)
  const active = useRunStore((s) => s.active)
  const intent = useRunStore((s) => s.intent)
  const planSuggestion = useRunStore((s) => s.planSuggestion)
  const approvals = useRunStore((s) => s.approvals)

  React.useEffect(() => {
    if (currentId) void load(currentId)
  }, [currentId, load])

  const bound = boundSessionId === currentId
  const livePlans = React.useMemo(
    () => (bound ? plans.filter((p) => p.status !== 'done' && p.status !== 'superseded') : []),
    [bound, plans],
  )
  const focusPlan = React.useMemo(
    () =>
      livePlans.find((p) => p.status === 'submitted') ??
      livePlans.find((p) => p.status === 'executing' || p.status === 'approved' || p.status === 'blocked') ??
      livePlans[0],
    [livePlans],
  )
  const members = React.useMemo(() => {
    if (!session) return []
    return session.participantIds.map((key) => ({ id: key, name: labelOfMemberKey(agents, session, key) }))
  }, [session, agents])

  const pendingApprovals = approvals.filter((a) => a.status === 'pending').length
  const failedReviews = focusPlan
    ? reviews.filter(
        (r) =>
          r.verdict === 'fail' && r.planId === focusPlan.id,
      ).length
    : 0
  const decisions = livePlans.filter((p) => p.status === 'submitted').length + pendingApprovals + failedReviews

  if (!currentId) {
    return <div className="flex h-full items-center justify-center text-[12.5px] text-muted-foreground">先选择一个会话</div>
  }

  const phase = phaseIndex(focusPlan, active)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-2 border-b px-3 py-2">
        <div className="flex items-center gap-1.5">
          <Hand className="size-3.5 text-primary" />
          <span className="text-[12px] font-semibold">运行</span>
          {active && <span className="text-[10.5px] text-primary">进行中</span>}
          {decisions > 0 && (
            <span className="ml-auto rounded-full bg-amber-500/15 px-1.5 py-px text-[10px] font-medium text-amber-700">
              {decisions} 项待决策
            </span>
          )}
          <button
            type="button"
            title="刷新计划与评审"
            className={cn('rounded p-0.5 text-muted-foreground hover:bg-accent/70', decisions === 0 && 'ml-auto')}
            onClick={() => void load(currentId)}
          >
            <RefreshCw className="size-3" />
          </button>
        </div>
        <PhaseBar active={phase} />
        <IntentCard intent={intent} suggestion={planSuggestion} />
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {livePlans.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
            <ShieldCheck className="size-6 text-muted-foreground/60" />
            <p className="text-[11.5px] text-muted-foreground">暂无进行中的计划</p>
            <p className="text-[10.5px] leading-4 text-muted-foreground/80">
              需要先拍板的需求会自动进入「规划 → 批准 → 执行」；也可以在消息上点按「派发下一棒」直接推进。
            </p>
          </div>
        ) : (
          livePlans.map((plan) => (
            <PlanSection
              key={plan.id}
              plan={plan}
              reviews={reviews}
              members={members}
              onResolve={(planId, decision) => resolve(planId, decision).then(() => undefined)}
            />
          ))
        )}

        {failedReviews > 0 && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-[11px] leading-4 text-destructive">
            <ShieldCheck className="mr-1 inline size-3" />
            有 {failedReviews} 条评审未通过：对应步骤已阻塞，修复后可重新推进。
          </div>
        )}
      </div>
    </div>
  )
}

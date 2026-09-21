/**
 * 定时任务面板（M35）：会话内定时任务的创建 / 启停 / 立即触发 / 删除。
 * - 数据：schedule-store（HTTP 快照 + WS notify:schedule-changed 实时归约）；
 * - 触发语义：run = 到点注入 @成员消息并启动协作；remind = 到点落事件条 + 提醒；
 * - 规格展示复用 shared.describeScheduleSpec（与服务端工具回灌同文案；时区取任务归一化结果）；
 * - 忙时跳过 / 错过补跑窗口 / 失败自动暂停等运行态由 lastStatus 徽章呈现。
 */
import * as React from 'react'
import { toast } from 'sonner'
import { BellRing, CalendarClock, Loader2, Pause, Play, Plus, RefreshCw, Trash2, Zap } from 'lucide-react'
import type { AgentDefinition, ScheduleLastStatus, ScheduledTask, ScheduleSpec } from '@multi-agent/shared'
import { describeScheduleSpec } from '@multi-agent/shared'
import { baseAgentId } from '@multi-agent/shared'
import { memberDisplayList, labelOfMemberKey } from '../../lib/members'
import { useAgentStore } from '../../stores/agent-store'
import { useScheduleStore } from '../../stores/schedule-store'
import { useSessionStore } from '../../stores/session-store'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Badge } from '../ui/badge'
import { AgentAvatar } from '../agents/AgentAvatar'

const LAST_META: Record<ScheduleLastStatus, { label: string; variant: 'success' | 'warning' | 'destructive' | 'outline' }> = {
  ok: { label: '上次成功', variant: 'success' },
  'skipped-busy': { label: '忙时跳过', variant: 'warning' },
  'skipped-missed': { label: '错过窗口', variant: 'warning' },
  error: { label: '上次失败', variant: 'destructive' },
  paused: { label: '已暂停', variant: 'outline' },
}

/** 常用调度预设（与服务端 minGapMs 5 分钟护栏兼容） */
const PRESETS: Array<{ label: string; expr: string }> = [
  { label: '每天 09:00', expr: '0 9 * * *' },
  { label: '工作日 09:00', expr: '0 9 * * 1-5' },
  { label: '每小时', expr: '0 * * * *' },
  { label: '每 30 分钟', expr: '*/30 * * * *' },
]

function browserTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** 距下次触发的人味化倒计时（next_run_at 为未来时刻） */
function untilText(iso?: string): string {
  if (!iso) return ''
  const diff = new Date(iso).getTime() - Date.now()
  if (!Number.isFinite(diff)) return ''
  if (diff <= 0) return '即将触发'
  const min = Math.round(diff / 60_000)
  if (min < 1) return '不到 1 分钟'
  if (min < 60) return `${min} 分钟后`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时后`
  return `${Math.floor(hour / 24)} 天后`
}

function fmtTime(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

/** 一次性任务的 datetime-local 默认值（明天此刻，本地时区） */
function defaultOnceAt(): string {
  const d = new Date(Date.now() + 24 * 3_600_000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 任务卡：规格 / 目标 / 下次触发 / 运行态 + 操作（立即执行 / 启停 / 删除） */
function ScheduleCard({ task }: { task: ScheduledTask }): React.JSX.Element {
  const agents = useAgentStore((s) => s.agents)
  const session = useSessionStore((s) => s.sessions.find((x) => x.id === s.currentId))
  const setEnabled = useScheduleStore((s) => s.setEnabled)
  const remove = useScheduleStore((s) => s.remove)
  const trigger = useScheduleStore((s) => s.runNow)
  const [busy, setBusy] = React.useState<string>()
  // M79-AF：只读共享（viewer）→ 触发 / 启停 / 删除全部只读（服务端另有写闸门兜底）
  const readOnly = session?.role === 'viewer'

  // M77：目标按成员实例署名（分身 = 名字·灵魂名；已离场也经回退链可读）；头像取基础角色
  const targetKey = task.targetAgentId
  const target = targetKey ? agents.find((a) => a.id === baseAgentId(targetKey)) : undefined
  const targetName = targetKey ? labelOfMemberKey(agents, session, targetKey) : undefined
  const last = task.lastStatus ? LAST_META[task.lastStatus] : undefined

  const onTrigger = async (): Promise<void> => {
    if (busy || readOnly) return
    setBusy('run')
    try {
      const res = await trigger(task.id)
      if (res.runId) toast('已触发协作运行')
      else if (res.skipped === 'busy') toast('会话正忙，本次已跳过')
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(undefined)
    }
  }

  const onToggle = async (): Promise<void> => {
    if (busy || readOnly) return
    setBusy('toggle')
    try {
      await setEnabled(task.id, !task.enabled)
      toast(task.enabled ? '已暂停定时任务' : '已恢复定时任务')
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(undefined)
    }
  }

  const onRemove = async (): Promise<void> => {
    if (busy || readOnly) return
    if (!window.confirm(`删除定时任务「${task.title}」？`)) return
    setBusy('remove')
    try {
      await remove(task.id)
      toast('已删除定时任务')
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <div className={cn('rounded-lg border bg-card px-2.5 py-2 shadow-soft', !task.enabled && 'opacity-70')}>
      <div className="flex flex-wrap items-center gap-1.5">
        {task.kind === 'run' ? (
          <Zap className="size-3.5 shrink-0 text-primary" />
        ) : (
          <BellRing className="size-3.5 shrink-0 text-amber-600" />
        )}
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold" title={task.title}>
          {task.title}
        </span>
        <Badge variant={task.kind === 'run' ? 'default' : 'secondary'} className="px-1 py-0 text-[9.5px]">
          {task.kind === 'run' ? '运行' : '提醒'}
        </Badge>
        {!task.enabled && (
          <Badge variant="outline" className="px-1 py-0 text-[9.5px]">
            已暂停
          </Badge>
        )}
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10.5px] text-muted-foreground">
        {task.kind === 'run' && (
          <span className="flex items-center gap-1">
            {target && <AgentAvatar agent={target} size={12} animated={false} />}
            {targetName ?? task.targetAgentId ?? '未指定'}
          </span>
        )}
        <span title={`${task.spec.kind === 'cron' ? `cron「${task.spec.expr ?? ''}」` : String(task.spec.at ?? '')}（${task.timezone}）`}>
          {describeScheduleSpec(task.spec, { tz: task.timezone })}
        </span>
        <span className="text-muted-foreground/60">·</span>
        <span>{task.timezone}</span>
      </div>

      <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[10.5px] text-muted-foreground">
        {task.enabled && task.nextRunAt ? (
          <span title={`下次触发：${fmtTime(task.nextRunAt)}`}>下次：{untilText(task.nextRunAt)}（{fmtTime(task.nextRunAt)}）</span>
        ) : (
          <span>不再触发</span>
        )}
        {last && (
          <Badge variant={last.variant} className="px-1 py-0 text-[9.5px]" title={task.lastError}>
            {last.label}
          </Badge>
        )}
        {task.runCount > 0 && <span className="tabular-nums">已触发 {task.runCount} 次</span>}
        {task.failStreak > 0 && <span className="text-destructive">连续失败 {task.failStreak}</span>}
      </div>
      {task.lastError && task.lastStatus !== 'ok' && (
        <p className="mt-0.5 truncate text-[10px] text-destructive/80" title={task.lastError}>
          {task.lastError}
        </p>
      )}

      <div className="mt-1.5 flex items-center gap-1 border-t pt-1.5">
        <Button
          variant="outline"
          size="sm"
          className="h-6 gap-1 px-2 text-[11px]"
          disabled={!!busy || readOnly}
          title={readOnly ? '只读共享（viewer）：无操作权限' : '立即触发一次（不改变调度节奏；会话忙时报错）'}
          onClick={() => void onTrigger()}
        >
          {busy === 'run' ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
          立即执行
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-6 gap-1 px-2 text-[11px]"
          disabled={!!busy || readOnly}
          title={readOnly ? '只读共享（viewer）：无操作权限' : undefined}
          onClick={() => void onToggle()}
        >
          {busy === 'toggle' ? (
            <Loader2 className="size-3 animate-spin" />
          ) : task.enabled ? (
            <Pause className="size-3" />
          ) : (
            <Play className="size-3" />
          )}
          {task.enabled ? '暂停' : '恢复'}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto text-muted-foreground hover:text-destructive"
          disabled={!!busy || readOnly}
          title={readOnly ? '只读共享（viewer）：无操作权限' : '删除任务'}
          onClick={() => void onRemove()}
        >
          {busy === 'remove' ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
        </Button>
      </div>
    </div>
  )
}

/** 创建表单（内联折叠）：标题 / 类型 / 目标成员 / 指令 / 调度规格（预设 + cron 或一次性时刻） */
function CreateForm({ members, onClose }: { members: AgentDefinition[]; onClose: () => void }): React.JSX.Element {
  const create = useScheduleStore((s) => s.create)
  const [title, setTitle] = React.useState('')
  const [kind, setKind] = React.useState<'run' | 'remind'>('run')
  const [targetAgentId, setTargetAgentId] = React.useState(members[0]?.id ?? '')
  const [instruction, setInstruction] = React.useState('')
  const [scheduleMode, setScheduleMode] = React.useState<'cron' | 'once'>('cron')
  const [cronExpr, setCronExpr] = React.useState('0 9 * * *')
  const [onceAt, setOnceAt] = React.useState(defaultOnceAt())
  const [saving, setSaving] = React.useState(false)

  const submit = async (): Promise<void> => {
    if (saving) return
    if (!title.trim()) {
      toast.error('请填写任务标题')
      return
    }
    if (!instruction.trim()) {
      toast.error('请填写任务指令')
      return
    }
    if (kind === 'run' && !targetAgentId) {
      toast.error('请选择目标成员')
      return
    }
    let spec: ScheduleSpec
    if (scheduleMode === 'cron') {
      if (!cronExpr.trim()) {
        toast.error('请填写 cron 表达式（分 时 日 月 周）')
        return
      }
      spec = { kind: 'cron', expr: cronExpr.trim(), tz: browserTz() }
    } else {
      const t = new Date(onceAt)
      if (!onceAt || Number.isNaN(t.getTime())) {
        toast.error('请选择有效的触发时刻')
        return
      }
      spec = { kind: 'once', at: t.toISOString() }
    }
    setSaving(true)
    try {
      await create({
        title: title.trim(),
        kind,
        instruction: instruction.trim(),
        targetAgentId: kind === 'run' ? targetAgentId : undefined,
        spec,
      })
      toast('已创建定时任务')
      onClose()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-2 border-b bg-muted/20 px-3 py-2.5">
      <div className="flex items-center gap-1.5">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="任务标题（如：每日晨会简报）"
          className="h-7 min-w-0 flex-1 rounded-md border bg-background px-2 text-[12px] focus:border-primary/40 focus:outline-none"
        />
        <span className="flex shrink-0 overflow-hidden rounded-full border text-[10.5px]">
          <button
            type="button"
            onClick={() => setKind('run')}
            className={cn('px-1.5 py-0.5 transition-colors', kind === 'run' ? 'bg-primary/10 font-medium text-primary' : 'hover:text-foreground')}
            title="到点注入 @成员 消息并启动协作运行"
          >
            运行
          </button>
          <button
            type="button"
            onClick={() => setKind('remind')}
            className={cn('border-l px-1.5 py-0.5 transition-colors', kind === 'remind' ? 'bg-primary/10 font-medium text-primary' : 'hover:text-foreground')}
            title="到点仅提醒（事件条 + 通知），不启动运行"
          >
            提醒
          </button>
        </span>
      </div>

      {kind === 'run' && (
        <div className="flex items-center gap-1.5">
          <span className="shrink-0 text-[11px] text-muted-foreground">目标成员</span>
          <select
            value={targetAgentId}
            onChange={(e) => setTargetAgentId(e.target.value)}
            className="h-7 min-w-0 flex-1 rounded-md border bg-background px-1.5 text-[12px] focus:border-primary/40 focus:outline-none"
          >
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <textarea
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        rows={2}
        placeholder={kind === 'run' ? '指令内容（到点后作为 @成员的协作指令）' : '提醒内容'}
        className="block w-full resize-none rounded-md border bg-background px-2 py-1 text-[12px] leading-5 focus:border-primary/40 focus:outline-none"
      />

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="flex shrink-0 overflow-hidden rounded-full border text-[10.5px]">
          <button
            type="button"
            onClick={() => setScheduleMode('cron')}
            className={cn('px-1.5 py-0.5 transition-colors', scheduleMode === 'cron' ? 'bg-primary/10 font-medium text-primary' : 'hover:text-foreground')}
          >
            循环
          </button>
          <button
            type="button"
            onClick={() => setScheduleMode('once')}
            className={cn('border-l px-1.5 py-0.5 transition-colors', scheduleMode === 'once' ? 'bg-primary/10 font-medium text-primary' : 'hover:text-foreground')}
          >
            一次性
          </button>
        </span>
        {scheduleMode === 'cron' ? (
          <input
            value={cronExpr}
            onChange={(e) => setCronExpr(e.target.value)}
            placeholder="分 时 日 月 周（如 0 9 * * 1-5）"
            className="h-7 min-w-0 flex-1 rounded-md border bg-background px-2 font-mono text-[11.5px] focus:border-primary/40 focus:outline-none"
          />
        ) : (
          <input
            type="datetime-local"
            value={onceAt}
            onChange={(e) => setOnceAt(e.target.value)}
            className="h-7 min-w-0 flex-1 rounded-md border bg-background px-2 text-[11.5px] focus:border-primary/40 focus:outline-none"
          />
        )}
      </div>

      {scheduleMode === 'cron' && (
        <div className="flex flex-wrap gap-1">
          {PRESETS.map((p) => (
            <button
              key={p.expr}
              type="button"
              onClick={() => setCronExpr(p.expr)}
              className={cn(
                'rounded-full border px-1.5 py-0.5 text-[10.5px] transition-colors',
                cronExpr === p.expr ? 'border-primary/40 bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:border-primary/30 hover:text-foreground',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center gap-1.5">
        <Button size="sm" className="h-6 px-2 text-[11px]" disabled={saving} onClick={() => void submit()}>
          {saving && <Loader2 className="size-3 animate-spin" />}
          创建
        </Button>
        <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" disabled={saving} onClick={onClose}>
          取消
        </Button>
        <span className="ml-auto truncate text-[10px] text-muted-foreground/80" title={browserTz()}>
          时区：{browserTz()}
        </span>
      </div>
    </div>
  )
}

export function SchedulePanel(): React.JSX.Element {
  const currentId = useSessionStore((s) => s.currentId)
  const session = useSessionStore((s) => s.sessions.find((x) => x.id === s.currentId))
  const agents = useAgentStore((s) => s.agents)
  const tasks = useScheduleStore((s) => s.tasks)
  const boundSessionId = useScheduleStore((s) => s.sessionId)
  const loading = useScheduleStore((s) => s.loading)
  const load = useScheduleStore((s) => s.load)
  const [creating, setCreating] = React.useState(false)

  React.useEffect(() => {
    if (currentId) void load(currentId)
  }, [currentId, load])

  // M77：成员实例投影（id = 成员键、name = 展示标签）+ 幽灵补位（历史定时任务的目标/创建者已离场时仍可读）
  const members = React.useMemo(
    () =>
      memberDisplayList(
        agents,
        session,
        tasks.flatMap((t) => [t.targetAgentId, t.createdBy === 'user' ? undefined : t.createdBy]),
      ),
    [session, agents, tasks],
  )

  if (!currentId) {
    return <div className="flex h-full items-center justify-center text-[12.5px] text-muted-foreground">先选择一个会话</div>
  }

  const list = boundSessionId === currentId ? tasks : []
  const enabledCount = list.filter((t) => t.enabled).length
  // M79-AF：只读共享（viewer）→ 不可新建（服务端另有写闸门兜底）
  const readOnly = session?.role === 'viewer'

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2 text-[11.5px] text-muted-foreground">
        <CalendarClock className="size-3.5" />
        <span>
          定时 {enabledCount}/{list.length}
        </span>
        <Button
          variant={creating ? 'secondary' : 'ghost'}
          size="sm"
          className="ml-auto h-6 gap-1 px-2 text-[11px]"
          disabled={readOnly}
          title={readOnly ? '只读共享（viewer）：无操作权限' : '新建定时任务'}
          onClick={() => setCreating((v) => !v)}
        >
          <Plus className="size-3" />
          新建
        </Button>
        <Button variant="ghost" size="icon-sm" title="刷新定时任务" disabled={loading} onClick={() => void load(currentId)}>
          {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
        </Button>
      </div>

      {creating && <CreateForm members={members} onClose={() => setCreating(false)} />}

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {list.length === 0 ? (
          <div className="px-3 py-10 text-center text-[12px] leading-5 text-muted-foreground">
            <CalendarClock className="mx-auto mb-2 size-6 opacity-50" />
            暂无定时任务
            <br />
            可手动创建，或让成员调用 schedule_task 工具设定
          </div>
        ) : (
          <div className="space-y-2">
            {list.map((task) => (
              <ScheduleCard key={task.id} task={task} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

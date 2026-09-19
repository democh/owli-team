/**
 * Trace 抽屉（M9）：指定 Run 的全链路时间轴，让「一轮协作发生了什么」可回看。
 * - 数据源：GET /api/runs/:id/trace（run 元信息 + run_events 时间序 + usage 汇总）；
 * - 展示：回合开始/结束（耗时 / token / 队列）、工具调用（名称 / 成败 / 耗时 / 摘要）、
 *   压缩事件（前后 token / 降级标记）、调度决策（丢弃理由 / 交还用户 / 循环抑制）、
 *   平台路由事件（M48：召集 / 派发 / 降级）；
 * - 入口：ContextBar「轨迹」按钮（ui-store.traceRunId 控制开关）。
 * - 覆盖：全部 run_events 事件类型的中文渲染（波次 / 队列更新 / 记忆召回·沉淀·入库 / 工具检索 /
 *   正文净化 / 交付核查 / 计划提交·派发·完成）；schedule.accepted 兼容新旧两种载荷
 *   （字符串数组 / {agentId, accepted[]}），交还用户哨兵 'user' 统一显示为「用户」。
 * - 样式：头部（标题 + 徽标）固定并带分隔线，刷新与右上角「关闭」同行顶对齐，内容区独立滚动（长轨迹不再整体撑高弹窗）；
 *   空态收口为「图标 + 文案（+ 提示）」的居中小块——「取不到记录」（Run 已清理 / 请求失败）
 *   与「本次运行尚无事件」分开归因，不再统一显示成一行灰字漂在空白里。
 */
import * as React from 'react'
import {
  Activity,
  Brain,
  ClipboardCheck,
  ClipboardList,
  Eraser,
  Flag,
  ListOrdered,
  Loader2,
  Play,
  RefreshCw,
  Route,
  Search,
  Shrink,
  Square,
  TriangleAlert,
  UserPlus,
  Users,
  Wrench,
} from 'lucide-react'
import type { TraceEntry } from '@multi-agent/shared'
import { apiGet } from '../../lib/api'
import { useAgentStore } from '../../stores/agent-store'
import { useUiStore } from '../../stores/ui-store'
import { cn } from '../../lib/utils'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'

interface TraceResponse {
  run: { id: string; state?: string; error?: string | null; turnIndex?: number } | null
  events: TraceEntry[]
  usage: { promptTokens: number; completionTokens: number; costUsd: number } | null
}

interface RenderedEvent {
  key: string
  icon: React.JSX.Element
  tone: string
  title: string
  detail?: string
  atMs?: number
}

function dropReason(d: unknown): string | undefined {
  if (!d || typeof d !== 'object') return undefined
  const rec = d as { id?: unknown; reason?: unknown }
  const id = typeof rec.id === 'string' ? rec.id : undefined
  const reason = typeof rec.reason === 'string' ? rec.reason : undefined
  if (!id) return undefined
  const label = reason === 'not-in-room' ? '不在场' : reason === 'self-continuous' ? '自我连续' : reason === 'duplicate' ? '重复委派' : reason
  return `${id}（${label}）`
}

/** 交还用户的哨兵 id（accepted / queue 中可能出现）：轨迹里统一显示为「用户」 */
function personName(id: string, nameOf: (id: string) => string): string {
  return id === 'user' ? '用户' : nameOf(id)
}

const MEMORY_SCOPE_LABEL: Record<string, string> = { session: '会话', agent: '成员', project: '项目', global: '全局' }
const TURN_MODE_LABEL: Record<string, string> = { plan: '规划', review: '评审' }

function renderEvent(entry: TraceEntry, nameOf: (id: string) => string, startedAt: number): RenderedEvent {
  const p = entry.payload
  const key = String(entry.id)
  const atMs = Number.isFinite(Date.parse(entry.ts)) ? Date.parse(entry.ts) - startedAt : undefined
  switch (entry.type) {
    case 'run:start': {
      const queue = Array.isArray(p.queue) ? (p.queue as string[]).map(nameOf) : []
      return {
        key,
        icon: <Play className="size-3.5" />,
        tone: 'text-primary',
        title: `运行开始 · 队列：${queue.join(' → ') || '—'}`,
        detail: typeof p.regenerateMessageId === 'string' ? `重新生成消息 ${p.regenerateMessageId}` : undefined,
        atMs,
      }
    }
    case 'run:end': {
      const error = typeof p.error === 'string' && p.error ? ` · ${p.error}` : ''
      return {
        key,
        icon: <Flag className="size-3.5" />,
        tone: 'text-primary',
        title: `运行结束 · ${String(p.reason ?? '?')} · 共 ${String(p.turns ?? '?')} 回合`,
        detail: error || undefined,
        atMs,
      }
    }
    case 'turn:start':
      return {
        key,
        icon: <Loader2 className="size-3.5" />,
        tone: 'text-muted-foreground',
        title: `回合 ${entry.turnIndex + 1} 开始 · ${nameOf(String(p.agentId ?? ''))}`,
        atMs,
      }
    case 'turn:end': {
      const pt = Number(p.promptTokens ?? 0)
      const ct = Number(p.completionTokens ?? 0)
      const queue = Array.isArray(p.queue) ? (p.queue as string[]).map(nameOf) : []
      const status = String(p.status ?? '')
      const statusLabel =
        status === 'stopped' ? ' · 已中断' : status === 'timeout' ? ' · 已超时' : status === 'error' ? ' · 出错' : ''
      return {
        key,
        icon: <Square className="size-3" />,
        tone:
          status === 'error' || status === 'timeout'
            ? 'text-rose-600'
            : status === 'stopped'
              ? 'text-amber-600'
              : 'text-emerald-600',
        title: `回合 ${entry.turnIndex + 1} 结束 · ${nameOf(String(p.agentId ?? ''))} · ${String(p.durationMs ?? '?')}ms${statusLabel}`,
        detail: `token ${pt}+${ct}${queue.length > 0 ? ` · 下一棒：${queue.join('、')}` : ''}`,
        atMs,
      }
    }
    case 'tool': {
      const ok = p.ok === true
      const aborted = p.aborted === true
      const summary = typeof p.summary === 'string' ? p.summary : undefined
      return {
        key,
        icon: <Wrench className="size-3.5" />,
        tone: ok ? 'text-violet-600' : aborted ? 'text-amber-600' : 'text-rose-600',
        title: `工具 ${String(p.name ?? '?')} · ${aborted ? '已中断' : ok ? '成功' : '失败'} · ${String(p.durationMs ?? '?')}ms`,
        detail: summary,
        atMs,
      }
    }
    case 'compression': {
      const degraded = p.degraded === true
      return {
        key,
        icon: <Shrink className="size-3.5" />,
        tone: degraded ? 'text-amber-600' : 'text-sky-600',
        title: `上下文压缩${degraded ? '（降级）' : ''} · ${Number(p.beforeTokens ?? 0).toLocaleString()} → ${Number(
          p.afterTokens ?? 0,
        ).toLocaleString()} tokens`,
        detail: `摘要水位 untilSeq=${String(p.untilSeq ?? '?')}`,
        atMs,
      }
    }
    case 'schedule': {
      const dropped = Array.isArray(p.dropped) ? (p.dropped as unknown[]).map(dropReason).filter(Boolean) : []
      // accepted 兼容两种载荷：新版 = 波末合并 [{agentId, accepted[]}]；旧版 = {agentId, accepted: string[]}
      const pairs: Array<{ from?: string; to: string[] }> = []
      if (Array.isArray(p.accepted)) {
        for (const item of p.accepted as unknown[]) {
          if (typeof item === 'string') {
            pairs.push({ from: typeof p.agentId === 'string' ? p.agentId : undefined, to: [item] })
          } else if (item && typeof item === 'object') {
            const rec = item as { agentId?: unknown; accepted?: unknown }
            pairs.push({
              from: typeof rec.agentId === 'string' ? rec.agentId : undefined,
              to: Array.isArray(rec.accepted)
                ? (rec.accepted as unknown[]).filter((x): x is string => typeof x === 'string')
                : [],
            })
          }
        }
      }
      const toText = (ids: string[]): string =>
        ids.length > 0 ? ids.map((id) => personName(id, nameOf)).join('、') : '（无）'
      const hop = (x: { from?: string; to: string[] }): string =>
        x.from ? `${personName(x.from, nameOf)} → ${toText(x.to)}` : toText(x.to)
      const flags = [
        p.handedToUser === true ? '交还用户' : '',
        p.loopSuppressed === true ? '循环抑制' : '',
        p.stallSuppressed === true ? '停滞抑制' : '',
        p.fallbackUsed === true ? '文本回退' : '',
      ].filter(Boolean)
      const source = typeof p.source === 'string' ? `来源 ${p.source === 'tool' ? 'handoff 工具' : '文本提及'}` : ''
      return {
        key,
        icon: <Route className="size-3.5" />,
        tone: 'text-slate-500',
        title: `调度 · ${
          pairs.length > 0
            ? pairs.map(hop).join('；')
            : hop({ from: typeof p.agentId === 'string' ? p.agentId : undefined, to: [] })
        }`,
        detail:
          [
            source,
            dropped.length > 0 ? `丢弃 ${dropped.join(' ')}` : '',
            flags.join(' · '),
          ]
            .filter(Boolean)
            .join(' · ') || undefined,
        atMs,
      }
    }
    case 'routing:dispatched': {
      // 降级：路由失败，在场首位接手
      if (p.fallback === true) {
        return {
          key,
          icon: <Route className="size-3.5" />,
          tone: 'text-amber-600',
          title: '平台路由降级 · 在场成员接手',
          detail: typeof p.error === 'string' && p.error ? `原因：${p.error}` : undefined,
          atMs,
        }
      }
      // 召集：路由或成员转交触发的新成员加入
      if (Array.isArray(p.members)) {
        const names = (p.members as string[]).map(nameOf)
        const reason = typeof p.reason === 'string' && p.reason ? `理由：${p.reason}` : ''
        return {
          key,
          icon: <UserPlus className="size-3.5" />,
          tone: 'text-indigo-600',
          title: names.length > 0 ? `平台召集 · ${names.join('、')}` : '平台召集 · 无新增成员（均已在场）',
          detail:
            [`来源 ${p.source === 'handoff' ? '成员转交触发' : '需求路由'}`, reason].filter(Boolean).join(' · ') ||
            undefined,
          atMs,
        }
      }
      // 派发：未 @ 消息的路由结果（任务便条分派给在场成员）
      const assigned = Array.isArray(p.assignments) ? (p.assignments as { agentId?: unknown }[]) : []
      const names = assigned.map((a) => nameOf(String(a.agentId ?? ''))).filter(Boolean)
      const reason = typeof p.reason === 'string' && p.reason ? `理由：${p.reason}` : ''
      return {
        key,
        icon: <Route className="size-3.5" />,
        tone: 'text-sky-600',
        title: names.length > 0 ? `平台派发 · ${names.join('、')}` : '平台派发 · 无合适成员',
        detail: reason || undefined,
        atMs,
      }
    }
    case 'wave:start': {
      const members = Array.isArray(p.members) ? (p.members as string[]).map((id) => personName(id, nameOf)) : []
      const mode = typeof p.mode === 'string' ? TURN_MODE_LABEL[p.mode] ?? p.mode : ''
      return {
        key,
        icon: <Users className="size-3.5" />,
        tone: 'text-teal-600',
        title: `波次 ${entry.turnIndex + 1} 开始 · ${members.join('、') || '—'}`,
        detail: [p.parallel === true ? '并行' : '', mode ? `模式：${mode}` : ''].filter(Boolean).join(' · ') || undefined,
        atMs,
      }
    }
    case 'queue:updated': {
      const queue = Array.isArray(p.queue) ? (p.queue as string[]).map((id) => personName(id, nameOf)) : []
      return {
        key,
        icon: <ListOrdered className="size-3.5" />,
        tone: 'text-muted-foreground',
        title: queue.length > 0 ? `队列更新 · ${queue.join(' → ')}` : '队列更新 · 已清空',
        atMs,
      }
    }
    case 'tool:search': {
      const activated = Array.isArray(p.activated)
        ? (p.activated as unknown[]).filter((x): x is string => typeof x === 'string')
        : []
      return {
        key,
        icon: <Search className="size-3.5" />,
        tone: 'text-cyan-600',
        title: `工具检索 · ${personName(String(p.agentId ?? ''), nameOf) || '—'}「${String(p.query ?? '')}」`,
        detail: activated.length > 0 ? `激活 ${activated.join('、')}` : '无命中',
        atMs,
      }
    }
    case 'memory:recall': {
      const count = Number(p.count ?? (Array.isArray(p.items) ? p.items.length : 0))
      const items = Array.isArray(p.items) ? (p.items as { scope?: unknown; score?: unknown }[]) : []
      const best = items.reduce((max, item) => Math.max(max, Number(item.score ?? 0)), 0)
      const scopes = [
        ...new Set(
          items
            .map((item) => (typeof item.scope === 'string' ? MEMORY_SCOPE_LABEL[item.scope] ?? item.scope : ''))
            .filter(Boolean),
        ),
      ]
      return {
        key,
        icon: <Brain className="size-3.5" />,
        tone: 'text-fuchsia-600',
        title: `记忆召回 · ${count} 条`,
        detail:
          [best > 0 ? `最高分 ${best.toFixed(2)}` : '', scopes.length > 0 ? `来源 ${scopes.join('、')}` : '']
            .filter(Boolean)
            .join(' · ') || undefined,
        atMs,
      }
    }
    case 'memory:digest':
      return {
        key,
        icon: <Brain className="size-3.5" />,
        tone: 'text-fuchsia-600',
        title: `记忆沉淀 · 候选 ${Number(p.candidates ?? 0)} · 入库 ${Number(p.added ?? 0)}`,
        atMs,
      }
    case 'memory:embed':
      return {
        key,
        icon: <Brain className="size-3.5" />,
        tone: 'text-fuchsia-600',
        title: `记忆入库 · ${p.queued === true ? '已排队' : '—'}`,
        atMs,
      }
    case 'content:sanitized':
      return {
        key,
        icon: <Eraser className="size-3.5" />,
        tone: 'text-muted-foreground',
        title: `正文净化 · ${Number(p.beforeChars ?? 0).toLocaleString()} → ${Number(p.afterChars ?? 0).toLocaleString()} 字符`,
        atMs,
      }
    case 'delivery:unverified': {
      const files = Array.isArray(p.files)
        ? (p.files as unknown[]).filter((x): x is string => typeof x === 'string')
        : []
      return {
        key,
        icon: <TriangleAlert className="size-3.5" />,
        tone: 'text-rose-600',
        title: `交付核查 · ${files.length} 项落盘声明无对应写入`,
        detail: files.join('、') || undefined,
        atMs,
      }
    }
    case 'plan:submitted':
      return {
        key,
        icon: <ClipboardList className="size-3.5" />,
        tone: 'text-purple-600',
        title: `计划提交 · ${typeof p.title === 'string' ? p.title : '—'}`,
        detail: `v${Number(p.version ?? 1)} · ${Number(p.steps ?? 0)} 步`,
        atMs,
      }
    case 'plan:dispatched': {
      const owners = Array.isArray(p.owners) ? (p.owners as string[]).map((id) => personName(id, nameOf)) : []
      return {
        key,
        icon: <ClipboardCheck className="size-3.5" />,
        tone: 'text-purple-600',
        title: `计划派发 · ${owners.join('、') || '—'}`,
        atMs,
      }
    }
    case 'plan:done':
      return {
        key,
        icon: <ClipboardCheck className="size-3.5" />,
        tone: 'text-purple-600',
        title: `计划完成 · 收口回合：${personName(String(p.synthesisAgent ?? ''), nameOf) || '—'}`,
        atMs,
      }
    default:
      return { key, icon: <Route className="size-3.5" />, tone: 'text-muted-foreground', title: entry.type, atMs }
  }
}

export function TraceDrawer(): React.JSX.Element | null {
  const runId = useUiStore((s) => s.traceRunId)
  const closeTrace = useUiStore((s) => s.closeTrace)
  const agents = useAgentStore((s) => s.agents)
  const [data, setData] = React.useState<TraceResponse | null>(null)
  const [loading, setLoading] = React.useState(false)
  /** 取数失败（Run 已被清理 / 请求失败）：空态按「取不到记录」归因，不冒充「暂无事件」 */
  const [loadError, setLoadError] = React.useState(false)

  const load = React.useCallback(async (): Promise<void> => {
    const id = useUiStore.getState().traceRunId
    if (!id) return
    setLoading(true)
    setLoadError(false)
    try {
      const res = await apiGet<TraceResponse>(`/api/runs/${id}/trace`)
      if (useUiStore.getState().traceRunId === id) setData(res)
    } catch {
      // Run 不存在（已被清理）等：空态 + 失败归因
      if (useUiStore.getState().traceRunId === id) {
        setData(null)
        setLoadError(true)
      }
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    setData(null)
    setLoadError(false)
    if (runId) void load()
  }, [runId, load])

  const nameOf = React.useCallback(
    (id: string): string => agents.find((a) => a.id === id)?.name ?? id,
    [agents],
  )
  const events = React.useMemo(() => data?.events ?? [], [data])
  const startedAt = events.length > 0 ? Date.parse(events[0].ts) : 0
  const rendered = React.useMemo(
    () => events.map((e) => renderEvent(e, nameOf, startedAt)),
    [events, nameOf, startedAt],
  )
  const turns = events.filter((e) => e.type === 'turn:end').length
  const usage = data?.usage

  return (
    <Dialog open={!!runId} onOpenChange={(v) => !v && closeTrace()}>
      <DialogContent className="flex max-h-[80vh] max-w-2xl flex-col">
        {/* 头部固定 + 分隔线；-mx-5/px-5 让分隔线通到弹窗内缘 */}
        <DialogHeader className="-mx-5 shrink-0 border-b px-5 pb-3">
          <DialogTitle className="flex items-center gap-2">
            运行轨迹
            {data?.run?.state && <Badge variant="outline">{data.run.state}</Badge>}
          </DialogTitle>
          <DialogDescription>
            {runId ? `Run ${runId}` : ''}
            {usage
              ? ` · 回合 ${turns} · token ${usage.promptTokens.toLocaleString()}+${usage.completionTokens.toLocaleString()} · 费用 $${usage.costUsd.toFixed(4)}`
              : ''}
          </DialogDescription>
        </DialogHeader>

        {/* 刷新：与右上角「关闭」（ui/dialog.tsx：right-3/top-3）同行顶对齐，不再落标题行里造成错位 */}
        <Button
          variant="ghost"
          size="icon-sm"
          className="absolute right-12 top-3"
          title="刷新"
          disabled={loading}
          onClick={() => void load()}
        >
          {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
        </Button>

        <div className="min-h-0 flex-1 overflow-y-auto pt-3 pr-1">
          {data?.run?.error && (
            <div className="mb-2 rounded-md border border-rose-500/30 bg-rose-500/5 px-2.5 py-1.5 text-[11.5px] text-rose-700">
              错误：{data.run.error}
            </div>
          )}
          {rendered.length === 0 && loading && (
            <div className="flex items-center justify-center gap-2 py-6 text-[12px] text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              载入中…
            </div>
          )}
          {rendered.length === 0 && !loading && (
            <div className="flex flex-col items-center gap-1.5 px-4 py-6 text-center">
              {loadError ? (
                <>
                  <TriangleAlert className="size-[18px] text-muted-foreground/55" aria-hidden />
                  <p className="text-[12.5px] text-muted-foreground">未找到该运行的轨迹记录</p>
                  <p className="text-[11px] leading-relaxed text-muted-foreground/75">可能已被清理；点右上「刷新」重试</p>
                </>
              ) : (
                <>
                  <Activity className="size-[18px] text-muted-foreground/55" aria-hidden />
                  <p className="text-[12.5px] text-muted-foreground">暂无轨迹事件（运行开始后逐步产生）</p>
                </>
              )}
            </div>
          )}
          <ol className="space-y-0">
            {rendered.map((e, i) => (
              <li key={e.key} className="relative flex gap-2.5 pb-3">
                {i < rendered.length - 1 && (
                  <span className="absolute bottom-0 left-[7px] top-4 w-px bg-border" aria-hidden />
                )}
                <span className={cn('relative z-10 mt-0.5 shrink-0 bg-background', e.tone)}>{e.icon}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] font-medium leading-5">{e.title}</div>
                  {e.detail && <div className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{e.detail}</div>}
                </div>
                {e.atMs !== undefined && (
                  <span className="shrink-0 pt-0.5 text-[10.5px] tabular-nums text-muted-foreground">
                    +{Math.max(0, Math.round(e.atMs / 100) / 10)}s
                  </span>
                )}
              </li>
            ))}
          </ol>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * 消息条目（M8 性能）：项级订阅 —— 只接收 messageId，内容从 store 按 id 取（O(1)）；
 * React.memo 隔离无关消息更新；流式内容渲染层 150ms 节流（数据层仍为 40ms 合并）。
 * 用户（右对齐卡片 + 点名头像条，自身不带头像）/ 成员（头像 + 姓名 + Markdown + 工具卡 + 交付明细行 + 交接卡）。
 * 支持 #msg-<id> 锚点与定位闪光（右侧接力视图点击跳转）。
 */
import * as React from 'react'
import { toast } from 'sonner'
import { Brain, Calculator, ChevronDown, ClipboardList, Clock, Loader2, SearchCheck } from 'lucide-react'
import { apiPatch, apiPost } from '../../lib/api'
import { baseAgentId } from '@multi-agent/shared'
import { labelOfMemberKey } from '../../lib/members'
import { useAgentStore } from '../../stores/agent-store'
import { useAuthStore } from '../../stores/auth-store'
import { usePlanStore } from '../../stores/plan-store'
import { useRunStore } from '../../stores/run-store'
import { useSessionStore } from '../../stores/session-store'
import { useUiStore } from '../../stores/ui-store'
import { useThrottledValue } from '../../lib/hooks'
import { calcExpressionOf } from '../../lib/calc-badge'
import { formatClock } from '../../lib/time'
import { cn } from '../../lib/utils'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { AgentAvatar } from '../agents/AgentAvatar'
import { HumanAvatar } from './HumanAvatar'
import { Markdown } from './Markdown'
import { DeliveryFiles } from './DeliveryList'
import { ChangeCard, isChangeMessage } from './ChangeCard'
import { MessageActions } from './MessageActions'
import { MessageAttachments } from './MessageAttachments'
import { ToolCallsPanel } from './ToolCard'
import { MessageContext, type MdMessageInfo } from './md-ext/message-context'
import { ReviewVerdictBadge, ReviewVerdictCard } from './ReviewVerdictCard'
import { HandoffBar, SystemMessage } from './SystemEvent'

/** 流式消息渲染节流间隔（与数据层 40ms delta 合并职责分离） */
const STREAM_THROTTLE_MS = 150
/** 入场动画窗口：更早的消息在虚拟列表里重新挂载时不重放动画 */
const ANIMATE_WINDOW_MS = 60_000

/** M35：定时任务来源徽章（到点注入的用户消息；来源可见、可溯源） */
function ScheduleBadge(): React.JSX.Element {
  return (
    <span
      className="inline-flex items-center gap-0.5 rounded-full bg-teal-500/10 px-1.5 py-px text-[10px] font-medium text-teal-600"
      title="本条消息由定时任务自动注入（到点触发）"
    >
      <Clock className="size-2.5" />
      定时
    </span>
  )
}

/** M41（FI-2）：口径校验徽章——消息内成功执行 calc 时亮「已核算」，hover 展示表达式（不新增工具面） */
function CalcBadge({ expr }: { expr: string }): React.JSX.Element {
  return (
    <span
      data-calc-badge=""
      title={`已核算：${expr}`}
      className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-1.5 text-[10.5px] font-medium leading-[1.7] text-emerald-600"
    >
      <Calculator className="size-3" aria-hidden />
      已核算
    </span>
  )
}

/** M24：回合范式徽章（规划 / 评审；执行缺省不渲染，保持旧消息零差异） */
function ModeBadge({ mode }: { mode: 'plan' | 'review' }): React.JSX.Element {
  return mode === 'plan' ? (
    <span
      className="inline-flex items-center gap-0.5 rounded-full bg-violet-500/10 px-1.5 py-px text-[10px] font-medium text-violet-600"
      title="本回合为规划范式：只读调研并提交计划（待你批准后执行）"
    >
      <ClipboardList className="size-2.5" />
      规划
    </span>
  ) : (
    <span
      className="inline-flex items-center gap-0.5 rounded-full bg-sky-500/10 px-1.5 py-px text-[10px] font-medium text-sky-600"
      title="本回合为评审范式：输出结构化评审判定"
    >
      <SearchCheck className="size-2.5" />
      评审
    </span>
  )
}

/** 思考块（V4 思考模式）：纯思考阶段展开跟随流式，正文开始/完成后自动折叠为一行摘要 */
function ReasoningBlock({ text, phase }: { text: string; phase: 'thinking' | 'done' }): React.JSX.Element {
  const [open, setOpen] = React.useState(phase === 'thinking')
  const [touched, setTouched] = React.useState(false)

  React.useEffect(() => {
    if (phase === 'done' && !touched) setOpen(false)
  }, [phase, touched])

  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => {
          setTouched(true)
          setOpen((v) => !v)
        }}
        title={open ? '收起思考过程' : '展开思考过程'}
        className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <Brain className="size-3.5 text-primary/60" />
        {phase === 'thinking' ? (
          <span className="inline-flex items-center gap-1">
            正在思考
            <span className="flex items-end gap-[2px]">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="pa-dot size-[3px] rounded-full bg-primary/60"
                  style={{ animationDelay: `${i * 0.18}s` }}
                />
              ))}
            </span>
          </span>
        ) : (
          <span>已深度思考 · {text.length.toLocaleString()} 字</span>
        )}
        <ChevronDown className={cn('size-3 transition-transform duration-200', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="mt-1.5 whitespace-pre-wrap rounded-lg border-l-2 border-primary/25 bg-primary/[0.04] py-2 pl-2.5 pr-3 text-[12px] leading-5 text-muted-foreground">
          {text}
        </div>
      )}
    </div>
  )
}

function MessageItemInner({ messageId }: { messageId: string }): React.JSX.Element | null {
  // O(1) 项级订阅：只有这条消息对象被替换时本组件才重渲染
  const message = useSessionStore((s) => s.byId.get(messageId))
  const agents = useAgentStore((s) => s.agents)
  const groups = useAgentStore((s) => s.groups)
  // M77：成员实例标签（同角多魂 = `名字·灵魂名`；经典/单实例 = 名字）
  const session = useSessionStore((s) => s.sessions.find((x) => x.id === s.currentId))
  const flashed = useUiStore((s) => s.focusRequest?.id === messageId)
  // M57 P2：共享会话人类署名（他人昵称表 + 本人 id；兼容模式 humanNames 为空 → 仍为「你」）
  const myUserId = useAuthStore((s) => s.user?.id)
  const humanNames = useSessionStore((s) => s.humanNames)
  // M79-B：人类画像表（头像 / 头衔；优先于 humanNames 渲染）
  const humanProfiles = useSessionStore((s) => s.humanProfiles)

  // M37：消息级上下文（checklist / choice 容器需要 messageId 落交互态、sessionId 隔离存储键）
  const mdContext = React.useMemo<MdMessageInfo>(
    () => ({ messageId: message?.id ?? '', sessionId: message?.sessionId ?? '' }),
    [message?.id, message?.sessionId],
  )

  const streaming = message?.status === 'streaming'
  const throttledContent = useThrottledValue(message?.content ?? '', STREAM_THROTTLE_MS)
  const throttledReasoning = useThrottledValue(message?.reasoning ?? '', STREAM_THROTTLE_MS)

  // M43：评审判定记录匹配（mode=review + runId/agentId 命中；未命中 → 常规「评审」徽章，零回归）
  const review = usePlanStore((s) =>
    message?.mode === 'review' && message.runId && message.agentId
      ? s.reviews.find((r) => r.runId === message.runId && r.agentId === message.agentId)
      : undefined,
  )
  // M41（FI-2）：口径校验徽章（成功 calc 的表达式；无 calc → undefined）
  const calcExpr = React.useMemo(() => calcExpressionOf(message?.toolCalls), [message?.toolCalls])

  // M8：内联编辑（编辑重发）——编辑态与草稿内聚在条目内
  const editing = useUiStore((s) => s.editingMessageId === messageId)
  const [draft, setDraft] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const contentForEdit = message?.content
  React.useEffect(() => {
    if (editing) setDraft(contentForEdit ?? '')
  }, [editing, contentForEdit])

  if (!message) return null

  // M16：成员事件条（system 消息）——居中轻量展示（加入 / 移出 / 换灵魂），不参与气泡与交接渲染
  if (message.role === 'system') return <SystemMessage message={message} />

  const content = streaming ? throttledContent : message.content
  const reasoning = streaming ? throttledReasoning || undefined : message.reasoning
  const animate = Date.now() - Date.parse(message.createdAt) < ANIMATE_WINDOW_MS
  const agent = message.agentId ? agents.find((a) => a.id === message.agentId) : undefined
  const group = agent ? groups.find((g) => g.id === agent.group) : undefined
  // M77：作者展示名（分身 = 名字·灵魂名）
  const authorLabel = message.agentId ? labelOfMemberKey(agents, session, message.memberKey ?? message.agentId) : undefined

  const cancelEdit = (): void => {
    useUiStore.getState().startEditMessage(undefined)
    setDraft('')
  }

  /** 保存编辑并按需重发：改完用户消息后，对下一条 Agent 回复执行重新生成 */
  const saveEdit = async (): Promise<void> => {
    const content = draft.trim()
    if (!content || saving) return
    setSaving(true)
    try {
      await apiPatch(`/api/sessions/${message.sessionId}/messages/${message.id}`, { content })
      const store = useSessionStore.getState()
      store.patchMessage(message.id, { content })
      useUiStore.getState().startEditMessage(undefined)
      const idx = store.order.indexOf(message.id)
      const next = idx >= 0 ? store.byId.get(store.order[idx + 1]) : undefined
      const runId = next && next.role === 'agent' ? (next.runId ?? store.latestRun?.id) : undefined
      if (next && next.role === 'agent' && runId && !useRunStore.getState().active) {
        const res = await apiPost<{ runId: string }>(`/api/runs/${runId}/messages/${next.id}/regenerate`)
        useRunStore.getState().attach(res.runId, message.sessionId)
        toast('已按新内容重新生成回复')
      } else {
        toast('已保存修改')
      }
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  if (message.role === 'user') {
    // M57 P2：共享会话人类署名（他人消息显示昵称；自己/兼容模式仍为「你」）
    // M79-B：他人人类消息呈现升维（左对齐 + 头像 + 头衔）；自己的消息维持现状（右对齐、无头像）
    const isSelf = !message.userId || message.userId === myUserId
    const profile = message.userId ? humanProfiles[message.userId] : undefined
    const senderName = isSelf
      ? '你'
      : (profile?.name ?? (message.userId ? (humanNames[message.userId] ?? '成员') : '成员'))
    const headline = !isSelf ? profile?.headline : undefined
    const corner = isSelf ? 'rounded-tr-md' : 'rounded-tl-md'
    const bubble = editing ? (
      <div className={cn('w-fit max-w-full rounded-xl border border-primary/40 bg-card px-3.5 py-2.5 shadow-soft ring-[3px] ring-primary/10', corner)}>
        <textarea
          value={draft}
          autoFocus
          rows={Math.min(8, Math.max(2, draft.split('\n').length))}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') cancelEdit()
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void saveEdit()
          }}
          className="block w-full resize-none bg-transparent text-[13.5px] leading-6 focus:outline-none"
        />
        <div className="mt-2 flex items-center gap-1.5 border-t border-primary/10 pt-2">
          <Button size="sm" className="h-6 px-2 text-[11.5px]" disabled={saving} onClick={() => void saveEdit()}>
            {saving && <Loader2 className="size-3 animate-spin" />}
            保存并重发
          </Button>
          <Button variant="outline" size="sm" className="h-6 px-2 text-[11.5px]" onClick={cancelEdit}>
            取消
          </Button>
        </div>
      </div>
    ) : (
      <div
        className={cn(
          // M79-N：w-fit 让气泡按内容宽度自适应（他人人类消息容器为 flex-1，短文本不再被拉到 82% 全宽）
          'w-fit max-w-full rounded-xl border px-3.5 py-2.5 shadow-soft',
          corner,
          isSelf ? 'border-primary/20 bg-gradient-to-br from-primary/[0.08] to-primary/[0.03]' : 'bg-card',
        )}
      >
        {/* M33：附件原生渲染（图片网格 / 视频播放器 / 文档卡；可与文本共存） */}
        {message.attachments && message.attachments.length > 0 && (
          <div className={cn(content && 'mb-2')}>
            <MessageAttachments sessionId={message.sessionId} attachments={message.attachments} />
          </div>
        )}
        {content ? (
          <MessageContext.Provider value={mdContext}>
            <Markdown content={content} />
          </MessageContext.Provider>
        ) : null}
        {message.mentions.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-primary/10 pt-2 text-[11px] text-muted-foreground">
            <span>点名</span>
            {message.mentions.map((id) => {
              const a = agents.find((x) => x.id === baseAgentId(id))
              return (
                <span
                  key={id}
                  className="inline-flex items-center gap-1 rounded-full bg-card py-0.5 pl-0.5 pr-2 shadow-sm ring-1 ring-primary/15"
                >
                  <AgentAvatar agent={a} size={16} animated={false} />
                  <span className="text-[10.5px] font-medium text-foreground">
                    {labelOfMemberKey(agents, session, id)}
                  </span>
                </span>
              )
            })}
          </div>
        )}
        {/* M79-E：人类定向 chips（@真人；被提及人收「提及」提醒） */}
        {message.humanMentions && message.humanMentions.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-primary/10 pt-2 text-[11px] text-muted-foreground">
            <span>提及</span>
            {message.humanMentions.map((id) => {
              const p = humanProfiles[id]
              const name = p?.name ?? humanNames[id] ?? '成员'
              return (
                <span
                  key={id}
                  className="inline-flex items-center gap-1 rounded-full bg-card py-0.5 pl-0.5 pr-2 shadow-sm ring-1 ring-primary/15"
                >
                  <HumanAvatar avatar={p?.avatar} name={name} size={16} />
                  <span className="text-[10.5px] font-medium text-foreground">{name}</span>
                </span>
              )
            })}
          </div>
        )}
      </div>
    )
    if (isSelf) {
      return (
        <div
          id={`msg-${message.id}`}
          className={cn(
            'group flex justify-end gap-2.5 px-4 py-[var(--msg-py)]',
            animate && 'animate-fade-in-up',
            flashed && 'msg-flash',
          )}
        >
          <div className="max-w-[78%]">
            <div className="mb-1 flex items-center justify-end gap-2 text-[11.5px] text-muted-foreground">
              {message.scheduleId && <ScheduleBadge />}
              {message.mode && message.mode !== 'execute' && <ModeBadge mode={message.mode} />}
              <span>{formatClock(message.createdAt)}</span>
              <span className="font-medium text-foreground">{senderName}</span>
              <span className="flex items-center opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 max-md:opacity-100">
                <MessageActions messageId={message.id} />
              </span>
            </div>
            {bubble}
          </div>
        </div>
      )
    }
    return (
      <div
        id={`msg-${message.id}`}
        className={cn(
          'group flex gap-2.5 px-4 py-[var(--msg-py)]',
          animate && 'animate-fade-in-up',
          flashed && 'msg-flash',
        )}
      >
        <HumanAvatar avatar={profile?.avatar} name={senderName} size={34} className="mt-0.5" />
        <div className="min-w-0 max-w-[82%] flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-muted-foreground">
            <span className="text-[12.5px] font-semibold text-foreground">{senderName}</span>
            {headline && <span className="turn-role">{headline}</span>}
            {message.scheduleId && <ScheduleBadge />}
            {message.mode && message.mode !== 'execute' && <ModeBadge mode={message.mode} />}
            <span className="text-[10.5px]">·</span>
            <span>{formatClock(message.createdAt)}</span>
            <span className="ml-auto flex items-center opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 max-md:opacity-100">
              <MessageActions messageId={message.id} />
            </span>
          </div>
          {bubble}
        </div>
      </div>
    )
  }

  const avatarState =
    message.status === 'streaming' ? 'speaking' : message.status === 'error' ? 'error' : 'idle'

  return (
    <div
      id={`msg-${message.id}`}
      className={cn(
        'group flex gap-2.5 px-4 py-[var(--msg-py)]',
        animate && 'animate-fade-in-up',
        flashed && 'msg-flash',
      )}
    >
      <AgentAvatar agent={agent} size={34} state={avatarState} className="mt-0.5" />
      <div className="min-w-0 max-w-[82%] flex-1">
        <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-muted-foreground">
          <span className="text-[12.5px] font-semibold text-foreground">{authorLabel ?? message.agentId}</span>
          {agent && <span className="turn-role">{agent.role}</span>}
          {message.mode && message.mode !== 'execute' &&
            (review ? <ReviewVerdictBadge verdict={review.verdict} /> : <ModeBadge mode={message.mode} />)}
          {typeof message.turnIndex === 'number' && message.turnIndex >= 0 && (
            <span className="turn-wave" title={`本轮第 ${message.turnIndex + 1} 波发言`}>
              第 {message.turnIndex + 1} 波
            </span>
          )}
          {calcExpr ? <CalcBadge expr={calcExpr} /> : null}
          <span className="text-[10.5px]">·</span>
          <span>{formatClock(message.createdAt)}</span>
          {message.status === 'stopped' && <Badge variant="warning">已停止</Badge>}
          {message.status === 'error' && <Badge variant="destructive">出错</Badge>}
          <span className="ml-auto flex items-center opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 max-md:opacity-100">
            <MessageActions messageId={message.id} />
          </span>
        </div>

        <div
          className={cn(
            'turn-card relative overflow-hidden rounded-xl rounded-tl-md border bg-card px-3.5 py-2.5 shadow-soft',
            message.status === 'error' && 'border-destructive/40',
            message.status === 'stopped' && 'border-amber-500/40',
          )}
        >
          {group && (
            <span
              className="turn-accent"
              data-turn-accent={group.theme[0]}
              style={{ background: `linear-gradient(180deg, ${group.theme[0]}, ${group.theme[1]})` }}
              aria-hidden
            />
          )}
          {streaming && <span className="turn-progress" aria-hidden />}
          {reasoning && <ReasoningBlock text={reasoning} phase={streaming && !content ? 'thinking' : 'done'} />}
          {review ? <ReviewVerdictCard review={review} /> : null}
          {content ? (
            <MessageContext.Provider value={mdContext}>
              <Markdown content={content} streaming={streaming} />
            </MessageContext.Provider>
          ) : (
            streaming && !reasoning && <span className="text-[13px] text-muted-foreground">正在酝酿…</span>
          )}
          {streaming && (content.length > 0 || !reasoning) && (
            <span className="typing-caret ml-0.5 inline-block h-3.5 w-[7px] translate-y-[1px] rounded-[1px] bg-primary" />
          )}

          {message.toolCalls && message.toolCalls.length > 0 && <ToolCallsPanel calls={message.toolCalls} />}

          {message.artifacts && message.artifacts.length > 0 &&
            (isChangeMessage(message) ? (
              <ChangeCard message={message} />
            ) : (
              <DeliveryFiles paths={message.artifacts} agentId={message.agentId} />
            ))}
        </div>

        <HandoffBar message={message} />
      </div>
    </div>
  )
}

/** React.memo：props 只有稳定的 messageId，流式高频更新由内部 store 订阅自行处理 */
export const MessageItem = React.memo(MessageItemInner)

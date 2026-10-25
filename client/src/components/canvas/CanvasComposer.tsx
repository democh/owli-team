/**
 * M36：画布指令条 —— 画布与对话同级的输入能力（不是对话的补充）。
 *
 * - 固定于画布底部居中：Enter 发送 / Shift+Enter 换行；运行中发送自动变为插话（服务端回合边界消费）；
 * - 输入条上方可展开「最近回复」浮层（运行状态 + 最近消息流 + 待审批提醒），完整历史仍在对话 Tab；
 * - 成员快捷条点击插入 @；范式三态 chip（执行 / 规划 / 评审）仅对下一条消息生效，发送后复位；
 * - 草稿按会话持久化（ma:draft:canvas:<sessionId>，与对话输入框互不干扰）。
 */
import * as React from 'react'
import { toast } from 'sonner'
import { ChevronDown, CornerDownLeft, Loader2, Quote, Send, ShieldAlert, Square } from 'lucide-react'
import type { ChatMessage, TurnMode } from '@multi-agent/shared'
import { baseAgentId } from '@multi-agent/shared'
import { quoteForComposer } from '../../lib/canvas'
import { labelOfMemberKey, memberViews } from '../../lib/members'
import { cn } from '../../lib/utils'
import { useAgentStore } from '../../stores/agent-store'
import { useCanvasStore } from '../../stores/canvas-store'
import { useRunStore } from '../../stores/run-store'
import { useSessionStore, useCurrentSession } from '../../stores/session-store'
import { useUiStore } from '../../stores/ui-store'
import { Button } from '../ui/button'
import { AgentAvatar } from '../agents/AgentAvatar'
import { Markdown } from '../chat/Markdown'
import { MessageContext } from '../chat/md-ext/message-context'

/** 浮层内展示的最近消息条数 */
const PREVIEW_LIMIT = 14

/** M24：消息级范式选择（三态 chip，默认「执行」；与对话输入区同一语义） */
const MODE_CHIPS: Array<{ mode: TurnMode; label: string; title: string }> = [
  { mode: 'execute', label: '自动', title: '自动编排：由意图判定决定（多环节 / 高风险 → 先出计划；验收类 → 评审）' },
  { mode: 'plan', label: '规划', title: '规划范式：首棒只读调研并提交计划，待你批准后执行（仅对下一条消息生效）' },
  { mode: 'review', label: '评审', title: '评审范式：成员输出结构化评审判定（仅对下一条消息生效）' },
]

function draftKey(sessionId?: string): string | undefined {
  return sessionId ? `ma:draft:canvas:${sessionId}` : undefined
}

export function CanvasComposer(): React.JSX.Element {
  const currentId = useSessionStore((s) => s.currentId)
  const order = useSessionStore((s) => s.order)
  const byId = useSessionStore((s) => s.byId)
  // M79：人类定向目标展示名（正文 @用户 / @user 泛称 chip 就地展开为具体人）
  const humanNames = useSessionStore((s) => s.humanNames)
  const humanProfiles = useSessionStore((s) => s.humanProfiles)
  const agents = useAgentStore((s) => s.agents)
  const statuses = useAgentStore((s) => s.statuses)
  const active = useRunStore((s) => s.active)
  const queue = useRunStore((s) => s.queue)
  const approvals = useRunStore((s) => s.approvals)

  const [value, setValue] = React.useState('')
  const [expanded, setExpanded] = React.useState(false)
  const [sending, setSending] = React.useState(false)
  const [mode, setMode] = React.useState<TurnMode>('execute')
  const ref = React.useRef<HTMLTextAreaElement>(null)
  const listRef = React.useRef<HTMLDivElement>(null)
  /** M31 修订：画布选中节点数（引用选中 chip） */
  const selectedCount = useCanvasStore((s) => s.selectedIds.length)

  const session = useCurrentSession()
  // M77：成员实例投影（id = 成员键、name = 标签）——召唤条按实例展示、插入 `@名字·灵魂名`（点名到具体分身）
  const pool = React.useMemo(() => {
    const inSession = memberViews(agents, session).map((m) => ({ ...m.agent, id: m.key, name: m.label }))
    return inSession.length > 0 ? inSession : agents
  }, [agents, session])

  /** 最近消息流（新 → 旧取窗口后反转；系统事件与空内容不占位） */
  const recent = React.useMemo(() => {
    const out: ChatMessage[] = []
    for (let i = order.length - 1; i >= 0 && out.length < PREVIEW_LIMIT; i -= 1) {
      const message = byId.get(order[i])
      if (!message || message.role === 'system') continue
      if (!message.content.trim() && message.status !== 'streaming') continue
      out.push(message)
    }
    return out.reverse()
  }, [order, byId])

  const lastAgent = React.useMemo(() => {
    for (let i = recent.length - 1; i >= 0; i -= 1) {
      if (recent[i].role === 'agent') return recent[i]
    }
    return undefined
  }, [recent])

  // M77：当前发言人按成员实例署名（分身 = 名字·灵魂名）；键无法解析时回退「协作进行中」
  const speakerKey = queue[0]
  const speakerLabel = speakerKey ? labelOfMemberKey(agents, session, speakerKey) : ''
  const pendingApprovals = approvals.filter((a) => a.status === 'pending').length
  const statusText = active ? (speakerLabel ? `${speakerLabel} 正在发言` : '协作进行中') : '待命中'

  // 草稿：切会话时恢复 / 清空（范式选择不持久化，同复位）
  React.useEffect(() => {
    const key = draftKey(currentId)
    setValue(key ? (localStorage.getItem(key) ?? '') : '')
    setMode('execute')
  }, [currentId])

  // 草稿：值变化即落盘
  React.useEffect(() => {
    const key = draftKey(currentId)
    if (!key) return
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  }, [value, currentId])

  // 自适应高度
  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`
  }, [value])

  // 展开浮层：滚动到最新
  React.useEffect(() => {
    if (!expanded) return
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [expanded, recent])

  // 运行结束：自动收起浮层（内容已定格，完整结论在对话 Tab）
  const prevActiveRef = React.useRef(active)
  React.useEffect(() => {
    if (prevActiveRef.current && !active) setExpanded((v) => (v ? false : v))
    prevActiveRef.current = active
  }, [active])

  const insert = (text: string): void => {
    setValue((v) => (v ? `${v} ${text}` : text))
    requestAnimationFrame(() => {
      const el = ref.current
      if (el) {
        el.focus()
        el.setSelectionRange(el.value.length, el.value.length)
      }
    })
  }

  /** M31 修订：把画布选中的节点引用到本输入框（逐行 quoteForComposer；与右键「引用到对话」同一文案管线） */
  const insertSelectionQuote = (): void => {
    const { doc, selectedIds } = useCanvasStore.getState()
    if (!doc || selectedIds.length === 0) return
    const picked = doc.nodes.filter((n) => selectedIds.includes(n.id))
    if (picked.length === 0) return
    const block = picked.map((n) => quoteForComposer(n)).join('\n')
    setValue((v) => (v ? `${v}\n${block}` : block))
    requestAnimationFrame(() => {
      const el = ref.current
      if (el) {
        el.focus()
        el.setSelectionRange(el.value.length, el.value.length)
      }
    })
    toast.success(`已引用 ${picked.length} 个选中节点`)
  }

  const submit = async (): Promise<void> => {
    const content = value.trim()
    if (!content || sending) return
    setSending(true)
    try {
      await useRunStore.getState().send(content, mode === 'execute' ? undefined : mode)
      setValue('')
      setMode('execute')
      const key = draftKey(currentId)
      if (key) localStorage.removeItem(key)
      setExpanded(true) // 发送即展开最近回复：画布内直接看到回执
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSending(false)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((e.nativeEvent as KeyboardEvent).isComposing) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
      return
    }
    if (e.key === 'Escape' && expanded) setExpanded(false)
  }

  const canSend = value.trim().length > 0 && !sending

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-12 pb-3">
      <div className="pointer-events-auto flex w-full max-w-[720px] flex-col overflow-hidden rounded-xl border bg-card/95 shadow-soft backdrop-blur">
        {/* 状态条：运行状态 + 最近回复摘要（点击展开浮层） */}
        <button
          type="button"
          className="flex h-7 shrink-0 items-center gap-1.5 border-b px-2.5 text-left transition-colors hover:bg-accent/40"
          onClick={() => setExpanded((v) => !v)}
        >
          <ChevronDown className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', !expanded && 'rotate-180')} aria-hidden />
          <span className="flex shrink-0 items-center gap-1 text-[10.5px] text-muted-foreground">
            <span className={cn('size-1.5 rounded-full', active ? 'animate-pulse bg-primary' : 'bg-slate-300')} />
            {statusText}
            {active && queue.length > 0 ? ` · 队列 ${queue.length}` : ''}
          </span>
          {pendingApprovals > 0 && (
            <span className="flex shrink-0 items-center gap-0.5 rounded-full border border-amber-500/40 px-1.5 text-[10px] text-amber-600">
              <ShieldAlert className="size-3" aria-hidden />
              待审批 {pendingApprovals}
            </span>
          )}
          {lastAgent && (
            <span className="min-w-0 flex-1 truncate text-[10.5px] text-foreground/70">
              {labelOfMemberKey(agents, session, lastAgent.memberKey ?? lastAgent.agentId ?? '') || '成员'}：
              {lastAgent.content.slice(0, 160)}
              {lastAgent.status === 'streaming' ? ' …' : ''}
            </span>
          )}
          {!lastAgent && <span className="min-w-0 flex-1 truncate text-[10.5px] text-muted-foreground/60">展开查看最近回复</span>}
        </button>

        {/* 浮层：最近消息流（完整历史在对话 Tab） */}
        {expanded && (
          <div ref={listRef} className="max-h-56 space-y-1.5 overflow-y-auto border-b bg-muted/20 px-2.5 py-2">
            {recent.length === 0 && <p className="py-3 text-center text-[11px] text-muted-foreground">本会话还没有消息</p>}
            {recent.map((m) => {
              // M77：署名按成员实例（分身 = 名字·灵魂名）；头像 / 运行态取基础角色与成员键
              const key = m.memberKey ?? m.agentId
              const agent = key ? agents.find((a) => a.id === baseAgentId(key)) : undefined
              const streaming = m.status === 'streaming'
              // M79：本条消息的人类定向目标展示名（@用户 泛称 chip 展开；无数据则不展开）
              const humanLabels = (m.humanMentions ?? [])
                .map((id) => humanProfiles[id]?.name ?? humanNames[id])
                .filter((x): x is string => !!x)
              return (
                <div key={m.id} className="flex items-start gap-1.5">
                  {m.role === 'user' ? (
                    <span className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full border bg-card text-[9.5px] text-muted-foreground">
                      你
                    </span>
                  ) : (
                    <AgentAvatar agent={agent} size={20} state={statuses[key ?? ''] ?? 'idle'} animated={false} className="mt-px" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                      <span className="font-medium text-foreground/80">
                        {m.role === 'user' ? '你' : key ? labelOfMemberKey(agents, session, key) : '成员'}
                      </span>
                      {streaming && <Loader2 className="size-2.5 animate-spin text-primary" aria-hidden />}
                    </div>
                    <div className="max-h-28 overflow-hidden text-[11.5px] leading-5 text-foreground/85">
                      <MessageContext.Provider
                        value={{
                          messageId: m.id,
                          sessionId: m.sessionId,
                          ...(humanLabels.length > 0 ? { humanLabels } : {}),
                        }}
                      >
                        <Markdown content={m.content || (streaming ? '正在酝酿…' : '')} streaming={streaming} />
                      </MessageContext.Provider>
                    </div>
                  </div>
                </div>
              )
            })}
            <p className="pt-1 text-center text-[10px] text-muted-foreground/70">仅显示最近 {PREVIEW_LIMIT} 条，完整历史在「对话」Tab</p>
          </div>
        )}

        {/* 成员快捷召唤（点击插入 @） */}
        {pool.length > 0 && (
          <div className="flex items-center gap-1 overflow-x-auto px-2.5 pb-0.5 pt-1.5">
            {pool.map((a) => (
              <button
                key={a.id}
                type="button"
                title={`召唤 ${a.name}（${a.role}）`}
                onClick={() => insert(`@${a.name} `)}
                className="flex shrink-0 items-center gap-1 rounded-full border border-transparent bg-muted/70 py-0.5 pl-0.5 pr-2 text-[11px] text-muted-foreground transition-colors hover:border-primary/25 hover:bg-primary/5 hover:text-primary"
              >
                <AgentAvatar agent={a} size={16} animated={false} />
                {a.name}
              </button>
            ))}
            <span className="ml-auto hidden shrink-0 pl-2 pr-1 text-[10px] text-muted-foreground/70 sm:inline">
              图片 / 视频可直接拖到画布
            </span>
          </div>
        )}

        <div className="relative">
          <textarea
            ref={ref}
            value={value}
            rows={1}
            placeholder="给团队发指令，Agent 会直接操作画布…（Enter 发送 · Shift+Enter 换行）"
            className="block w-full resize-none bg-transparent px-3 py-2 pr-36 text-[12.5px] leading-5 placeholder:text-muted-foreground focus:outline-none"
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <div className="absolute bottom-1.5 right-1.5 flex items-center gap-1.5">
            {active && (
              <Button variant="outline" size="sm" className="h-7 text-[12px]" onClick={() => void useRunStore.getState().stop()}>
                <Square className="size-3 fill-current" />
                停止
              </Button>
            )}
            <Button size="sm" className="h-7 px-2.5" disabled={!canSend} onClick={() => void submit()}>
              {sending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
              {active ? '插话' : '发送'}
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-t px-2.5 py-1 text-[10.5px] text-muted-foreground">
          <span className="flex overflow-hidden rounded-full border bg-muted/40 p-0.5">
            {MODE_CHIPS.map((c) => (
              <button
                key={c.mode}
                type="button"
                title={active ? '运行中发送为插话，范式选择在下一轮生效前不可用' : c.title}
                disabled={active}
                onClick={() => setMode(c.mode)}
                className={cn(
                  'rounded-full px-1.5 py-px text-[10px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                  mode === c.mode
                    ? c.mode === 'execute'
                      ? 'bg-background text-foreground shadow-sm'
                      : 'bg-primary/15 text-primary shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {c.label}
              </button>
            ))}
          </span>
          {mode !== 'execute' && (
            <span className="text-primary/80">本条以「{MODE_CHIPS.find((c) => c.mode === mode)?.label}」发送，仅生效一次</span>
          )}
          {selectedCount > 0 && (
            <button
              type="button"
              title="把画布上选中的节点引用到输入框（发送时随消息给 Agent）"
              className="flex items-center gap-1 rounded-full border border-primary/30 bg-primary/5 px-1.5 py-px text-[10.5px] text-primary transition-colors hover:bg-primary/10"
              onClick={insertSelectionQuote}
            >
              <Quote className="size-3" aria-hidden />
              引用选中 {selectedCount}
            </button>
          )}
          <span className="ml-auto flex items-center gap-1">
            <CornerDownLeft className="size-3" aria-hidden />
            {active ? '运行中发送将作为插话' : '消息进入当前会话'}
          </span>
          {active && queue.length > 0 && (
            <span className="flex items-center gap-1 text-primary">
              <Loader2 className="size-3 animate-spin" aria-hidden />
              队列 {queue.length}
            </span>
          )}
          <button
            type="button"
            className="text-muted-foreground/80 underline-offset-2 transition-colors hover:text-foreground hover:underline"
            onClick={() => useUiStore.getState().setMainTab('chat')}
          >
            打开对话
          </button>
        </div>
      </div>
    </div>
  )
}

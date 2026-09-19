/**
 * 交接条（§10.4 三分支重设计）：居中、自适应宽度的简约胶囊，纯静态无滑动动效。
 * - 接力给成员：[发起者头像+名] → [接手者头像流+名]（M11：点击接手者头像 = 一键接棒插入 @）；
 * - 交还用户：[发起者头像+名] → 「你的回合」；
 * - 无后续：链路暂歇轻提示。
 * 尾部内联交接物摘要（交付件文件名 · 工具次数），与右侧接力视图形成双视角。
 * M11：入场一拍动效（handoff-in，安静模式 / reduced-motion 下不播）。
 * M16：新增 SystemMessage —— role='system' 成员事件条（加入 / 移出 / 换灵魂）。
 */
import * as React from 'react'
import { ArrowRight, CircleSlash, FileText, Wrench } from 'lucide-react'
import type { ChatMessage } from '@multi-agent/shared'
import { useAgentStore } from '../../stores/agent-store'
import { useUiStore } from '../../stores/ui-store'
import { formatClock } from '../../lib/time'
import { cn } from '../../lib/utils'
import { AgentAvatar } from '../agents/AgentAvatar'

/** 入场动效窗口：仅新近消息播放，虚拟列表重挂载不重放 */
const HANDOFF_ANIMATE_WINDOW_MS = 60_000

/** 胶囊底座：内容自适应宽度，最宽不超过消息列 */
const SHELL =
  'inline-flex max-w-full items-center gap-1.5 rounded-full border border-primary/15 bg-card/80 py-1 pl-1 pr-3 text-[11.5px] shadow-sm'

/** 交接物摘要：胶囊尾部内联（交付件文件名 · 工具调用次数） */
function HandoffMeta({ message }: { message: ChatMessage }): React.JSX.Element | null {
  const artifactNames = (message.artifacts ?? []).map((p) => p.split('/').pop() ?? p)
  const toolCount = message.toolCalls?.length ?? 0
  if (artifactNames.length === 0 && toolCount === 0) return null

  return (
    <>
      {artifactNames.length > 0 && (
        <span className="inline-flex min-w-0 items-center gap-1 text-muted-foreground" title={artifactNames.join('、')}>
          <span className="shrink-0 text-muted-foreground/40">·</span>
          <FileText className="size-3 shrink-0 text-primary/70" />
          <span className="max-w-36 truncate">{artifactNames.join('、')}</span>
        </span>
      )}
      {toolCount > 0 && (
        <span className="inline-flex shrink-0 items-center gap-1 text-muted-foreground">
          <span className="text-muted-foreground/40">·</span>
          <Wrench className="size-2.5" />
          {toolCount} 次
        </span>
      )}
    </>
  )
}

export function HandoffBar({ message }: { message: ChatMessage }): React.JSX.Element | null {
  const agents = useAgentStore((s) => s.agents)
  const quiet = useUiStore((s) => s.quietMode)
  const insertToComposer = useUiStore((s) => s.insertToComposer)

  if (message.role !== 'agent') return null
  if (message.status === 'streaming') return null

  const mentions = message.mentions ?? []
  const from = agents.find((a) => a.id === message.agentId)
  const byId = (id: string): (typeof agents)[number] | undefined => agents.find((a) => a.id === id)
  const targets = mentions.filter((x) => x !== 'user')
  const shellCls = cn(SHELL, !quiet && Date.now() - Date.parse(message.createdAt) < HANDOFF_ANIMATE_WINDOW_MS && 'handoff-in')

  // 交还用户：显示「你的回合」
  if (mentions.includes('user') && targets.length === 0) {
    return (
      <div className="mt-2 flex justify-center">
        <div className={shellCls} title={`${from?.name ?? message.agentId} 交还给用户`}>
          <AgentAvatar agent={from} size={22} animated={false} className="ring-1 ring-primary/15" />
          <span className="shrink-0 font-medium">{from?.name ?? message.agentId}</span>
          <ArrowRight className="mx-0.5 size-3 shrink-0 text-muted-foreground/60" />
          <span className="font-medium text-primary">你的回合</span>
          <HandoffMeta message={message} />
        </div>
      </div>
    )
  }

  // 接力给成员（M11：点击接手者头像 = 插入 @ 一键接棒）
  if (targets.length > 0) {
    const names = targets.map((id) => byId(id)?.name ?? id)
    return (
      <div className="mt-2 flex justify-center">
        <div className={shellCls} title={`${from?.name ?? message.agentId} 交棒给 ${names.join('、')}`}>
          <AgentAvatar agent={from} size={22} animated={false} className="ring-1 ring-primary/15" />
          <span className="shrink-0 font-medium">{from?.name ?? message.agentId}</span>
          <ArrowRight className="mx-0.5 size-3 shrink-0 text-muted-foreground/60" />
          <div className="flex shrink-0 -space-x-1.5">
            {targets.map((id) => {
              const target = byId(id)
              const name = target?.name ?? id
              return (
                <button
                  key={id}
                  type="button"
                  title={`一键接棒：插入 @${name}，由 TA 继续推进`}
                  className="rounded-full transition-transform hover:z-10 hover:-translate-y-0.5"
                  onClick={() => insertToComposer(`@${name} `)}
                >
                  <AgentAvatar agent={target} size={22} animated={false} className="ring-2 ring-card" />
                </button>
              )
            })}
          </div>
          <span className="min-w-0 truncate font-medium text-primary">{names.join('、')}</span>
          <HandoffMeta message={message} />
        </div>
      </div>
    )
  }

  // 链路暂歇
  return (
    <div className="mt-2 flex justify-center">
      <div className="inline-flex items-center gap-1.5 rounded-full bg-muted/50 px-3 py-1 text-[11px] text-muted-foreground">
        <CircleSlash className="size-3" />
        本轮链路暂歇，可 @ 成员继续
      </div>
    </div>
  )
}

/**
 * M16：成员事件条（role='system'）——居中、轻量胶囊：涉事成员头像 + 文案 + 时间。
 * 用于「X 邀请了 Y 加入协作」「Z 换上了『狂野』灵魂」「W 离开了协作」等成员变更记录。
 * 持久化可回放、不进 LLM 窗口；与交接条共用入场动效（安静模式 / reduced-motion 下不播）。
 */
export function SystemMessage({ message }: { message: ChatMessage }): React.JSX.Element {
  const agents = useAgentStore((s) => s.agents)
  const quiet = useUiStore((s) => s.quietMode)
  const agent = message.agentId ? agents.find((a) => a.id === message.agentId) : undefined
  const animate = !quiet && Date.now() - Date.parse(message.createdAt) < HANDOFF_ANIMATE_WINDOW_MS

  return (
    <div id={`msg-${message.id}`} className={cn('flex justify-center px-4 py-1.5', animate && 'handoff-in')}>
      <div
        className="inline-flex max-w-[85%] items-center gap-1.5 rounded-full border border-dashed bg-muted/40 py-1 pl-1 pr-3 text-[11.5px] text-muted-foreground"
        title={message.content}
      >
        {agent && (
          <AgentAvatar agent={agent} size={18} animated={false} className="shrink-0 ring-1 ring-border" />
        )}
        <span className="min-w-0 truncate">{message.content}</span>
        <span className="shrink-0 text-[10.5px] text-muted-foreground/70">{formatClock(message.createdAt)}</span>
      </div>
    </div>
  )
}

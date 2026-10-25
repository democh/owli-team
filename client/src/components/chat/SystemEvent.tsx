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
import { ArrowRight, CircleSlash, FileText, Package, Wrench } from 'lucide-react'
import type { ChatMessage } from '@multi-agent/shared'
import { useAgentStore } from '../../stores/agent-store'
import { useSessionStore } from '../../stores/session-store'
import { useUiStore } from '../../stores/ui-store'
import { formatClock } from '../../lib/time'
import { cn } from '../../lib/utils'
import { AgentAvatar } from '../agents/AgentAvatar'
import { HumanAvatar } from './HumanAvatar'

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

/**
 * M87：交接包徽标 —— 只展示 handoff 工具显式声明的 artifacts / notes（自动带出的本轮产出
 * 已在 HandoffMeta 中展示，不重复）。点击打开交付件面板并定位首件。
 */
function HandoffPackage({ message }: { message: ChatMessage }): React.JSX.Element | null {
  const call = (message.toolCalls ?? []).find((c) => c.name === 'handoff' && c.status === 'ok')
  if (!call) return null
  const args = call.args ?? {}
  const paths = Array.isArray(args.artifacts)
    ? args.artifacts.filter((p): p is string => typeof p === 'string' && p.length > 0)
    : []
  const notes = typeof args.notes === 'string' && args.notes.trim() ? args.notes.trim() : undefined
  if (paths.length === 0 && !notes) return null
  return (
    <button
      type="button"
      data-handoff-package=""
      title={`${paths.length > 0 ? `交接包：${paths.join('、')}` : '交接口径'}${notes ? `\n口径：${notes}` : ''}`}
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10.5px] font-medium text-primary transition-colors hover:bg-primary/15"
      onClick={() => {
        if (paths[0]) useUiStore.getState().requestArtifact(paths[0])
        useUiStore.getState().expandWorkspace('artifacts')
      }}
    >
      <Package className="size-2.5" aria-hidden />
      {paths.length > 0 ? `交接包 ${paths.length}` : '交接口径'}
    </button>
  )
}

export function HandoffBar({ message }: { message: ChatMessage }): React.JSX.Element | null {
  const agents = useAgentStore((s) => s.agents)
  const quiet = useUiStore((s) => s.quietMode)
  const insertToComposer = useUiStore((s) => s.insertToComposer)
  // M79-AA：交还目标的具体真人（画像优先，回退名单 id）
  const humanProfiles = useSessionStore((s) => s.humanProfiles)
  const humanNames = useSessionStore((s) => s.humanNames)

  if (message.role !== 'agent') return null
  if (message.status === 'streaming') return null

  const mentions = message.mentions ?? []
  const from = agents.find((a) => a.id === message.agentId)
  const byId = (id: string): (typeof agents)[number] | undefined => agents.find((a) => a.id === id)
  const targets = mentions.filter((x) => x !== 'user')
  const shellCls = cn(SHELL, !quiet && Date.now() - Date.parse(message.createdAt) < HANDOFF_ANIMATE_WINDOW_MS && 'handoff-in')

  // M79-AA：交还真人——显示具体真人（头像流 + 名字；点击一键接棒），替代泛称「你的回合」
  const humanTargets = message.humanMentions ?? []
  if (humanTargets.length > 0) {
    const names = humanTargets.map((id) => humanProfiles[id]?.name ?? humanNames[id] ?? id)
    return (
      <div className="mt-2 flex justify-center">
        <div className={shellCls} title={`${from?.name ?? message.agentId} 交还 给 ${names.join('、')}`}>
          <AgentAvatar agent={from} size={22} animated={false} className="ring-1 ring-primary/15" />
          <span className="shrink-0 font-medium">{from?.name ?? message.agentId}</span>
          <ArrowRight className="mx-0.5 size-3 shrink-0 text-muted-foreground/60" />
          <div className="flex shrink-0 -space-x-1.5">
            {humanTargets.map((id, i) => {
              const name = names[i]!
              return (
                <button
                  key={id}
                  type="button"
                  title={`一键接棒：插入 @${name}，由 TA 继续推进`}
                  className="rounded-full transition-transform hover:z-10 hover:-translate-y-0.5"
                  onClick={() => insertToComposer(`@${name} `)}
                >
                  <HumanAvatar
                    avatar={humanProfiles[id]?.avatar}
                    name={name}
                    size={22}
                    className="ring-2 ring-card"
                  />
                </button>
              )
            })}
          </div>
          <span className="min-w-0 truncate font-medium text-primary" data-handoff-targets="">
            {names.join('、')}
          </span>
          <HandoffMeta message={message} />
          <HandoffPackage message={message} />
        </div>
      </div>
    )
  }

  // 交还用户（兼容回退：无具体目标数据的旧消息）：显示「你的回合」
  if (mentions.includes('user') && targets.length === 0) {
    return (
      <div className="mt-2 flex justify-center">
        <div className={shellCls} title={`${from?.name ?? message.agentId} 交还给用户`}>
          <AgentAvatar agent={from} size={22} animated={false} className="ring-1 ring-primary/15" />
          <span className="shrink-0 font-medium">{from?.name ?? message.agentId}</span>
          <ArrowRight className="mx-0.5 size-3 shrink-0 text-muted-foreground/60" />
          <span className="font-medium text-primary">你的回合</span>
          <HandoffMeta message={message} />
          <HandoffPackage message={message} />
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
          <HandoffPackage message={message} />
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

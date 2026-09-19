/**
 * 节点悬停预览卡（§28.5，M22）：悬停约 280ms 后浮现，免点击速览成员状况。
 * - pointer-events: none（绝不抢 hover / 点击链路——消失仅由节点 mouseleave 驱动）
 * - 内容：状态徽章 + 最近发言摘要 + 战绩三数 + 游离提示；定位由调用方（GraphView）按视口换算
 * - 状态文案与档案面板同口径（STATUS_LABEL 复用 GraphInspector）
 */
import * as React from 'react'
import { Unplug } from 'lucide-react'
import type { AgentDefinition, ChatMessage } from '@multi-agent/shared'
import { cn } from '../../../lib/utils'
import { AgentAvatar } from '../../agents/AgentAvatar'
import { STATUS_LABEL } from './GraphInspector'

export interface NodePreviewProps {
  agent: AgentDefinition
  speaking: boolean
  queueIndex: number
  awaitingUser: boolean
  /** 运行状态（agent-store.statuses[agent.id]） */
  status?: string
  inCount: number
  outCount: number
  talks: number
  /** 游离成员（尚未接入接力链） */
  isolated: boolean
  /** 最近一条完成发言（摘要显示） */
  lastMessage?: ChatMessage
  /** 定位（相对画布容器左上角；右缘 / 下缘溢出由调用方 clamp） */
  left: number
  top: number
}

export function NodePreview({
  agent,
  speaking,
  queueIndex,
  awaitingUser,
  status,
  inCount,
  outCount,
  talks,
  isolated,
  lastMessage,
  left,
  top,
}: NodePreviewProps): React.JSX.Element {
  const statusText = speaking
    ? '发言中'
    : queueIndex > 0
      ? `排队第 ${queueIndex} 位`
      : awaitingUser
        ? '待你指示'
        : (STATUS_LABEL[status ?? 'idle'] ?? '待命')
  return (
    <div
      aria-hidden
      className="graph-pop-in pointer-events-none absolute z-30 w-[236px] rounded-xl border bg-card/95 p-2.5 shadow-lg backdrop-blur-sm"
      style={{ left, top }}
    >
      <div className="flex items-center gap-2">
        <AgentAvatar agent={agent} size={26} animated={false} className="shrink-0 rounded-md" />
        <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium leading-4">{agent.name}</span>
        <span
          className={cn(
            'shrink-0 rounded-full border px-1.5 py-px text-[9px]',
            speaking
              ? 'border-primary/40 bg-primary/10 text-primary'
              : awaitingUser
                ? 'border-amber-400/50 bg-amber-50 text-amber-600'
                : 'text-muted-foreground',
          )}
        >
          {statusText}
        </span>
      </div>
      {lastMessage ? (
        <p className="mt-1.5 line-clamp-2 text-[10.5px] leading-4 text-foreground/80">{lastMessage.content.slice(0, 120)}</p>
      ) : (
        <p className="mt-1.5 text-[10.5px] leading-4 text-muted-foreground/70">尚未发言</p>
      )}
      <div className="mt-1.5 flex items-center gap-2 border-t pt-1.5 text-[9.5px] text-muted-foreground">
        <span>
          接手 <b className="font-semibold text-foreground/75">{inCount}</b>
        </span>
        <span>
          交出 <b className="font-semibold text-foreground/75">{outCount}</b>
        </span>
        <span>
          发言 <b className="font-semibold text-foreground/75">{talks}</b>
        </span>
      </div>
      {isolated && (
        <div className="mt-1.5 flex items-center gap-1 border-t pt-1.5 text-[9.5px] text-muted-foreground">
          <Unplug className="size-2.5 shrink-0" aria-hidden />
          还没接过棒 · 召唤 TA 加入接力
        </div>
      )}
    </div>
  )
}

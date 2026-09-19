/**
 * 图谱成员节点卡（§28.4，M21）：M17 状态体系 + 游戏化升级。
 * - 发言中：滚动光带描边（graph-speaking-ring）+ 呼吸；接手徽章「⚡N」= 累计接手次数
 * - 接力脉冲：flash nonce 触发一次性「接收」光环；拖动手感由 .react-flow__node.dragging 抬升
 * - 游离成员：未接入接力链（isolated）虚线呼吸环轻提示（发言中不叠加）
 * - 待你指示浮标 / 排队序号 / 近期接力高亮 / 分组主题色竖条沿用 M17 口径
 */
import * as React from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { Zap } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { AgentAvatar } from '../../agents/AgentAvatar'
import type { FlowNodeData } from './types'

export type AgentFlowNode = Node<FlowNodeData, 'agent'>

const AgentNodeView = React.memo(function AgentNodeView({ data }: NodeProps<AgentFlowNode>): React.JSX.Element {
  const { agent, themeColor, speaking, queueIndex, awaitingUser, recent, dimmed, pinned, enterDelay, flash, inCount, isolated } = data
  return (
    <div className="relative">
      {speaking && <span aria-hidden className="graph-speaking-ring absolute -inset-[1.5px] rounded-[13px]" />}
      {isolated && !speaking && <span aria-hidden className="graph-isolated-ring absolute -inset-1 rounded-2xl" />}
      {flash > 0 && <span key={flash} aria-hidden className="graph-node-flash absolute -inset-1.5 rounded-2xl" />}
      <div
        className={cn(
          'graph-node-card graph-node-in relative z-[1] flex w-[180px] cursor-grab items-center gap-2 rounded-xl border bg-card px-2.5 py-2 shadow-soft',
          speaking && 'graph-speaking border-primary/50',
          !speaking && recent && 'border-amber-400/60',
          pinned && 'border-primary/50 ring-2 ring-primary/25',
          dimmed && 'opacity-35',
        )}
        style={{
          animationDelay: `${enterDelay}ms`,
          ...(themeColor ? { borderLeftColor: themeColor, borderLeftWidth: 3 } : {}),
        }}
      >
        <Handle type="target" position={Position.Left} isConnectable={false} className="!size-1 !border-0 !bg-transparent" />
        <AgentAvatar agent={agent} size={32} animated={false} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1">
            <span className="truncate text-[12px] font-medium leading-4">{agent.name}</span>
            {inCount > 0 && (
              <span
                className="ml-auto flex shrink-0 items-center gap-0.5 rounded-full bg-primary/10 px-1 py-px text-[9px] font-semibold leading-3 text-primary"
                title={`累计接手 ${inCount} 次`}
              >
                <Zap className="size-2.5" aria-hidden />
                {inCount}
              </span>
            )}
          </div>
          <div className="truncate text-[10px] text-muted-foreground">{agent.role}</div>
        </div>
        {queueIndex > 0 && !speaking && (
          <span
            className="absolute -right-1.5 -top-1.5 flex size-4 items-center justify-center rounded-full bg-primary text-[9px] font-semibold text-primary-foreground ring-1 ring-card"
            title={`排队第 ${queueIndex} 位`}
          >
            {queueIndex}
          </span>
        )}
        {speaking && (
          <span className="pa-dot absolute -right-1 -top-1 size-2 rounded-full bg-primary ring-1 ring-card" title="发言中" />
        )}
        {awaitingUser && (
          <span className="graph-await-pop absolute -bottom-2 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border bg-card px-1.5 py-px text-[9px] text-primary shadow-soft">
            待你指示
          </span>
        )}
        <Handle type="source" position={Position.Right} isConnectable={false} className="!size-1 !border-0 !bg-transparent" />
      </div>
    </div>
  )
})

export { AgentNodeView }

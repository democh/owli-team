/**
 * 圆桌中心图腾（§28.4，M21）：radial 布局的「圆桌」本体——场景名 + 在场成员数。
 * 仅装饰：不可拖动、不可选中、不参与模型推导；虚线环缓慢旋转（安静 / reduced-motion 关闭）。
 */
import * as React from 'react'
import { Users } from 'lucide-react'
import type { Node, NodeProps } from '@xyflow/react'
import type { CoreData } from './types'

export type CoreFlowNode = Node<CoreData, 'core'>

const CoreNodeView = React.memo(function CoreNodeView({ data }: NodeProps<CoreFlowNode>): React.JSX.Element {
  const { name, count, color, enterDelay } = data
  return (
    <div className="graph-node-in relative flex size-24 items-center justify-center" style={{ animationDelay: `${enterDelay}ms` }}>
      <span
        aria-hidden
        className="graph-core-spin absolute inset-0 rounded-full border-2 border-dashed"
        style={{ borderColor: color ?? 'hsl(var(--primary) / 0.5)' }}
      />
      <div
        className="flex size-[72px] flex-col items-center justify-center gap-0.5 rounded-full border bg-gradient-to-b from-card to-muted/60 text-center shadow-soft"
        style={color ? { boxShadow: `0 0 0 4px ${color}14` } : undefined}
        title={`${name} · ${count} 位成员`}
      >
        <Users className="size-3.5" style={{ color: color ?? 'hsl(var(--primary))' }} aria-hidden />
        <span className="max-w-[64px] truncate text-[11px] font-medium leading-3.5">{name}</span>
        <span className="text-[9px] text-muted-foreground">{count} 位成员</span>
      </div>
    </div>
  )
})

export { CoreNodeView }

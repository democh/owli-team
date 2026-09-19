/**
 * M31：节点统一外壳 —— 选中描边 / 悬停操作行（副本 · 删除）/ NodeResizer / 左右连线把手。
 * 说明：节点内容由各类型组件提供；画框（GroupNode）样式差异大，单独实现不走上壳。
 * M31 修订：作者徽标 —— agent 写入（node.by）的节点左下角挂头像（内部查 store，零侵入子节点组件）。
 */
import * as React from 'react'
import { Handle, NodeResizer, Position } from '@xyflow/react'
import { Copy, Trash2 } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { useAgentStore } from '../../../stores/agent-store'
import { useCanvasStore } from '../../../stores/canvas-store'
import { AgentAvatar } from '../../agents/AgentAvatar'

export interface NodeShellProps {
  nodeId: string
  selected: boolean
  children: React.ReactNode
  className?: string
  /** 可缩放（图片 / 视频 / 便签 / 提示词） */
  resizable?: { minWidth: number; minHeight: number }
  /** 参与连线（左入右出；缺省 true） */
  connectable?: boolean
  onDoubleClick?: () => void
}

function ShellAction({
  title,
  danger,
  onClick,
  children,
}: {
  title: string
  danger?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={title}
      className={cn(
        'nodrag flex size-5 items-center justify-center rounded text-muted-foreground/80 transition-colors hover:bg-accent hover:text-foreground',
        danger && 'hover:bg-rose-500/10 hover:text-rose-600',
      )}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
    >
      {children}
    </button>
  )
}

export function NodeShell({
  nodeId,
  selected,
  children,
  className,
  resizable,
  connectable = true,
  onDoubleClick,
}: NodeShellProps): React.JSX.Element {
  const duplicateNodes = useCanvasStore((s) => s.duplicateNodes)
  const removeNodes = useCanvasStore((s) => s.removeNodes)
  // M31 修订：作者徽标数据源（选择器返回字符串 / 对象引用稳定，不引起额外重渲染）
  const authorId = useCanvasStore((s) => s.doc?.nodes.find((n) => n.id === nodeId)?.by)
  const authorAgent = useAgentStore((s) => (authorId ? s.agents.find((a) => a.id === authorId) : undefined))
  return (
    <div
      className={cn(
        'canvas-node-pop group/cnode relative h-full w-full rounded-xl border bg-card text-card-foreground shadow-soft transition-[box-shadow,border-color]',
        selected ? 'border-primary/50 ring-2 ring-primary/40' : 'hover:border-muted-foreground/30',
        className,
      )}
      onDoubleClick={onDoubleClick}
    >
      {resizable && (
        <NodeResizer
          isVisible={selected}
          minWidth={resizable.minWidth}
          minHeight={resizable.minHeight}
          lineClassName="!border-primary/50"
          handleClassName="!size-2 !rounded-sm !border-primary/70 !bg-card"
        />
      )}
      {children}
      {authorAgent && (
        <span className="absolute -bottom-2 left-1.5 z-20" title={`由「${authorAgent.name}」写入`}>
          <AgentAvatar agent={authorAgent} size={14} animated={false} />
        </span>
      )}
      <div className="absolute -top-3 right-1.5 z-20 hidden items-center gap-0.5 rounded-md border bg-card/95 p-0.5 shadow-sm backdrop-blur group-hover/cnode:flex">
        <ShellAction title="创建副本" onClick={() => duplicateNodes([nodeId])}>
          <Copy className="size-3" />
        </ShellAction>
        <ShellAction title="删除" danger onClick={() => removeNodes([nodeId])}>
          <Trash2 className="size-3" />
        </ShellAction>
      </div>
      {connectable && (
        <>
          <Handle
            type="target"
            position={Position.Left}
            className="!size-2 !border !border-card !bg-primary/60 opacity-70 transition-opacity hover:!bg-primary hover:opacity-100"
          />
          <Handle
            type="source"
            position={Position.Right}
            className="!size-2 !border !border-card !bg-primary/60 opacity-70 transition-opacity hover:!bg-primary hover:opacity-100"
          />
        </>
      )}
    </div>
  )
}

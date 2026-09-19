/**
 * M31：画框节点（group）—— 半透明收纳区；可缩放 / 双击改标题 / 拖入节点即收纳（reparentNodes）。
 * 子节点为相对坐标（parentId），拖动画框时子节点跟随（React Flow 子流）。
 */
import * as React from 'react'
import { NodeResizer } from '@xyflow/react'
import { Layers } from 'lucide-react'
import type { CanvasNodeDataMap } from '@multi-agent/shared'
import { cn } from '../../../lib/utils'
import { useCanvasStore } from '../../../stores/canvas-store'
import { useInlineEdit } from './useInlineEdit'
import type { CanvasNodeProps } from './types'

export const GroupNode = React.memo(function GroupNode({ id, data, selected }: CanvasNodeProps): React.JSX.Element {
  const d = data as CanvasNodeDataMap['group']
  const childCount = useCanvasStore((s) => s.doc?.nodes.reduce((acc, n) => (n.parentId === id ? acc + 1 : acc), 0) ?? 0)
  const updateNodeData = useCanvasStore((s) => s.updateNodeData)
  const commit = React.useCallback((title: string) => updateNodeData(id, { title }), [id, updateNodeData])
  const edit = useInlineEdit(id, d.title, commit)

  return (
    <div
      className={cn(
        'canvas-node-pop h-full w-full rounded-2xl border-2 border-dashed transition-colors',
        selected ? 'border-primary/50 bg-primary/[0.04]' : 'border-muted-foreground/25 bg-muted/20',
      )}
      onDoubleClick={edit.begin}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={220}
        minHeight={140}
        lineClassName="!border-primary/50"
        handleClassName="!size-2 !rounded-sm !border-primary/70 !bg-card"
      />
      <div className="pointer-events-none flex items-center gap-1.5 px-3 pt-2">
        <Layers className="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden />
        {edit.editing ? (
          <input
            autoFocus
            value={edit.draft}
            placeholder="画框标题"
            onChange={(e) => edit.setDraft(e.target.value)}
            onBlur={edit.commit}
            onKeyDown={(e) => {
              edit.onKeyDown(e)
              if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) edit.commit()
            }}
            className="nodrag pointer-events-auto w-40 rounded border border-border/60 bg-card px-1.5 py-0.5 text-[11.5px] outline-none"
          />
        ) : (
          <span className="pointer-events-auto max-w-60 cursor-text truncate text-[11.5px] font-medium text-muted-foreground/80">
            {d.title || '画框'}
          </span>
        )}
        {childCount > 0 && <span className="text-[10px] text-muted-foreground/50">{childCount} 个节点</span>}
      </div>
    </div>
  )
})

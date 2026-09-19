/**
 * M31：便签节点 —— 双击内联编辑 / 色带强调（accent）/ 可缩放。
 */
import * as React from 'react'
import type { CanvasNodeDataMap } from '@multi-agent/shared'
import { cn } from '../../../lib/utils'
import { useCanvasStore } from '../../../stores/canvas-store'
import { accentOf } from './accents'
import { NodeShell } from './NodeShell'
import { useInlineEdit } from './useInlineEdit'
import type { CanvasNodeProps } from './types'

export const NoteNode = React.memo(function NoteNode({ id, data, selected }: CanvasNodeProps): React.JSX.Element {
  const d = data as CanvasNodeDataMap['note']
  const updateNodeData = useCanvasStore((s) => s.updateNodeData)
  const commit = React.useCallback((text: string) => updateNodeData(id, { text }), [id, updateNodeData])
  const edit = useInlineEdit(id, d.text, commit)
  const accent = accentOf(d.accent)

  return (
    <NodeShell
      nodeId={id}
      selected={selected}
      resizable={{ minWidth: 140, minHeight: 90 }}
      onDoubleClick={edit.begin}
    >
      <div className={cn('flex h-full flex-col overflow-hidden rounded-[inherit]', accent.tint)}>
        <div className={cn('h-1.5 w-full shrink-0', accent.bar)} />
        {edit.editing ? (
          <textarea
            autoFocus
            value={edit.draft}
            placeholder="写点什么…"
            onChange={(e) => edit.setDraft(e.target.value)}
            onBlur={edit.commit}
            onKeyDown={edit.onKeyDown}
            className="nodrag nowheel h-full w-full flex-1 resize-none bg-transparent px-2.5 py-2 text-[12px] leading-5 outline-none placeholder:text-muted-foreground/50"
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-hidden whitespace-pre-wrap break-words px-2.5 py-2 text-[12px] leading-5">
            {d.text || <span className="text-muted-foreground/50">双击编辑，随手记下想法…</span>}
          </div>
        )}
      </div>
    </NodeShell>
  )
})

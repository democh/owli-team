/**
 * M31：提示词节点 —— 双击编辑 / 负面词 / 作为生成数据流的源头（flow 边）。
 */
import * as React from 'react'
import { TerminalSquare } from 'lucide-react'
import type { CanvasNodeDataMap } from '@multi-agent/shared'
import { useCanvasStore } from '../../../stores/canvas-store'
import { NodeShell } from './NodeShell'
import { useInlineEdit } from './useInlineEdit'
import type { CanvasNodeProps } from './types'

export const PromptNode = React.memo(function PromptNode({ id, data, selected }: CanvasNodeProps): React.JSX.Element {
  const d = data as CanvasNodeDataMap['prompt']
  const updateNodeData = useCanvasStore((s) => s.updateNodeData)
  const commit = React.useCallback((text: string) => updateNodeData(id, { text }), [id, updateNodeData])
  const edit = useInlineEdit(id, d.text, commit)

  return (
    <NodeShell
      nodeId={id}
      selected={selected}
      resizable={{ minWidth: 180, minHeight: 110 }}
      onDoubleClick={edit.begin}
      className="border-l-[3px] border-l-primary/70"
    >
      <div className="flex h-full flex-col overflow-hidden rounded-[inherit]">
        <div className="flex shrink-0 items-center gap-1.5 border-b border-border/60 px-2 py-1 text-[10px] text-muted-foreground">
          <TerminalSquare className="size-3" aria-hidden />
          <span>提示词</span>
          <span className="ml-auto text-[9px] text-muted-foreground/60">→ 连到图片 / 视频</span>
        </div>
        {edit.editing ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <textarea
              autoFocus
              value={edit.draft}
              placeholder="描述你想生成的画面…"
              onChange={(e) => edit.setDraft(e.target.value)}
              onBlur={edit.commit}
              onKeyDown={edit.onKeyDown}
              className="nodrag nowheel min-h-0 flex-1 resize-none bg-transparent px-2.5 py-2 font-mono text-[11.5px] leading-5 outline-none placeholder:text-muted-foreground/50"
            />
            {d.negative !== undefined && (
              <input
                value={d.negative}
                placeholder="负面词（可选）"
                onChange={(e) => updateNodeData(id, { negative: e.target.value })}
                className="nodrag border-t border-border/60 bg-transparent px-2.5 py-1.5 text-[10.5px] text-muted-foreground outline-none placeholder:text-muted-foreground/50"
              />
            )}
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-hidden whitespace-pre-wrap break-words px-2.5 py-2 font-mono text-[11.5px] leading-5">
            {d.text || <span className="font-sans text-muted-foreground/50">双击写下提示词…</span>}
          </div>
        )}
        {!edit.editing && d.negative && (
          <div className="shrink-0 truncate border-t border-border/60 px-2.5 py-1 text-[10px] text-muted-foreground">
            负面词：{d.negative}
          </div>
        )}
      </div>
    </NodeShell>
  )
})

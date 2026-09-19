/**
 * M31：脑图节点 —— 胶囊形 / 双击编辑 / 折叠切换（fold 时隐藏 mind 出边后代）。
 * 长文本在文本区（max-w-52）内折行（行数与 lib/mind.ts estimateMindSize 对齐），不再溢出卡片。
 * 完整 xmind 式快捷编辑（Tab / Enter / 拖拽重组）见 P4。
 */
import * as React from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { CanvasNodeDataMap } from '@multi-agent/shared'
import { cn } from '../../../lib/utils'
import { useCanvasStore } from '../../../stores/canvas-store'
import { accentOf } from './accents'
import { NodeShell } from './NodeShell'
import { useInlineEdit } from './useInlineEdit'
import type { CanvasNodeProps } from './types'

export const MindNode = React.memo(function MindNode({ id, data, selected }: CanvasNodeProps): React.JSX.Element {
  const d = data as CanvasNodeDataMap['mind']
  const childCount = useCanvasStore(
    (s) => s.doc?.edges.reduce((acc, e) => (e.kind === 'mind' && e.source === id ? acc + 1 : acc), 0) ?? 0,
  )
  const updateNodeData = useCanvasStore((s) => s.updateNodeData)
  const commit = React.useCallback((text: string) => updateNodeData(id, { text }), [id, updateNodeData])
  const edit = useInlineEdit(id, d.text, commit)
  const accent = accentOf(d.accent)

  return (
    <NodeShell
      nodeId={id}
      selected={selected}
      onDoubleClick={edit.begin}
      className="h-auto w-fit min-w-28 rounded-2xl"
    >
      <div className="flex items-center gap-1.5 rounded-2xl px-3 py-1.5">
        <span className={cn('size-1.5 shrink-0 rounded-full', accent.bar)} aria-hidden />
        {edit.editing ? (
          <input
            autoFocus
            value={edit.draft}
            placeholder="主题"
            size={Math.max(4, edit.draft.length)}
            onChange={(e) => edit.setDraft(e.target.value)}
            onBlur={edit.commit}
            onKeyDown={(e) => {
              edit.onKeyDown(e)
              if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) edit.commit()
            }}
            className="nodrag min-w-10 max-w-52 bg-transparent text-[12px] leading-5 outline-none placeholder:text-muted-foreground/50"
          />
        ) : (
          <span className="max-w-52 break-words text-[12px] leading-5">{d.text || '主题'}</span>
        )}
        {childCount > 0 && (
          <button
            type="button"
            title={d.collapsed ? '展开分支' : '收拢分支'}
            aria-label={d.collapsed ? '展开分支' : '收拢分支'}
            className="nodrag -mr-1 flex items-center rounded-full px-1 py-0.5 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation()
              updateNodeData(id, { collapsed: !d.collapsed })
            }}
          >
            {d.collapsed ? <ChevronRight className="size-3" aria-hidden /> : <ChevronDown className="size-3" aria-hidden />}
            <span className="text-[10px] tabular-nums">{childCount}</span>
          </button>
        )}
      </div>
    </NodeShell>
  )
})

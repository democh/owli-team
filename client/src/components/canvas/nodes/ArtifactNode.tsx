/**
 * M31：交付件节点 —— 引用工作区文件（点击「查看」跳转交付件页）。
 */
import * as React from 'react'
import { FileCode, FileImage, FileSpreadsheet, FileText, FolderOpen } from 'lucide-react'
import type { CanvasNodeDataMap } from '@multi-agent/shared'
import { baseName, extOf } from '../../../lib/artifacts'
import { useUiStore } from '../../../stores/ui-store'
import { NodeShell } from './NodeShell'
import type { CanvasNodeProps } from './types'

function iconFor(path: string): React.JSX.Element {
  const ext = extOf(path)
  if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'webp' || ext === 'gif' || ext === 'svg') {
    return <FileImage className="size-4 shrink-0 text-primary/70" aria-hidden />
  }
  if (ext === 'xlsx' || ext === 'csv' || ext === 'tsv') {
    return <FileSpreadsheet className="size-4 shrink-0 text-emerald-600/80" aria-hidden />
  }
  if (ext === 'ts' || ext === 'tsx' || ext === 'js' || ext === 'jsx' || ext === 'py' || ext === 'go' || ext === 'json') {
    return <FileCode className="size-4 shrink-0 text-sky-600/80" aria-hidden />
  }
  return <FileText className="size-4 shrink-0 text-muted-foreground/70" aria-hidden />
}

export const ArtifactNode = React.memo(function ArtifactNode({ id, data, selected }: CanvasNodeProps): React.JSX.Element {
  const d = data as CanvasNodeDataMap['artifact']
  const expandWorkspace = useUiStore((s) => s.expandWorkspace)

  return (
    <NodeShell nodeId={id} selected={selected}>
      <div className="flex h-full items-center gap-2 px-2.5">
        {iconFor(d.path)}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11.5px] font-medium">{baseName(d.path)}</div>
          <div className="truncate text-[10px] text-muted-foreground/80">{d.path}</div>
        </div>
        <button
          type="button"
          title="在交付件页查看"
          className="nodrag flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation()
            expandWorkspace('artifacts')
          }}
        >
          <FolderOpen className="size-3" aria-hidden />
          查看
        </button>
      </div>
    </NodeShell>
  )
})

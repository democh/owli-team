/**
 * M31：图片节点 —— 预览 / 来源徽标 / 尺寸徽标 / 生成谱系摘要 / 失败占位。
 */
import * as React from 'react'
import { Image as ImageIcon, Link2, Sparkles, TriangleAlert, Upload } from 'lucide-react'
import type { CanvasImageData } from '@multi-agent/shared'
import { artifactContentUrl } from '../../../lib/artifacts'
import { useCanvasStore } from '../../../stores/canvas-store'
import { NodeShell } from './NodeShell'
import type { CanvasNodeProps } from './types'

const SOURCE_META = {
  generate: { label: '生成', icon: Sparkles },
  upload: { label: '上传', icon: Upload },
  ref: { label: '引用', icon: Link2 },
} as const

export const ImageNode = React.memo(function ImageNode({ id, data, selected }: CanvasNodeProps): React.JSX.Element {
  const sessionId = useCanvasStore((s) => s.sessionId)
  const d = data as CanvasImageData
  const [broken, setBroken] = React.useState(false)
  const url = sessionId && d.artifact ? artifactContentUrl(sessionId, d.artifact) : undefined
  const meta = d.source ? SOURCE_META[d.source] : undefined
  const size = d.params?.width && d.params?.height ? `${d.params.width}×${d.params.height}` : undefined

  return (
    <NodeShell nodeId={id} selected={selected} resizable={{ minWidth: 140, minHeight: 110 }}>
      <div className="flex h-full flex-col overflow-hidden rounded-[inherit]">
        <div className="flex shrink-0 items-center gap-1.5 border-b border-border/60 px-2 py-1 text-[10px] text-muted-foreground">
          {meta ? <meta.icon className="size-3" aria-hidden /> : <ImageIcon className="size-3" aria-hidden />}
          <span>{meta?.label ?? '图片'}</span>
          {size && <span className="ml-auto tabular-nums">{size}</span>}
        </div>
        <div className="relative min-h-0 flex-1 bg-muted/40">
          {url && !broken ? (
            <img
              src={url}
              alt={d.prompt ?? '画布图片'}
              loading="lazy"
              draggable={false}
              className="h-full w-full object-cover"
              onError={() => setBroken(true)}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-1.5 px-3 text-center">
              <ImageIcon className="size-5 text-muted-foreground/40" aria-hidden />
              <span className="line-clamp-3 text-[10.5px] leading-4 text-muted-foreground/80">
                {d.prompt || '拖入图片，或连接提示词节点后生成'}
              </span>
            </div>
          )}
          {d.error && (
            <div className="absolute inset-x-1 bottom-1 flex items-center gap-1 rounded-md bg-rose-500/90 px-1.5 py-0.5 text-[10px] text-white">
              <TriangleAlert className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{d.error}</span>
            </div>
          )}
        </div>
        {d.prompt && url && (
          <div className="shrink-0 truncate border-t border-border/60 px-2 py-1 text-[10px] text-muted-foreground">
            {d.prompt}
          </div>
        )}
      </div>
    </NodeShell>
  )
})

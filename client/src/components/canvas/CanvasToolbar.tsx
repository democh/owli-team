/**
 * M31：画布工具栏（左上浮动）—— 添加节点 / 上传 / 媒体生成 / 脑图工坊 / 撤销重做 /
 * 对齐分布整理（含脑图整理）/ 适应视野 / 导出 JSON 与脑图 Markdown / 保存状态。
 */
import * as React from 'react'
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalSpaceAround,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalSpaceAround,
  Download,
  FileText,
  LayoutGrid,
  Maximize,
  Plus,
  Redo2,
  Sparkles,
  Undo2,
  Upload,
  Waypoints,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '../../lib/utils'
import { useCanvasStore } from '../../stores/canvas-store'
import type { AlignMode } from '../../lib/canvas'

function ToolBtn({
  title,
  disabled,
  active,
  onClick,
  children,
}: {
  title: string
  disabled?: boolean
  active?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      className={cn(
        'flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-35',
        active && 'bg-accent text-foreground',
      )}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function ToolSep(): React.JSX.Element {
  return <span className="mx-0.5 h-4 w-px shrink-0 bg-border" aria-hidden />
}

const ALIGN_ITEMS: Array<{ mode: AlignMode; label: string; icon: LucideIcon }> = [
  { mode: 'left', label: '左对齐', icon: AlignStartVertical },
  { mode: 'hcenter', label: '水平居中', icon: AlignCenterVertical },
  { mode: 'right', label: '右对齐', icon: AlignEndVertical },
  { mode: 'top', label: '顶对齐', icon: AlignStartHorizontal },
  { mode: 'vcenter', label: '垂直居中', icon: AlignCenterHorizontal },
  { mode: 'bottom', label: '底对齐', icon: AlignEndHorizontal },
]

export interface CanvasToolbarProps {
  onAdd(): void
  onUpload(): void
  onGenerate(): void
  onMind(): void
  onFit(): void
  onExport(): void
  onExportMind(): void
}

export function CanvasToolbar({
  onAdd,
  onUpload,
  onGenerate,
  onMind,
  onFit,
  onExport,
  onExportMind,
}: CanvasToolbarProps): React.JSX.Element {
  const selectedIds = useCanvasStore((s) => s.selectedIds)
  const undoDepth = useCanvasStore((s) => s.undoDepth)
  const redoDepth = useCanvasStore((s) => s.redoDepth)
  const saving = useCanvasStore((s) => s.saving)
  const dirty = useCanvasStore((s) => s.dirty)
  const lastSavedAt = useCanvasStore((s) => s.lastSavedAt)
  const hasMind = useCanvasStore((s) => s.doc?.nodes.some((n) => n.type === 'mind') ?? false)
  const hasMindSelected = useCanvasStore(
    (s) => s.selectedIds.length > 0 && s.selectedIds.some((id) => s.doc?.nodes.some((n) => n.id === id && n.type === 'mind')),
  )
  const [alignOpen, setAlignOpen] = React.useState(false)
  const alignRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (!alignOpen) return
    const onPointerDown = (e: PointerEvent): void => {
      if (!alignRef.current?.contains(e.target as Node)) setAlignOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [alignOpen])

  const selCount = selectedIds.length
  const run = (fn: () => void): void => {
    fn()
    setAlignOpen(false)
  }

  const saveBadge = saving
    ? '保存中…'
    : dirty
      ? '未保存'
      : lastSavedAt
        ? `已保存 ${new Date(lastSavedAt).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })}`
        : ''

  return (
    <div className="absolute left-3 top-3 z-30 flex items-center gap-0.5 rounded-lg border bg-card/95 p-1 shadow-soft backdrop-blur">
      <ToolBtn title="添加节点" onClick={onAdd}>
        <Plus className="size-4" />
      </ToolBtn>
      <ToolBtn title="上传图片 / 视频" onClick={onUpload}>
        <Upload className="size-4" />
      </ToolBtn>
      <ToolBtn title="媒体生成（文生图 / 视频）" onClick={onGenerate}>
        <Sparkles className="size-4" />
      </ToolBtn>
      <ToolBtn title="脑图工坊（AI 生成 / 大纲导入）" onClick={onMind}>
        <Waypoints className="size-4" />
      </ToolBtn>
      <ToolSep />
      <ToolBtn title="撤销 ⌘Z" disabled={undoDepth === 0} onClick={() => useCanvasStore.getState().undo()}>
        <Undo2 className="size-4" />
      </ToolBtn>
      <ToolBtn
        title="重做 ⇧⌘Z"
        disabled={redoDepth === 0}
        onClick={() => useCanvasStore.getState().redo()}
      >
        <Redo2 className="size-4" />
      </ToolBtn>
      <ToolSep />
      <div ref={alignRef} className="relative">
        <ToolBtn title="整理与对齐（先框选多个节点）" active={alignOpen} onClick={() => setAlignOpen((v) => !v)}>
          <LayoutGrid className="size-4" />
        </ToolBtn>
        {alignOpen && (
          <div className="canvas-node-pop absolute left-0 top-full z-40 mt-1 w-40 rounded-lg border bg-card p-1 shadow-soft">
            {ALIGN_ITEMS.map((item) => (
              <button
                key={item.mode}
                type="button"
                disabled={selCount < 2}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
                onClick={() => run(() => useCanvasStore.getState().align(selectedIds, item.mode))}
              >
                <item.icon className="size-3.5 text-muted-foreground" aria-hidden />
                {item.label}
              </button>
            ))}
            <span className="my-1 block h-px bg-border" aria-hidden />
            <button
              type="button"
              disabled={selCount < 3}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
              onClick={() => run(() => useCanvasStore.getState().distribute(selectedIds, 'h'))}
            >
              <AlignHorizontalSpaceAround className="size-3.5 text-muted-foreground" aria-hidden />
              水平等距
            </button>
            <button
              type="button"
              disabled={selCount < 3}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
              onClick={() => run(() => useCanvasStore.getState().distribute(selectedIds, 'v'))}
            >
              <AlignVerticalSpaceAround className="size-3.5 text-muted-foreground" aria-hidden />
              垂直等距
            </button>
            <span className="my-1 block h-px bg-border" aria-hidden />
            <button
              type="button"
              disabled={selCount < 2}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
              onClick={() => run(() => useCanvasStore.getState().tidy(selectedIds))}
            >
              <LayoutGrid className="size-3.5 text-muted-foreground" aria-hidden />
              网格整理
            </button>
            {hasMindSelected && (
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-accent"
                onClick={() => run(() => useCanvasStore.getState().arrangeMind(selectedIds))}
              >
                <Waypoints className="size-3.5 text-muted-foreground" aria-hidden />
                脑图整理
              </button>
            )}
          </div>
        )}
      </div>
      <ToolBtn title="适应视野" onClick={onFit}>
        <Maximize className="size-4" />
      </ToolBtn>
      <ToolBtn title="导出画布 JSON" onClick={onExport}>
        <Download className="size-4" />
      </ToolBtn>
      <ToolBtn title="导出脑图 Markdown" disabled={!hasMind} onClick={onExportMind}>
        <FileText className="size-4" />
      </ToolBtn>
      {saveBadge && (
        <span
          className={cn('ml-0.5 mr-1 shrink-0 text-[10px] tabular-nums', dirty ? 'text-amber-600' : 'text-muted-foreground/70')}
        >
          {saveBadge}
        </span>
      )}
    </div>
  )
}

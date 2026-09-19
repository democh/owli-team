/**
 * M31 修订：画布缩放指示器（React Flow Controls 内嵌，Excalidraw / Figma 范式）——
 *
 * - 作为 `<Controls>` 的自定义子项渲染在左下控件组内（不新增浮动层：独立浮层在主区窄栏
 *   会与底部指令条重叠——本组件随控件组向上生长，天然避让）；
 * - 常驻显示当前缩放百分比（useViewport 实时）；点击向上展开菜单：
 *   缩放到 100%（⇧0）/ 适应视野（⇧1）/ 缩放到选区（⇧2，无选区禁用）；
 * - ± 步进与 fitView 按钮由 React Flow Controls 内置按钮承担。
 */
import * as React from 'react'
import { useReactFlow, useViewport } from '@xyflow/react'
import { Focus, Maximize } from 'lucide-react'
import { cn } from '../../lib/utils'
import { FIT_MAX_ZOOM, FIT_VIEW_PADDING } from '../../lib/canvas'
import { useCanvasStore } from '../../stores/canvas-store'

const FIT_DURATION = 300

export function CanvasZoomIndicator(): React.JSX.Element {
  const { zoom } = useViewport()
  const { zoomTo, fitView } = useReactFlow()
  const selectedCount = useCanvasStore((s) => s.selectedIds.length)
  const [menuOpen, setMenuOpen] = React.useState(false)
  const rootRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (e: PointerEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const percent = Math.round(zoom * 100)
  const run = (fn: () => void): void => {
    setMenuOpen(false)
    fn()
  }

  /** 缩放到选区：仅对选中节点取景（缩放上限 / 留白与适应视野同口径） */
  const fitSelection = (): void => {
    const { doc, selectedIds } = useCanvasStore.getState()
    if (!doc || selectedIds.length === 0) return
    const picked = doc.nodes.filter((n) => selectedIds.includes(n.id)).map((n) => ({ id: n.id }))
    if (picked.length === 0) return
    void fitView({ nodes: picked, padding: FIT_VIEW_PADDING, maxZoom: FIT_MAX_ZOOM, duration: FIT_DURATION })
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        title="缩放选项（⇧0 100% · ⇧1 适应视野 · ⇧2 缩放到选区）"
        aria-label={`当前缩放 ${percent}%，点击展开缩放选项`}
        className={cn(
          'canvas-zoom-pill flex h-[26px] w-full items-center justify-center text-[10px] tabular-nums text-muted-foreground transition-colors hover:text-foreground',
          menuOpen && 'text-foreground',
        )}
        onClick={() => setMenuOpen((v) => !v)}
      >
        {percent}%
      </button>

      {menuOpen && (
        <div className="canvas-node-pop absolute bottom-full left-0 z-40 mb-1 w-44 rounded-lg border bg-card p-1 shadow-soft">
          <MenuItem
            icon={<span className="text-[10.5px] font-medium">100%</span>}
            shortcut="⇧0"
            label="缩放到 100%"
            onClick={() => run(() => zoomTo(1, { duration: FIT_DURATION }))}
          />
          <MenuItem
            icon={<Maximize className="size-3.5 text-muted-foreground" aria-hidden />}
            shortcut="⇧1"
            label="适应视野"
            onClick={() => run(() => void fitView({ padding: FIT_VIEW_PADDING, maxZoom: FIT_MAX_ZOOM, duration: FIT_DURATION }))}
          />
          <MenuItem
            icon={<Focus className="size-3.5 text-muted-foreground" aria-hidden />}
            shortcut="⇧2"
            label="缩放到选区"
            disabled={selectedCount === 0}
            onClick={() => run(fitSelection)}
          />
        </div>
      )}
    </div>
  )
}

function MenuItem({
  icon,
  label,
  shortcut,
  disabled,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  shortcut: string
  disabled?: boolean
  onClick(): void
}): React.JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
      onClick={onClick}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 text-[10px] text-muted-foreground/70">{shortcut}</span>
    </button>
  )
}

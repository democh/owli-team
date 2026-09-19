/**
 * M31 修订：画布内查找（「/」快捷键 / 工具栏「查找节点」）——
 * 顶部居中浮层：输入即匹配（lib/canvas.searchNodes 纯函数），↑↓ 选择 / Enter 定位 / Esc 关闭；
 * 定位 = 居中 + 程序化选中 + 闪环（连续定位不关面板）；外部点击关闭。
 */
import * as React from 'react'
import { Search } from 'lucide-react'
import { searchNodes } from '../../lib/canvas'
import { cn } from '../../lib/utils'
import { useCanvasStore } from '../../stores/canvas-store'

export function CanvasSearch({ onClose, onLocate }: { onClose(): void; onLocate(id: string): void }): React.JSX.Element {
  const doc = useCanvasStore((s) => s.doc)
  const [query, setQuery] = React.useState('')
  const [active, setActive] = React.useState(0)
  const rootRef = React.useRef<HTMLDivElement>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)

  const hits = React.useMemo(() => (doc && query.trim() ? searchNodes(doc, query) : []), [doc, query])

  // 挂载即聚焦（一帧后，确保浮层已布局）
  React.useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [])

  // 外部点击关闭
  React.useEffect(() => {
    const onPointerDown = (e: PointerEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [onClose])

  // 查询变化重置选择位
  React.useEffect(() => setActive(0), [query])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, hits.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const hit = hits[active]
      if (hit) onLocate(hit.id)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <div
      ref={rootRef}
      className="canvas-node-pop absolute left-1/2 top-14 z-40 w-[360px] -translate-x-1/2 rounded-lg border bg-card/95 p-1.5 shadow-soft backdrop-blur"
    >
      <div className="flex items-center gap-1.5 rounded-md border bg-background px-2">
        <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="查找节点（文本 / 标题 / 提示词 / 标的）…"
          aria-label="画布查找"
          className="h-7 min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-muted-foreground"
        />
        <span className="shrink-0 text-[10px] text-muted-foreground/70">Esc 关闭</span>
      </div>
      {query.trim() && (
        <div className="mt-1 max-h-64 overflow-y-auto">
          {hits.length === 0 && <p className="px-2 py-3 text-center text-[11px] text-muted-foreground">没有匹配的节点</p>}
          {hits.map((h, i) => (
            <button
              key={h.id}
              type="button"
              className={cn(
                'flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors',
                i === active ? 'bg-accent' : 'hover:bg-accent/60',
              )}
              onMouseEnter={() => setActive(i)}
              onClick={() => onLocate(h.id)}
            >
              <span className="w-full truncate text-[12px]">{h.label}</span>
              <span className="w-full truncate text-[10.5px] text-muted-foreground">{h.snippet}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * M31：创建菜单（双击空白 / 工具栏「添加」）—— 便签 / 提示词 / 脑图 / 画框 / 上传素材 / 博弈推演 / K 线行情。
 * M31 修订：提示词节点 hint 按媒体能力门控（未配置生成能力时降级为「记录可复用的指令」）。
 */
import * as React from 'react'
import { Dices, Frame, LineChart, StickyNote, TerminalSquare, Upload, Waypoints, type LucideIcon } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useMediaCapabilities } from './useMediaCapabilities'

export type CreateKind = 'note' | 'prompt' | 'mind' | 'group' | 'upload' | 'game' | 'kline'

const ITEMS: Array<{ kind: CreateKind; label: string; hint?: string; icon: LucideIcon }> = [
  { kind: 'note', label: '便签', hint: '双击空白也可', icon: StickyNote },
  { kind: 'prompt', label: '提示词节点', hint: '连到图片 / 视频生成', icon: TerminalSquare },
  { kind: 'mind', label: '脑图节点', hint: 'Tab / Enter 扩展分支', icon: Waypoints },
  { kind: 'group', label: '画框', hint: '把相关节点收在一起', icon: Frame },
  { kind: 'upload', label: '上传图片 / 视频', icon: Upload },
  // M34：博弈推演节点（四模型纯计算，结果可视化与消息块共用内核）
  { kind: 'game', label: '博弈推演', hint: '四模型 · 可运行', icon: Dices },
  // M34：K 线行情节点（直连行情网关，块 / 节点共用渲染内核）
  { kind: 'kline', label: 'K 线行情', hint: '输入标的拉取', icon: LineChart },
]

export function CanvasCreateMenu({
  x,
  y,
  onPick,
  onClose,
}: {
  x: number
  y: number
  onPick(kind: CreateKind): void
  onClose(): void
}): React.JSX.Element {
  // 能力门控：提示词节点 hint 随生图 / 生视频能力切换（节点本体保留——无能力时仍是可复用的指令载体）
  const { canGenerate } = useMediaCapabilities()
  const items = React.useMemo(
    () =>
      ITEMS.map((it) =>
        it.kind === 'prompt' ? { ...it, hint: canGenerate ? '连到图片 / 视频生成' : '记录可复用的指令' } : it,
      ),
    [canGenerate],
  )
  const menuRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const onPointerDown = (e: PointerEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const left = Math.min(x, window.innerWidth - 200)
  const top = Math.min(y, window.innerHeight - 260)
  return (
    <div
      ref={menuRef}
      className="canvas-node-pop fixed z-50 w-48 rounded-lg border bg-card p-1 shadow-soft"
      style={{ left, top }}
    >
      {items.map((item) => (
        <button
          key={item.kind}
          type="button"
          className={cn(
            'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-foreground transition-colors hover:bg-accent',
          )}
          onClick={() => onPick(item.kind)}
        >
          <item.icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
          {item.hint && <span className="truncate text-[10px] text-muted-foreground/60">{item.hint}</span>}
        </button>
      ))}
    </div>
  )
}

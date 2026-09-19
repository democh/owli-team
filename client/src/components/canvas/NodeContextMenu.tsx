/**
 * M31：节点右键菜单 —— 编辑文本 / 脑图分支（加子·整理）/ 副本 / 复制 / z 序 / 换色 /
 * 生成（变体·首尾帧）/ 引用到对话 / 删除（脑图节点删除整棵分支）。
 */
import * as React from 'react'
import {
  ArrowDown,
  ArrowUp,
  ClipboardCopy,
  Copy,
  Frame,
  ImagePlus,
  ListPlus,
  Palette,
  PencilLine,
  Quote,
  Trash2,
  Wand2,
  Waypoints,
  type LucideIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import type { CanvasImageData, CanvasNodeData } from '@multi-agent/shared'
import { quoteForComposer } from '../../lib/canvas'
import { indexMind, mindSubtreeIds } from '../../lib/mind'
import { cn } from '../../lib/utils'
import { useCanvasStore } from '../../stores/canvas-store'
import { useMediaStore } from '../../stores/media-store'
import { useUiStore } from '../../stores/ui-store'
import { nextAccent } from './nodes/accents'

function MenuItem({
  icon: Icon,
  label,
  danger,
  onClick,
}: {
  icon: LucideIcon
  label: string
  danger?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-accent',
        danger && 'text-rose-600 hover:bg-rose-500/10',
      )}
      onClick={onClick}
    >
      <Icon className="size-3.5 shrink-0 opacity-70" aria-hidden />
      {label}
    </button>
  )
}

function MenuSep(): React.JSX.Element {
  return <span className="my-1 block h-px bg-border" aria-hidden />
}

export interface NodeContextMenuProps {
  nodeId: string
  x: number
  y: number
  onClose(): void
  onBeginEdit(nodeId: string): void
}

export function NodeContextMenu({ nodeId, x, y, onClose, onBeginEdit }: NodeContextMenuProps): React.JSX.Element | null {
  const node = useCanvasStore((s) => s.doc?.nodes.find((n) => n.id === nodeId))
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

  if (!node) return null
  const data = node.data as Record<string, unknown>
  const editable = node.type === 'note' || node.type === 'prompt' || node.type === 'mind' || node.type === 'group'
  const accentable = node.type === 'note' || node.type === 'mind'
  const imageArtifact = node.type === 'image' ? (node.data as CanvasImageData).artifact : undefined
  const imagePrompt = node.type === 'image' ? (node.data as CanvasImageData).prompt : undefined
  const run = (fn: () => void): void => {
    fn()
    onClose()
  }
  /** 删除：脑图节点删除整棵分支（包含后代）；其余节点删除自身 */
  const removeNode = (): void => {
    const store = useCanvasStore.getState()
    const d = store.doc
    if (node.type === 'mind' && d) {
      store.removeNodes(mindSubtreeIds(indexMind(d.nodes, d.edges), nodeId))
      return
    }
    store.removeNodes([nodeId])
  }
  const left = Math.min(x, window.innerWidth - 190)
  const top = Math.min(y, window.innerHeight - 430)

  return (
    <div
      ref={menuRef}
      className="canvas-node-pop fixed z-50 w-44 rounded-lg border bg-card p-1 shadow-soft"
      style={{ left, top }}
    >
      {editable && <MenuItem icon={PencilLine} label="编辑文本" onClick={() => run(() => onBeginEdit(nodeId))} />}
      {node.type === 'mind' && (
        <>
          <MenuItem
            icon={ListPlus}
            label="添加子节点（Tab）"
            onClick={() =>
              run(() => {
                const id = useCanvasStore.getState().mindAddChild(nodeId)
                if (id) onBeginEdit(id)
              })
            }
          />
          <MenuItem
            icon={Waypoints}
            label="整理分支"
            onClick={() => run(() => useCanvasStore.getState().arrangeMind([nodeId]))}
          />
        </>
      )}
      <MenuItem
        icon={Copy}
        label="创建副本"
        onClick={() => run(() => useCanvasStore.getState().duplicateNodes([nodeId]))}
      />
      <MenuItem
        icon={ClipboardCopy}
        label="复制"
        onClick={() => run(() => useCanvasStore.getState().copySelection([nodeId]))}
      />
      <MenuItem
        icon={ArrowUp}
        label="上移一层"
        onClick={() => run(() => useCanvasStore.getState().zOrder([nodeId], 'forward'))}
      />
      <MenuItem
        icon={ArrowDown}
        label="下移一层"
        onClick={() => run(() => useCanvasStore.getState().zOrder([nodeId], 'backward'))}
      />
      {accentable && (
        <MenuItem
          icon={Palette}
          label="换个颜色"
          onClick={() =>
            run(() => {
              const key = typeof data.accent === 'string' ? data.accent : undefined
              useCanvasStore.getState().updateNodeData(nodeId, { accent: nextAccent(key) } as Partial<CanvasNodeData>)
            })
          }
        />
      )}
      <MenuSep />
      {imageArtifact && (
        <>
          <MenuItem
            icon={ImagePlus}
            label="用作生成输入"
            onClick={() => run(() => useMediaStore.getState().openPanel({ images: [imageArtifact] }))}
          />
          {imagePrompt && (
            <MenuItem
              icon={Wand2}
              label="生成变体"
              onClick={() =>
                run(() => useMediaStore.getState().openPanel({ images: [imageArtifact], prompt: imagePrompt }))
              }
            />
          )}
          <MenuItem
            icon={Frame}
            label="设为首帧（视频）"
            onClick={() => run(() => useMediaStore.getState().openPanel({ firstFrame: imageArtifact }))}
          />
          <MenuItem
            icon={Frame}
            label="设为尾帧（视频）"
            onClick={() => run(() => useMediaStore.getState().openPanel({ lastFrame: imageArtifact }))}
          />
          <MenuSep />
        </>
      )}
      <MenuItem
        icon={Quote}
        label="引用到对话"
        onClick={() =>
          run(() => {
            useUiStore.getState().insertToComposer(quoteForComposer(node))
            toast('已引用到输入框')
          })
        }
      />
      <MenuSep />
      <MenuItem
        icon={Trash2}
        label={node.type === 'mind' ? '删除分支' : '删除'}
        danger
        onClick={() => run(removeNode)}
      />
    </div>
  )
}

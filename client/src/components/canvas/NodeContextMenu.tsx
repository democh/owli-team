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
  RefreshCw,
  Trash2,
  Wand2,
  Waypoints,
  type LucideIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import type { CanvasGenerationParams, CanvasImageData, CanvasVideoData, CanvasNodeData } from '@multi-agent/shared'
import { quoteForComposer } from '../../lib/canvas'
import { indexMind, mindSubtreeIds } from '../../lib/mind'
import { cn } from '../../lib/utils'
import { useCanvasStore } from '../../stores/canvas-store'
import { useMediaStore } from '../../stores/media-store'
import { useUiStore } from '../../stores/ui-store'
import { nextAccent } from './nodes/accents'
import { useMediaCapabilities } from './useMediaCapabilities'

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
  // 能力门控（M31 修订）：未配置生图 / 生视频时整段生成入口不渲染（含分隔线）
  const { canImage, canVideo, canGenerate } = useMediaCapabilities()
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
  /** M31 修订：失败/中断的生成节点（无 artifact、非 pending、有 error）→ 「重新生成」入口 */
  const genData = node.data as CanvasImageData & CanvasVideoData & { pending?: boolean; error?: string }
  const failedGen =
    (node.type === 'image' || node.type === 'video') && Boolean(genData.error) && genData.pending !== true
  const run = (fn: () => void): void => {
    fn()
    onClose()
  }
  /** M31 修订：按节点存的谱系参数重新生成（输入不齐——如图生图未随节点落存输入图——则回填面板引导补齐） */
  const retryFailedGen = (): void => {
    const params: CanvasGenerationParams | undefined = genData.params
    const capability = params?.capability ?? (node.type === 'video' ? 'text2video' : 'text2image')
    const prompt = genData.prompt?.trim()
    const needsImage = capability === 'image2image' || capability === 'image2video'
    const needsFirstLast = capability === 'firstlast2video'
    const firstFrame = genData.firstFrame
    const lastFrame = genData.lastFrame
    if (!prompt || needsImage || (needsFirstLast && (!firstFrame || !lastFrame))) {
      useMediaStore.getState().openPanel({ prompt: prompt ?? '', params })
      toast.success('已在生成面板回填原参数：请补齐输入后重试')
      return
    }
    void useMediaStore.getState().createJob({
      capability,
      prompt,
      negative: params?.negative,
      model: params?.model,
      inputs: needsFirstLast ? { firstFrame, lastFrame } : undefined,
      params: {
        width: params?.width,
        height: params?.height,
        steps: params?.steps,
        seed: params?.seed,
        duration: params?.duration,
        workflowId: params?.workflowId,
      },
    })
    toast.success('已按原参数重新生成')
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
      {imageArtifact && (canImage || canVideo) && (
        <>
          <MenuItem
            icon={ImagePlus}
            label="用作生成输入"
            onClick={() => run(() => useMediaStore.getState().openPanel({ images: [imageArtifact] }))}
          />
          {canImage && imagePrompt && (
            <MenuItem
              icon={Wand2}
              label="生成变体"
              onClick={() =>
                run(() => useMediaStore.getState().openPanel({ images: [imageArtifact], prompt: imagePrompt }))
              }
            />
          )}
          {canVideo && (
            <>
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
            </>
          )}
          <MenuSep />
        </>
      )}
      {failedGen && canGenerate && <MenuItem icon={RefreshCw} label="重新生成" onClick={() => run(retryFailedGen)} />}
      <MenuItem
        icon={Quote}
        label="引用到对话"
        onClick={() =>
          run(() => {
            useUiStore.getState().insertToComposer(quoteForComposer(node))
            toast.success('已引用到输入框')
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

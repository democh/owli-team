/**
 * 附件托盘（M33）：Composer 输入框上方的待发附件区。
 * - 图片 / 视频显示本地缩略（object URL），其余为类型化文件卡；
 * - 上传中显示进度条，失败标红并在 title 中给出原因；
 * - 点击图片 / 视频打开 Lightbox；× 移除（上传中的项会取消本地预览）。
 */
import * as React from 'react'
import {
  AlertCircle,
  File,
  FileArchive,
  FileSpreadsheet,
  FileText,
  Film,
  Loader2,
  Music,
  Presentation,
  X,
} from 'lucide-react'
import type { MessageAttachment } from '@multi-agent/shared'
import {
  VISUAL_LABEL,
  formatBytes,
  formatDuration,
  type AttachmentVisual,
} from '../../lib/attachments'
import { cn } from '../../lib/utils'

export interface TrayItem {
  /** 本地临时 id（与附件 path 无关） */
  id: string
  name: string
  size: number
  mime: string
  visual: AttachmentVisual
  status: 'uploading' | 'done' | 'error'
  /** 0~1 */
  progress: number
  error?: string
  /** 上传完成后的服务端附件元数据 */
  attachment?: MessageAttachment
  /** 本地 object URL（图片 / 视频缩略；移除或发送后 revoke） */
  localUrl?: string
  width?: number
  height?: number
  durationMs?: number
}

/** 文档类视觉 → lucide 图标 */
const VISUAL_ICON: Record<Exclude<AttachmentVisual, 'image' | 'video'>, React.ComponentType<{ className?: string }>> = {
  audio: Music,
  pdf: FileText,
  word: FileText,
  excel: FileSpreadsheet,
  ppt: Presentation,
  archive: FileArchive,
  text: FileText,
  file: File,
}

/** 文档类视觉 → 图标底色（轻微彩色区分） */
const VISUAL_TONE: Partial<Record<AttachmentVisual, string>> = {
  pdf: 'bg-rose-500/12 text-rose-600',
  word: 'bg-blue-500/12 text-blue-600',
  excel: 'bg-emerald-500/12 text-emerald-600',
  ppt: 'bg-orange-500/12 text-orange-600',
  archive: 'bg-amber-500/12 text-amber-600',
  audio: 'bg-violet-500/12 text-violet-600',
}

/** 元数据行：图片尺寸 / 视频时长与分辨率 / 其余体积 */
function metaLine(item: TrayItem): string {
  if (item.visual === 'video' && item.durationMs) {
    const res = item.width && item.height ? ` · ${item.width}×${item.height}` : ''
    return `${formatDuration(item.durationMs)}${res} · ${formatBytes(item.size)}`
  }
  if (item.visual === 'image' && item.width && item.height) {
    return `${item.width}×${item.height} · ${formatBytes(item.size)}`
  }
  return formatBytes(item.size)
}

export function AttachmentTray({
  items,
  onRemove,
  onOpen,
}: {
  items: TrayItem[]
  onRemove: (id: string) => void
  /** 打开图片 / 视频预览（Lightbox） */
  onOpen: (id: string) => void
}): React.JSX.Element | null {
  if (items.length === 0) return null

  return (
    <div
      className="flex items-stretch gap-2 overflow-x-auto px-2.5 pb-1 pt-2"
      role="list"
      aria-label="待发送附件"
    >
      {items.map((item) => {
        const isMedia = item.visual === 'image' || item.visual === 'video'
        const uploading = item.status === 'uploading'
        const failed = item.status === 'error'

        const removeButton = (
          <button
            type="button"
            aria-label={`移除 ${item.name}`}
            title={failed ? `上传失败：${item.error ?? '未知错误'}（点击移除）` : `移除 ${item.name}`}
            onClick={(e) => {
              e.stopPropagation()
              onRemove(item.id)
            }}
            className={cn(
              'absolute -right-1.5 -top-1.5 z-10 flex size-5 items-center justify-center rounded-full border bg-card text-muted-foreground shadow-sm transition-all hover:border-destructive/40 hover:bg-destructive hover:text-white',
              'opacity-0 group-hover/tray:opacity-100 max-md:opacity-100',
            )}
          >
            <X className="size-2.5" />
          </button>
        )

        if (isMedia) {
          return (
            <div
              key={item.id}
              role="listitem"
              className={cn(
                'group/tray relative size-16 shrink-0 overflow-hidden rounded-lg border bg-muted/40 shadow-sm transition-colors',
                failed ? 'border-destructive/50' : 'border-border hover:border-primary/40',
              )}
            >
              <button
                type="button"
                className="block size-full"
                title={isMedia ? `${item.name}（点击预览）` : item.name}
                onClick={() => !uploading && !failed && onOpen(item.id)}
              >
                {item.localUrl ? (
                  item.visual === 'video' ? (
                    <video src={item.localUrl} preload="metadata" muted playsInline className="size-full object-cover" />
                  ) : (
                    <img src={item.localUrl} alt={item.name} className="size-full object-cover" />
                  )
                ) : (
                  <span className="flex size-full items-center justify-center text-muted-foreground">
                    {item.visual === 'video' ? <Film className="size-5" /> : <FileText className="size-5" />}
                  </span>
                )}
              </button>
              {item.visual === 'video' && item.durationMs && (
                <span className="pointer-events-none absolute bottom-0 right-0 rounded-tl bg-black/60 px-1 py-px text-[9px] font-medium text-white">
                  {formatDuration(item.durationMs)}
                </span>
              )}
              {uploading && (
                <>
                  <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/55">
                    <Loader2 className="size-4 animate-spin text-primary" />
                  </span>
                  <span className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-border">
                    <span
                      className="block h-full bg-primary transition-[width] duration-150"
                      style={{ width: `${Math.round(item.progress * 100)}%` }}
                    />
                  </span>
                </>
              )}
              {failed && (
                <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-destructive/15">
                  <AlertCircle className="size-4 text-destructive" />
                </span>
              )}
              {removeButton}
            </div>
          )
        }

        const Icon = VISUAL_ICON[item.visual as Exclude<AttachmentVisual, 'image' | 'video'>] ?? File
        return (
          <div
            key={item.id}
            role="listitem"
            title={failed ? `${item.name} · 上传失败：${item.error ?? '未知错误'}` : `${item.name} · ${metaLine(item)}`}
            className={cn(
              'group/tray relative flex h-16 w-44 shrink-0 items-center gap-2 rounded-lg border bg-card px-2 shadow-sm transition-colors',
              failed ? 'border-destructive/50' : 'border-border hover:border-primary/40',
            )}
          >
            <span
              className={cn(
                'flex size-8 shrink-0 items-center justify-center rounded-md',
                VISUAL_TONE[item.visual] ?? 'bg-muted text-muted-foreground',
              )}
            >
              {uploading ? <Loader2 className="size-4 animate-spin" /> : <Icon className="size-4" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] font-medium leading-4">{item.name}</span>
              <span className="mt-0.5 flex items-center gap-1 text-[10.5px] text-muted-foreground">
                <span className="shrink-0 rounded-sm bg-muted px-1 py-px text-[9.5px]">{VISUAL_LABEL[item.visual]}</span>
                <span className="truncate">{failed ? '上传失败' : metaLine(item)}</span>
              </span>
            </span>
            {uploading && (
              <span className="pointer-events-none absolute inset-x-1 bottom-1 h-0.5 rounded bg-border">
                <span
                  className="block h-full rounded bg-primary transition-[width] duration-150"
                  style={{ width: `${Math.round(item.progress * 100)}%` }}
                />
              </span>
            )}
            {removeButton}
          </div>
        )
      })}
      <span className="flex shrink-0 items-center pl-0.5 pr-1 text-[10px] text-muted-foreground/70">
        随消息发送
      </span>
    </div>
  )
}

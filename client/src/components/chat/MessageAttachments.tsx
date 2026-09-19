/**
 * 消息内附件原生渲染（M33）——不做 Markdown 降级，按类型给出原生视图：
 * - 图片：网格（1 张大图 / 多张 2~3 列网格）→ 点击 Lightbox（多图左右切换、← → 键）；
 * - 视频：封面式播放器（首帧预览 + 播放按钮 → 内联播放），时长与分辨率角标；
 * - 音频：紧凑播放条；
 * - 文档（PDF / Office / 文本 / 压缩包）：类型化文件卡 → 点击打开右侧交付件预览，附下载按钮。
 */
import * as React from 'react'
import {
  File,
  FileArchive,
  FileSpreadsheet,
  FileText,
  Download,
  Music,
  Play,
  Presentation,
} from 'lucide-react'
import type { MessageAttachment } from '@multi-agent/shared'
import {
  VISUAL_LABEL,
  attachmentUrl,
  attachmentVisual,
  extOfFile,
  formatBytes,
  formatDuration,
  type AttachmentVisual,
} from '../../lib/attachments'
import { useUiStore } from '../../stores/ui-store'
import { cn } from '../../lib/utils'
import { AttachmentLightbox, type LightboxItem } from './AttachmentLightbox'

/** 网格最大展示张数（更多以 +N 覆盖收尾） */
const GRID_MAX = 9

/** 浏览器可直出的视频容器（其余容器降级为文档卡：兼容历史 / 伪造 kind='video' 的 mkv / avi） */
const PLAYABLE_VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'm4v'])

/** 文档类视觉 → 图标 */
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

const VISUAL_TONE: Partial<Record<AttachmentVisual, string>> = {
  pdf: 'bg-rose-500/12 text-rose-600',
  word: 'bg-blue-500/12 text-blue-600',
  excel: 'bg-emerald-500/12 text-emerald-600',
  ppt: 'bg-orange-500/12 text-orange-600',
  archive: 'bg-amber-500/12 text-amber-600',
  audio: 'bg-violet-500/12 text-violet-600',
}

/** 图片网格（含 +N 收尾与 Lightbox） */
function ImageGrid({
  sessionId,
  images,
  onOpen,
}: {
  sessionId: string
  images: MessageAttachment[]
  onOpen: (index: number) => void
}): React.JSX.Element {
  if (images.length === 1) {
    const only = images[0]
    const ratio = only.width && only.height ? `${only.width} / ${only.height}` : undefined
    return (
      <button
        type="button"
        className="block max-w-full overflow-hidden rounded-lg border shadow-sm transition-shadow hover:shadow-md"
        title={`${only.name}（点击放大）`}
        onClick={() => onOpen(0)}
      >
        <img
          src={attachmentUrl(sessionId, only.path)}
          alt={only.name}
          loading="lazy"
          style={ratio ? { aspectRatio: ratio } : undefined}
          className="max-h-64 w-auto max-w-full object-cover"
        />
      </button>
    )
  }
  const shown = images.slice(0, GRID_MAX)
  const rest = images.length - shown.length
  const cols = images.length === 2 ? 'grid-cols-2' : images.length <= 4 ? 'grid-cols-2' : 'grid-cols-3'
  return (
    <div className={cn('grid max-w-md gap-1.5', cols)}>
      {shown.map((img, i) => (
        <button
          key={img.path}
          type="button"
          className="group/img relative aspect-square overflow-hidden rounded-lg border shadow-sm transition-shadow hover:shadow-md"
          title={`${img.name}（点击放大）`}
          onClick={() => onOpen(i)}
        >
          <img
            src={attachmentUrl(sessionId, img.path)}
            alt={img.name}
            loading="lazy"
            className="size-full object-cover transition-transform duration-200 group-hover/img:scale-[1.03]"
          />
          {i === shown.length - 1 && rest > 0 && (
            <span className="absolute inset-0 flex items-center justify-center bg-black/55 text-[15px] font-semibold text-white backdrop-blur-[1px]">
              +{rest}
            </span>
          )}
        </button>
      ))}
    </div>
  )
}

/** 视频：封面式播放器（首帧 + 中央播放键 → 内联 controls 播放） */
function VideoAttachment({ sessionId, att }: { sessionId: string; att: MessageAttachment }): React.JSX.Element {
  const [playing, setPlaying] = React.useState(false)
  const url = attachmentUrl(sessionId, att.path)
  const ratio = att.width && att.height ? `${att.width} / ${att.height}` : '16 / 9'

  if (playing) {
    return (
      <video
        src={url}
        controls
        autoPlay
        playsInline
        className="max-h-80 w-full max-w-md rounded-lg border bg-black shadow-sm"
        style={{ aspectRatio: ratio }}
      />
    )
  }
  return (
    <button
      type="button"
      className="group/vid relative block w-full max-w-md overflow-hidden rounded-lg border bg-black shadow-sm transition-shadow hover:shadow-md"
      style={{ aspectRatio: ratio }}
      title={`${att.name}（点击播放）`}
      onClick={() => setPlaying(true)}
    >
      <video src={url} preload="metadata" muted playsInline className="pointer-events-none size-full object-contain" />
      <span className="absolute inset-0 flex items-center justify-center">
        <span className="flex size-11 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur transition-transform duration-150 group-hover/vid:scale-105">
          <Play className="ml-0.5 size-5 fill-current" />
        </span>
      </span>
      <span className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-black/65 to-transparent px-2.5 pb-1.5 pt-5 text-[10.5px] text-white/90">
        <span className="truncate">{att.name}</span>
        <span className="shrink-0">
          {att.durationMs ? formatDuration(att.durationMs) : ''}
          {att.width && att.height ? ` · ${att.width}×${att.height}` : ''}
        </span>
      </span>
    </button>
  )
}

/** 音频：紧凑播放条 */
function AudioAttachment({ sessionId, att }: { sessionId: string; att: MessageAttachment }): React.JSX.Element {
  return (
    <div className="flex w-full max-w-sm items-center gap-2.5 rounded-lg border bg-card px-3 py-2 shadow-sm">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-violet-500/12 text-violet-600">
        <Music className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] font-medium leading-4">{att.name}</span>
        <audio src={attachmentUrl(sessionId, att.path)} controls className="mt-1 h-8 w-full" />
      </span>
    </div>
  )
}

/** 文档卡：点击打开右侧交付件预览（Office / PDF / 文本 / 压缩包），右侧下载 */
function DocumentCard({ sessionId, att }: { sessionId: string; att: MessageAttachment }): React.JSX.Element {
  const requestArtifact = useUiStore((s) => s.requestArtifact)
  const visual = attachmentVisual(att)
  const Icon = VISUAL_ICON[visual as Exclude<AttachmentVisual, 'image' | 'video'>] ?? File
  const meta = [VISUAL_LABEL[visual], formatBytes(att.size)].join(' · ')
  return (
    <div
      className="flex w-full max-w-sm items-center gap-2.5 rounded-lg border bg-card px-3 py-2 shadow-sm transition-colors hover:border-primary/40"
      title={att.path}
    >
      <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-md', VISUAL_TONE[visual] ?? 'bg-muted text-muted-foreground')}>
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <button
          type="button"
          className="block max-w-full truncate text-left text-[12px] font-medium leading-4 transition-colors hover:text-primary"
          title={`预览 ${att.name}`}
          onClick={() => requestArtifact(att.path)}
        >
          {att.name}
        </button>
        <span className="text-[10.5px] text-muted-foreground">{meta}</span>
      </span>
      <a
        href={attachmentUrl(sessionId, att.path, { download: true })}
        download
        aria-label={`下载 ${att.name}`}
        title="下载"
        onClick={(e) => e.stopPropagation()}
        className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Download className="size-3.5" />
      </a>
    </div>
  )
}

export function MessageAttachments({
  sessionId,
  attachments,
}: {
  sessionId: string
  attachments: MessageAttachment[]
}): React.JSX.Element | null {
  const [lightbox, setLightbox] = React.useState<{ items: LightboxItem[]; index: number } | null>(null)
  if (attachments.length === 0) return null

  const images = attachments.filter((a) => a.kind === 'image')
  const playable = (a: MessageAttachment): boolean =>
    a.kind === 'video' && PLAYABLE_VIDEO_EXT.has(extOfFile(a.name))
  const videos = attachments.filter(playable)
  const audios = attachments.filter(
    (a) => a.kind !== 'image' && a.kind !== 'video' && a.mime.startsWith('audio/'),
  )
  const docs = attachments.filter(
    (a) => a.kind !== 'image' && !playable(a) && !a.mime.startsWith('audio/'),
  )

  const openImages = (index: number): void => {
    setLightbox({
      items: images.map((img) => ({ url: attachmentUrl(sessionId, img.path), name: img.name, kind: 'image' as const })),
      index,
    })
  }

  return (
    <div className="flex flex-col gap-2">
      {images.length > 0 && <ImageGrid sessionId={sessionId} images={images} onOpen={openImages} />}
      {videos.map((v) => (
        <VideoAttachment key={v.path} sessionId={sessionId} att={v} />
      ))}
      {audios.map((a) => (
        <AudioAttachment key={a.path} sessionId={sessionId} att={a} />
      ))}
      {docs.map((d) => (
        <DocumentCard key={d.path} sessionId={sessionId} att={d} />
      ))}
      {lightbox && (
        <AttachmentLightbox
          items={lightbox.items}
          index={lightbox.index}
          onIndexChange={(i) => setLightbox((prev) => (prev ? { ...prev, index: i } : prev))}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  )
}

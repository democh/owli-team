/**
 * M31：视频节点 —— 首帧封面 / 点击播放 / 首尾帧谱系标记 / 失败占位。
 * M31 修订：空态文案按生视频能力门控（未配置时不再引导「连接素材后生成」）；
 * pending 占位（任务创建即落位）→ 呼吸 + 实时进度（服务端结算后原地变产物）。
 */
import * as React from 'react'
import { Clapperboard, Link2, Loader2, Pause, Play, Sparkles, TriangleAlert, Upload } from 'lucide-react'
import type { CanvasVideoData } from '@multi-agent/shared'
import { artifactContentUrl } from '../../../lib/artifacts'
import { useCanvasStore } from '../../../stores/canvas-store'
import { useMediaStore } from '../../../stores/media-store'
import { cn } from '../../../lib/utils'
import { useMediaCapabilities } from '../useMediaCapabilities'
import { NodeShell } from './NodeShell'
import type { CanvasNodeProps } from './types'

const SOURCE_META = {
  generate: { label: '生成', icon: Sparkles },
  upload: { label: '上传', icon: Upload },
  ref: { label: '引用', icon: Link2 },
} as const

/** 生成中占位：呼吸 + 实时进度文案（仅订阅本任务进度字符串，引用稳定不频繁重渲染） */
function PendingHint({ jobId, prompt }: { jobId?: string; prompt?: string }): React.JSX.Element {
  const progressText = useMediaStore((s) => {
    const job = jobId ? s.jobs.find((j) => j.id === jobId) : undefined
    if (!job) return undefined
    return job.progress != null ? `生成中 ${job.progress}%` : (job.progressText ?? '生成中…')
  })
  return (
    <div className="canvas-breath flex h-full flex-col items-center justify-center gap-1.5 px-3 text-center">
      <Loader2 className="size-5 animate-spin text-primary/70" aria-hidden />
      <span className="line-clamp-2 text-[10.5px] leading-4 text-muted-foreground">{progressText ?? '生成中…'}</span>
      {prompt && <span className="line-clamp-1 text-[9.5px] text-muted-foreground/60">{prompt}</span>}
    </div>
  )
}

/** 空态提示：无视频无提示词时按能力给文案（仅空态节点订阅，避免每个视频节点重复订阅） */
function EmptyHint({ prompt }: { prompt?: string }): React.JSX.Element {
  const { canVideo } = useMediaCapabilities()
  return (
    <span className="line-clamp-3 text-[10.5px] leading-4 text-muted-foreground/80">
      {prompt || (canVideo ? '拖入视频，或连接素材后生成' : '拖入视频，或从交付件送上画布')}
    </span>
  )
}

export const VideoNode = React.memo(function VideoNode({ id, data, selected }: CanvasNodeProps): React.JSX.Element {
  const sessionId = useCanvasStore((s) => s.sessionId)
  const d = data as CanvasVideoData
  const videoRef = React.useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = React.useState(false)
  const url = sessionId && d.artifact ? artifactContentUrl(sessionId, d.artifact) : undefined
  const poster = sessionId && d.poster ? artifactContentUrl(sessionId, d.poster) : undefined
  const meta = d.source ? SOURCE_META[d.source] : undefined

  const toggle = (): void => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) void v.play().catch(() => undefined)
    else v.pause()
  }

  return (
    <NodeShell nodeId={id} selected={selected} resizable={{ minWidth: 160, minHeight: 120 }}>
      <div className="flex h-full flex-col overflow-hidden rounded-[inherit]">
        <div className="flex shrink-0 items-center gap-1.5 border-b border-border/60 px-2 py-1 text-[10px] text-muted-foreground">
          {meta ? <meta.icon className="size-3" aria-hidden /> : <Clapperboard className="size-3" aria-hidden />}
          <span>{meta?.label ?? '视频'}</span>
          {d.params?.duration && <span className="ml-auto tabular-nums">{d.params.duration}s</span>}
        </div>
        <div className="relative min-h-0 flex-1 bg-muted/40">
          {url ? (
            <>
              <video
                ref={videoRef}
                src={url}
                poster={poster}
                preload="metadata"
                playsInline
                className="h-full w-full bg-black/85 object-contain"
                onClick={toggle}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
              />
              {!playing && (
                <button
                  type="button"
                  title="播放"
                  aria-label="播放"
                  className="nodrag absolute inset-0 flex items-center justify-center"
                  onClick={(e) => {
                    e.stopPropagation()
                    toggle()
                  }}
                >
                  <span className="flex size-9 items-center justify-center rounded-full border bg-card/85 shadow-sm backdrop-blur transition-transform hover:scale-105">
                    <Play className="size-4 translate-x-[1px]" aria-hidden />
                  </span>
                </button>
              )}
              {playing && (
                <button
                  type="button"
                  title="暂停"
                  aria-label="暂停"
                  className="nodrag absolute right-1.5 top-1.5 flex size-6 items-center justify-center rounded-md bg-card/85 shadow-sm backdrop-blur"
                  onClick={(e) => {
                    e.stopPropagation()
                    toggle()
                  }}
                >
                  <Pause className="size-3" aria-hidden />
                </button>
              )}
              <div className="pointer-events-none absolute bottom-1.5 left-1.5 flex gap-1">
                {d.firstFrame && <FrameTag label="首帧" />}
                {d.lastFrame && <FrameTag label="尾帧" />}
              </div>
            </>
          ) : d.pending ? (
            <PendingHint jobId={d.jobId} prompt={d.prompt} />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-1.5 px-3 text-center">
              <Clapperboard className="size-5 text-muted-foreground/40" aria-hidden />
              <EmptyHint prompt={d.prompt} />
            </div>
          )}
          {d.error && (
            <div className="absolute inset-x-1 top-1 flex items-center gap-1 rounded-md bg-rose-500/90 px-1.5 py-0.5 text-[10px] text-white">
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

function FrameTag({ label }: { label: string }): React.JSX.Element {
  return (
    <span className={cn('rounded bg-card/85 px-1 py-px text-[9px] font-medium text-muted-foreground shadow-sm backdrop-blur')}>
      {label}
    </span>
  )
}

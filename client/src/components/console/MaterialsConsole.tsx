/**
 * M68：素材库管理页面（ActivityRail「素材库」→ 主区全幅视图；全员可见的个人资源）。
 *
 * - 网格：缩略图卡片（图片直显 / 视频取静帧 / 音频音符占位）+ 名称 + 大小 + hover 操作（放入画布 / 下载 / 删除）；
 * - 头部：条目数 + 容量条（用量 / 配额；>80% 琥珀、>95% 玫瑰）+「上传素材」（多选 / 拖拽页面亦可）；
 * - 工具行：搜索（服务端过滤，300ms 防抖）+ 类型筛选（全部 / 图片 / 视频 / 音频）；
 * - 预览：点击卡片 → 灯箱（图片 / 视频 / 音频播放；Esc / 点击遮罩关闭）；
 * - 空态：引导上传（跨会话随取随用）；loading：骨架网格。
 */
import * as React from 'react'
import { Clapperboard, Download, Frame, Image as ImageIcon, Images, Loader2, Music, Search, Trash2, Upload, X } from 'lucide-react'
import type { LibraryItem, LibraryItemKind } from '@multi-agent/shared'
import { cn } from '../../lib/utils'
import { useLibraryStore } from '../../stores/library-store'
import { Button } from '../ui/button'

/** 字节 → 展示（MB / KB） */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

const KIND_FILTERS: Array<{ key: 'all' | LibraryItemKind; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'image', label: '图片' },
  { key: 'video', label: '视频' },
  { key: 'audio', label: '音频' },
]

export function MaterialsConsole(): React.JSX.Element {
  const items = useLibraryStore((s) => s.items)
  const usage = useLibraryStore((s) => s.usage)
  const loading = useLibraryStore((s) => s.loading)
  const uploading = useLibraryStore((s) => s.uploading)
  const [query, setQuery] = React.useState('')
  const [kind, setKind] = React.useState<'all' | LibraryItemKind>('all')
  const [preview, setPreview] = React.useState<LibraryItem | null>(null)
  const [dragActive, setDragActive] = React.useState(false)
  const fileRef = React.useRef<HTMLInputElement>(null)

  // 初次加载 + 查询 / 筛选变化（300ms 防抖）
  const firstLoad = React.useRef(true)
  React.useEffect(() => {
    if (firstLoad.current) {
      firstLoad.current = false
      void useLibraryStore.getState().load()
      return
    }
    const t = window.setTimeout(() => {
      void useLibraryStore.getState().load({ query, kind: kind === 'all' ? undefined : kind })
    }, 300)
    return () => window.clearTimeout(t)
  }, [query, kind])

  // 灯箱 Esc 关闭
  React.useEffect(() => {
    if (!preview) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setPreview(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [preview])

  const onFiles = (files: readonly File[]): void => {
    void useLibraryStore.getState().upload(files)
  }

  const usageMb = usage ? usage.bytes / (1024 * 1024) : 0
  const ratio = usage?.limitMb ? Math.min(usageMb / usage.limitMb, 1) : 0
  const over80 = ratio >= 0.8 && ratio < 0.95
  const over95 = ratio >= 0.95

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 页头 */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <Images className="size-4 text-muted-foreground" />
        <span className="text-[13px] font-semibold">素材库</span>
        <span className="text-[11px] text-muted-foreground">
          {usage ? `${usage.count} 个素材 · 已用 ${formatBytes(usage.bytes)}` : '…'}
        </span>
        {usage?.limitMb && (
          <span className="flex items-center gap-1.5" title={`存储上限 ${usage.limitMb} MB（工作区 + 素材库合计）`}>
            <span className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
              <span
                className={cn('block h-full rounded-full transition-all', over95 ? 'bg-rose-500' : over80 ? 'bg-amber-500' : 'bg-emerald-500')}
                style={{ width: `${Math.max(ratio * 100, 2)}%` }}
              />
            </span>
            <span className={cn('text-[10.5px] tabular-nums', over95 ? 'text-rose-600' : over80 ? 'text-amber-600' : 'text-muted-foreground')}>
              {usageMb.toFixed(1)} / {usage.limitMb} MB
            </span>
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <label className="relative flex items-center gap-1 rounded-md border bg-background px-2 py-1">
            <Search className="size-3.5 text-muted-foreground" aria-hidden />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索素材名…"
              aria-label="搜索素材"
              className="w-40 bg-transparent text-[12px] outline-none placeholder:text-muted-foreground"
            />
            {query && (
              <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setQuery('')} title="清除">
                <X className="size-3" />
              </button>
            )}
          </label>
          <Button size="xs" disabled={uploading > 0} onClick={() => fileRef.current?.click()}>
            {uploading > 0 ? <Loader2 className="mr-1 size-3 animate-spin" /> : <Upload className="mr-1 size-3" />}
            {uploading > 0 ? `上传中 ${uploading}` : '上传素材'}
          </Button>
        </div>
      </div>

      {/* 筛选行 */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b px-4">
        {KIND_FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            className={cn(
              'rounded-full border px-2 py-0.5 text-[11px] transition-colors',
              kind === f.key ? 'border-primary/60 bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
            onClick={() => setKind(f.key)}
          >
            {f.label}
          </button>
        ))}
        <span className="ml-auto text-[10.5px] text-muted-foreground/70">拖拽图片 / 视频 / 音频到本页面即可上传</span>
      </div>

      {/* 内容区（拖拽上传热区） */}
      <div
        className={cn('min-h-0 flex-1 overflow-y-auto p-4', dragActive && 'canvas-drop-active')}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
            setDragActive(true)
          }
        }}
        onDragLeave={(e) => {
          const related = e.relatedTarget
          if (!(related instanceof HTMLElement) || !e.currentTarget.contains(related)) setDragActive(false)
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          setDragActive(false)
          onFiles([...e.dataTransfer.files])
        }}
      >
        {loading && items.length === 0 ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="canvas-breath aspect-[4/3] rounded-xl border bg-muted/40" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <Images className="size-6 text-muted-foreground/40" aria-hidden />
            <p className="text-[12px] text-muted-foreground">
              {query || kind !== 'all' ? '没有匹配的素材' : '还没有素材：上传的图片 / 视频 / 音频会保存在这里，跨会话随取随用'}
            </p>
            {!query && kind === 'all' && (
              <Button size="xs" variant="outline" onClick={() => fileRef.current?.click()}>
                <Upload className="mr-1 size-3" />
                上传素材
              </Button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
            {items.map((item) => (
              <MaterialCard key={item.id} item={item} onPreview={() => setPreview(item)} />
            ))}
          </div>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/*,video/*,audio/*"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = [...(e.target.files ?? [])]
            e.target.value = ''
            if (files.length > 0) onFiles(files)
          }}
        />
      </div>

      {/* 预览灯箱 */}
      {preview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
          onClick={() => setPreview(null)}
          role="dialog"
          aria-label="素材预览"
        >
          <div className="canvas-node-pop flex max-h-full max-w-4xl flex-col overflow-hidden rounded-xl border bg-card" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 border-b px-3 py-1.5">
              <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{preview.name}</span>
              <span className="shrink-0 text-[10.5px] text-muted-foreground">{formatBytes(preview.sizeBytes)}</span>
              <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setPreview(null)} title="关闭（Esc）">
                <X className="size-3.5" />
              </button>
            </div>
            <div className="flex min-h-0 items-center justify-center bg-black/40">
              {preview.kind === 'image' ? (
                <img src={`/api/library/items/${preview.id}/content`} alt={preview.name} className="max-h-[70vh] max-w-full object-contain" />
              ) : preview.kind === 'audio' ? (
                <div className="flex w-[min(480px,80vw)] flex-col items-center gap-4 px-8 py-10">
                  <Music className="size-10 text-muted-foreground/40" aria-hidden />
                  <audio src={`/api/library/items/${preview.id}/content`} controls autoPlay className="w-full" />
                </div>
              ) : (
                <video src={`/api/library/items/${preview.id}/content`} controls autoPlay className="max-h-[70vh] max-w-full" />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** 素材卡片：缩略图 + 名称 + hover 操作（放入画布 / 下载 / 删除） */
function MaterialCard({ item, onPreview }: { item: LibraryItem; onPreview(): void }): React.JSX.Element {
  const busy = useLibraryStore((s) => s.uploading > 0)
  const contentUrl = `/api/library/items/${item.id}/content`
  return (
    <div className="group relative overflow-hidden rounded-xl border bg-card shadow-soft transition-colors hover:border-primary/30">
      <button type="button" className="block w-full" onClick={onPreview} title="预览">
        <span className="flex aspect-[4/3] items-center justify-center overflow-hidden bg-muted/40">
          {item.kind === 'image' ? (
            <img src={contentUrl} alt={item.name} loading="lazy" className="h-full w-full object-cover" draggable={false} />
          ) : item.kind === 'audio' ? (
            // 音频：无静帧可截取，音符占位（播放统一走预览灯箱）
            <Music className="size-7 text-muted-foreground/40" aria-hidden />
          ) : (
            // 视频：静帧取 metadata（无 poster 时浏览器自动取首帧）
            <video src={contentUrl} preload="metadata" muted playsInline className="h-full w-full object-cover">
              <track kind="captions" />
            </video>
          )}
        </span>
      </button>
      <div className="flex items-center gap-1 px-2 py-1.5">
        <span className="text-muted-foreground">
          {item.kind === 'image' ? (
            <ImageIcon className="size-3" />
          ) : item.kind === 'video' ? (
            <Clapperboard className="size-3" />
          ) : (
            <Music className="size-3" />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11.5px]" title={item.name}>
          {item.name}
        </span>
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{formatBytes(item.sizeBytes)}</span>
      </div>
      {/* hover 操作条 */}
      <div className="absolute right-1 top-1 hidden items-center gap-0.5 rounded-md border bg-card/95 p-0.5 shadow-sm backdrop-blur group-hover:flex">
        <button
          type="button"
          title="放入当前会话画布（副本存入会话工作区）"
          className="flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={() => void useLibraryStore.getState().toCanvas(item.id)}
        >
          <Frame className="size-3" />
        </button>
        <a
          href={contentUrl}
          download={item.name}
          title="下载"
          className="flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Download className="size-3" />
        </a>
        <button
          type="button"
          title="删除（不可恢复）"
          disabled={busy}
          className="flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-rose-500/10 hover:text-rose-600 disabled:opacity-40"
          onClick={() => {
            if (window.confirm(`删除素材「${item.name}」？不可恢复。`)) void useLibraryStore.getState().remove(item.id)
          }}
        >
          <Trash2 className="size-3" />
        </button>
      </div>
    </div>
  )
}

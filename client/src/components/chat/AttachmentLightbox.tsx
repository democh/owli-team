/**
 * 附件预览浮层（M33）：图片灯箱与视频播放共用。
 * - 多张媒体时支持左右切换（按钮 / ← → 键），顶部计数；
 * - 复用 md-ext 的 Overlay（portal 到 body、Esc / 遮罩关闭、锁定滚动）。
 */
import * as React from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Overlay } from './md-ext/Overlay'

export interface LightboxItem {
  url: string
  name: string
  kind: 'image' | 'video'
}

export function AttachmentLightbox({
  items,
  index,
  onIndexChange,
  onClose,
}: {
  items: LightboxItem[]
  index: number
  onIndexChange: (next: number) => void
  onClose: () => void
}): React.JSX.Element | null {
  const count = items.length

  React.useEffect(() => {
    if (count <= 1) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowLeft') onIndexChange((index - 1 + count) % count)
      else if (e.key === 'ArrowRight') onIndexChange((index + 1) % count)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [count, index, onIndexChange])

  const item = items[index]
  if (!item) return null

  return (
    <Overlay open title={item.name} onClose={onClose}>
      <div className="relative flex items-center justify-center gap-3">
        {count > 1 && (
          <button
            type="button"
            aria-label="上一张"
            title="上一张（←）"
            onClick={() => onIndexChange((index - 1 + count) % count)}
            className="absolute left-1 z-10 flex size-8 items-center justify-center rounded-full bg-black/45 text-white/90 backdrop-blur transition-colors hover:bg-black/65"
          >
            <ChevronLeft className="size-4" />
          </button>
        )}
        {item.kind === 'image' ? (
          <img src={item.url} alt={item.name} className="max-h-[78vh] max-w-full rounded-lg object-contain shadow-2xl" />
        ) : (
          <video src={item.url} controls autoPlay className="max-h-[78vh] max-w-full rounded-lg shadow-2xl" />
        )}
        {count > 1 && (
          <button
            type="button"
            aria-label="下一张"
            title="下一张（→）"
            onClick={() => onIndexChange((index + 1) % count)}
            className="absolute right-1 z-10 flex size-8 items-center justify-center rounded-full bg-black/45 text-white/90 backdrop-blur transition-colors hover:bg-black/65"
          >
            <ChevronRight className="size-4" />
          </button>
        )}
      </div>
      {count > 1 && (
        <div className="mt-2 text-center text-[11px] text-white/70">
          {index + 1} / {count}
        </div>
      )}
    </Overlay>
  )
}

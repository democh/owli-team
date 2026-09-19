/**
 * M65-B0：studio 懒加载边界——three 栈的唯一入口。
 *
 * 纪律（§6.2 红线）：three / @react-three/* 只允许在本文件（及其 load 回调内）被引用；
 * 其余任何文件引用 3D 能力必须经 `StudioSurface`（React.lazy + Suspense）。
 * chunk 归属由 vite.config.ts 的 `THREE_STACK_RE` → 'three-stack' 保证；
 * 卸载即释放（React.lazy 的模块缓存仍在，重开秒开，不重建 WebGL 之外的依赖图）。
 */
import * as React from 'react'
import { Loader2 } from 'lucide-react'
import type { StudioCanvasProps } from './StudioCanvas'

const LazyStudioCanvas = React.lazy(async () => {
  const mod = await import('./StudioCanvas')
  return { default: mod.StudioCanvas }
})

export type StudioSurfaceProps = StudioCanvasProps & {
  /** 渗透到画布容器的类名（尺寸由调用方给定；画布撑满容器） */
  className?: string
}

/** studio 3D 面（懒加载 + 骨架屏）——调用方负责给容器尺寸；scene 直通画布 */
export function StudioSurface({ className, ...canvasProps }: StudioSurfaceProps): React.JSX.Element {
  return (
    <React.Suspense
      fallback={
        <div className={className} data-studio-loading>
          <div className="flex h-full items-center justify-center gap-2 text-[12px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            正在加载 3D 工作台…
          </div>
        </div>
      }
    >
      <div className={className} data-studio-surface>
        <LazyStudioCanvas {...canvasProps} />
      </div>
    </React.Suspense>
  )
}

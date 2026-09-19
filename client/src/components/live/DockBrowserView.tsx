/**
 * 直播窗 · 浏览器 tab（M22+）：帧流直出 + 当前步骤 + 应急接管 + 跳右栏。
 * 与右栏 BrowserPanel 共用 browser-store：帧 / 步骤 / 接管状态零同步成本地一致。
 */
import * as React from 'react'
import { Hand, Loader2, PanelRight, RotateCcw } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useBrowserFrameInput } from '../../lib/frame-input'
import { useBrowserStore } from '../../stores/browser-store'
import { useLiveDockStore } from '../../stores/live-dock-store'
import { useSessionStore } from '../../stores/session-store'
import { useUiStore } from '../../stores/ui-store'
import { Button } from '../ui/button'

export function DockBrowserView(): React.JSX.Element {
  const currentId = useSessionStore((s) => s.currentId)
  const session = useBrowserStore((s) => s.session)
  const loadedFor = useBrowserStore((s) => s.sessionId)
  const frame = useBrowserStore((s) => s.frame)
  const steps = useBrowserStore((s) => s.steps)
  const mode = useBrowserStore((s) => s.mode)
  const streamStatus = useBrowserStore((s) => s.streamStatus)
  const busy = useBrowserStore((s) => s.busy)
  const imgRef = React.useRef<HTMLImageElement>(null)
  const wrapRef = React.useRef<HTMLDivElement>(null)
  const input = useBrowserFrameInput(wrapRef, imgRef)

  // 懒加载：直播窗独立于右栏打开时也能就位（与右栏共用的数据源）
  React.useEffect(() => {
    if (currentId && loadedFor !== currentId) void useBrowserStore.getState().load(currentId)
  }, [currentId, loadedFor])

  const frameSrc = React.useMemo(() => (frame ? `data:image/jpeg;base64,${frame.data}` : undefined), [frame])
  const last = steps.length > 0 ? steps[steps.length - 1] : undefined

  if (!session) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
        <p className="text-[11.5px] leading-relaxed text-muted-foreground">当前会话暂无浏览器</p>
        <Button size="xs" disabled={!currentId || busy} onClick={() => void useBrowserStore.getState().start().catch(() => undefined)}>
          {busy && <Loader2 className="mr-1 size-3 animate-spin" />}
          打开浏览器
        </Button>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 帧画面 + 输入通道 */}
      <div
        ref={wrapRef}
        tabIndex={0}
        className={cn(
          'relative min-h-0 flex-1 overflow-hidden bg-slate-900/95 outline-none',
          mode === 'takeover' ? 'cursor-crosshair ring-1 ring-inset ring-violet-500/40' : 'cursor-pointer',
        )}
        onMouseDown={input.onMouseDown}
        onMouseUp={input.onMouseUp}
        onMouseMove={input.onMouseMove}
        onKeyDown={input.onKeyDown}
        onContextMenu={input.onContextMenu}
      >
        {frameSrc ? (
          <img ref={imgRef} src={frameSrc} alt="浏览器画面" className="block h-full w-full select-none object-contain" draggable={false} />
        ) : (
          <div className="flex h-full items-center justify-center text-[11.5px] text-slate-300">
            {streamStatus === 'open' ? '等待首帧…' : '未连接帧流'}
          </div>
        )}
        {mode !== 'takeover' && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-center gap-1 bg-gradient-to-t from-slate-900/80 to-transparent px-2 pb-1 pt-4 text-[10px] text-slate-200">
            点击画面即可接管
          </div>
        )}
      </div>

      {/* 当前步骤 + 接管 */}
      <div className="flex shrink-0 items-center gap-1.5 border-t px-2 py-1.5">
        <span
          className={cn(
            'shrink-0 rounded-full border px-1.5 text-[9.5px]',
            last?.actor === 'human' ? 'border-violet-500/30 text-violet-700' : 'border-sky-500/25 text-sky-700',
          )}
        >
          {last ? (last.actor === 'human' ? '人工' : 'Agent') : '待操作'}
        </span>
        <span className="min-w-0 flex-1 truncate text-[10.5px]" title={last?.detail ?? last?.url}>
          {last
            ? `${last.seq} · ${last.action}${last.durationMs !== undefined ? ` · ${last.durationMs >= 1000 ? `${(last.durationMs / 1000).toFixed(1)}s` : `${last.durationMs}ms`}` : ''}`
            : '等待 Agent 操作…'}
        </span>
        {mode === 'takeover' ? (
          <Button size="xs" variant="secondary" disabled={busy} onClick={() => void useBrowserStore.getState().release()}>
            <RotateCcw className="mr-1 size-3" />
            归还给 Agent
          </Button>
        ) : (
          <Button
            size="xs"
            variant="outline"
            disabled={busy || session.state === 'closed'}
            onClick={() => void useBrowserStore.getState().takeover().catch(() => undefined)}
          >
            <Hand className="mr-1 size-3" />
            人工接管
          </Button>
        )}
        <Button
          size="xs"
          variant="ghost"
          title="在右栏「实况」中查看（步骤时间轴 / 截图证据）"
          onClick={() => {
            useUiStore.getState().setRightView('live')
            useLiveDockStore.getState().minimize()
          }}
        >
          <PanelRight className="size-3" />
        </Button>
      </div>
    </div>
  )
}

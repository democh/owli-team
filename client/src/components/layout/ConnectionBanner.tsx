/**
 * 断线提示条（M8）：WS 通知未连通时常驻提示 + 「立即重连」。
 * open 时不渲染；connecting 为轻提示（首次连接会出现一瞬）。
 */
import * as React from 'react'
import { Loader2, PlugZap, WifiOff } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useWsStore } from '../../stores/ws-store'

export function ConnectionBanner(): React.JSX.Element | null {
  const status = useWsStore((s) => s.status)
  const reconnect = useWsStore((s) => s.reconnect)

  if (status === 'open') return null

  const connecting = status === 'connecting'
  return (
    <div
      role="status"
      className={cn(
        'flex h-7 shrink-0 items-center justify-center gap-2 border-b text-[11.5px]',
        connecting ? 'bg-amber-500/10 text-amber-700' : 'bg-rose-500/10 text-rose-700',
      )}
    >
      {connecting ? <Loader2 className="size-3 animate-spin" /> : <WifiOff className="size-3" />}
      {connecting ? '实时通知连接中…（已自动降级为轮询，功能不受影响）' : '实时通知已断开，已降级为轮询，功能不受影响'}
      {!connecting && (
        <button
          type="button"
          onClick={() => reconnect()}
          className="inline-flex items-center gap-1 rounded border border-current/30 px-1.5 py-0.5 transition-colors hover:bg-rose-500/10"
        >
          <PlugZap className="size-3" />
          立即重连
        </button>
      )}
    </div>
  )
}

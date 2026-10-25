/** 已提交到本地待发箱的消息；失败在原条目重试，正文不会重新塞回输入框。 */
import * as React from 'react'
import { Loader2, RotateCcw, X } from 'lucide-react'
import { toast } from 'sonner'
import { useOutboxStore } from '../../stores/outbox-store'
import { useAuthStore } from '../../stores/auth-store'

export function PendingMessages({ sessionId }: { sessionId?: string }): React.JSX.Element | null {
  const ownerId = useAuthStore((s) => s.user?.id) ?? ''
  const items = useOutboxStore((s) => s.items)
  React.useEffect(() => {
    const store = useOutboxStore.getState()
    store.restore()
    const flush = (): void => {
      for (const sid of new Set(useOutboxStore.getState().items.map((m) => m.sessionId)))
        void useOutboxStore.getState().flush(sid)
    }
    const sync = (event: StorageEvent): void => {
      if (event.key?.startsWith('ma:outbox:')) useOutboxStore.getState().restore()
    }
    flush()
    window.addEventListener('online', flush)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener('online', flush)
      window.removeEventListener('storage', sync)
    }
  }, [ownerId])
  const pending = items.filter((m) => m.sessionId === sessionId && m.ownerId === ownerId)
  if (!pending.length) return null
  const act = (fn: () => void): void => {
    try {
      fn()
    } catch (err) {
      toast.error((err as Error).message)
    }
  }
  return (
    <div className="max-h-48 shrink-0 space-y-2 overflow-y-auto border-t px-4 py-2" aria-label="待发送消息">
      {pending.map((item) => (
        <div key={item.id} className="ml-auto w-fit max-w-[85%] rounded-xl bg-primary/10 px-3 py-2 text-sm">
          <p className="whitespace-pre-wrap break-words">{item.content}</p>
          {!!item.attachments?.length && (
            <p className="text-xs text-muted-foreground">
              附件：{item.attachments.map((a) => a.name).join('、')}
            </p>
          )}
          <div
            className="mt-1 flex items-center justify-end gap-2 text-xs text-muted-foreground"
            role="status"
          >
            {item.status === 'sending' ? (
              <>
                <Loader2 className="size-3 animate-spin" />
                发送中…
              </>
            ) : item.status === 'queued' ? (
              '等待发送（离线或前序消息待处理）'
            ) : (
              <span className="text-destructive">{item.error ?? '发送失败'}</span>
            )}
            {item.status !== 'sending' && (
              <>
                <button
                  type="button"
                  aria-label="重试发送"
                  title="使用同一提交标识重试，不重复创建消息"
                  onClick={() => act(() => useOutboxStore.getState().retry(item.id))}
                >
                  <RotateCcw className="size-3.5" />
                </button>
                <button
                  type="button"
                  aria-label="移出待发箱"
                  title="仅移出本地待发箱，不撤回可能已送达的消息"
                  onClick={() => act(() => useOutboxStore.getState().discard(item.id))}
                >
                  <X className="size-3.5" />
                </button>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

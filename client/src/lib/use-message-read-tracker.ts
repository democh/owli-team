/** 已读水位取消息真实 DOM 位置，而不是虚拟列表的 overscan 或已加载最大序号。 */
import * as React from 'react'
import type { ChatMessage } from '@multi-agent/shared'
import { useSessionStore } from '../stores/session-store'
import { useWsStore } from '../stores/ws-store'

export function visibleMessageSeq(root: HTMLElement, messages: ReadonlyMap<string, ChatMessage>): number {
  const viewport = root.getBoundingClientRect()
  if (viewport.height <= 0 || viewport.width <= 0) return 0
  let seq = 0
  for (const node of root.querySelectorAll<HTMLElement>('[id^="msg-"]')) {
    const bounds = node.getBoundingClientRect()
    // 读到消息底边才确认，超长消息及位于视口外的预渲染消息不会提前已读。
    if (bounds.height <= 0 || bounds.bottom <= viewport.top || bounds.bottom > viewport.bottom + 1) continue
    if (bounds.right <= viewport.left || bounds.left >= viewport.right) continue
    const message = messages.get(node.id.slice(4))
    if (message?.status === 'streaming') continue
    seq = Math.max(seq, message?.seq ?? 0)
  }
  return seq
}

export function useMessageReadTracker(
  rootRef: React.RefObject<HTMLElement>,
  sessionId: string | undefined,
  order: string[],
  enabled = true,
): void {
  React.useEffect(() => {
    const root = rootRef.current
    if (!root || !sessionId || !enabled) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = (): void => {
      timer = undefined
      if (document.visibilityState !== 'visible' || !document.hasFocus()) return
      const state = useSessionStore.getState()
      if (state.currentId !== sessionId || state.loadingMessages) return
      const seq = visibleMessageSeq(root, state.byId)
      if (seq > 0) useWsStore.getState().markRead(sessionId, seq)
    }
    const schedule = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(read, 250)
    }
    const intersection =
      typeof IntersectionObserver === 'undefined'
        ? undefined
        : new IntersectionObserver(schedule, { root, threshold: [0, 0.5, 1] })
    const observe = (): void => {
      intersection?.disconnect()
      for (const node of root.querySelectorAll('[id^="msg-"]')) intersection?.observe(node)
      schedule()
    }
    const mutation = new MutationObserver(observe)
    mutation.observe(root, { childList: true, subtree: true })
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule)
    resize?.observe(root)
    root.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('focus', schedule)
    document.addEventListener('visibilitychange', schedule)
    observe()
    return () => {
      clearTimeout(timer)
      mutation.disconnect()
      intersection?.disconnect()
      resize?.disconnect()
      root.removeEventListener('scroll', schedule)
      window.removeEventListener('focus', schedule)
      document.removeEventListener('visibilitychange', schedule)
    }
  }, [rootRef, sessionId, order, enabled])
}

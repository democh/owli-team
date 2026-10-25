import { toast } from 'sonner'
import { attachActiveRunFor, useRunStore } from '../stores/run-store'
import { useSessionStore } from '../stores/session-store'
import { useUiStore } from '../stores/ui-store'
import { useWsStore } from '../stores/ws-store'

/** 用户导航必须同时更新数据与可见视图；启动恢复可显式保留原页面。 */
export async function openConversation(id: string, options: { reveal?: boolean } = {}): Promise<boolean> {
  const ui = useUiStore.getState()
  if (options.reveal !== false) {
    if (!ui.setAppView('workspace')) return false
    ui.setMainTab('chat')
    ui.setSessionDrawer(false)
    const session = useSessionStore.getState().sessions.find((item) => item.id === id)
    if (session && ui.sessionFilter !== 'all') {
      ui.setSessionFilter(session.kind === 'direct' || session.kind === 'group' ? 'chat' : 'team')
    }
  }
  ui.clearFocus()
  useRunStore.getState().detach()
  const pending = useSessionStore.getState().selectSession(id)
  const version = useSessionStore.getState().selectionVersion
  const isCurrent = (): boolean => {
    const state = useSessionStore.getState()
    return state.currentId === id && state.selectionVersion === version
  }
  try {
    await pending
    if (!isCurrent() || useSessionStore.getState().messageLoadError) return false
    useWsStore.getState().ensureSubscribed(id)
    // 已读水位由消息可见性跟踪器上报，导航本身不把未看到的消息标为已读。
    await attachActiveRunFor(id)
    return isCurrent()
  } catch (err) {
    if (isCurrent()) toast.error(err instanceof Error ? err.message : '会话加载失败')
    return false
  }
}

export function openContacts(): boolean {
  const ui = useUiStore.getState()
  if (!ui.setAppView('workspace')) return false
  ui.setMainTab('chat')
  ui.setLeftPanelOpen(true)
  ui.setLeftTab('contacts')
  ui.setSessionDrawer(true)
  return true
}

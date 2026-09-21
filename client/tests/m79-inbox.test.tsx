/**
 * M79-I 客户端测试：通知中心（持久收件箱 UI 落点）。
 *
 * 覆盖：
 * - 门控：兼容模式（multiUser=false）不渲染；
 * - 徽章 + 面板列表（类型标签 / 未读点 / 时间）；
 * - 会话类条目点击 → 单项已读上报（POST /inbox/read ids）+ 打开会话（GET /api/sessions/:id）+ 面板关闭；
 * - 好友类条目点击 → 切联系人页签；
 * - 「全部已读」→ POST upTo + 徽章清零；
 * - 联系人面板打开 → 仅好友申请类自动已读（邀请 / 提及保留未读）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, cleanup, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { InboxItem } from '@multi-agent/shared'

vi.mock('sonner', () => {
  const toastFn = vi.fn()
  return { toast: Object.assign(toastFn, { error: vi.fn(), success: vi.fn(), info: vi.fn() }) }
})

import { InboxPanel } from '../src/components/layout/InboxPanel'
import { ContactsPanel } from '../src/components/contacts/ContactsPanel'
import { useAuthStore } from '../src/stores/auth-store'
import { useFriendsStore } from '../src/stores/friends-store'
import { useInboxStore } from '../src/stores/inbox-store'
import { useSessionStore } from '../src/stores/session-store'
import { useUiStore } from '../src/stores/ui-store'

const fetchMock = vi.fn()

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

function item(partial: Partial<InboxItem> & { id: string; seq: number }): InboxItem {
  return {
    type: 'system',
    title: '通知',
    createdAt: '2026-09-20T00:00:00.000Z',
    ...partial,
  }
}

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation((url: string) => {
    const u = String(url)
    if (u.includes('/messages')) return Promise.resolve(jsonResponse({ messages: [] }))
    if (/\/api\/sessions\/[^/?]+$/.test(u)) {
      const id = u.split('/').pop()
      return Promise.resolve(jsonResponse({ session: { id, title: '会话', participantIds: [] }, messages: [], humanNames: {}, humanProfiles: {} }))
    }
    if (u === '/api/friends') return Promise.resolve(jsonResponse({ friends: [] }))
    if (u === '/api/friends/requests') return Promise.resolve(jsonResponse({ incoming: [], outgoing: [] }))
    return Promise.resolve(jsonResponse({}))
  })
  vi.stubGlobal('fetch', fetchMock)
  useAuthStore.setState({
    user: { id: 'u_me', username: 'alice', displayName: 'Alice', role: 'member' },
    isAdmin: false,
    status: { needsSetup: false, authRequired: true, multiUser: true },
  })
  useInboxStore.getState().reset()
  useUiStore.setState({ leftTab: 'sessions', leftPanelOpen: true, sessionFilter: 'all' })
  useSessionStore.setState({ currentId: undefined, sessions: [], byId: new Map(), order: [] })
  useFriendsStore.getState().reset()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('M79-I：通知中心', () => {
  it('兼容模式不渲染；未读徽章与类型标签（多用户）', async () => {
    useAuthStore.setState({ status: { needsSetup: false, authRequired: false, multiUser: false } })
    const first = render(<InboxPanel />)
    expect(first.container.querySelector('[title^="通知中心"]')).toBeNull()
    first.unmount()

    useAuthStore.setState({ status: { needsSetup: false, authRequired: true, multiUser: true } })
    useInboxStore.setState({
      items: [
        item({ id: 'ib_1', seq: 1, type: 'friend-request', title: 'Bob 请求添加你为好友', readAt: '2026-09-20T00:01:00.000Z' }),
        item({ id: 'ib_2', seq: 2, type: 'mention', title: 'Bob 在「团队甲」提到了你', sessionId: 's_1' }),
      ],
      cursor: 2,
      unreadCount: 1,
    })
    render(<InboxPanel />)
    expect(screen.getByTitle('通知中心（1 条未读）')).toBeTruthy()
    await userEvent.setup().click(screen.getByTitle('通知中心（1 条未读）'))
    expect(screen.getByText('Bob 在「团队甲」提到了你')).toBeTruthy()
    expect(screen.getByText('好友申请')).toBeTruthy()
    expect(screen.getByText('提及')).toBeTruthy()
    // 仅未读项带未读点
    expect(screen.getAllByLabelText('未读')).toHaveLength(1)
  })

  it('会话类条目点击：单项已读上报 + 打开会话 + 面板关闭', async () => {
    useInboxStore.setState({
      items: [item({ id: 'ib_m', seq: 1, type: 'mention', title: 'Bob 提到了你', sessionId: 's_9' })],
      cursor: 1,
      unreadCount: 1,
    })
    const user = userEvent.setup()
    render(<InboxPanel />)
    await user.click(screen.getByTitle('通知中心（1 条未读）'))
    await user.click(screen.getByText('Bob 提到了你'))

    await waitFor(() => {
      const readCall = fetchMock.mock.calls.find(([u, i]) => String(u) === '/api/inbox/read' && (i as RequestInit)?.method === 'POST')
      expect(readCall).toBeTruthy()
      expect(JSON.parse((readCall![1] as RequestInit).body as string)).toEqual({ ids: ['ib_m'] })
    })
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/sessions/s_9'))).toBe(true)
    })
    // 面板关闭 + 本地已读
    expect(screen.queryByText('全部已读')).toBeNull()
    expect(useInboxStore.getState().unreadCount).toBe(0)
  })

  it('好友类条目点击 → 切联系人页签；全部已读 → upTo 上报 + 徽章清零', async () => {
    useInboxStore.setState({
      items: [item({ id: 'ib_f', seq: 1, type: 'friend-accepted', title: 'Bob 已同意你的好友申请' })],
      cursor: 1,
      unreadCount: 1,
    })
    const user = userEvent.setup()
    render(<InboxPanel />)
    await user.click(screen.getByTitle('通知中心（1 条未读）'))
    await user.click(screen.getByText('Bob 已同意你的好友申请'))
    await waitFor(() => {
      expect(useUiStore.getState().leftTab).toBe('contacts')
      expect(useUiStore.getState().leftPanelOpen).toBe(true)
    })

    // 再放一条未读 → 全部已读（等待 store 变更 flush 到视图）
    await act(async () => {
      useInboxStore.setState({
        items: [item({ id: 'ib_x', seq: 2, type: 'waiting', title: '艾达在「团队乙」等你回复', sessionId: 's_2' })],
        cursor: 2,
        unreadCount: 1,
      })
    })
    await waitFor(() => expect(screen.getByTitle('通知中心（1 条未读）')).toBeTruthy())
    await user.click(screen.getByTitle('通知中心（1 条未读）'))
    await user.click(screen.getByRole('button', { name: /全部已读/ }))
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([u, i]) => String(u) === '/api/inbox/read' && (i as RequestInit)?.method === 'POST' && JSON.parse((i as RequestInit).body as string).upTo === 2,
      )
      expect(call).toBeTruthy()
    })
    expect(useInboxStore.getState().unreadCount).toBe(0)
    expect(screen.getByTitle('通知中心')).toBeTruthy()
  })
})

describe('M79-I：联系人面板 ack 收敛', () => {
  it('打开联系人：仅好友申请类自动已读；邀请 / 提及保留未读', async () => {
    useInboxStore.setState({
      items: [
        item({ id: 'ib_fr', seq: 1, type: 'friend-request', title: 'Bob 请求添加你为好友' }),
        item({ id: 'ib_mt', seq: 2, type: 'mention', title: 'Bob 提到了你', sessionId: 's_1' }),
      ],
      cursor: 2,
      unreadCount: 2,
    })
    render(<ContactsPanel onSelectSession={vi.fn()} />)
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u, i]) => String(u) === '/api/inbox/read' && (i as RequestInit)?.method === 'POST')
      expect(call).toBeTruthy()
      expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({ ids: ['ib_fr'] })
    })
    expect(useInboxStore.getState().unreadCount).toBe(1) // 提及保留
    expect(useInboxStore.getState().items.find((i) => i.id === 'ib_mt')?.readAt).toBeUndefined()
  })
})

/**
 * M79-C 客户端测试：联系人面板 + 好友 store + WS 帧归约。
 *
 * 覆盖：
 * - 请求区（接受 / 拒绝 → 对应端点 + 重拉后列表收敛）；
 * - 好友列表（在线点 / 头衔 / 移除二次确认 → DELETE）；
 * - 搜索（防抖 → 关系态按钮：加好友 → POST 请求）；
 * - ws-store：notify:friends-changed → 重拉；notify:presence → 在线点就地更新。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('sonner', () => {
  const toastFn = vi.fn()
  return { toast: Object.assign(toastFn, { error: vi.fn(), success: vi.fn(), info: vi.fn() }) }
})

import type { NotifyEnvelope } from '@multi-agent/shared'
import { ContactsPanel } from '../src/components/contacts/ContactsPanel'
import { useFriendsStore } from '../src/stores/friends-store'
import { handleNotify } from '../src/stores/ws-store'

const fetchMock = vi.fn()

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

const BOB_FRIEND = {
  userId: 'u_bob',
  username: 'bob',
  displayName: 'Bob',
  headline: '工程',
  online: true,
}
const CAROL_REQUEST = {
  id: 'fl_carol',
  direction: 'in' as const,
  user: { userId: 'u_carol', username: 'carol', displayName: 'Carol' },
  message: '一起协作',
  createdAt: '2026-09-20T00:00:00.000Z',
}
const DAVE_OUTGOING = {
  id: 'fl_dave',
  direction: 'out' as const,
  user: { userId: 'u_dave', username: 'dave', displayName: 'Dave' },
  createdAt: '2026-09-20T00:00:00.000Z',
}

let friendsPayload: { friends: unknown[] }
let requestsPayload: { incoming: unknown[]; outgoing: unknown[] }

beforeEach(() => {
  fetchMock.mockReset()
  friendsPayload = { friends: [BOB_FRIEND] }
  requestsPayload = { incoming: [CAROL_REQUEST], outgoing: [DAVE_OUTGOING] }
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    if (u === '/api/friends') return Promise.resolve(jsonResponse(friendsPayload))
    if (u === '/api/sessions') return Promise.resolve(jsonResponse({ sessions: [] }))
    if (u === '/api/friends/requests' && method === 'GET') return Promise.resolve(jsonResponse(requestsPayload))
    if (u === '/api/friends/requests' && method === 'POST') return Promise.resolve(jsonResponse({ ok: true }, 201))
    if (u.startsWith('/api/users/search')) {
      return Promise.resolve(
        jsonResponse({
          users: [
            { userId: 'u_ali', username: 'alice2', displayName: 'Alice2', headline: '设计', relation: 'none' },
            { userId: 'u_bob', username: 'bob', displayName: 'Bob', relation: 'accepted' },
          ],
        }),
      )
    }
    if (u === '/api/chats/group' && method === 'POST') return Promise.resolve(jsonResponse({ session: { id: 's_group' } }, 201))
    if (u.includes('/accept')) {
      // 接受后：请求区清空 + carol 进入好友列表
      requestsPayload = { incoming: [], outgoing: [DAVE_OUTGOING] }
      friendsPayload = { friends: [BOB_FRIEND, { userId: 'u_carol', username: 'carol', displayName: 'Carol', online: false }] }
      return Promise.resolve(jsonResponse({ ok: true }))
    }
    if (u.includes('/reject')) return Promise.resolve(jsonResponse({ ok: true }))
    if (method === 'DELETE') {
      friendsPayload = { friends: [] }
      return Promise.resolve(jsonResponse({ ok: true }))
    }
    return Promise.resolve(jsonResponse({}))
  })
  vi.stubGlobal('fetch', fetchMock)
  useFriendsStore.getState().reset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('M79-C：ContactsPanel', () => {
  it('请求区 / 好友列表渲染；接受 → 端点调用 + 列表收敛', async () => {
    const user = userEvent.setup()
    render(<ContactsPanel onSelectSession={vi.fn()} />)
    // 请求区：Carol + 附言；好友列表：Bob + 头衔 + 在线点
    expect(await screen.findByText('Carol')).toBeTruthy()
    expect(screen.getByText('一起协作')).toBeTruthy()
    expect(screen.getByText('Bob')).toBeTruthy()
    expect(screen.getByLabelText('在线')).toBeTruthy()
    expect(screen.getByText(/工程 · @bob/)).toBeTruthy()
    // 已发出请求折叠行
    expect(screen.getByText(/已发出 1 条请求/)).toBeTruthy()

    await user.click(screen.getByRole('button', { name: '接受' }))
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([u]) => String(u) === '/api/friends/requests/fl_carol/accept')).toBe(true)
    })
    // 重拉后：请求区消失（收起），Carol 进入好友列表
    await waitFor(() => {
      expect(screen.queryByText('一起协作')).toBeNull()
      expect(useFriendsStore.getState().friends.map((f) => f.userId)).toEqual(['u_bob', 'u_carol'])
    })
  })

  it('搜索防抖 → 结果关系态按钮；加好友 → POST 请求', async () => {
    const user = userEvent.setup()
    render(<ContactsPanel onSelectSession={vi.fn()} />)
    await screen.findByText('Bob')

    await user.type(screen.getByPlaceholderText('搜索用户（用户名 / 昵称）'), 'ali')
    const aliceRow = await screen.findByText('Alice2')
    const row = aliceRow.closest('div')!.parentElement!.parentElement! // 行容器
    await user.click(within(row).getByRole('button', { name: /加好友/ }))
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u, i]) => String(u) === '/api/friends/requests' && (i as RequestInit)?.method === 'POST')
      expect(call).toBeTruthy()
      expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({ userId: 'u_ali' })
    })
  })

  it('移除二次确认 → DELETE /friends/:id', async () => {
    const user = userEvent.setup()
    render(<ContactsPanel onSelectSession={vi.fn()} />)
    await screen.findByText('Bob')

    await user.click(screen.getByTitle('移除好友'))
    await user.click(screen.getByRole('button', { name: '确认移除' }))
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u, i]) => String(u) === '/api/friends/u_bob' && (i as RequestInit)?.method === 'DELETE')
      expect(call).toBeTruthy()
    })
  })

  it('新建群聊：好友多选 → POST /chats/group 载荷契约 + 创建后切换会话', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<ContactsPanel onSelectSession={onSelect} />)
    await screen.findByText('Bob')

    await user.click(screen.getByRole('button', { name: /新建群聊/ }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByText('Bob'))
    await user.click(within(dialog).getByRole('button', { name: /创建（1 人）/ }))
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u, i]) => String(u) === '/api/chats/group' && (i as RequestInit)?.method === 'POST')
      expect(call).toBeTruthy()
      const body = JSON.parse((call![1] as RequestInit).body as string) as { memberIds: string[] }
      expect(body.memberIds).toEqual(['u_bob'])
    })
    // 会话列表重拉 + 切换由 loadSessions/onSelect 承接
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('s_group'))
  })
})

describe('M79-C：ws-store 好友帧归约', () => {
  it('notify:friends-changed → 重拉；notify:presence → 在线点就地更新', async () => {
    const envelope = (type: NotifyEnvelope['type'], payload: Record<string, unknown>): NotifyEnvelope => ({
      v: 1,
      id: `n_${Math.random().toString(36).slice(2, 8)}`,
      seq: 0,
      ts: new Date().toISOString(),
      sessionId: 'u:u_me',
      type,
      payload,
    })
    const before = fetchMock.mock.calls.length
    handleNotify(envelope('notify:friends-changed', { userId: 'u_bob', action: 'request' }))
    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(before)
      expect(fetchMock.mock.calls.some(([u]) => String(u) === '/api/friends')).toBe(true)
    })
    await vi.waitFor(() => expect(useFriendsStore.getState().friends).toHaveLength(1))

    handleNotify(envelope('notify:presence', { users: [{ userId: 'u_bob', online: false, lastSeenAt: '2026-09-20T00:00:00.000Z' }] }))
    expect(useFriendsStore.getState().friends[0]).toMatchObject({ userId: 'u_bob', online: false })
  })
})

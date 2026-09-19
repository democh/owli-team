/**
 * M57 P2 客户端测试：会话共享（share-store + ShareDialog + ws-store 分支）。
 * - share-store：load / invite / setRole / remove / leave 的请求形状与视图回写；
 * - ShareDialog：属主可邀请与改角色；成员无邀请表单可自助退出（退出后刷新列表并离开当前会话）；
 * - 兼容模式（multiUser=false）：提示需先完成管理员设置；
 * - ws-store：notify:share-changed → 刷新列表；当前会话已不可见 → 清空 + 提示。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { NotifyEnvelope } from '@multi-agent/shared'

vi.mock('sonner', () => {
  const toastFn = vi.fn()
  return { toast: Object.assign(toastFn, { error: vi.fn(), success: vi.fn(), info: vi.fn() }) }
})

import { toast } from 'sonner'
import { ShareDialog } from '../src/components/sessions/ShareDialog'
import { MessageItem } from '../src/components/chat/MessageItem'
import { useAuthStore } from '../src/stores/auth-store'
import { useSessionStore } from '../src/stores/session-store'
import { useShareStore } from '../src/stores/share-store'
import { handleNotify, useWsStore } from '../src/stores/ws-store'

const fetchMock = vi.fn()

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

const SID = 's_share1'
const ME = { id: 'u_me', username: 'alice', displayName: 'Alice', role: 'member' as const }
const OWNER = { userId: 'u_own', username: 'root', displayName: 'Root' }
const BOB = {
  userId: 'u_bob',
  username: 'bob',
  displayName: 'Bob',
  role: 'editor' as const,
  createdAt: '2026-09-19T00:00:00.000Z',
}
const VIEW = { owner: OWNER, members: [BOB] }

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  ;(toast.error as ReturnType<typeof vi.fn>).mockClear?.()
  ;(toast.info as unknown as ReturnType<typeof vi.fn>).mockClear?.()
  useShareStore.setState({ sessionId: undefined, view: null, loading: false, busy: false })
  useSessionStore.setState({ sessions: [], currentId: undefined })
  useAuthStore.setState({
    status: { needsSetup: false, authRequired: true, multiUser: true },
    user: ME,
  })
})

describe('M57 P2 share-store：请求形状与视图回写', () => {
  it('load / invite / setRole / remove / leave 全链路', async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = []
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (method === 'GET') return jsonResponse(VIEW)
      if (method === 'DELETE') return jsonResponse({ ...VIEW, members: [] })
      if (url.endsWith('/leave')) return jsonResponse({ ok: true })
      if (method === 'POST') return jsonResponse({ ...VIEW, members: [BOB, { ...BOB, userId: 'u_cara', username: 'cara' }] })
      return jsonResponse({ ...VIEW, members: [{ ...BOB, role: 'viewer' }] })
    })

    const store = useShareStore.getState()
    await store.load(SID)
    expect(useShareStore.getState().view?.owner?.displayName).toBe('Root')
    expect(calls[0]).toMatchObject({ url: `/api/sessions/${SID}/shares`, method: 'GET' })

    await useShareStore.getState().invite(SID, 'cara', 'editor')
    expect(calls[1]).toMatchObject({ method: 'POST', body: { username: 'cara', role: 'editor' } })
    expect(useShareStore.getState().view?.members.map((m) => m.username)).toEqual(['bob', 'cara'])

    await useShareStore.getState().setRole(SID, 'u_bob', 'viewer')
    expect(calls[2]).toMatchObject({ method: 'PATCH', body: { role: 'viewer' } })
    expect(useShareStore.getState().view?.members[0]?.role).toBe('viewer')

    await useShareStore.getState().remove(SID, 'u_bob')
    expect(calls[3]?.method).toBe('DELETE')
    expect(useShareStore.getState().view?.members).toHaveLength(0)

    await useShareStore.getState().leave(SID)
    expect(calls[4]).toMatchObject({ url: `/api/sessions/${SID}/leave`, method: 'POST' })
    expect(useShareStore.getState().view).toBeNull()
  })
})

describe('M57 P2 ShareDialog：角色视图', () => {
  it('属主：成员列表 + 邀请表单；改角色/移出按钮可用', async () => {
    useAuthStore.setState({ user: { ...ME, id: 'u_own' } }) // 我是属主
    fetchMock.mockImplementation(async () => jsonResponse(VIEW))
    render(<ShareDialog sessionId={SID} open onOpenChange={() => {}} />)
    await waitFor(() => expect(screen.getByText('Root')).toBeTruthy())
    expect(screen.getByText('Bob')).toBeTruthy()
    expect(screen.getByText('@bob')).toBeTruthy()
    expect(screen.getByText('邀请成员（按用户名）')).toBeTruthy()
    expect(screen.getByText('改为只读')).toBeTruthy()
    expect(screen.getByRole('button', { name: '邀请' })).toBeTruthy()
  })

  it('成员（editor）：无邀请表单，可自助退出（刷新列表并离开当前会话）', async () => {
    const myShare = { ...BOB, userId: 'u_me', username: 'alice', displayName: 'Alice', role: 'editor' as const }
    const memberView = { owner: OWNER, members: [BOB, myShare] }
    useShareStore.setState({ sessionId: SID, view: memberView, loading: false, busy: false })
    useSessionStore.setState({ currentId: SID, sessions: [{ id: SID, title: 'T' } as never] })
    const onOpenChange = vi.fn()
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/leave')) return jsonResponse({ ok: true })
      if (url.includes('/shares')) return jsonResponse(memberView) // 面板打开时的加载
      // 退出后刷新列表：会话已不可见
      return jsonResponse({ sessions: [] })
    })
    render(<ShareDialog sessionId={SID} open onOpenChange={onOpenChange} />)
    await waitFor(() => expect(screen.getByText('退出共享')).toBeTruthy())
    expect(screen.queryByText('邀请成员（按用户名）')).toBeNull()
    await userEvent.click(screen.getByText('退出共享'))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(useSessionStore.getState().currentId).toBeUndefined()
    expect(toast.success).toHaveBeenCalled()
  })

  it('兼容模式（multiUser=false）：提示需先启用多用户', () => {
    useAuthStore.setState({ status: { needsSetup: false, authRequired: false, multiUser: false } })
    render(<ShareDialog sessionId={SID} open onOpenChange={() => {}} />)
    expect(screen.getByText(/共享需先在「账号 → 创建管理员并启用多用户」完成初始化/)).toBeTruthy()
  })
})

describe('M57 P2 消息气泡：人类署名', () => {
  it('共享会话：他人消息显示昵称；自己的消息仍为「你」', () => {
    useAuthStore.setState({ user: { ...ME } })
    const base = {
      sessionId: SID,
      role: 'user' as const,
      content: '内容',
      mentions: [],
      status: 'complete' as const,
      createdAt: '2026-09-19T00:00:00.000Z',
    }
    const otherMsg = { ...base, id: 'm_other', userId: 'u_bob' }
    const mineMsg = { ...base, id: 'm_mine', userId: 'u_me' }
    useSessionStore.setState({
      currentId: SID,
      humanNames: { u_bob: 'Bob' },
      byId: new Map([
        [otherMsg.id, otherMsg],
        [mineMsg.id, mineMsg],
      ]),
      order: [otherMsg.id, mineMsg.id],
    })
    render(
      <>
        <MessageItem messageId={otherMsg.id} />
        <MessageItem messageId={mineMsg.id} />
      </>,
    )
    expect(screen.getByText('Bob')).toBeTruthy()
    expect(screen.getAllByText('你')).toHaveLength(1)
  })

  it('兼容模式（userId 缺省 / 无署名表）：全部仍为「你」', () => {
    useAuthStore.setState({ user: { ...ME, legacy: true } })
    const msg = {
      id: 'm_legacy',
      sessionId: SID,
      role: 'user' as const,
      content: '旧消息',
      mentions: [],
      status: 'complete' as const,
      createdAt: '2026-09-19T00:00:00.000Z',
    }
    useSessionStore.setState({ currentId: SID, humanNames: {}, byId: new Map([[msg.id, msg]]), order: [msg.id] })
    render(<MessageItem messageId={msg.id} />)
    expect(screen.getAllByText('你')).toHaveLength(1)
  })
})

describe('M57 P2 ws-store：notify:share-changed', () => {
  it('刷新会话列表；当前会话已被移出 → 清空并提示', async () => {
    useSessionStore.setState({ currentId: SID, sessions: [{ id: SID, title: 'T' } as never] })
    fetchMock.mockImplementation(async () => jsonResponse({ sessions: [] }))
    const env: NotifyEnvelope = {
      v: 1,
      id: 'n-share-1',
      seq: 9001,
      ts: '2026-09-19T00:00:00.000Z',
      type: 'notify:share-changed',
      sessionId: SID,
      payload: { sessionId: SID, userId: 'u_me', action: 'removed' },
    }
    handleNotify(env)
    await waitFor(() => expect(useSessionStore.getState().currentId).toBeUndefined())
    expect(toast.info).toHaveBeenCalled()
    void useWsStore // 保持导入（handleNotify 为模块级导出）
  })
})

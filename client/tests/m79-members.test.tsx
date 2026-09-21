/**
 * M79-F 客户端测试：群成员弹窗 / 多人协作静默引导 / 会话筛选 chip。
 *
 * 覆盖：
 * - ChatMembersDialog（group）：成员名单渲染（群主徽章 / 头衔 / 账号）；邀请好友选择器
 *   （候选 = 好友 − 已在场）→ POST /shares（role 恒 editor）→ 重拉后新成员入列；
 * - 群主移出：二次确认 → DELETE /shares/:userId；
 * - ShareDialog 静默引导：team 会话已有成员且 routeMode=auto → 提示行；「开启」→ PATCH routeMode
 *   → 提示消失（applySession 生效）；
 * - SessionList：筛选 chip（团队 / 聊天；默认第一个「团队」选中，无「全部」项，再点同类取消）过滤会话列表。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('sonner', () => {
  const toastFn = vi.fn()
  return { toast: Object.assign(toastFn, { error: vi.fn(), success: vi.fn(), info: vi.fn() }) }
})

import type { Session, SessionSummary } from '@multi-agent/shared'
import { ChatMembersDialog } from '../src/components/sessions/ChatMembersDialog'
import { ShareDialog } from '../src/components/sessions/ShareDialog'
import { SessionList } from '../src/components/sessions/SessionList'
import { useAuthStore } from '../src/stores/auth-store'
import { useFriendsStore } from '../src/stores/friends-store'
import { useSessionStore } from '../src/stores/session-store'
import { useShareStore } from '../src/stores/share-store'
import { useUiStore } from '../src/stores/ui-store'
import { useWsStore } from '../src/stores/ws-store'

const fetchMock = vi.fn()

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

const ME = { id: 'u_me', username: 'alice', displayName: 'Alice', role: 'member' as const }

/** 可变共享视图（模拟服务端真相随写操作更新） */
let shareView: {
  owner?: { userId: string; username: string; displayName: string; headline?: string }
  members: Array<{ userId: string; username: string; displayName: string; headline?: string; role: 'editor' | 'viewer'; createdAt: string }>
}

function sessionOf(partial: Partial<Session> & { id: string }): Session {
  return {
    title: 'T',
    participantIds: [],
    kind: 'group',
    ownerId: ME.id,
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
    ...partial,
  }
}

/** 列表用摘要（SessionSummary = Session + messageCount） */
const summaryOf = (partial: Partial<Session> & { id: string }): SessionSummary => ({ ...sessionOf(partial), messageCount: 0 })

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    if (u.endsWith('/shares') && method === 'GET') return Promise.resolve(jsonResponse(shareView))
    if (u.endsWith('/shares') && method === 'POST') {
      const body = JSON.parse(String(init!.body)) as { username: string; role: 'editor' | 'viewer' }
      shareView = {
        ...shareView,
        members: [
          ...shareView.members,
          { userId: `u_${body.username}`, username: body.username, displayName: body.username === 'dave' ? 'Dave' : body.username, role: body.role, createdAt: '2026-09-20T00:00:00.000Z' },
        ],
      }
      return Promise.resolve(jsonResponse(shareView, 201))
    }
    if (u.includes('/shares/') && method === 'DELETE') {
      const userId = u.split('/shares/')[1]!
      shareView = { ...shareView, members: shareView.members.filter((m) => m.userId !== userId) }
      return Promise.resolve(jsonResponse(shareView))
    }
    if (u.match(/\/api\/sessions\/[^/]+$/) && method === 'PATCH') {
      const body = JSON.parse(String(init!.body)) as Record<string, unknown>
      const id = u.split('/').pop()!
      const current = useSessionStore.getState().sessions.find((s) => s.id === id)!
      return Promise.resolve(jsonResponse({ session: { ...current, ...body } }))
    }
    if (u === '/api/friends') {
      return Promise.resolve(
        jsonResponse({
          friends: [
            { userId: 'u_dave', username: 'dave', displayName: 'Dave', headline: '设计', online: false },
          ],
        }),
      )
    }
    if (u === '/api/friends/requests') return Promise.resolve(jsonResponse({ incoming: [], outgoing: [] }))
    // 退出 / 解散后的列表对账（loadSessions）
    if (u === '/api/sessions' && method === 'GET') return Promise.resolve(jsonResponse({ sessions: [] }))
    return Promise.resolve(jsonResponse({}))
  })
  vi.stubGlobal('fetch', fetchMock)
  useAuthStore.setState({
    user: { ...ME },
    isAdmin: false,
    status: { needsSetup: false, authRequired: true, multiUser: true },
  })
  useShareStore.setState({ sessionId: undefined, view: null, loading: false, busy: false })
  useWsStore.setState({ presenceMap: {} })
  useFriendsStore.getState().reset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('M79-F：ChatMembersDialog（群）', () => {
  it('成员名单渲染（群主徽章 / 头衔）；邀请好友 → POST /shares（editor）→ 新成员入列', async () => {
    shareView = {
      owner: { userId: ME.id, username: 'alice', displayName: 'Alice' },
      members: [{ userId: 'u_bob', username: 'bob', displayName: 'Bob', headline: '工程', role: 'editor', createdAt: '2026-09-20T00:00:00.000Z' }],
    }
    const session = sessionOf({ id: 's_g', title: '群聊' })
    const user = userEvent.setup()
    render(<ChatMembersDialog session={session} open onOpenChange={vi.fn()} />)

    // 名单：Alice（群主 + 我）与 Bob（头衔 + 账号）
    expect(await screen.findByText('Alice')).toBeTruthy()
    expect(screen.getByText('群主')).toBeTruthy()
    expect(screen.getByText('Bob')).toBeTruthy()
    expect(screen.getByText('工程')).toBeTruthy() // 头衔 chip
    expect(screen.getByText('@bob')).toBeTruthy()

    // 候选 = 好友 Dave（已在场的 Bob / 本人不在候选）
    expect(await screen.findByText('Dave')).toBeTruthy()
    expect(screen.getByRole('button', { name: /邀请（0 人）/ })).toBeDisabled()
    await user.click(screen.getByText('Dave'))
    await user.click(screen.getByRole('button', { name: /邀请（1 人）/ }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u, i]) => String(u).endsWith('/shares') && (i as RequestInit)?.method === 'POST')
      expect(call).toBeTruthy()
      expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({ username: 'dave', role: 'editor' })
    })
    // 重拉后：Dave 进入成员名单；候选空态
    await waitFor(() => {
      expect(screen.getByText('好友都已在群里（或还没有好友）')).toBeTruthy()
    })
  })

  it('群主移出：二次确认 → DELETE /shares/:userId', async () => {
    shareView = {
      owner: { userId: ME.id, username: 'alice', displayName: 'Alice' },
      members: [{ userId: 'u_bob', username: 'bob', displayName: 'Bob', role: 'editor', createdAt: '2026-09-20T00:00:00.000Z' }],
    }
    const session = sessionOf({ id: 's_g', title: '群聊' })
    const user = userEvent.setup()
    render(<ChatMembersDialog session={session} open onOpenChange={vi.fn()} />)
    await screen.findByText('Bob')

    await user.click(screen.getByTitle('移出成员'))
    await user.click(screen.getByRole('button', { name: '确认移出' }))
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u, i]) => String(u).includes('/shares/u_bob') && (i as RequestInit)?.method === 'DELETE')
      expect(call).toBeTruthy()
    })
    await waitFor(() => {
      expect(screen.queryByText('@bob')).toBeNull()
    })
  })

  it('M79-G：成员行在线点（presenceMap 同会话成员可见；未知 = 离线灰）', async () => {
    shareView = {
      owner: { userId: ME.id, username: 'alice', displayName: 'Alice' },
      members: [{ userId: 'u_bob', username: 'bob', displayName: 'Bob', role: 'editor', createdAt: '2026-09-20T00:00:00.000Z' }],
    }
    useWsStore.setState({ presenceMap: { u_bob: true } })
    render(<ChatMembersDialog session={sessionOf({ id: 's_g', title: '群聊' })} open onOpenChange={vi.fn()} />)
    await screen.findByText('Bob')
    expect(screen.getByLabelText('在线')).toBeTruthy() // Bob
    expect(screen.getByLabelText('离线')).toBeTruthy() // Alice 未知 → 灰
  })
})

describe('群管理补全：退出群聊 / 解散群聊', () => {
  it('成员视角：显示「退出群聊」→ 二次确认 → POST /leave；群主不显示该按钮', async () => {
    shareView = {
      owner: { userId: 'u_zoe', username: 'zoe', displayName: 'Zoe' },
      members: [{ userId: ME.id, username: 'alice', displayName: 'Alice', role: 'editor', createdAt: '2026-09-20T00:00:00.000Z' }],
    }
    const onOpenChange = vi.fn()
    const user = userEvent.setup()
    render(<ChatMembersDialog session={sessionOf({ id: 's_g', title: '群聊' })} open onOpenChange={onOpenChange} />)
    await screen.findByText('Zoe')

    // 成员视角：可见「退出群聊」；不可见「解散群聊」与「移出成员」
    await user.click(screen.getByRole('button', { name: '退出群聊' }))
    expect(screen.queryByRole('button', { name: '解散群聊' })).toBeNull()
    expect(screen.queryByTitle('移出成员')).toBeNull()
    // 未确认不发请求
    expect(fetchMock.mock.calls.some(([u, i]) => String(u).includes('/leave') && (i as RequestInit)?.method === 'POST')).toBe(false)

    await user.click(screen.getByRole('button', { name: '确认退出' }))
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u, i]) => String(u) === '/api/sessions/s_g/leave' && (i as RequestInit)?.method === 'POST')
      expect(call).toBeTruthy()
    })
    // 退出后：关闭弹窗
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it('群主视角：显示「解散群聊」→ 二次确认 → DELETE /api/sessions/:id；成员不显示', async () => {
    shareView = {
      owner: { userId: ME.id, username: 'alice', displayName: 'Alice' },
      members: [{ userId: 'u_bob', username: 'bob', displayName: 'Bob', role: 'editor', createdAt: '2026-09-20T00:00:00.000Z' }],
    }
    const onOpenChange = vi.fn()
    const user = userEvent.setup()
    render(<ChatMembersDialog session={sessionOf({ id: 's_g', title: '群聊' })} open onOpenChange={onOpenChange} />)
    await screen.findByText('Bob')

    await user.click(screen.getByRole('button', { name: '解散群聊' }))
    expect(screen.queryByRole('button', { name: '退出群聊' })).toBeNull()
    // 未确认不发请求
    expect(fetchMock.mock.calls.some(([u, i]) => String(u) === '/api/sessions/s_g' && (i as RequestInit)?.method === 'DELETE')).toBe(false)

    await user.click(screen.getByRole('button', { name: '确认解散' }))
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u, i]) => String(u) === '/api/sessions/s_g' && (i as RequestInit)?.method === 'DELETE')
      expect(call).toBeTruthy()
    })
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })
})

describe('M79-F：ShareDialog 静默引导', () => {
  it('team 会话已有成员且 auto → 提示行；开启 → PATCH routeMode=mention → 提示消失', async () => {
    shareView = {
      owner: { userId: ME.id, username: 'alice', displayName: 'Alice' },
      members: [{ userId: 'u_bob', username: 'bob', displayName: 'Bob', role: 'editor', createdAt: '2026-09-20T00:00:00.000Z' }],
    }
    useSessionStore.setState({
      sessions: [summaryOf({ id: 's_t', title: '团队会话', kind: 'team' })],
      currentId: 's_t',
      byId: new Map(),
      order: [],
    })
    const user = userEvent.setup()
    render(<ShareDialog sessionId="s_t" open onOpenChange={vi.fn()} />)

    const hint = await screen.findByText(/多人协作建议开启「仅点名唤起」/)
    expect(hint).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '开启' }))
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u, i]) => String(u) === '/api/sessions/s_t' && (i as RequestInit)?.method === 'PATCH')
      expect(call).toBeTruthy()
      expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({ routeMode: 'mention' })
    })
    await waitFor(() => {
      expect(screen.queryByText(/多人协作建议开启「仅点名唤起」/)).toBeNull()
      expect(useSessionStore.getState().sessions[0]?.routeMode).toBe('mention')
    })
  })
})

describe('M79-N：ShareDialog 好友快捷邀请', () => {
  it('从好友选择：列出未在场好友，点选即邀（POST /shares editor）', async () => {
    shareView = {
      owner: { userId: ME.id, username: 'alice', displayName: 'Alice' },
      members: [{ userId: 'u_bob', username: 'bob', displayName: 'Bob', role: 'editor', createdAt: '2026-09-20T00:00:00.000Z' }],
    }
    useSessionStore.setState({
      sessions: [summaryOf({ id: 's_t', title: '团队会话', kind: 'team' })],
      currentId: 's_t',
      byId: new Map(),
      order: [],
    })
    const user = userEvent.setup()
    render(<ShareDialog sessionId="s_t" open onOpenChange={vi.fn()} />)

    // 好友 dave 未在场 → chip 可见（Bob 已在场不出现）；M79-R：勾选 + 批量按钮
    const chip = await screen.findByTitle('选择 Dave（可协作（读写））')
    expect(screen.queryByTitle(/选择 Bob（/)).toBeNull()
    await user.click(chip)
    await user.click(screen.getByRole('button', { name: /邀请（1 人）/ }))
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([u, i]) => String(u).endsWith('/shares') && (i as RequestInit)?.method === 'POST',
      )
      expect(call).toBeTruthy()
      expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({ username: 'dave', role: 'editor' })
    })
  })
})

describe('M79-F：SessionList 筛选 chip', () => {
  it('默认选中第一个「团队」；点「聊天」过滤；再点同类取消恢复全部', async () => {
    useSessionStore.setState({
      sessions: [
        summaryOf({ id: 's_t', title: '团队甲', kind: 'team' }),
        summaryOf({ id: 's_d', title: '私聊乙', kind: 'direct' }),
        summaryOf({ id: 's_g', title: '群聊丙', kind: 'group' }),
      ],
      currentId: undefined,
      byId: new Map(),
      order: [],
    })
    // 初始默认 = 第一个 chip「团队」（与 ui-store 初值一致）：打开即过滤，无需点选
    useUiStore.setState({ leftTab: 'sessions', sessionFilter: 'team' })
    const user = userEvent.setup()
    render(<SessionList onSelect={vi.fn()} />)

    // 无「全部」chip；默认「团队」：仅团队会话可见
    expect(screen.queryByRole('button', { name: '全部' })).toBeNull()
    expect(screen.getByText('团队甲')).toBeTruthy()
    expect(screen.queryByText('私聊乙')).toBeNull()
    expect(screen.queryByText('群聊丙')).toBeNull()

    await user.click(screen.getByRole('button', { name: '聊天' }))
    expect(screen.queryByText('团队甲')).toBeNull()
    expect(screen.getByText('私聊乙')).toBeTruthy()
    expect(screen.getByText('群聊丙')).toBeTruthy()

    // 再点「聊天」取消筛选 → 恢复全部
    await user.click(screen.getByRole('button', { name: '聊天' }))
    expect(screen.getByText('团队甲')).toBeTruthy()
    expect(screen.getByText('私聊乙')).toBeTruthy()
    expect(screen.getByText('群聊丙')).toBeTruthy()

    // 点「团队」→ 仅团队（三态切换闭环）
    await user.click(screen.getByRole('button', { name: '团队' }))
    expect(screen.getByText('团队甲')).toBeTruthy()
    expect(screen.queryByText('私聊乙')).toBeNull()
    expect(screen.queryByText('群聊丙')).toBeNull()
  })
})

describe('M79-R：ShareDialog 移出二次确认', () => {
  it('点『移出共享』进入确认态（不删除）；『确认移出』后才 DELETE；取消则不删除', async () => {
    shareView = {
      owner: { userId: ME.id, username: 'alice', displayName: 'Alice' },
      members: [{ userId: 'u_bob', username: 'bob', displayName: 'Bob', role: 'editor', createdAt: '2026-09-20T00:00:00.000Z' }],
    }
    useSessionStore.setState({
      sessions: [summaryOf({ id: 's_t', title: '团队会话', kind: 'team' })],
      currentId: 's_t',
      byId: new Map(),
      order: [],
    })
    const user = userEvent.setup()
    render(<ShareDialog sessionId="s_t" open onOpenChange={vi.fn()} />)
    await screen.findByText('Bob')

    const deleted = (): boolean =>
      fetchMock.mock.calls.some(
        ([u, i]) => String(u).includes('/shares/u_bob') && (i as RequestInit)?.method === 'DELETE',
      )

    // 进入确认态：未删除；取消还原
    await user.click(screen.getByTitle('移出共享'))
    expect(deleted()).toBe(false)
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.getByTitle('移出共享')).toBeTruthy()

    // 确认移出：DELETE 发出
    await user.click(screen.getByTitle('移出共享'))
    await user.click(screen.getByRole('button', { name: '确认移出' }))
    await waitFor(() => expect(deleted()).toBe(true))
  })
})

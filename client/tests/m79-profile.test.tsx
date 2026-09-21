/**
 * M79-B 客户端测试：资料卡与人类画像渲染。
 *
 * 覆盖：
 * - MyProfileCard：初值回填 / 色块选择 / 保存载荷契约（含 null 清除）/ 成功后 auth-store 就地更新；
 * - MessageItem：他人人类消息显示画像（头衔 + emoji 头像），自己消息维持「你」且不渲染头像。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('sonner', () => {
  const toastFn = vi.fn()
  return { toast: Object.assign(toastFn, { error: vi.fn(), success: vi.fn(), info: vi.fn() }) }
})

import { MessageItem } from '../src/components/chat/MessageItem'
import { HumanAvatar } from '../src/components/chat/HumanAvatar'
import { MyProfileCard, MyPrivacyCard } from '../src/components/settings/MyProfileCard'
import { useAuthStore } from '../src/stores/auth-store'
import { useSessionStore } from '../src/stores/session-store'

const fetchMock = vi.fn()

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  useAuthStore.setState({
    phase: 'ready',
    user: { id: 'u_me', username: 'alice', displayName: 'Alice', role: 'member', headline: '产品经理' },
    isAdmin: false,
    status: { needsSetup: false, authRequired: true, multiUser: true },
  })
  useSessionStore.setState({ currentId: undefined, sessions: [], order: [], byId: new Map(), humanNames: {}, humanProfiles: {} })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('M79-B：MyProfileCard', () => {
  it('初值回填；选色块保存 → PATCH 载荷契约；成功后 auth-store 就地更新', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url) === '/api/auth/profile' && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        return Promise.resolve(
          jsonResponse({
            user: { id: 'u_me', username: 'alice', displayName: body.displayName, role: 'member', headline: body.headline, avatar: body.avatar },
          }),
        )
      }
      return Promise.resolve(jsonResponse({}))
    })
    const user = userEvent.setup()
    render(<MyProfileCard />)

    // 初值回填（显示名 / 头衔）
    expect((screen.getByDisplayValue('Alice') as HTMLInputElement).value).toBe('Alice')
    expect((screen.getByDisplayValue('产品经理') as HTMLInputElement).value).toBe('产品经理')

    // 选色块（第二个预设色 '#8b5cf6'）
    await user.click(screen.getByRole('button', { name: '色块' }))
    await user.click(screen.getByRole('button', { name: '头像色 #8b5cf6' }))
    await user.click(screen.getByRole('button', { name: /保存资料/ }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u]) => String(u) === '/api/auth/profile')
      expect(call).toBeTruthy()
      const body = JSON.parse((call![1] as RequestInit).body as string) as Record<string, unknown>
      expect(body).toMatchObject({
        displayName: 'Alice',
        headline: '产品经理',
        avatar: { kind: 'color', value: '#8b5cf6' },
      })
    })
    // auth-store 就地更新（头像落位）
    await waitFor(() => {
      expect(useAuthStore.getState().user?.avatar).toEqual({ kind: 'color', value: '#8b5cf6' })
    })
  })

  it('头像模式「默认」保存 → avatar: null（清除）；emoji 非法（多字符）拦截', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ user: { id: 'u_me', username: 'alice', displayName: 'Alice', role: 'member' } })))
    const user = userEvent.setup()
    render(<MyProfileCard />)
    await user.click(screen.getByRole('button', { name: /保存资料/ }))
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u]) => String(u) === '/api/auth/profile')
      const body = JSON.parse((call![1] as RequestInit).body as string) as Record<string, unknown>
      expect(body.avatar).toBeNull()
    })

    // emoji 模式多字符 → 本地拦截（不发请求）
    const before = fetchMock.mock.calls.length
    await user.click(screen.getByRole('button', { name: 'emoji' }))
    await user.type(screen.getByPlaceholderText(/输入一个 emoji/), 'ab')
    await user.click(screen.getByRole('button', { name: /保存资料/ }))
    await new Promise((r) => setTimeout(r, 30))
    expect(fetchMock.mock.calls.length).toBe(before)
  })
})

describe('M79-B：MessageItem 人类画像渲染', () => {
  it('他人消息显示头衔与 emoji 头像；自己消息仍为「你」且无头像', () => {
    const other = {
      id: 'm_other',
      sessionId: 's1',
      role: 'user' as const,
      userId: 'u_bob',
      content: '大家看下这个方案',
      mentions: [],
      status: 'complete' as const,
      createdAt: '2026-09-20T00:00:00.000Z',
    }
    const mine = { ...other, id: 'm_mine', userId: 'u_me', content: '收到' }
    useSessionStore.setState({
      currentId: 's1',
      byId: new Map([
        [other.id, other],
        [mine.id, mine],
      ]),
      order: [other.id, mine.id],
      humanNames: { u_bob: 'Bob' },
      humanProfiles: { u_bob: { name: 'Bob', headline: '工程', avatar: { kind: 'emoji', value: '🛠' } } },
    })
    render(
      <>
        <MessageItem messageId={other.id} />
        <MessageItem messageId={mine.id} />
      </>,
    )
    expect(screen.getByText('Bob')).toBeTruthy()
    expect(screen.getByText('工程')).toBeTruthy() // 头衔
    expect(screen.getByText('🛠')).toBeTruthy() // emoji 头像
    expect(screen.getAllByText('你')).toHaveLength(1) // 自己消息

    // M79-N：气泡宽度按内容自适应（w-fit）——他人消息容器为 flex-1，缺 w-fit 时短文本被拉到全宽
    const bubble = document.querySelector(`#msg-${other.id} .w-fit`)
    expect(bubble).toBeTruthy()
    expect(bubble!.className).toContain('max-w-full')
  })

  it('无画像时回退 humanNames 昵称（零回归）', () => {
    const msg = {
      id: 'm_plain',
      sessionId: 's1',
      role: 'user' as const,
      userId: 'u_carol',
      content: 'hello',
      mentions: [],
      status: 'complete' as const,
      createdAt: '2026-09-20T00:00:00.000Z',
    }
    useSessionStore.setState({
      currentId: 's1',
      byId: new Map([[msg.id, msg]]),
      order: [msg.id],
      humanNames: { u_carol: 'Carol' },
      humanProfiles: {},
    })
    render(<MessageItem messageId={msg.id} />)
    expect(screen.getByText('Carol')).toBeTruthy()
  })
})

describe('M79-J（§14.9）：MyPrivacyCard 隐私开关', () => {
  it('回填服务端偏好；切换 → PUT 载荷契约；失败回滚', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url)
      if (u === '/api/auth/preferences' && (!init || !init.method || init.method === 'GET')) {
        return Promise.resolve(jsonResponse({ preferences: { searchable: false, allowFriendRequests: true } }))
      }
      if (u === '/api/auth/preferences' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        return Promise.resolve(jsonResponse({ preferences: { searchable: true, allowFriendRequests: true, ...body } }))
      }
      return Promise.resolve(jsonResponse({}))
    })
    const user = userEvent.setup()
    render(<MyPrivacyCard />)

    const searchSwitch = await screen.findByRole('switch', { name: '允许他人搜索到我' })
    await waitFor(() => expect(searchSwitch.getAttribute('aria-checked')).toBe('false'))
    expect(screen.getByRole('switch', { name: '允许好友申请' }).getAttribute('aria-checked')).toBe('true')

    await user.click(searchSwitch)
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, i]) => (i as RequestInit)?.method === 'PUT')
      expect(call).toBeTruthy()
      expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({ searchable: true })
    })
    await waitFor(() => expect(screen.getByRole('switch', { name: '允许他人搜索到我' }).getAttribute('aria-checked')).toBe('true'))

    // 失败回滚（下一次切换服务端 500）
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url) === '/api/auth/preferences' && init?.method === 'PUT') {
        return Promise.resolve(jsonResponse({ error: '服务端错误' }, 500))
      }
      return Promise.resolve(jsonResponse({ preferences: {} }))
    })
    await user.click(screen.getByRole('switch', { name: '允许好友申请' }))
    await waitFor(() => expect(screen.getByRole('switch', { name: '允许好友申请' }).getAttribute('aria-checked')).toBe('true'))
  })
})

describe('M79-Q：图片头像', () => {
  it('HumanAvatar：image 渲染 <img>；加载失败回退首字', async () => {
    const { fireEvent } = await import('@testing-library/react')
    const { container } = render(<HumanAvatar avatar={{ kind: 'image', value: '/api/avatars/u_x-1.png' }} name="Dave" />)
    const img = container.querySelector('img')
    expect(img?.getAttribute('src')).toBe('/api/avatars/u_x-1.png')
    fireEvent.error(img!)
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('D')
  })

  it('MyProfileCard：图片头像回填为「图片」模式；「保存资料」不携带 avatar（防清除）', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url) === '/api/auth/profile' && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        expect('avatar' in body).toBe(false) // M79-Q：image 模式不改 avatar
        return Promise.resolve(jsonResponse({ user: { id: 'u_me', username: 'alice', displayName: 'Alice', role: 'member', avatar: { kind: 'image', value: '/api/avatars/u_me-1.png' } } }))
      }
      return Promise.resolve(jsonResponse({}))
    })
    useAuthStore.setState({
      phase: 'ready',
      user: {
        id: 'u_me',
        username: 'alice',
        displayName: 'Alice',
        role: 'member',
        avatar: { kind: 'image', value: '/api/avatars/u_me-1.png' },
      },
      isAdmin: false,
      status: { needsSetup: false, authRequired: true, multiUser: true },
    })
    const user = userEvent.setup()
    render(<MyProfileCard />)

    // 「图片」段存在且预览为服务端图片
    expect(screen.getByRole('button', { name: '图片' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /选择图片/ })).toBeTruthy()
    expect(document.querySelector('img[src="/api/avatars/u_me-1.png"]')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: /保存资料/ }))
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([u, i]) => String(u) === '/api/auth/profile' && (i as RequestInit)?.method === 'PATCH',
      )
      expect(call).toBeTruthy()
    })
  })
})

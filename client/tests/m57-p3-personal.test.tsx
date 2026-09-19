/**
 * M57 P3 客户端测试：个人连接（成员「我的连接」卡）。
 * - 列表只显示本人 personal（system / 他人 personal 不入列）；
 * - 新建：POST /api/connections（sqlite 路径 → config）；
 * - 删除：DELETE + 列表刷新；
 * - 个人设置页门控：多用户才渲染此卡。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ConnectionDefinition } from '@multi-agent/shared'

vi.mock('sonner', () => {
  const toastFn = vi.fn()
  return { toast: Object.assign(toastFn, { error: vi.fn(), success: vi.fn(), info: vi.fn() }) }
})

import { toast } from 'sonner'
import { PersonalConnectionsCard } from '../src/components/settings/PersonalConnectionsCard'
import { PersonalSettingsView } from '../src/components/settings/PersonalSettingsView'
import { useAuthStore } from '../src/stores/auth-store'

const fetchMock = vi.fn()

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

const ME = { id: 'u_me', username: 'alice', displayName: 'Alice', role: 'member' as const }

function conn(over: Partial<ConnectionDefinition>): ConnectionDefinition {
  return {
    id: 'c_1',
    name: '我的库',
    kind: 'sqlite',
    config: { path: '/tmp/mine.db' },
    status: 'idle',
    enabled: true,
    secretSet: false,
    scope: 'personal',
    ownerId: 'u_me',
    memberUse: true,
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
    ...over,
  }
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  ;(toast.error as ReturnType<typeof vi.fn>).mockClear?.()
  ;(toast.success as ReturnType<typeof vi.fn>).mockClear?.()
  useAuthStore.setState({
    status: { needsSetup: false, authRequired: true, multiUser: true },
    user: ME,
  })
})

describe('M57 P3 PersonalConnectionsCard', () => {
  it('列表只显示本人 personal（system 与他人 personal 不入列）', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({
        connections: [
          conn({ id: 'c_mine', name: '我的库' }),
          conn({ id: 'c_sys', name: '团队库', scope: 'system', ownerId: undefined }),
          conn({ id: 'c_other', name: 'Bob 库', ownerId: 'u_bob' }),
        ],
      }),
    )
    render(<PersonalConnectionsCard />)
    await waitFor(() => expect(screen.getByText('我的库')).toBeTruthy())
    expect(screen.queryByText('团队库')).toBeNull()
    expect(screen.queryByText('Bob 库')).toBeNull()
  })

  it('新建：提交名称 + kind + sqlite config；成功后刷新列表', async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = []
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (method === 'POST') return jsonResponse({ connection: conn({ id: 'c_new', name: '新库' }) })
      // 首次 GET：空；刷新 GET：含新连接
      const refreshed = calls.filter((c) => c.method === 'GET').length > 1
      return jsonResponse({ connections: refreshed ? [conn({ id: 'c_new', name: '新库' })] : [] })
    })
    render(<PersonalConnectionsCard />)
    await waitFor(() => expect(screen.getByText(/还没有个人连接/)).toBeTruthy())

    await userEvent.click(screen.getByRole('button', { name: /新建/ }))
    await userEvent.type(screen.getByPlaceholderText('如：我的测试库'), '新库')
    await userEvent.type(screen.getByPlaceholderText('/Users/me/data.db'), '/tmp/new.db')
    await userEvent.click(screen.getByRole('button', { name: '创建' }))

    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringContaining('连接已创建')))
    const post = calls.find((c) => c.method === 'POST')
    expect(post?.url).toBe('/api/connections')
    expect(post?.body).toMatchObject({ name: '新库', kind: 'sqlite', config: { path: '/tmp/new.db', readOnly: true } })
    await waitFor(() => expect(screen.getByText('新库')).toBeTruthy())
  })

  it('删除：DELETE 调用并刷新', async () => {
    const calls: string[] = []
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if ((init?.method ?? 'GET') === 'DELETE') return jsonResponse({ ok: true })
      const refreshed = calls.filter((c) => c.startsWith('GET')).length > 1
      return jsonResponse({ connections: refreshed ? [] : [conn({ id: 'c_mine', name: '我的库' })] })
    })
    render(<PersonalConnectionsCard />)
    await waitFor(() => expect(screen.getByText('我的库')).toBeTruthy())
    await userEvent.click(screen.getByTitle('删除（会话绑定一并解除）'))
    await waitFor(() => expect(toast).toHaveBeenCalledWith('连接已删除'))
    expect(calls.some((c) => c === 'DELETE /api/connections/c_mine')).toBe(true)
  })
})

describe('M57 P3 PersonalSettingsView：个人连接卡门控', () => {
  it('多用户渲染；兼容模式隐藏', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/usage/me')) {
        return jsonResponse({ summary: { userId: '', todayTokens: 0, monthCostUsd: 0, sessions: 0, storageMb: 0, limits: {} } })
      }
      if (url.includes('/api/connections')) return jsonResponse({ connections: [] })
      return jsonResponse({ preferences: {} })
    })
    const { unmount } = render(<PersonalSettingsView />)
    await waitFor(() => expect(screen.getByText('我的连接')).toBeTruthy())
    unmount()

    useAuthStore.setState({ status: { needsSetup: false, authRequired: false, multiUser: false } })
    render(<PersonalSettingsView />)
    await waitFor(() => expect(screen.getByText('通知偏好')).toBeTruthy())
    expect(screen.queryByText('我的连接')).toBeNull()
  })
})

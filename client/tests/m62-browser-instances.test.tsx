/**
 * M62 前端测试：连接控制台「实例」页签（admin 观测面）。
 *
 * 覆盖：
 * - admin：页签可见 → 拉取 `/api/browser/sessions` → 归属 / 空闲时长展示 → 关闭动作（POST + 列表移除）；
 * - 成员：页签隐藏且不发起实例请求（管理面口径，与连接 CRUD 一致）。
 * mock fetch + 真实 store（connections-store / browser-store / auth-store）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { BrowserInstanceInfo } from '@multi-agent/shared'
import { ConnectionsConsole } from '../src/components/console/ConnectionsConsole'
import { useAuthStore } from '../src/stores/auth-store'
import { useBrowserStore } from '../src/stores/browser-store'
import { useConnectionsStore } from '../src/stores/connections-store'
import { useSessionStore } from '../src/stores/session-store'

const fetchMock = vi.fn()

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

const INSTANCE: BrowserInstanceInfo = {
  id: 'bs_1',
  sessionId: 's_1',
  backend: 'local',
  state: 'ready',
  controller: 'agent',
  headless: true,
  currentUrl: 'https://example.com/',
  createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  topic: 'browser:bs_1',
  ownerId: 'u_a',
  ownerName: '张三',
  idleMs: 120_000,
  subscribers: 1,
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockImplementation((url: string) => {
    if (url === '/api/connections') return Promise.resolve(jsonResponse({ connections: [] }))
    return Promise.resolve(jsonResponse({}, 404))
  })
  useAuthStore.setState({ isAdmin: true })
  useConnectionsStore.setState({
    connections: [],
    bindings: [],
    ops: [],
    sessionId: undefined,
    busyId: undefined,
    loading: false,
  })
  useBrowserStore.setState({ instances: [], instancesLoading: false })
  useSessionStore.setState({ currentId: undefined })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('M62：连接控制台实例页签', () => {
  it('admin：展示实例（归属 / 空闲时长 / 观察者）并可关闭', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url === '/api/connections') return Promise.resolve(jsonResponse({ connections: [] }))
      if (url === '/api/browser/sessions') return Promise.resolve(jsonResponse({ sessions: [INSTANCE] }))
      if (url === '/api/browser/sessions/bs_1/close' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ ok: true }))
      }
      return Promise.resolve(jsonResponse({}, 404))
    })
    render(<ConnectionsConsole />)

    // 页签可见（admin）
    await userEvent.click(await screen.findByRole('button', { name: '实例' }))
    expect(await screen.findByText('张三')).toBeTruthy()
    expect(screen.getByText(/无操作 2 分钟/)).toBeTruthy()
    expect(screen.getByText('观察 1')).toBeTruthy()

    // 关闭动作：POST + 本地列表移除
    await userEvent.click(screen.getByTitle('关闭该浏览器实例（Agent 再次调用 browser_* 时会重新启动）'))
    await waitFor(() => {
      expect(calls.some((c) => c.url === '/api/browser/sessions/bs_1/close' && c.init?.method === 'POST')).toBe(true)
    })
    await waitFor(() => expect(screen.queryByText('张三')).toBeNull())
  })

  it('成员：无实例页签且不发起实例请求（管理面口径）', async () => {
    useAuthStore.setState({ isAdmin: false })
    const calls: string[] = []
    fetchMock.mockImplementation((url: string) => {
      calls.push(String(url))
      if (url === '/api/connections') return Promise.resolve(jsonResponse({ connections: [] }))
      return Promise.resolve(jsonResponse({}, 404))
    })
    render(<ConnectionsConsole />)

    expect(await screen.findByRole('button', { name: /连接（0）/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '实例' })).toBeNull()
    expect(calls.some((url) => url.startsWith('/api/browser/sessions'))).toBe(false)
  })
})

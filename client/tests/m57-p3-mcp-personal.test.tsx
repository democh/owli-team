/**
 * M57 P3 客户端测试：个人 MCP（成员「我的 MCP」卡）。
 * - 列表只显示本人 personal（system / 他人 personal 不入列）；
 * - 新建：POST /api/mcp/servers（stdio → command/args），保存后自动测试（test 路由）并刷新；
 * - 合法 slug 校验（非法 → toast.error，不发请求）；
 * - 删除 / 重连调用对应路由。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { McpServerDefinition } from '@multi-agent/shared'

vi.mock('sonner', () => {
  const toastFn = vi.fn()
  return { toast: Object.assign(toastFn, { error: vi.fn(), success: vi.fn(), info: vi.fn() }) }
})

import { toast } from 'sonner'
import { PersonalMcpCard } from '../src/components/settings/PersonalMcpCard'
import { useAuthStore } from '../src/stores/auth-store'

const fetchMock = vi.fn()

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

const ME = { id: 'u_me', username: 'alice', displayName: 'Alice', role: 'member' as const }

function mcp(over: Partial<McpServerDefinition>): McpServerDefinition {
  return {
    id: 'mcp_1',
    name: 'my-notes',
    transport: 'stdio',
    config: { command: 'npx' },
    secretSet: false,
    enabled: true,
    status: 'idle',
    tools: [],
    source: 'ui',
    scope: 'personal',
    ownerId: 'u_me',
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

describe('M57 P3 PersonalMcpCard', () => {
  it('列表只显示本人 personal（system 与他人 personal 不入列）且带连接状态', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({
        servers: [
          mcp({ id: 'mcp_mine', name: 'my-notes', displayName: '我的笔记库', status: 'ok' }),
          mcp({ id: 'mcp_sys', name: 'team-echo', scope: 'system', ownerId: undefined }),
          mcp({ id: 'mcp_other', name: 'bob-echo', ownerId: 'u_bob' }),
        ],
      }),
    )
    render(<PersonalMcpCard />)
    await waitFor(() => expect(screen.getByText('我的笔记库')).toBeTruthy())
    expect(screen.getByText('已连接')).toBeTruthy()
    expect(screen.queryByText('team-echo')).toBeNull()
    expect(screen.queryByText('bob-echo')).toBeNull()
  })

  it('新建 stdio：POST payload（command/args）→ 自动测试 → 刷新列表', async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = []
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (url.endsWith('/test')) return jsonResponse({ ok: true, detail: '3 个工具' })
      if (method === 'POST') return jsonResponse({ server: mcp({ id: 'mcp_new', name: 'my-notes' }) })
      const refreshed = calls.filter((c) => c.method === 'GET').length > 1
      return jsonResponse({
        servers: refreshed ? [mcp({ id: 'mcp_new', name: 'my-notes', displayName: '笔记库', status: 'ok' })] : [],
      })
    })
    render(<PersonalMcpCard />)
    await waitFor(() => expect(screen.getByText(/还没有个人 MCP 服务器/)).toBeTruthy())

    await userEvent.click(screen.getByRole('button', { name: /新建/ }))
    await userEvent.type(screen.getByPlaceholderText('如 my-notes'), 'my-notes')
    await userEvent.type(screen.getByPlaceholderText('如 我的笔记库'), '笔记库')
    await userEvent.type(screen.getByPlaceholderText('如 npx'), 'npx')
    await userEvent.type(screen.getByPlaceholderText(/server-memory/), '-y @modelcontextprotocol/server-memory')
    await userEvent.click(screen.getByRole('button', { name: /创建并连接/ }))

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('已创建并连接成功')))
    const post = calls.find((c) => c.method === 'POST' && c.url === '/api/mcp/servers')
    expect(post?.body).toMatchObject({
      name: 'my-notes',
      displayName: '笔记库',
      transport: 'stdio',
      config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
    })
    expect(calls.some((c) => c.url === '/api/mcp/servers/mcp_new/test')).toBe(true)
    await waitFor(() => expect(screen.getByText('笔记库')).toBeTruthy())
  })

  it('非法 slug 拒绝：toast.error 且不发 POST', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ servers: [] }))
    render(<PersonalMcpCard />)
    await waitFor(() => expect(screen.getByText(/还没有个人 MCP 服务器/)).toBeTruthy())

    await userEvent.click(screen.getByRole('button', { name: /新建/ }))
    await userEvent.type(screen.getByPlaceholderText('如 my-notes'), 'Bad Name!')
    await userEvent.click(screen.getByRole('button', { name: /创建并连接/ }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('小写 slug')))
    expect(fetchMock.mock.calls.every(([, init]) => ((init as RequestInit | undefined)?.method ?? 'GET') === 'GET')).toBe(true)
  })

  it('删除 / 重连：调用对应路由并刷新', async () => {
    const calls: string[] = []
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push(`${method} ${url}`)
      if (method === 'DELETE') return jsonResponse({ ok: true })
      if (url.endsWith('/reconnect')) return jsonResponse({ server: mcp({ id: 'mcp_mine', status: 'ok' }) })
      // 删除后刷新 → 空；其余刷新保持条目（重连后仍可选删除）
      const deleted = calls.some((c) => c.startsWith('DELETE'))
      return jsonResponse({ servers: deleted ? [] : [mcp({ id: 'mcp_mine', name: 'my-notes', status: 'error' })] })
    })
    render(<PersonalMcpCard />)
    await waitFor(() => expect(screen.getByText('连接失败')).toBeTruthy())

    await userEvent.click(screen.getByTitle('重连（重建进程 / 连接）'))
    await waitFor(() => expect(calls.some((c) => c === 'POST /api/mcp/servers/mcp_mine/reconnect')).toBe(true))

    await userEvent.click(screen.getByTitle('删除（会话绑定一并解除）'))
    await waitFor(() => expect(toast).toHaveBeenCalledWith('服务器已删除（会话绑定一并解除）'))
    expect(calls.some((c) => c === 'DELETE /api/mcp/servers/mcp_mine')).toBe(true)
  })
})

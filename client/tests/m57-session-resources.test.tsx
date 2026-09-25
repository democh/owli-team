/**
 * M57 P3 客户端测试：会话资源弹窗（连接 / MCP 成员自助绑定）。
 * - 打开加载两区数据：已绑定（解绑）/ 可绑定（绑定）分组正确；
 * - 绑定 / 解绑调用对应路由并 toast；
 * - viewer（canWrite=false）：无绑定 / 解绑按钮，显示只读提示。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ConnectionDefinition, McpServerDefinition } from '@multi-agent/shared'

vi.mock('sonner', () => {
  const toastFn = vi.fn()
  return { toast: Object.assign(toastFn, { error: vi.fn(), success: vi.fn(), info: vi.fn() }) }
})

import { toast } from 'sonner'
import { SessionResourcesDialog } from '../src/components/sessions/SessionResourcesDialog'
import { useAuthStore } from '../src/stores/auth-store'
import { useConnectionsStore } from '../src/stores/connections-store'
import { useMcpStore } from '../src/stores/mcp-store'

const fetchMock = vi.fn()

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

const ME = { id: 'u_me', username: 'alice', displayName: 'Alice', role: 'member' as const }

function conn(id: string, name: string, over: Partial<ConnectionDefinition> = {}): ConnectionDefinition {
  return {
    id,
    name,
    kind: 'sqlite',
    config: { path: '/tmp/x.db' },
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

function mcp(id: string, name: string, over: Partial<McpServerDefinition> = {}): McpServerDefinition {
  return {
    id,
    name,
    transport: 'stdio',
    config: { command: 'stub' },
    secretSet: false,
    enabled: true,
    status: 'ok',
    tools: [],
    source: 'ui',
    scope: 'personal',
    ownerId: 'u_me',
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
    ...over,
  }
}

function installFetchMock(calls?: string[]): void {
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls?.push(`${method} ${url}`)
    if (method === 'POST' && url.endsWith('/sessions/s1/connections')) {
      return jsonResponse({ bindings: [{ connection: conn('c_free', '候选库'), grantedAt: 'x' }] })
    }
    if (method === 'POST' && url.endsWith('/sessions/s1/mcp-servers')) {
      return jsonResponse({
        bindings: [
          { server: mcp('m_bound', '已绑服务'), grantedAt: 'x' },
          { server: mcp('m_free', '候选服务'), grantedAt: 'x' },
        ],
      })
    }
    if (method === 'DELETE') return jsonResponse({ ok: true })
    if (url === '/api/connections') {
      return jsonResponse({ connections: [conn('c_bound', '已绑库'), conn('c_free', '候选库')] })
    }
    if (url === '/api/sessions/s1/connections') {
      return jsonResponse({ bindings: [{ connection: conn('c_bound', '已绑库'), grantedAt: 'x' }] })
    }
    if (url === '/api/mcp/servers') {
      return jsonResponse({ servers: [mcp('m_bound', '已绑服务'), mcp('m_free', '候选服务', { status: 'idle' })] })
    }
    if (url === '/api/sessions/s1/mcp-servers') {
      return jsonResponse({ bindings: [{ server: mcp('m_bound', '已绑服务'), grantedAt: 'x' }] })
    }
    if (url.startsWith('/api/audit')) return jsonResponse({ entries: [] })
    if (url === '/api/mcp/tools') return jsonResponse({ tools: [] })
    if (url === '/api/mcp/json-config') return jsonResponse({ config: {} })
    return jsonResponse({})
  })
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  ;(toast.error as ReturnType<typeof vi.fn>).mockClear?.()
  useConnectionsStore.getState().reset()
  useMcpStore.getState().reset()
  useAuthStore.setState({
    status: { needsSetup: false, authRequired: true, multiUser: true },
    user: ME,
  })
})

describe('M57 P3 SessionResourcesDialog', () => {
  it('连接区：已绑定（解绑）与候选（绑定）分组；绑定调用 POST 路由', async () => {
    const calls: string[] = []
    installFetchMock(calls)
    render(<SessionResourcesDialog sessionId="s1" open canWrite onOpenChange={() => undefined} />)

    await waitFor(() => expect(screen.getByText('已绑库')).toBeTruthy())
    expect(screen.getByText('候选库')).toBeTruthy()
    expect(screen.getByRole('button', { name: /解绑/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /绑定/ })).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: /绑定/ }))
    await waitFor(() => expect(calls.some((c) => c === 'POST /api/sessions/s1/connections')).toBe(true))
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('已绑定「候选库」到当前会话'))
  })

  it('MCP 区：切页签后绑定 / 解绑调用对应路由', async () => {
    const calls: string[] = []
    installFetchMock(calls)
    render(<SessionResourcesDialog sessionId="s1" open canWrite onOpenChange={() => undefined} />)

    await userEvent.click(screen.getByRole('tab', { name: /MCP/ }))
    await waitFor(() => expect(screen.getByText('已绑服务')).toBeTruthy())
    expect(screen.getByText('候选服务')).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: /绑定/ }))
    await waitFor(() => expect(calls.some((c) => c === 'POST /api/sessions/s1/mcp-servers')).toBe(true))

    // 定位「已绑服务」行内的解绑（绑定后候选行也存在解绑入口）
    const boundRow = screen.getByText('已绑服务').closest('div') as HTMLElement
    await userEvent.click(within(boundRow).getByRole('button', { name: /解绑/ }))
    await waitFor(() => expect(calls.some((c) => c === 'DELETE /api/sessions/s1/mcp-servers/m_bound')).toBe(true))
    // 契约防御：DELETE 响应缺 bindings 字段（mock 仅回 { ok: true }）→ 回退空列表，弹窗不崩溃
    await waitFor(() => expect(screen.getByText(/尚未绑定 MCP 服务器/)).toBeTruthy())
  })

  it('viewer（canWrite=false）：无绑定 / 解绑按钮 + 只读提示', async () => {
    installFetchMock()
    render(<SessionResourcesDialog sessionId="s1" open canWrite={false} onOpenChange={() => undefined} />)

    await waitFor(() => expect(screen.getByText('已绑库')).toBeTruthy())
    expect(screen.getByText(/只读共享/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^绑定$/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /^解绑$/ })).toBeNull()
  })
})

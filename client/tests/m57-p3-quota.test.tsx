/**
 * M57 P3 客户端测试：配额与用量展示。
 * - PersonalSettingsView「我的用量」卡：多用户渲染（含限额分母）/ 兼容模式隐藏；
 * - QuotaDialog：加载回填（限额 + 用量）/ 保存 payload（留空 → null 清除）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('sonner', () => {
  const toastFn = vi.fn()
  return { toast: Object.assign(toastFn, { error: vi.fn(), success: vi.fn(), info: vi.fn() }) }
})

import { toast } from 'sonner'
import { PersonalSettingsView } from '../src/components/settings/PersonalSettingsView'
import { QuotaDialog } from '../src/components/console/QuotaDialog'
import { useAuthStore } from '../src/stores/auth-store'

const fetchMock = vi.fn()

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

const USAGE = {
  summary: {
    userId: 'u_1',
    todayTokens: 12345,
    monthCostUsd: 1.23,
    sessions: 3,
    storageMb: 12.5,
    limits: { dailyTokens: 100000, maxSessions: 10 },
  },
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  ;(toast.error as ReturnType<typeof vi.fn>).mockClear?.()
  ;(toast.success as ReturnType<typeof vi.fn>).mockClear?.()
  useAuthStore.setState({
    status: { needsSetup: false, authRequired: true, multiUser: true },
    user: { id: 'u_1', username: 'alice', displayName: 'Alice', role: 'member' },
  })
})

describe('M57 P3 PersonalSettingsView：我的用量', () => {
  it('多用户：渲染用量卡（含限额分母）', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/usage/me')) return jsonResponse(USAGE)
      return jsonResponse({ preferences: {} })
    })
    render(<PersonalSettingsView />)
    await waitFor(() => expect(screen.getByText('我的用量')).toBeTruthy())
    expect(screen.getByText('12,345')).toBeTruthy()
    expect(screen.getByText(/\/ 100,000/)).toBeTruthy()
    expect(screen.getByText('$1.23')).toBeTruthy()
    expect(screen.getByText(/\/ 10$/)).toBeTruthy()
  })

  it('兼容模式（userId 为空）：不渲染用量卡', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/usage/me')) {
        return jsonResponse({ summary: { userId: '', todayTokens: 0, monthCostUsd: 0, sessions: 0, storageMb: 0, limits: {} } })
      }
      return jsonResponse({ preferences: {} })
    })
    render(<PersonalSettingsView />)
    await waitFor(() => expect(screen.getByText('通知偏好')).toBeTruthy())
    expect(screen.queryByText('我的用量')).toBeNull()
  })
})

describe('M57 P3 QuotaDialog：回填与保存', () => {
  it('加载限额与用量；保存时留空字段以 null 提交（清除回不限）', async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = []
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (url.endsWith('/quota') && method === 'GET') {
        return jsonResponse({ quota: { maxConcurrentRuns: 2, dailyTokens: 100000, maxSessions: 10 } })
      }
      if (url.endsWith('/usage')) return jsonResponse(USAGE)
      return jsonResponse({ quota: {} })
    })
    render(<QuotaDialog userId="u_1" displayName="Alice" open onOpenChange={() => {}} />)
    // 回填：并发 2 / 日 token 100000 / 会话 10；用量：今日 token 12,345
    await waitFor(() => expect(screen.getByDisplayValue('2')).toBeTruthy())
    expect(screen.getByDisplayValue('100000')).toBeTruthy()
    expect(screen.getByDisplayValue('10')).toBeTruthy()
    expect(screen.getByText('12,345')).toBeTruthy()

    // 清空会话数（→ null 清除），保留其余
    await userEvent.clear(screen.getByDisplayValue('10'))
    await userEvent.click(screen.getByRole('button', { name: '保存配额' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    const put = calls.find((c) => c.method === 'PUT')
    expect(put?.url).toBe('/api/users/u_1/quota')
    expect(put?.body).toMatchObject({ maxConcurrentRuns: 2, dailyTokens: 100000, maxSessions: null })
    expect(put?.body).toMatchObject({ monthlyCostUsd: null, maxStorageMb: null })
  })

  it('非法输入（非正数）：拒绝保存并提示', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/quota')) return jsonResponse({ quota: {} })
      return jsonResponse(USAGE)
    })
    render(<QuotaDialog userId="u_1" displayName="Alice" open onOpenChange={() => {}} />)
    await waitFor(() => expect(screen.getByText('保存配额')).toBeTruthy())
    await userEvent.type(screen.getByPlaceholderText('如 30'), '-5')
    await userEvent.click(screen.getByRole('button', { name: '保存配额' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')).toBe(false)
  })
})

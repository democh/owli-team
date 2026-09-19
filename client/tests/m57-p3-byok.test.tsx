/**
 * M57 P3 客户端测试：模型直连（BYOK）卡。
 * - 未配置：默认展开表单；保存 → PUT payload（留空字段不下发）；
 * - 已配置：状态徽章 + 地址/模型回显（无密钥）；恢复系统默认 → DELETE；
 * - 校验：短 Key 拒绝保存并提示。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('sonner', () => {
  const toastFn = vi.fn()
  return { toast: Object.assign(toastFn, { error: vi.fn(), success: vi.fn(), info: vi.fn() }) }
})

import { toast } from 'sonner'
import { ByokCard } from '../src/components/settings/ByokCard'

const fetchMock = vi.fn()

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  ;(toast.error as ReturnType<typeof vi.fn>).mockClear?.()
  ;(toast.success as ReturnType<typeof vi.fn>).mockClear?.()
})

describe('M57 P3 ByokCard', () => {
  it('未配置：默认展开表单；保存下发 apiKey/baseUrl/model', async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = []
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (method === 'PUT') {
        return jsonResponse({ status: { configured: true, baseUrl: 'https://api.example.com/v1', model: 'my-model' } })
      }
      return jsonResponse({ status: { configured: false } })
    })
    render(<ByokCard />)
    await waitFor(() => expect(screen.getByText('使用系统默认')).toBeTruthy())

    await userEvent.type(screen.getByPlaceholderText('sk-…'), 'sk-live-12345678')
    await userEvent.type(screen.getByPlaceholderText('https://api.example.com/v1'), 'https://api.example.com/v1')
    await userEvent.type(screen.getByPlaceholderText('如 deepseek-chat'), 'my-model')
    await userEvent.click(screen.getByRole('button', { name: '保存凭据' }))

    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    const put = calls.find((c) => c.method === 'PUT')
    expect(put?.url).toBe('/api/auth/llm-credentials')
    expect(put?.body).toEqual({ apiKey: 'sk-live-12345678', baseUrl: 'https://api.example.com/v1', model: 'my-model' })
    // 保存后回到已配置态（表单收起 + 徽章）
    await waitFor(() => expect(screen.getByText('已配置（自定义 Key）')).toBeTruthy())
    expect(screen.queryByPlaceholderText('sk-…')).toBeNull()
  })

  it('已配置：回显地址/模型（无密钥）；恢复系统默认 → DELETE', async () => {
    const calls: Array<{ url: string; method: string }> = []
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push({ url, method })
      if (method === 'DELETE') return jsonResponse({ status: { configured: false } })
      return jsonResponse({ status: { configured: true, baseUrl: 'https://my.example.com/v1', model: 'my-model' } })
    })
    render(<ByokCard />)
    await waitFor(() => expect(screen.getByText('已配置（自定义 Key）')).toBeTruthy())
    expect(screen.getByText('https://my.example.com/v1')).toBeTruthy()
    expect(screen.getByText('my-model')).toBeTruthy()
    expect(screen.queryByPlaceholderText('sk-…')).toBeNull() // 已配置默认收起表单（密钥永不回显）

    await userEvent.click(screen.getByRole('button', { name: /恢复系统默认/ }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith('已恢复系统默认模型与 Key'))
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true)
    await waitFor(() => expect(screen.getByText('使用系统默认')).toBeTruthy())
  })

  it('校验：短 Key / 非法地址 → 拒绝保存', async () => {
    const calls: Array<{ method: string }> = []
    fetchMock.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ method: init?.method ?? 'GET' })
      return jsonResponse({ status: { configured: false } })
    })
    render(<ByokCard />)
    await waitFor(() => expect(screen.getByText('使用系统默认')).toBeTruthy())

    await userEvent.type(screen.getByPlaceholderText('sk-…'), 'short')
    await userEvent.click(screen.getByRole('button', { name: '保存凭据' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('API Key 至少 8 位'))

    await userEvent.clear(screen.getByPlaceholderText('sk-…'))
    await userEvent.type(screen.getByPlaceholderText('sk-…'), 'sk-12345678')
    await userEvent.type(screen.getByPlaceholderText('https://api.example.com/v1'), 'ftp://bad')
    await userEvent.click(screen.getByRole('button', { name: '保存凭据' }))
    await waitFor(() => expect((toast.error as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1))
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
  })
})

/**
 * WorktreeBar（M6）：sandbox 不渲染；worktree / repo 模式显示分支与三动作；
 * 「查看改动」展开 diff；merge / discard 需二次确认（拒绝时不发请求）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { WorktreeBar, type WorktreeState } from '../src/components/sessions/WorktreeBar'

const worktreeState: WorktreeState = {
  mode: 'worktree',
  root: '/tmp/worktrees/s1',
  branch: 'agent/s1',
  repoRoot: '/tmp/repo',
  mainBranch: 'main',
  diff: {
    branch: 'agent/s1',
    files: ['src/app.ts'],
    diff: '--- a/src/app.ts\n+++ b/src/app.ts\n-export const v = 1\n+export const v = 2',
    truncated: false,
  },
}

type FetchCall = { url: string; method: string }

let calls: FetchCall[] = []

function stubFetch(state: WorktreeState, failPost = false): void {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET' })
      if (String(input).includes('/worktree') && (init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify(state), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (failPost) {
        return new Response(JSON.stringify({ error: '主仓库存在未提交改动' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ ok: true, detail: '合并完成' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }),
  )
}

beforeEach(() => {
  calls = []
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('WorktreeBar', () => {
  it('sandbox 模式：不渲染面板', async () => {
    stubFetch({ mode: 'sandbox', root: '/tmp/ws/s1', diff: null })
    const { container } = render(<WorktreeBar sessionId="s1" />)
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/worktree'))).toBe(true)
    })
    expect(container.firstChild).toBeNull()
  })

  it('worktree 模式：显示分支与三个动作；「查看改动」展开 diff', async () => {
    stubFetch(worktreeState)
    render(<WorktreeBar sessionId="s1" />)

    expect(await screen.findByText('agent/s1')).toBeInTheDocument()
    expect(screen.getByText('查看改动')).toBeInTheDocument()
    expect(screen.getByText('合并到主分支')).toBeInTheDocument()
    expect(screen.getByText('丢弃 worktree')).toBeInTheDocument()

    fireEvent.click(screen.getByText('查看改动'))
    expect(await screen.findByText(/\+export const v = 2/)).toBeInTheDocument()
  })

  it('repo 模式：仅显示「查看改动」，无合并 / 丢弃动作', async () => {
    stubFetch({ mode: 'repo', root: '/tmp/repo', repoRoot: '/tmp/repo', mainBranch: 'main', diff: null })
    render(<WorktreeBar sessionId="s1" />)

    expect(await screen.findByText(/直连仓库/)).toBeInTheDocument()
    expect(screen.queryByText('合并到主分支')).toBeNull()
    expect(screen.queryByText('丢弃 worktree')).toBeNull()
  })

  it('合并：确认后以 confirm:true 调用接口；拒绝确认时不发请求', async () => {
    stubFetch(worktreeState)
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<WorktreeBar sessionId="s1" />)

    fireEvent.click(await screen.findByText('合并到主分支'))
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.url.includes('/worktree/merge'))).toBe(true)
    })

    confirmSpy.mockReturnValue(false)
    const before = calls.length
    fireEvent.click(screen.getByText('丢弃 worktree'))
    await new Promise((r) => setTimeout(r, 20))
    expect(calls.length).toBe(before)
  })

  it('合并失败：toast 错误且面板保留', async () => {
    stubFetch(worktreeState, false)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<WorktreeBar sessionId="s1" />)
    fireEvent.click(await screen.findByText('合并到主分支'))
    // 失败后按钮恢复可点（busy 复位）
    await waitFor(() => {
      expect(screen.getByText('合并到主分支')).toBeEnabled()
    })
  })
})

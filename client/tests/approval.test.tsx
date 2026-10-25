/**
 * 审批卡（M8）：挂起卡渲染 / 批准 / 拒绝 / 自定义反馈（fetch mock 校验请求体）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ApprovalRequest } from '@multi-agent/shared'
import { ApprovalPanel } from '../src/components/chat/ApprovalPanel'
import { useRunStore } from '../src/stores/run-store'
import { useSessionStore } from '../src/stores/session-store'
import { useAgentStore } from '../src/stores/agent-store'

function makeApproval(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'ap1',
    runId: 'r1',
    sessionId: 's1',
    action: 'git_commit',
    detail: 'git commit -m "feat: 初始化"',
    options: ['approve', 'reject', 'custom'],
    status: 'pending',
    createdAt: new Date().toISOString(),
    ...over,
  }
}

const fetchMock = vi.fn()

beforeEach(() => {
  localStorage.clear()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  useAgentStore.setState({ agents: [], skills: [], loaded: true, loading: false, statuses: {} })
  useSessionStore.setState({ currentId: 's1', sessions: [], byId: new Map(), order: [] })
  useRunStore.setState({ runId: 'r1', sessionId: 's1', active: true, approvals: [makeApproval()] })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ApprovalPanel 挂起卡', () => {
  it('其他模态层或输入框中使用快捷键，不触发审批', () => {
    render(
      <>
        <ApprovalPanel />
        <div role="dialog" aria-label="账号">
          <input aria-label="昵称" />
        </div>
      </>,
    )
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true })
    fireEvent.keyDown(screen.getByLabelText('昵称'), { key: 'Backspace', ctrlKey: true })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('普通输入框、输入法组合及长按重复事件不触发审批', () => {
    render(
      <>
        <ApprovalPanel />
        <textarea aria-label="消息草稿" />
      </>,
    )
    fireEvent.keyDown(screen.getByLabelText('消息草稿'), { key: 'Enter', ctrlKey: true })
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true, isComposing: true })
    fireEvent.keyDown(window, { key: 'Backspace', ctrlKey: true, repeat: true })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('无其他交互层时保留审批快捷键', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ approval: makeApproval({ status: 'approved' }) })),
    )
    render(<ApprovalPanel />)
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByText('模型请求审批')).toBeNull())
  })

  it('渲染动作、命令原文与选项；非当前会话的审批不展示', () => {
    useRunStore.setState({
      approvals: [makeApproval(), makeApproval({ id: 'ap2', sessionId: 'other' })],
    })
    render(<ApprovalPanel />)
    expect(screen.getByText('模型请求审批')).toBeInTheDocument()
    expect(screen.getByText('git_commit')).toBeInTheDocument()
    expect(screen.getByText(/git commit -m/)).toBeInTheDocument()
    expect(screen.getByText('approve')).toBeInTheDocument()
    expect(screen.getByText('超时将自动拒绝')).toBeInTheDocument()
  })

  it('无挂起项时不渲染', () => {
    useRunStore.setState({ approvals: [] })
    const { container } = render(<ApprovalPanel />)
    expect(container.firstChild).toBeNull()
  })

  it('批准：POST 决定并本地替换为结论', async () => {
    const user = userEvent.setup()
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          approval: makeApproval({
            status: 'approved',
            decision: 'approve',
            decidedAt: new Date().toISOString(),
          }),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    render(<ApprovalPanel />)
    await user.click(screen.getByRole('button', { name: /批准/ }))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/runs/r1/approvals/ap1')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ decision: 'approve', feedback: undefined })

    // 决议后：挂起卡消失；已决结论行按产品决策隐藏（不常驻）
    await waitFor(() => expect(screen.queryByText('模型请求审批')).not.toBeInTheDocument())
    expect(screen.queryByText('已批准')).toBeNull()
  })

  it('拒绝：decision=reject 且展示已拒绝', async () => {
    const user = userEvent.setup()
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          approval: makeApproval({
            status: 'rejected',
            decision: 'reject',
            decidedAt: new Date().toISOString(),
          }),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    render(<ApprovalPanel />)
    await user.click(screen.getByRole('button', { name: /拒绝/ }))
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(JSON.parse(String(init.body)).decision).toBe('reject')
    // 结论行已隐藏（同批产品决策）：挂起卡消失即完成交互
    await waitFor(() => expect(screen.queryByText('模型请求审批')).not.toBeInTheDocument())
  })

  it('自定义反馈：空内容拦截；填写后随请求提交', async () => {
    const user = userEvent.setup()
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          approval: makeApproval({ status: 'rejected', decision: 'custom', feedback: '改用 rebase 提交' }),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    render(<ApprovalPanel />)
    await user.click(screen.getByRole('button', { name: '自定义反馈…' }))
    const box = screen.getByPlaceholderText(/填写修改意见/)
    await user.click(screen.getByRole('button', { name: /提交反馈/ }))
    expect(fetchMock).not.toHaveBeenCalled() // 空内容被拦截

    await user.type(box, '改用 rebase 提交')
    await user.click(screen.getByRole('button', { name: /提交反馈/ }))
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(JSON.parse(String(init.body))).toEqual({ decision: 'custom', feedback: '改用 rebase 提交' })
  })
})

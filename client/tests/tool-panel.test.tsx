/**
 * 工具调用面板（ToolCallsPanel）：执行中自动展开跟随进度；执行完成后自动收起为一行摘要；
 * 用户手动切换后尊重其选择，不再自动干预（对齐思考块范式）。
 */
import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ToolCallRecord } from '@multi-agent/shared'
import { ToolCallsPanel } from '../src/components/chat/ToolCard'

function call(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id: 't1',
    name: 'read_file',
    args: { path: 'a.md' },
    status: 'ok',
    summary: '已读取 a.md（1.0KB）',
    startedAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('ToolCallsPanel 展开/收起', () => {
  it('执行中：自动展开，工具卡可见', () => {
    render(<ToolCallsPanel calls={[call({ status: 'running', summary: undefined })]} />)
    expect(screen.getByRole('button', { name: /工具调用/ })).toBeInTheDocument()
    expect(screen.getByText('读取文件')).toBeInTheDocument()
  })

  it('已完成（历史消息）：默认收起为一行摘要，工具卡不渲染', () => {
    render(<ToolCallsPanel calls={[call()]} />)
    expect(screen.getByRole('button', { name: /工具调用/ })).toBeInTheDocument()
    expect(screen.queryByText('读取文件')).toBeNull()
  })

  it('执行中 → 全部完成：自动收起（无需手动操作）', () => {
    const { rerender } = render(<ToolCallsPanel calls={[call({ status: 'running', summary: undefined })]} />)
    expect(screen.getByText('读取文件')).toBeInTheDocument()
    rerender(<ToolCallsPanel calls={[call({ status: 'ok' })]} />)
    expect(screen.queryByText('读取文件')).toBeNull()
  })

  it('完成后再手动展开：可查看工具卡，且后续状态下发不打断展开态', () => {
    const { rerender } = render(<ToolCallsPanel calls={[call({ status: 'running', summary: undefined })]} />)
    rerender(<ToolCallsPanel calls={[call({ status: 'ok' })]} />)
    fireEvent.click(screen.getByRole('button', { name: /工具调用/ }))
    expect(screen.getByText('读取文件')).toBeInTheDocument()
    // 追加一条已完成调用（新数组引用）→ 手动展开态保持
    rerender(
      <ToolCallsPanel
        calls={[call({ status: 'ok' }), call({ id: 't2', name: 'list_dir', summary: '已列出 3 项' })]}
      />,
    )
    expect(screen.getByText('读取文件')).toBeInTheDocument()
    expect(screen.getByText('列出目录')).toBeInTheDocument()
  })

  it('运行中用户手动收起：执行完成后保持收起（尊重手动选择）', () => {
    const { rerender } = render(<ToolCallsPanel calls={[call({ status: 'running', summary: undefined })]} />)
    fireEvent.click(screen.getByRole('button', { name: /工具调用/ }))
    expect(screen.queryByText('读取文件')).toBeNull()
    rerender(<ToolCallsPanel calls={[call({ status: 'ok' })]} />)
    expect(screen.queryByText('读取文件')).toBeNull()
  })
})

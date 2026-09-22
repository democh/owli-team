/**
 * 工具调用面板（ToolCallsPanel）：展开锚点 = 本回合是否仍在进行（streaming）——
 * 流式中恒展开（多批工具之间的空档不收起再展开，消除抖动）；回合结束自动收起一次为一行摘要；
 * 历史消息默认收起；用户手动切换后尊重其选择，不再自动干预（对齐思考块范式）。
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
  it('流式中：自动展开，工具卡可见', () => {
    render(<ToolCallsPanel streaming calls={[call({ status: 'running', summary: undefined })]} />)
    expect(screen.getByRole('button', { name: /工具调用/ })).toBeInTheDocument()
    expect(screen.getByText('读取文件')).toBeInTheDocument()
  })

  it('历史消息（非流式）：默认收起为一行摘要，工具卡不渲染', () => {
    render(<ToolCallsPanel streaming={false} calls={[call()]} />)
    expect(screen.getByRole('button', { name: /工具调用/ })).toBeInTheDocument()
    expect(screen.queryByText('读取文件')).toBeNull()
  })

  it('流式中工具完成 → 下一批到来：全程保持展开（不收起再展开，防抖动）', () => {
    const { rerender } = render(
      <ToolCallsPanel streaming calls={[call({ status: 'running', summary: undefined })]} />,
    )
    expect(screen.getByText('读取文件')).toBeInTheDocument()
    // 第一批完成（回合仍在进行，模型即将发起下一批）→ 不收起
    rerender(<ToolCallsPanel streaming calls={[call({ status: 'ok' })]} />)
    expect(screen.getByText('读取文件')).toBeInTheDocument()
    // 第二批到来（新卡片追加）→ 仍展开，新卡可见
    rerender(
      <ToolCallsPanel
        streaming
        calls={[
          call({ status: 'ok' }),
          call({ id: 't2', name: 'list_dir', status: 'running', summary: undefined }),
        ]}
      />,
    )
    expect(screen.getByText('读取文件')).toBeInTheDocument()
    expect(screen.getByText('列出目录')).toBeInTheDocument()
  })

  it('回合结束（streaming → false）：自动收起一次为一行摘要', () => {
    const { rerender } = render(
      <ToolCallsPanel streaming calls={[call({ status: 'running', summary: undefined })]} />,
    )
    expect(screen.getByText('读取文件')).toBeInTheDocument()
    rerender(<ToolCallsPanel streaming={false} calls={[call({ status: 'ok' })]} />)
    expect(screen.queryByText('读取文件')).toBeNull()
    expect(screen.getByRole('button', { name: /工具调用/ })).toBeInTheDocument()
  })

  it('回合结束后手动展开：可查看工具卡，后续状态下发不打断展开态', () => {
    const { rerender } = render(<ToolCallsPanel streaming={false} calls={[call({ status: 'ok' })]} />)
    fireEvent.click(screen.getByRole('button', { name: /工具调用/ }))
    expect(screen.getByText('读取文件')).toBeInTheDocument()
    // 追加一条已完成调用（新数组引用）→ 手动展开态保持
    rerender(
      <ToolCallsPanel
        streaming={false}
        calls={[call({ status: 'ok' }), call({ id: 't2', name: 'list_dir', summary: '已列出 3 项' })]}
      />,
    )
    expect(screen.getByText('读取文件')).toBeInTheDocument()
    expect(screen.getByText('列出目录')).toBeInTheDocument()
  })

  it('流式中用户手动收起：下一批到来与回合结束均保持收起（尊重手动选择）', () => {
    const { rerender } = render(
      <ToolCallsPanel streaming calls={[call({ status: 'running', summary: undefined })]} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /工具调用/ }))
    expect(screen.queryByText('读取文件')).toBeNull()
    rerender(
      <ToolCallsPanel
        streaming
        calls={[
          call({ status: 'ok' }),
          call({ id: 't2', name: 'list_dir', status: 'running', summary: undefined }),
        ]}
      />,
    )
    expect(screen.queryByText('列出目录')).toBeNull()
    rerender(<ToolCallsPanel streaming={false} calls={[call({ status: 'ok' })]} />)
    expect(screen.queryByText('读取文件')).toBeNull()
  })
})

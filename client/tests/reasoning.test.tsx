/**
 * 思考模式（V4）前端：MessageItem 思考块（流式展开/完成折叠/手动切换）+ store 增量追加。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ChatMessage } from '@multi-agent/shared'
import { MessageItem } from '../src/components/chat/MessageItem'
import { useAgentStore } from '../src/stores/agent-store'
import { messagesOf, useSessionStore } from '../src/stores/session-store'
import { useUiStore } from '../src/stores/ui-store'

function msg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    sessionId: 's1',
    role: 'agent',
    agentId: 'pm',
    content: '已完成评审。',
    mentions: [],
    status: 'complete',
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

beforeEach(() => {
  useAgentStore.setState({ agents: [], skills: [], loaded: true, loading: false, statuses: {} })
  useUiStore.setState({ focusRequest: undefined })
  useSessionStore.setState({ byId: new Map(), order: [], currentId: 's1' })
})

/** M8：MessageItem 只接收 messageId（项级订阅），因此先把消息写入 store 再渲染 */
function renderItem(message: ChatMessage): void {
  useSessionStore.setState({ byId: new Map([[message.id, message]]), order: [message.id] })
  render(<MessageItem messageId={message.id} />)
}

describe('MessageItem 思考块', () => {
  it('完成态：折叠为「已深度思考」摘要，点击展开思维链', () => {
    renderItem(msg({ reasoning: '先梳理需求，再产出交付件。' }))
    const toggle = screen.getByRole('button', { name: /已深度思考/ })
    expect(screen.queryByText('先梳理需求，再产出交付件。')).toBeNull()
    fireEvent.click(toggle)
    expect(screen.getByText('先梳理需求，再产出交付件。')).toBeInTheDocument()
  })

  it('流式纯思考阶段：默认展开并展示「正在思考」', () => {
    renderItem(msg({ reasoning: '正在盘点工作区…', content: '', status: 'streaming' }))
    expect(screen.getByText(/正在思考/)).toBeInTheDocument()
    expect(screen.getByText('正在盘点工作区…')).toBeInTheDocument()
  })

  it('无 reasoning 不渲染思考块（默认关闭思考的常规消息）', () => {
    renderItem(msg({ content: '常规回复' }))
    expect(screen.queryByText(/深度思考/)).toBeNull()
  })
})

describe('session-store.appendReasoning', () => {
  it('追加思维链增量；未知 id 无副作用', () => {
    const store = useSessionStore.getState()
    store.upsertMessage(msg({ id: 'm2', content: '' }))
    store.appendReasoning('m2', '第一步：')
    store.appendReasoning('m2', '盘点工作区。')
    store.appendReasoning('nope', 'x')
    const messages = messagesOf(useSessionStore.getState())
    expect(messages).toHaveLength(1)
    expect(messages[0].reasoning).toBe('第一步：盘点工作区。')
  })
})

/**
 * M79-AA：交还目标具体真人渲染。
 * - 交接条（HandoffBar）：humanMentions（真人目标）→ 「from → 真人名」+ data-handoff-targets；
 *   点击头像一键接棒；无具体目标数据的旧消息（mentions 含 user）→ 回退「你的回合」；
 * - 正文泛称展开（MessageItem 集成）：`@用户` / `@user` chip 就地展开为具体定向人名。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ChatMessage } from '@multi-agent/shared'

vi.mock('sonner', () => {
  const toastFn = vi.fn()
  return { toast: Object.assign(toastFn, { error: vi.fn(), success: vi.fn(), info: vi.fn() }) }
})

import { MessageItem } from '../src/components/chat/MessageItem'
import { HandoffBar } from '../src/components/chat/SystemEvent'
import { useAgentStore } from '../src/stores/agent-store'
import { useSessionStore } from '../src/stores/session-store'
import { useUiStore } from '../src/stores/ui-store'

function makeAgentMessage(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm_a1',
    sessionId: 's1',
    seq: 2,
    role: 'agent',
    agentId: 'pm',
    content: '请确认下一步',
    mentions: [],
    status: 'complete',
    createdAt: new Date('2026-09-20T12:00:00.000Z').toISOString(),
    ...over,
  }
}

beforeEach(() => {
  useAgentStore.setState({
    agents: [{ id: 'pm', name: '费利', group: 'pm', avatar: { gradient: ['#3b82f6', '#f59e0b'], icon: 'user' } } as never],
  } as never)
  useSessionStore.setState({
    humanNames: { u1: '张三', u2: '李四' },
    humanProfiles: {
      u1: { name: '张三', avatar: { kind: 'color', value: '#3366ff' } },
      u2: { name: '李四' },
    },
  } as never)
})

describe('M79-AA：交接条具体真人渲染', () => {
  it('humanMentions → 显示具体真人名（不再是「你的回合」）', () => {
    const insert = vi.fn()
    useUiStore.setState({ insertToComposer: insert } as never)
    render(<HandoffBar message={makeAgentMessage({ mentions: ['user'], humanMentions: ['u1', 'u2'] })} />)
    const targets = document.querySelector('[data-handoff-targets]')
    expect(targets?.textContent).toBe('张三、李四')
    expect(screen.queryByText('你的回合')).toBeNull()
    // 点击真人头像：一键接棒插入 @名
    fireEvent.click(screen.getByTitle(/一键接棒：插入 @张三/))
    expect(insert).toHaveBeenCalledWith('@张三 ')
  })

  it('旧消息（无 humanMentions + @用户）→ 回退「你的回合」', () => {
    render(<HandoffBar message={makeAgentMessage({ mentions: ['user'] })} />)
    expect(screen.getByText('你的回合')).toBeTruthy()
    expect(document.querySelector('[data-handoff-targets]')).toBeNull()
  })
})

describe('M79-AA：正文 @用户 泛称展开（MessageItem 集成）', () => {
  it('agent 消息正文 @用户 → chip 展开为具体定向人名（与交接条同源 humanMentions）', () => {
    const msg = makeAgentMessage({
      id: 'm_expand',
      content: '账目已理清，@用户 请拍板。',
      mentions: ['user'],
      humanMentions: ['u1'],
    })
    useSessionStore.setState({
      currentId: 's1',
      byId: new Map([[msg.id, msg]]),
      order: [msg.id],
    } as never)
    const { container } = render(<MessageItem messageId="m_expand" />)
    // 正文 chip 展示具体人（data-mention 保留原 token 锚点）
    expect(container.querySelector('[data-mention="用户"]')?.textContent).toBe('@张三')
    // 交接条口径一致（同一数据源）
    expect(document.querySelector('[data-handoff-targets]')?.textContent).toBe('张三')
  })
})

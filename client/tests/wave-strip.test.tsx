/**
 * 波次悬浮条（WaveStrip）组件测（M37-3 · ADR 0065 决策 4 续修订）：
 * - 顶部方位条结构：渐隐遮罩（data-wave-scrim / aria-hidden）与药丸（data-wave-strip 锚点）恒同层——
 *   滚过顶端的内容在边缘自然淡出，消除药丸与消息头部同排交错的观感；
 * - 读数：第 N 波 + 成员头像与名字；「共 N 波」仅总数 ≥2 时显示（缺省 / 单波不显示）；
 * - 交互：点击触发 onJump（跳波起点由调用侧完成）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import type { AgentDefinition, ChatMessage } from '@multi-agent/shared'
import { WaveStrip } from '../src/components/chat/WaveStrip'
import type { WaveInfo } from '../src/lib/chat-rows'
import { useAgentStore } from '../src/stores/agent-store'
import { useSessionStore } from '../src/stores/session-store'

const T0 = '2026-09-19T10:00:00.000Z'

function makeAgent(id: string, name: string): AgentDefinition {
  return {
    id,
    name,
    role: '谈判手',
    title: '',
    description: '',
    capabilities: [],
    group: 'negotiation',
    avatar: { gradient: ['#0ea5e9', '#14b8a6'], icon: 'user' },
    handoff: [],
  }
}

const TAN = makeAgent('tan', '谭成')

function agentMsg(id: string, agentId: string): ChatMessage {
  return {
    id,
    sessionId: 's1',
    role: 'agent',
    agentId,
    content: '',
    mentions: [],
    status: 'complete',
    createdAt: T0,
    runId: 'r1',
    turnIndex: 0,
  }
}

const INFO: WaveInfo = { runId: 'r1', turnIndex: 0, memberIds: ['m1'] }

beforeEach(() => {
  useAgentStore.setState({ agents: [TAN], groups: [], skills: [], loaded: true, loading: false, statuses: {} })
  useSessionStore.setState({ byId: new Map([['m1', agentMsg('m1', 'tan')]]), order: ['m1'] })
})

describe('WaveStrip（顶部方位条）', () => {
  it('渲染锚点药丸（第 N 波 + 成员名字）与顶部渐隐遮罩', () => {
    const { container } = render(<WaveStrip info={INFO} total={3} onJump={() => undefined} />)
    const strip = container.querySelector('[data-wave-strip="0"]')
    expect(strip).not.toBeNull()
    expect(strip).toHaveTextContent('第 1 波')
    expect(strip).toHaveTextContent('谭成')
    const scrim = container.querySelector('[data-wave-scrim]')
    expect(scrim).not.toBeNull()
    expect(scrim).toHaveAttribute('aria-hidden')
    expect(scrim!.className).toContain('from-background')
  })

  it('「共 N 波」仅在总数 ≥2 时显示', () => {
    const { container, rerender } = render(<WaveStrip info={INFO} total={3} onJump={() => undefined} />)
    expect(container.querySelector('[data-wave-strip]')).toHaveTextContent('共 3 波')
    rerender(<WaveStrip info={INFO} total={1} onJump={() => undefined} />)
    expect(container.querySelector('[data-wave-strip]')).not.toHaveTextContent('共')
    rerender(<WaveStrip info={INFO} onJump={() => undefined} />)
    expect(container.querySelector('[data-wave-strip]')).not.toHaveTextContent('共')
  })

  it('点击触发 onJump（跳波起点）', () => {
    const onJump = vi.fn()
    const { container } = render(<WaveStrip info={INFO} total={2} onJump={onJump} />)
    fireEvent.click(container.querySelector('[data-wave-strip]')!)
    expect(onJump).toHaveBeenCalledTimes(1)
  })
})

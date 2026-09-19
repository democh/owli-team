/**
 * M22 图谱深化前端测试（§28.5）：
 * - GraphReplay 回放条：进度 / 播放暂停 / 拖动定格 / 回到实时；
 * - NodePreview 悬停预览卡：状态徽章（与档案面板同口径）/ 最近发言 / 战绩三数 / 游离提示；
 * - GraphInspector 增量：技能 chips（前 4 + 计数）/ 灵魂徽标 / 接力链追踪按钮 / 游离提示。
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as React from 'react'
import type { AgentDefinition, ChatMessage, SoulMeta } from '@multi-agent/shared'
import { GraphInspector } from '../src/components/team/graph/GraphInspector'
import { GraphReplay } from '../src/components/team/graph/GraphReplay'
import { NodePreview } from '../src/components/team/graph/NodePreview'
import { useAgentStore } from '../src/stores/agent-store'

const T0 = '2026-06-01T08:00:00.000Z'

const ZEN: SoulMeta = { id: 'zen', name: '禅意', tagline: '静水流深，以问代答', icon: 'moon', traits: ['寡言'], tone: '慢而稳' }

const PM: AgentDefinition = {
  id: 'pm',
  name: '费利',
  role: '产品经理',
  title: '需求负责人',
  description: '',
  capabilities: ['需求分析', '用户故事', '验收标准', '优先级排序', '风险识别'],
  group: 'development',
  avatar: { gradient: ['#3b82f6', '#f59e0b'], icon: 'user' },
  handoff: [],
  souls: [ZEN],
  defaultSoul: 'zen',
}

const LAST: ChatMessage = {
  id: 'm1',
  sessionId: 's1',
  role: 'agent',
  agentId: 'pm',
  content: '需求已确认，下一步交给艾达设计接口。',
  mentions: [],
  status: 'complete',
  createdAt: T0,
}

// ---------- GraphReplay 回放条 ----------

describe('GraphReplay 回放条（M22）', () => {
  it('渲染进度与控件；播放中显示暂停', () => {
    render(<GraphReplay index={3} total={10} playing onSeek={vi.fn()} onToggle={vi.fn()} onExit={vi.fn()} />)
    expect(screen.getByText('3/10')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '暂停回放' })).toBeInTheDocument()
    const slider = screen.getByRole('slider', { name: '回放进度' }) as HTMLInputElement
    expect(slider.value).toBe('3')
    expect(slider.max).toBe('10')
  })

  it('点击播放/暂停触发 onToggle；拖动滑块定格触发 onSeek', async () => {
    const onToggle = vi.fn()
    const onSeek = vi.fn()
    const user = userEvent.setup()
    render(<GraphReplay index={2} total={8} playing={false} onSeek={onSeek} onToggle={onToggle} onExit={vi.fn()} />)
    expect(screen.getByRole('button', { name: '播放回放' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '播放回放' }))
    expect(onToggle).toHaveBeenCalledTimes(1)
    fireEvent.change(screen.getByRole('slider', { name: '回放进度' }), { target: { value: '5' } })
    expect(onSeek).toHaveBeenCalledWith(5)
  })

  it('回到实时触发 onExit', async () => {
    const onExit = vi.fn()
    const user = userEvent.setup()
    render(<GraphReplay index={0} total={4} playing onSeek={vi.fn()} onToggle={vi.fn()} onExit={onExit} />)
    await user.click(screen.getByRole('button', { name: /回到实时/ }))
    expect(onExit).toHaveBeenCalledTimes(1)
  })
})

// ---------- NodePreview 悬停预览卡 ----------

describe('NodePreview 悬停预览卡（M22）', () => {
  it('状态徽章（发言优先）/ 最近发言摘要 / 战绩三数', () => {
    render(
      <NodePreview
        agent={PM}
        speaking
        queueIndex={2}
        awaitingUser={false}
        status="idle"
        inCount={3}
        outCount={1}
        talks={4}
        isolated={false}
        lastMessage={LAST}
        left={20}
        top={30}
      />,
    )
    expect(screen.getByText('费利')).toBeInTheDocument()
    expect(screen.getByText('发言中')).toBeInTheDocument()
    expect(screen.getByText(/需求已确认/)).toBeInTheDocument()
    // 数字拆在 <b> 里：getByText 只匹配直接文本节点，用外层 span + toHaveTextContent 断言
    expect(screen.getByText('接手')).toHaveTextContent('接手 3')
    expect(screen.getByText('交出')).toHaveTextContent('交出 1')
    expect(screen.getByText('发言')).toHaveTextContent('发言 4')
  })

  it('排队序号与待你指示文案（与档案面板同口径）；无发言空态', () => {
    const { rerender } = render(
      <NodePreview
        agent={PM}
        speaking={false}
        queueIndex={3}
        awaitingUser={false}
        inCount={0}
        outCount={0}
        talks={0}
        isolated={false}
        left={0}
        top={0}
      />,
    )
    expect(screen.getByText('排队第 3 位')).toBeInTheDocument()
    expect(screen.getByText('尚未发言')).toBeInTheDocument()
    rerender(
      <NodePreview
        agent={PM}
        speaking={false}
        queueIndex={0}
        awaitingUser
        inCount={0}
        outCount={0}
        talks={0}
        isolated={false}
        left={0}
        top={0}
      />,
    )
    expect(screen.getByText('待你指示')).toBeInTheDocument()
  })

  it('游离成员提示', () => {
    render(
      <NodePreview
        agent={PM}
        speaking={false}
        queueIndex={0}
        awaitingUser={false}
        inCount={0}
        outCount={0}
        talks={0}
        isolated
        left={0}
        top={0}
      />,
    )
    expect(screen.getByText('待命')).toBeInTheDocument()
    expect(screen.getByText(/还没接过棒/)).toBeInTheDocument()
  })
})

// ---------- GraphInspector 增量 ----------

describe('GraphInspector M22 增量', () => {
  const base = {
    upstream: [],
    downstream: [],
    talks: 0,
    speaking: false,
    queueIndex: 0,
    awaitingUser: false,
    onFocus: vi.fn(),
    onSelect: vi.fn(),
    onClose: vi.fn(),
  }

  it('技能 chips：前 4 条 + 更多计数', () => {
    useAgentStore.setState({ agents: [PM] })
    render(<GraphInspector agent={PM} {...base} />)
    expect(screen.getByText('专长')).toBeInTheDocument()
    expect(screen.getByText('需求分析')).toBeInTheDocument()
    expect(screen.getByText('优先级排序')).toBeInTheDocument()
    // 第 5 条裁到 +1 计数
    expect(screen.queryByText('风险识别')).not.toBeInTheDocument()
    expect(screen.getByText('+1')).toBeInTheDocument()
  })

  it('灵魂徽标：soul 渲染 SoulBadge；缺省不占位', () => {
    useAgentStore.setState({ agents: [PM] })
    const { rerender } = render(<GraphInspector agent={PM} {...base} soul={ZEN} />)
    expect(screen.getByText('禅意')).toBeInTheDocument()
    rerender(<GraphInspector agent={PM} {...base} />)
    expect(screen.queryByText('禅意')).not.toBeInTheDocument()
  })

  it('追踪按钮：onTrace 存在时渲染并回调；traceActive 切换文案；未接线不渲染', async () => {
    useAgentStore.setState({ agents: [PM] })
    const onTrace = vi.fn()
    const user = userEvent.setup()
    const { rerender } = render(<GraphInspector agent={PM} {...base} onTrace={onTrace} />)
    await user.click(screen.getByRole('button', { name: /追踪接力链/ }))
    expect(onTrace).toHaveBeenCalledTimes(1)
    rerender(<GraphInspector agent={PM} {...base} onTrace={onTrace} traceActive />)
    expect(screen.getByRole('button', { name: /停止追踪/ })).toBeInTheDocument()
    rerender(<GraphInspector agent={PM} {...base} />)
    expect(screen.queryByRole('button', { name: /追踪/ })).not.toBeInTheDocument()
  })

  it('游离成员提示条', () => {
    useAgentStore.setState({ agents: [PM] })
    render(<GraphInspector agent={PM} {...base} isolated />)
    expect(screen.getByText(/还没接过棒/)).toBeInTheDocument()
    expect(screen.getByText('接力链')).toBeInTheDocument()
  })
})

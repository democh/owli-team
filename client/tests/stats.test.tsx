/**
 * 战绩视图（战力榜）：指标卡总览 / 点击指标卡切换排行维度 / 综合贡献排序 / 成就 chip 与解锁进度 / 空态。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AgentDefinition, ChatMessage } from '@multi-agent/shared'
import { StatsView } from '../src/components/team/StatsView'
import { useRunStore } from '../src/stores/run-store'
import { useUiStore } from '../src/stores/ui-store'

function makeAgent(id: string, name: string): AgentDefinition {
  return {
    id,
    name,
    role: id,
    title: id,
    description: '',
    capabilities: [],
    group: 'development',
    avatar: { gradient: ['#3b82f6', '#f59e0b'], icon: 'user' },
    handoff: [],
  }
}

function msg(partial: Partial<ChatMessage> & { id: string; agentId?: string }): ChatMessage {
  return {
    sessionId: 's1',
    role: 'agent',
    content: '',
    mentions: [],
    status: 'complete',
    createdAt: '2026-09-16T00:00:00.000Z',
    ...partial,
  }
}

const AGENTS = [makeAgent('mason', '梅森'), makeAgent('luna', '卢娜'), makeAgent('victor', '维克多')]

/**
 * 战绩样本：
 * 梅森：发言 2 / 交付 1（docs/prd.md）/ 被 cue 1（用户 @）/ 交接 1 → 战力 65（首位发言 → 破冰者）
 * 卢娜：发言 2 / 交付 0 / 被 cue 2 / 交接 1 / 工具 3 → 战力 50
 * 维克多：尚未出战
 */
const MESSAGES: ChatMessage[] = [
  msg({ id: 'm1', agentId: 'mason', content: '先拆一下需求', artifacts: ['docs/prd.md'], mentions: ['luna'] }),
  msg({ id: 'm2', agentId: 'luna', content: '收到', mentions: ['user'] }),
  msg({
    id: 'm3',
    agentId: 'luna',
    content: '写了两个脚本',
    mentions: ['mason'],
    toolCalls: [
      { id: 't1', name: 'write_file', args: {}, status: 'ok', startedAt: '2026-09-16T00:00:01.000Z' },
      { id: 't2', name: 'write_file', args: {}, status: 'ok', startedAt: '2026-09-16T00:00:02.000Z' },
      { id: 't3', name: 'run_shell', args: {}, status: 'error', startedAt: '2026-09-16T00:00:03.000Z' },
    ],
  }),
  msg({ id: 'm4', role: 'user', content: '继续', mentions: [] }),
  msg({ id: 'm5', role: 'user', content: '@卢娜 再补充一版', mentions: ['luna'] }),
  msg({ id: 'm6', agentId: 'mason', content: '这版可以', mentions: ['user'] }),
]

function rowTitles(): string[] {
  return screen.getAllByRole('listitem').map((li) => li.getAttribute('title') ?? '')
}

beforeEach(() => {
  useRunStore.setState({ runId: undefined, active: false, lastEndReason: undefined })
  useUiStore.setState({ quietMode: true })
})

describe('StatsView 战力榜', () => {
  it('指标总览：发言 / 交付 / 被 cue / 工具 / 交接 / 完成回合 六卡统计', () => {
    render(<StatsView participants={AGENTS} messages={MESSAGES} />)

    expect(within(screen.getByTitle('按「发言」排名')).getByText('4')).toBeInTheDocument()
    expect(within(screen.getByTitle('按「交付件」排名')).getByText('1')).toBeInTheDocument()
    expect(within(screen.getByTitle('按「被 cue」排名')).getByText('3')).toBeInTheDocument()
    expect(within(screen.getByTitle('按「工具调用」排名')).getByText('3')).toBeInTheDocument()
    expect(within(screen.getByTitle('按「交接」排名')).getByText('2')).toBeInTheDocument()
    // 完成回合：不可点击的纯展示卡
    const turnsCard = screen.getByText('完成回合').closest('div.rounded-xl') as HTMLElement
    expect(within(turnsCard).getByText('4')).toBeInTheDocument()
  })

  it('默认按综合贡献排名：战力分降序 + 榜首金签 + 未出手成员沉底', () => {
    render(<StatsView participants={AGENTS} messages={MESSAGES} />)

    expect(screen.getByText('按 综合贡献 排名')).toBeInTheDocument()
    const rows = rowTitles()
    expect(rows[0]).toContain('梅森')
    expect(rows[0]).toContain('战力 65')
    expect(rows[0]).toContain('发言 2 · 交付 1 · 被 cue 1')
    expect(rows[1]).toContain('卢娜')
    expect(rows[1]).toContain('战力 50')
    expect(rows[2]).toContain('维克多')
    expect(rows[2]).toContain('战力 0')
    expect(screen.getByText('尚未出战')).toBeInTheDocument()
  })

  it('成就体系：已达成徽记 + 最接近解锁的一枚进度提示', () => {
    render(<StatsView participants={AGENTS} messages={MESSAGES} />)

    expect(screen.getByText('破冰者')).toBeInTheDocument()
    expect(screen.getByText('交付官')).toBeInTheDocument()
    // 各自展示最接近解锁的一枚：梅森 → 主力担当 2/4；卢娜 → 人气王 2/3
    expect(screen.getByTitle('距解锁「主力担当」还差 2 次发言')).toBeInTheDocument()
    expect(screen.getByTitle('距解锁「人气王」还差 1 次被 cue')).toBeInTheDocument()
  })

  it('点击指标卡切换排行维度，「返回综合」恢复默认排序', async () => {
    const user = userEvent.setup()
    render(<StatsView participants={AGENTS} messages={MESSAGES} />)

    // 被 cue 维度：卢娜（2）反超梅森（1）
    await user.click(screen.getByTitle('按「被 cue」排名'))
    await waitFor(() => expect(rowTitles()[0]).toContain('卢娜'))
    expect(screen.getByText('按 被 cue 排名')).toBeInTheDocument()
    expect(screen.getByTitle('按「被 cue」排名（点击恢复综合）')).toHaveAttribute('aria-pressed', 'true')

    await user.click(screen.getByText('返回综合'))
    await waitFor(() => expect(rowTitles()[0]).toContain('梅森'))
    expect(screen.getByText('按 综合贡献 排名')).toBeInTheDocument()
  })

  it('运行中显示实时标记；结束后隐藏', () => {
    useRunStore.setState({ active: true })
    const { rerender } = render(<StatsView participants={AGENTS} messages={MESSAGES} />)
    expect(screen.getByText('实时')).toBeInTheDocument()

    useRunStore.setState({ active: false })
    rerender(<StatsView participants={AGENTS} messages={MESSAGES} />)
    expect(screen.queryByText('实时')).toBeNull()
  })

  it('空态：无成员提示选择会话；有成员但未出手提示开启协作', () => {
    const { rerender } = render(<StatsView participants={[]} messages={[]} />)
    expect(screen.getByText('选择一个会话查看战力榜')).toBeInTheDocument()

    rerender(<StatsView participants={AGENTS} messages={[]} />)
    expect(screen.getByText('战绩册还是空的')).toBeInTheDocument()
  })

  it('存在 runId 时提供运行轨迹入口', () => {
    useRunStore.setState({ runId: 'r9' })
    render(<StatsView participants={AGENTS} messages={MESSAGES} />)
    expect(screen.getByText('查看本次运行轨迹')).toBeInTheDocument()
  })
})

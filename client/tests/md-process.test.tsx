/**
 * M81：过程叙述折叠块（::: process）测试：
 * - 解析：正常块（标题 / 字数 / 默认收起）、未闭合 fail-safe、代码块内不解析、空块不渲染、
 *   多块原序上提至消息头部、嵌套块就地渲染（不参与上提）；
 * - 交互（镜像 ToolCallsPanel 范式）：流式展开 / 历史收起 / 回合结束折叠一次 / 手动展开保持 /
 *   流式中手动收起后保持；
 * - 顺序：上提后 `.md-process` 位于正文其余节点之前。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { AgentDefinition, AgentGroup } from '@multi-agent/shared'
import { Markdown } from '../src/components/chat/Markdown'
import { ProcessBlock } from '../src/components/chat/md-ext/ProcessBlock'
import { StreamingContext } from '../src/components/chat/md-ext/streaming'
import { clearMarkdownCaches } from '../src/lib/md-cache'
import { useAgentStore } from '../src/stores/agent-store'
import { useSessionStore } from '../src/stores/session-store'

function makeAgent(overrides: Partial<AgentDefinition> & { id: string; name: string }): AgentDefinition {
  return {
    role: '角色',
    title: '',
    description: '',
    capabilities: [],
    group: 'wellness-mind',
    avatar: { gradient: ['#be185d', '#f472b6'], icon: 'heart' },
    handoff: [],
    ...overrides,
  }
}

const GROUPS: AgentGroup[] = [
  {
    id: 'wellness-mind',
    name: '心理支持',
    description: '',
    icon: 'heart',
    theme: ['#be185d', '#f472b6'],
    objective: '',
    chain: ['emotion-companion'],
    defaultSkills: [],
    parallel: false,
    rounds: false,
    order: 0,
  },
]

beforeEach(() => {
  clearMarkdownCaches()
  useAgentStore.setState({
    agents: [makeAgent({ id: 'emotion-companion', name: '听澜' })],
    groups: GROUPS,
    skills: [],
    loaded: true,
    loading: false,
    statuses: {},
  })
  useSessionStore.setState({ byId: new Map(), order: [] })
})

// ---------- 解析 ----------

describe('::: process 解析', () => {
  it('正常块：摘要行（标题 + 字数）且完成态默认收起', () => {
    const content = ['正文一句。', '', '::: process 过程记录', '- 先按用户原话复述。', '- 下一步等补充。', ':::'].join('\n')
    const { container } = render(<Markdown content={content} />)
    const block = container.querySelector('.md-process')!
    expect(block).not.toBeNull()
    expect(block.getAttribute('data-process')).toBe('')
    expect(block.querySelector('.md-process-summary')?.textContent).toContain('过程记录')
    expect(block.querySelector('.md-process-summary')?.textContent).toMatch(/\d+ 字/)
    // 完成态：折叠体不渲染
    expect(container.querySelector('.md-process-body')).toBeNull()
  })

  it('流式渲染：默认展开，过程文本可见', () => {
    const content = ['::: process', '先按用户原话复述，不追加解释。', ':::'].join('\n')
    const { container } = render(<Markdown content={content} streaming />)
    const body = container.querySelector('.md-process-body')!
    expect(body).not.toBeNull()
    expect(body.textContent).toContain('先按用户原话复述')
  })

  it('未闭合（fail-safe）：内容展开回正文，不渲染壳', () => {
    const content = ['::: process 过程记录', '这段还没收口。'].join('\n')
    const { container } = render(<Markdown content={content} />)
    expect(container.querySelector('.md-process')).toBeNull()
    expect(container.textContent).toContain('这段还没收口')
  })

  it('代码块内的 ::: 不解析', () => {
    const content = ['```md', '::: process', '不是容器', ':::', '```'].join('\n')
    const { container } = render(<Markdown content={content} />)
    expect(container.querySelector('.md-process')).toBeNull()
  })

  it('空块不渲染', () => {
    const content = ['::: process', ':::'].join('\n')
    const { container } = render(<Markdown content={content} />)
    expect(container.querySelector('.md-process')).toBeNull()
  })

  it('多块原序上提；嵌套块就地渲染（不参与上提）', () => {
    const content = [
      '正文一句。',
      '',
      '::: process 第一段',
      '甲。',
      ':::',
      '',
      '::: tip 提示',
      '::: process 嵌套',
      '乙。',
      ':::',
      ':::',
      '',
      '::: process 第二段',
      '丙。',
      ':::',
    ].join('\n')
    const { container } = render(<Markdown content={content} />)
    const body = container.querySelector('.md-body')!
    const top = Array.from(body.children)
    // 顶层两块上提到头部且原序（第一段 → 第二段）；顶层仅此两块
    expect(top[0]!.classList.contains('md-process')).toBe(true)
    expect(top[1]!.classList.contains('md-process')).toBe(true)
    expect(top[0]!.textContent).toContain('第一段')
    expect(top[1]!.textContent).toContain('第二段')
    expect(top.filter((n) => n.classList.contains('md-process'))).toHaveLength(2)
    // 嵌套块留在 callout 内（不参与上提，位于顶部两块之后）
    const calloutIdx = top.findIndex((n) => n.classList.contains('md-callout'))
    expect(calloutIdx).toBeGreaterThan(1)
    expect(top[calloutIdx]!.querySelector('.md-process')).not.toBeNull()
  })
})

// ---------- 交互（镜像 ToolCallsPanel 范式） ----------

describe('ProcessBlock 展开/收起', () => {
  const tree = (streaming: boolean): React.JSX.Element => (
    <StreamingContext.Provider value={streaming}>
      <ProcessBlock title="过程记录" chars={128}>
        <p>过程文本一句。</p>
      </ProcessBlock>
    </StreamingContext.Provider>
  )

  it('流式中：自动展开，过程文本可见', () => {
    render(tree(true))
    expect(screen.getByRole('button', { name: /过程记录/ })).toBeInTheDocument()
    expect(screen.getByText('过程文本一句。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /过程记录/ }).textContent).toContain('128 字')
  })

  it('历史消息（非流式）：默认收起为一行摘要', () => {
    render(tree(false))
    expect(screen.getByRole('button', { name: /过程记录/ })).toBeInTheDocument()
    expect(screen.queryByText('过程文本一句。')).toBeNull()
  })

  it('回合结束（streaming → false）：自动收起一次', () => {
    const { rerender } = render(tree(true))
    expect(screen.getByText('过程文本一句。')).toBeInTheDocument()
    rerender(tree(false))
    expect(screen.queryByText('过程文本一句。')).toBeNull()
    expect(screen.getByRole('button', { name: /过程记录/ })).toBeInTheDocument()
  })

  it('回合结束后手动展开：保持展开，后续状态下发不打断', () => {
    const { rerender } = render(tree(false))
    fireEvent.click(screen.getByRole('button', { name: /过程记录/ }))
    expect(screen.getByText('过程文本一句。')).toBeInTheDocument()
    rerender(tree(false))
    expect(screen.getByText('过程文本一句。')).toBeInTheDocument()
  })

  it('流式中用户手动收起：回合结束保持收起（尊重手动选择）', () => {
    const { rerender } = render(tree(true))
    fireEvent.click(screen.getByRole('button', { name: /过程记录/ }))
    expect(screen.queryByText('过程文本一句。')).toBeNull()
    rerender(tree(true))
    expect(screen.queryByText('过程文本一句。')).toBeNull()
    rerender(tree(false))
    expect(screen.queryByText('过程文本一句。')).toBeNull()
  })

  it('空容器：不渲染（返回 null）', () => {
    const { container } = render(
      <StreamingContext.Provider value={false}>
        <ProcessBlock title="过程" />
      </StreamingContext.Provider>,
    )
    expect(container.querySelector('.md-process')).toBeNull()
  })
})

// ---------- 顺序 ----------

describe('过程块上提顺序（TurnCard 过程区）', () => {
  it('上提后 .md-process 位于正文其余节点之前', () => {
    const content = ['开门见山的正文。', '', '::: process', '过程一句。', ':::', '', '正文第二段。'].join('\n')
    const { container } = render(<Markdown content={content} />)
    const body = container.querySelector('.md-body')!
    const top = Array.from(body.children)
    const procIdx = top.findIndex((n) => n.classList.contains('md-process'))
    const firstP = top.findIndex((n) => n.tagName === 'P')
    expect(procIdx).toBe(0)
    expect(firstP).toBeGreaterThan(procIdx)
  })
})

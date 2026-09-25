/**
 * Markdown 渲染：@mention 插件（已知 token → chip；未知 token 保持纯文本）+ 基础排版。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { AgentDefinition } from '@multi-agent/shared'
import { Markdown } from '../src/components/chat/Markdown'
import { MessageContext } from '../src/components/chat/md-ext/message-context'
import { useAgentStore } from '../src/stores/agent-store'

function makeAgent(id: string, name: string, gradient: [string, string]): AgentDefinition {
  return {
    id,
    name,
    role: '架构师',
    title: '',
    description: '',
    capabilities: [],
    group: 'development',
    avatar: { gradient, icon: 'user' },
    handoff: [],
  }
}

beforeEach(() => {
  useAgentStore.setState({
    agents: [makeAgent('architect', '艾达', ['#3b82f6', '#60a5fa']), makeAgent('pm', '费利', ['#f59e0b', '#fbbf24'])],
    skills: [],
    loaded: true,
    loading: false,
    statuses: {},
  })
})

describe('Markdown @mention 插件', () => {
  it('已知成员名渲染为 chip（data-mention + 主色）', () => {
    const { container } = render(<Markdown content="需求已澄清，请 @艾达 开始架构设计。" />)
    const chip = container.querySelector('[data-mention="艾达"]')
    expect(chip).not.toBeNull()
    expect(chip!.textContent).toBe('@艾达')
    // 主色着色（gradient[0] → rgb 形式）
    expect(chip!.getAttribute('style')).toContain('rgb(59, 130, 246)')
  })

  it('用户别名（@用户 / @user / @你）命中 chip', () => {
    const { container } = render(<Markdown content="总结完毕，@用户 请拍板。@user 同义。@你 也是。" />)
    expect(container.querySelector('[data-mention="用户"]')).not.toBeNull()
    expect(container.querySelector('[data-mention="user"]')).not.toBeNull()
    expect(container.querySelector('[data-mention="你"]')).not.toBeNull()
  })

  it('M79-AA：有具体定向人时 @用户 / @user 展开为人名（@你 保持第二人称）', () => {
    const { container } = render(
      <MessageContext.Provider value={{ messageId: 'm1', sessionId: 's1', humanLabels: ['democh'] }}>
        <Markdown content="账目已理清，@用户 请拍板。@user 同义。@你 也是。" />
      </MessageContext.Provider>,
    )
    // 展示文本展开为具体人名；data-mention 保留原 token（测试与交互锚点不变）
    expect(container.querySelector('[data-mention="用户"]')!.textContent).toBe('@democh')
    expect(container.querySelector('[data-mention="user"]')!.textContent).toBe('@democh')
    expect(container.querySelector('[data-mention="你"]')!.textContent).toBe('@你')
  })

  it('M79-AA：多定向人顿号连接；无具体数据回退原 token（缓存不串）', () => {
    const multi = render(
      <MessageContext.Provider value={{ messageId: 'm1', sessionId: 's1', humanLabels: ['张三', '李四'] }}>
        <Markdown content="结论已出，@用户 请确认。" />
      </MessageContext.Provider>,
    )
    expect(multi.container.querySelector('[data-mention="用户"]')!.textContent).toBe('@张三、李四')
    multi.unmount()
    // 同内容无定向数据（如兼容模式 / 流式中）→ 按原 token 渲染（缓存 key 含展开名，不串用）
    const fallback = render(<Markdown content="结论已出，@用户 请确认。" />)
    expect(fallback.container.querySelector('[data-mention="用户"]')!.textContent).toBe('@用户')
  })

  it('未知 token 保持纯文本，不产生 chip', () => {
    const { container } = render(<Markdown content="发邮件到 team@example 抄送 @unknown_person" />)
    expect(container.querySelectorAll('[data-mention]')).toHaveLength(0)
    expect(container.textContent).toContain('@unknown_person')
  })

  it('行内代码中的 @名字 不替换为 chip', () => {
    const { container } = render(<Markdown content={'使用 `@艾达` 作为占位符'} />)
    expect(container.querySelector('[data-mention]')).toBeNull()
    expect(container.querySelector('code')?.textContent).toBe('@艾达')
  })

  it('基础 Markdown：标题 / 列表 / 表格渲染', () => {
    render(<Markdown content={'## 测试计划\n\n- 冒烟\n- 回归\n\n| 项 | 值 |\n| --- | --- |\n| 用例 | 42 |'} />)
    expect(screen.getByRole('heading', { level: 2, name: '测试计划' })).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByRole('table')).toBeInTheDocument()
  })

  it('任务列表（GFM）：checkbox 表达完成状态（结构化断言；静态展示不可编辑）', () => {
    const { container } = render(<Markdown content={'- [ ] 待办一\n- [x] 已完成项'} />)
    const items = container.querySelectorAll('li.task-list-item')
    expect(items).toHaveLength(2)
    const boxes = container.querySelectorAll('li.task-list-item > input[type="checkbox"]')
    expect(boxes).toHaveLength(2)
    expect((boxes[0] as HTMLInputElement).checked).toBe(false)
    expect((boxes[1] as HTMLInputElement).checked).toBe(true)
    // 静态展示：可勾选 / 可回填的清单走 ::: checklist 容器（ADR 0064 口径）
    expect((boxes[0] as HTMLInputElement).disabled).toBe(true)
  })
})

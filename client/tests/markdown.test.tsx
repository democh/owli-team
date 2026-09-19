/**
 * Markdown 渲染：@mention 插件（已知 token → chip；未知 token 保持纯文本）+ 基础排版。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { AgentDefinition } from '@multi-agent/shared'
import { Markdown } from '../src/components/chat/Markdown'
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
})

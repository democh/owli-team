/**
 * 左右栏显隐入口：左钮 = 主区左缘垂直中部悬浮把手（LeftPanelEdgeHandle——默认不展示、悬停热区
 * 淡入；单个折角箭头方向随展开 / 收起翻转）、右钮右对齐于主区头部最右端（面板样式图标）——
 * 展开态 = 「隐藏 X 栏」、收起态 = 「显示 X 栏」；与 ⌘B / ⌘⇧B、命令面板「左 / 右栏：显示 / 隐藏」
 * 同源（同读写 ui-store）；面板头部（会话 / 团队）不再内嵌收起钮，窄屏为抽屉（入口在顶栏 /
 * 底部成员条）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LeftPanelEdgeHandle, PanelToggleButton } from '../src/components/layout/AppLayout'
import { SessionList } from '../src/components/sessions/SessionList'
import { TeamPanel } from '../src/components/team/TeamPanel'
import { useUiStore } from '../src/stores/ui-store'

beforeEach(() => {
  useUiStore.setState({ rightView: 'members', lastOf: {}, rightPanelOpen: true, leftPanelOpen: true })
})

describe('主区左缘·左栏悬浮把手（垂直中部·默认不展示、悬停淡入）', () => {
  it('默认隐藏（opacity-0 + group-hover 淡入）；点击收起并切换为「显示左栏」（折角箭头翻转），再点恢复', async () => {
    const { container } = render(<LeftPanelEdgeHandle />)

    const user = userEvent.setup()
    const handle = screen.getByTitle('隐藏左栏（⌘⇧B）')
    // 非悬浮不展示：把手常驻但透明，悬停左缘热区（group-hover）时淡入
    expect(handle.className).toContain('opacity-0')
    expect(handle.className).toContain('group-hover:opacity-100')
    // 单折角箭头双态：展开（可收起）= 向左；收起（可展开）= 向右
    expect(container.querySelector('.lucide-chevron-left')).not.toBeNull()
    await user.click(handle)
    expect(useUiStore.getState().leftPanelOpen).toBe(false)
    expect(container.querySelector('.lucide-chevron-right')).not.toBeNull()

    await user.click(screen.getByTitle('显示左栏（⌘⇧B）'))
    expect(useUiStore.getState().leftPanelOpen).toBe(true)
    expect(container.querySelector('.lucide-chevron-left')).not.toBeNull()
  })
})

describe('主区头部·右栏显隐钮（右对齐于头部最右端·面板图标）', () => {
  it('展开态 = 「隐藏右栏（⌘B）」：点击收起并切换为「显示右栏」，再点恢复', async () => {
    render(<PanelToggleButton side="right" />)

    const user = userEvent.setup()
    await user.click(screen.getByTitle('隐藏右栏（⌘B）'))
    expect(useUiStore.getState().rightPanelOpen).toBe(false)

    await user.click(screen.getByTitle('显示右栏（⌘B）'))
    expect(useUiStore.getState().rightPanelOpen).toBe(true)
  })
})

describe('面板头部不再内嵌收起钮（已收敛于主区头部）', () => {
  it('会话列表头部无面板显隐钮', () => {
    render(<SessionList onSelect={() => undefined} />)
    expect(screen.queryByTitle('隐藏左栏（⌘⇧B）')).toBeNull()
    expect(screen.queryByTitle('显示左栏（⌘⇧B）')).toBeNull()
  })

  it('团队面板页签行无面板显隐钮', () => {
    render(<TeamPanel />)
    expect(screen.queryByTitle('隐藏右栏（⌘B）')).toBeNull()
    expect(screen.queryByTitle('显示右栏（⌘B）')).toBeNull()
  })
})

/**
 * 快捷键帮助（M12；Tab 化重设计）：ui-store.helpOpen 驱动 Dialog 显隐；
 * 分组页签（通用 / 输入框 / 审批卡 / 画布）一次只展开一组，「指派语义」说明块随「输入框」页签。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ShortcutHelp } from '../src/components/layout/ShortcutHelp'
import { useUiStore } from '../src/stores/ui-store'

beforeEach(() => {
  useUiStore.setState({ helpOpen: false })
})

describe('快捷键帮助（M12 · Tab 分组）', () => {
  it('helpOpen 驱动显隐', () => {
    render(<ShortcutHelp />)
    expect(screen.queryByText('键盘快捷键')).toBeNull()

    act(() => useUiStore.getState().setHelpOpen(true))
    expect(screen.getByText('键盘快捷键')).toBeTruthy()
  })

  it('默认停在「通用」页签：仅通用组按键渲染，其他组不渲染', () => {
    useUiStore.setState({ helpOpen: true })
    render(<ShortcutHelp />)

    expect(screen.getByRole('tab', { name: '通用' })).toBeTruthy()
    expect(screen.getByText('命令面板')).toBeTruthy()
    expect(screen.getByText('K')).toBeTruthy()
    // 非当前页签的内容不挂载
    expect(screen.queryByText('Backspace')).toBeNull()
    expect(screen.queryByText('@ / 命令候选选择')).toBeNull()
    expect(screen.queryByText('指派语义')).toBeNull()
  })

  it('切到「输入框」页签：候选键与「指派语义」说明出现', async () => {
    useUiStore.setState({ helpOpen: true })
    render(<ShortcutHelp />)

    const user = userEvent.setup()
    await user.click(screen.getByRole('tab', { name: '输入框' }))

    expect(screen.getByText('@ / 命令候选选择')).toBeTruthy()
    expect(screen.getByText('发送消息')).toBeTruthy()
    expect(screen.getByText('指派语义')).toBeTruthy()
    expect(screen.getByText(/行首 @ 指定首棒/)).toBeTruthy()
    // 通用组随页签卸载
    expect(screen.queryByText('命令面板')).toBeNull()
  })

  it('切到「审批卡」与「画布」页签：各自按键组分别呈现', async () => {
    useUiStore.setState({ helpOpen: true })
    render(<ShortcutHelp />)

    const user = userEvent.setup()
    await user.click(screen.getByRole('tab', { name: '审批卡' }))
    expect(screen.getByText('Backspace')).toBeTruthy()
    expect(screen.getByText('批准')).toBeTruthy()

    await user.click(screen.getByRole('tab', { name: '画布' }))
    expect(screen.getByText('手型工具 / 选择工具')).toBeTruthy()
    expect(screen.getByText('H')).toBeTruthy()
    expect(screen.getByText('撤销 / 重做')).toBeTruthy()
  })

  it('页签选择在组件内记忆：关闭重开后停留上次分组', async () => {
    useUiStore.setState({ helpOpen: true })
    render(<ShortcutHelp />)

    const user = userEvent.setup()
    await user.click(screen.getByRole('tab', { name: '画布' }))

    act(() => useUiStore.getState().setHelpOpen(false))
    act(() => useUiStore.getState().setHelpOpen(true))
    expect(screen.getByText('手型工具 / 选择工具')).toBeTruthy()
    expect(screen.queryByText('命令面板')).toBeNull()
  })
})

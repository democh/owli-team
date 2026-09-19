/**
 * 快捷键帮助（M12）：ui-store.helpOpen 驱动 Dialog 显隐；展示分组按键与「指派语义」说明块。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { ShortcutHelp } from '../src/components/layout/ShortcutHelp'
import { useUiStore } from '../src/stores/ui-store'

beforeEach(() => {
  useUiStore.setState({ helpOpen: false })
})

describe('快捷键帮助（M12）', () => {
  it('helpOpen 驱动显隐', () => {
    render(<ShortcutHelp />)
    expect(screen.queryByText('键盘快捷键')).toBeNull()

    act(() => useUiStore.getState().setHelpOpen(true))
    expect(screen.getByText('键盘快捷键')).toBeTruthy()
  })

  it('展示分组按键与指派语义说明', () => {
    useUiStore.setState({ helpOpen: true })
    render(<ShortcutHelp />)

    expect(screen.getByText('命令面板')).toBeTruthy()
    expect(screen.getByText('K')).toBeTruthy()
    expect(screen.getByText('Backspace')).toBeTruthy()
    expect(screen.getByText('@ 候选选择')).toBeTruthy()
    expect(screen.getByText('指派语义')).toBeTruthy()
    expect(screen.getByText(/行首 @ 指定首棒/)).toBeTruthy()
  })
})

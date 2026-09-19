/**
 * 顶栏 HeaderBar（M26 通栏布局）：实时连接状态 / 安静模式 / 快捷键帮助。
 * 头部维护：安静模式开关自右栏面板头部上移至此（全局 UI 偏好，右栏页签区不挤占开关位）。
 * （后补）命令面板与面板显隐撤出顶栏：命令面板 = ⌘K 键盘直达；面板显隐收敛于主区（左 = 左缘悬浮
 * 把手 / 右 = 头部最右端，见 tests/right-panel.test.tsx），键盘路径 ⌘B（右）/ ⌘⇧B（左）。
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HeaderBar } from '../src/components/layout/AppLayout'
import { useUiStore } from '../src/stores/ui-store'

describe('顶栏 HeaderBar：安静模式开关（自右栏上移）', () => {
  it('铃铛按钮实时切换 quietMode 并回显状态', async () => {
    useUiStore.setState({ quietMode: false })
    render(<HeaderBar />)

    const user = userEvent.setup()
    await user.click(screen.getByTitle('安静模式（关闭趣味动画）'))
    expect(useUiStore.getState().quietMode).toBe(true)
    expect(screen.getByTitle('退出安静模式')).toBeTruthy()

    await user.click(screen.getByTitle('退出安静模式'))
    expect(useUiStore.getState().quietMode).toBe(false)
  })

  it('命令面板与右栏显隐按钮已撤出顶栏（⌘K / ⌘B 键盘直达）', () => {
    render(<HeaderBar />)
    expect(screen.queryByTitle('命令面板（⌘K）')).toBeNull()
    expect(screen.queryByTitle('隐藏右栏（⌘B）')).toBeNull()
    expect(screen.queryByTitle('显示右栏（⌘B）')).toBeNull()
  })
})

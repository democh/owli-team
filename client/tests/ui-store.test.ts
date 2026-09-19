/**
 * UI store：消息定位请求（右侧接力卡 → 对话区滚动 + 闪光）、安静模式与面板显隐（左右栏）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { useUiStore } from '../src/stores/ui-store'

beforeEach(() => {
  useUiStore.setState({
    mainTab: 'chat',
    rightView: 'members',
    rightPanelOpen: true,
    leftPanelOpen: true,
    newArtifactCount: 0,
    focusRequest: undefined,
  })
})

describe('ui-store 消息定位', () => {
  it('focusMessage：从交付件页切回对话页，nonce 从 1 起', () => {
    useUiStore.setState({ mainTab: 'artifacts' })
    useUiStore.getState().focusMessage('m1')
    const s = useUiStore.getState()
    expect(s.mainTab).toBe('chat')
    expect(s.focusRequest).toEqual({ id: 'm1', nonce: 1 })
  })

  it('focusMessage：重复点击同一消息 nonce 递增（保证重新触发闪光）', () => {
    useUiStore.getState().focusMessage('m1')
    useUiStore.getState().focusMessage('m1')
    useUiStore.getState().focusMessage('m2')
    expect(useUiStore.getState().focusRequest).toEqual({ id: 'm2', nonce: 3 })
  })

  it('clearFocus：清空定位请求', () => {
    useUiStore.getState().focusMessage('m1')
    useUiStore.getState().clearFocus()
    expect(useUiStore.getState().focusRequest).toBeUndefined()
  })
})

describe('ui-store 右栏显隐', () => {
  it('toggleRightPanel / setRightPanelOpen：翻转并持久化 ma:rightPanelOpen', () => {
    useUiStore.getState().toggleRightPanel()
    expect(useUiStore.getState().rightPanelOpen).toBe(false)
    expect(localStorage.getItem('ma:rightPanelOpen')).toBe('0')

    useUiStore.getState().toggleRightPanel()
    expect(useUiStore.getState().rightPanelOpen).toBe(true)
    expect(localStorage.getItem('ma:rightPanelOpen')).toBe('1')

    useUiStore.getState().setRightPanelOpen(false)
    expect(useUiStore.getState().rightPanelOpen).toBe(false)
  })

  it('setRightView 默认展开右栏（用户选视图必有可见结果）', () => {
    useUiStore.setState({ rightPanelOpen: false })
    useUiStore.getState().setRightView('memory')
    expect(useUiStore.getState().rightView).toBe('memory')
    expect(useUiStore.getState().rightPanelOpen).toBe(true)
  })

  it('setRightView({ reveal: false })（程序性跟随）不抢展开：只改视图状态', () => {
    useUiStore.setState({ rightPanelOpen: false })
    useUiStore.getState().setRightView('live', { reveal: false })
    expect(useUiStore.getState().rightView).toBe('live')
    expect(useUiStore.getState().rightPanelOpen).toBe(false)
  })
})

describe('ui-store 左栏显隐（与右栏对称）', () => {
  it('toggleLeftPanel / setLeftPanelOpen：翻转并持久化 ma:leftPanelOpen', () => {
    useUiStore.getState().toggleLeftPanel()
    expect(useUiStore.getState().leftPanelOpen).toBe(false)
    expect(localStorage.getItem('ma:leftPanelOpen')).toBe('0')

    useUiStore.getState().toggleLeftPanel()
    expect(useUiStore.getState().leftPanelOpen).toBe(true)
    expect(localStorage.getItem('ma:leftPanelOpen')).toBe('1')

    useUiStore.getState().setLeftPanelOpen(false)
    expect(useUiStore.getState().leftPanelOpen).toBe(false)
  })
})

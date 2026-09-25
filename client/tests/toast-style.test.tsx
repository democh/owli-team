/**
 * 全局 toast 视觉（sonner 包装；M85+ 视觉优化）：
 * - 配置导出：类型图标齐全与自定义类名映射（样式在 index.css 承接）；
 * - 渲染穿透：success toast 带类型节点 / 自定义类 / 图标 / 关闭按钮；主题不退化为暗色（锁定浅色）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { Toaster, TOAST_CLASSNAMES, TOAST_ICONS } from '../src/components/ui/sonner'

beforeEach(() => {
  // sonner 需要的浏览器 API：jsdom 兜底（不改变断言语义）
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  )
  if (typeof window.matchMedia !== 'function') {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }))
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('全局 toast（sonner 包装）', () => {
  it('配置：类型图标齐全 + 自定义类名映射齐全（裸 toast 走 [data-type] 主色锚点）', () => {
    expect(Object.keys(TOAST_ICONS).sort()).toEqual(['error', 'info', 'loading', 'success', 'warning'])
    expect(TOAST_CLASSNAMES.toast).toBe('ma-toast')
    expect(TOAST_CLASSNAMES.icon).toBe('ma-toast-icon')
    expect(TOAST_CLASSNAMES.closeButton).toBe('ma-toast-close')
    expect(TOAST_CLASSNAMES.description).toBe('ma-toast-desc')
  })

  it('渲染穿透：success toast 带类型节点 / 自定义类 / 图标 / 关闭按钮；主题不退化为暗色', async () => {
    const { unmount } = render(<Toaster />)
    act(() => {
      toast.success('已保存')
    })
    await waitFor(() => {
      const el = document.querySelector('[data-sonner-toast][data-type="success"]')
      expect(el).not.toBeNull()
      expect(el!.className).toContain('ma-toast')
      expect(el!.querySelector('.ma-toast-icon svg')).not.toBeNull()
      expect(el!.querySelector('.ma-toast-close')).not.toBeNull()
      expect(el!.textContent).toContain('已保存')
    })
    // 主题锁定浅色：toaster 容器不得为 dark（防止系统暗色下与项目浅色 UI 漂移）
    const toaster = document.querySelector('[data-sonner-toaster]')
    expect(toaster?.getAttribute('data-theme')).not.toBe('dark')
    act(() => {
      toast.dismiss()
    })
    unmount()
  })
})

import * as React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { apiGet, apiPost } from '../src/lib/api'
import { useUnsavedChanges } from '../src/lib/unsaved-changes'
import { useUiStore } from '../src/stores/ui-store'
import { Overlay } from '../src/components/chat/md-ext/Overlay'

function DirtyForm({ dirty }: { dirty: boolean }): React.JSX.Element {
  const confirm = useUnsavedChanges(dirty)
  return (
    <button
      onClick={() => {
        if (confirm()) useUiStore.getState().setMainTab('chat')
      }}
    >
      恢复
    </button>
  )
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('交互基础保护', () => {
  it('有未保存修改时取消导航保持原视图，确认后才离开', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    useUiStore.setState({ appView: 'settings' })
    const view = render(<DirtyForm dirty />)
    expect(useUiStore.getState().setAppView('workspace')).toBe(false)
    expect(useUiStore.getState().appView).toBe('settings')
    confirm.mockReturnValue(true)
    expect(useUiStore.getState().setAppView('workspace')).toBe(true)
    view.unmount()
    confirm.mockClear()
    useUiStore.getState().setAppView('settings')
    expect(confirm).not.toHaveBeenCalled()
  })

  it('表单恢复操作与关闭页面受脏状态保护，保存后解除', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    useUiStore.setState({ mainTab: 'artifacts' })
    const view = render(<DirtyForm dirty />)
    fireEvent.click(screen.getByText('恢复'))
    expect(useUiStore.getState().mainTab).toBe('artifacts')
    const dirtyEvent = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(dirtyEvent)
    expect(dirtyEvent.defaultPrevented).toBe(true)
    view.rerender(<DirtyForm dirty={false} />)
    const cleanEvent = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(cleanEvent)
    expect(cleanEvent.defaultPrevented).toBe(false)
  })

  it('预览浮层限制 Tab 焦点，Esc 关闭后回到触发按钮', async () => {
    function Host(): React.JSX.Element {
      const [open, setOpen] = React.useState(false)
      return (
        <>
          <button onClick={() => setOpen(true)}>打开预览</button>
          <button>背景按钮</button>
          <Overlay open={open} title="预览测试" onClose={() => setOpen(false)}>
            <button>浮层动作</button>
          </Overlay>
        </>
      )
    }
    const user = userEvent.setup()
    render(<Host />)
    const trigger = screen.getByText('打开预览')
    await user.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: '预览测试' })
    expect(dialog.contains(document.activeElement)).toBe(true)
    for (let i = 0; i < 4; i++) {
      await user.tab()
      expect(dialog.contains(document.activeElement)).toBe(true)
    }
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(trigger).toHaveFocus())
  })
})

describe('HTTP 请求时限与取消', () => {
  function abortableFetch(): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const fail = (): void => reject(new DOMException('请求中止', 'AbortError'))
          if (init?.signal?.aborted) fail()
          else init?.signal?.addEventListener('abort', fail, { once: true })
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('读取超时终止请求并返回可理解的错误', async () => {
    vi.useFakeTimers()
    abortableFetch()
    const result = apiGet('/slow', { timeoutMs: 100 }).catch((error: Error) => error.message)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(await result).toBe('请求超时，请稍后重试')
  })

  it('写请求超时明确提示执行状态未知，不自动重试', async () => {
    vi.useFakeTimers()
    const fetchMock = abortableFetch()
    const result = apiPost('/write', {}, { timeoutMs: 100 }).catch((error: Error) => error.message)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(await result).toContain('操作可能已执行')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('调用方可以取消请求，取消不被误报成超时', async () => {
    abortableFetch()
    const controller = new AbortController()
    const result = apiGet('/search', { signal: controller.signal }).catch((error: Error) => error.name)
    controller.abort()
    expect(await result).toBe('AbortError')
  })
})

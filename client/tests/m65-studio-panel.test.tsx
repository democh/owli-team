/**
 * M65-B：StudioPanel 组件测——方案列表合并（工作区文件 ∪ layout 容器声明）/ 空态 / 视图切换 /
 * 工具切换与家具置入 / 选中操作条 / 保存调用。
 * 依赖 mock：scene ctx（sessionId）/ use-scene-data（容器）/ apiGet（文件列表）/
 * useDesignScene（受控状态）/ StudioSurface·StudioPlanView（避免 three）/ sonner。
 */
import * as React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { DesignScene } from '@multi-agent/shared'
import { addFurniture, emptyScene } from '../src/components/studio/design-scene-model'

const h = vi.hoisted(() => ({
  sessionId: 's1' as string | undefined,
  containers: [] as { name: string; lines: string[] }[],
  files: [] as { path: string }[],
  surfaceSelectId: null as string | null,
  ds: {
    scene: undefined as undefined | { furniture: { id: string }[] },
    loading: false,
    error: undefined as string | undefined,
    notFound: false,
    filtered: 0,
    dirty: false,
    save: (() => Promise.resolve({ ok: true })) as () => Promise<{ ok: boolean; error?: string; conflict?: boolean }>,
    update: ((() => {}) as unknown) as (fn: (s: DesignScene) => DesignScene) => void,
    reload: ((): void => {}) as () => void,
  },
}))

vi.mock('../src/lib/api', () => ({
  apiGet: (): Promise<{ scenes: { path: string }[] }> => Promise.resolve({ scenes: h.files }),
  apiPut: (): Promise<unknown> => Promise.resolve({}),
  ApiError: class ApiError extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message)
    }
  },
}))
vi.mock('../src/components/scene/context', () => ({
  useSceneCtx: () => ({ sessionId: h.sessionId }),
}))
vi.mock('../src/components/scene/use-scene-data', () => ({
  useSceneContainers: () => h.containers,
}))
vi.mock('../src/components/studio/studio-lazy', () => ({
  StudioSurface: (props: { onSelect?: (id: string | null) => void }): React.ReactElement => (
    <button data-testid="mock-surface" onClick={() => props.onSelect?.(h.surfaceSelectId)}>
      3D
    </button>
  ),
}))
vi.mock('../src/components/studio/StudioPlanView', () => ({
  StudioPlanView: (): React.ReactElement => <div data-testid="mock-plan" />,
}))
vi.mock('../src/components/studio/use-design-scene', () => ({
  useDesignScene: (): unknown => h.ds,
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { toast } from 'sonner'
import { StudioPanel } from '../src/components/scene/panels/StudioPanel'
import { StudioPrintSheet } from '../src/components/studio/StudioPrintSheet'
import { useSessionStore } from '../src/stores/session-store'
import { useUiStore } from '../src/stores/ui-store'

beforeEach(() => {
  cleanup()
  h.sessionId = 's1'
  h.containers = []
  // 默认给一个方案来源（工作台 UI 需 sources 非空）；空态用例自行清空
  h.files = [{ path: 'design/plan-a.scene.json' }]
  h.surfaceSelectId = null
  h.ds = {
    scene: undefined,
    loading: false,
    error: undefined,
    notFound: false,
    filtered: 0,
    dirty: false,
    save: vi.fn(async () => ({ ok: true })),
    update: vi.fn(),
    reload: vi.fn(),
  }
})

describe('M65-B：StudioPanel 组件', () => {
  it('空态：无文件且无容器声明 → 引导文案', () => {
    h.files = []
    render(<StudioPanel />)
    expect(screen.getByText(/方案文件就位后在这里打开 3D 工作台/)).toBeTruthy()
  })

  it('方案列表：工作区文件 ∪ layout 容器「方案源」（去重保序）', async () => {
    h.files = [{ path: 'design/plan-a.scene.json' }]
    h.containers = [{ name: 'layout', lines: ['方案源：design/plan-b.scene.json', '方案源：design/plan-a.scene.json'] }]
    h.ds = { ...h.ds, scene: emptyScene() }
    render(<StudioPanel />)
    await waitFor(() => expect(document.querySelector('[data-studio-pick]')).toBeTruthy())
    const pick = document.querySelector('[data-studio-pick]') as HTMLSelectElement
    expect(pick).toBeTruthy()
    const opts = [...pick.options].map((o) => o.value)
    expect(opts).toEqual(['design/plan-a.scene.json', 'design/plan-b.scene.json'])
  })

  it('M79-AD：打开通道（pendingStudioOpen）→ 挂载后消费——方案加入列表并选中', async () => {
    h.files = [{ path: 'design/plan-a.scene.json' }]
    h.containers = []
    h.ds = { ...h.ds, scene: emptyScene() }
    render(<StudioPanel />)
    await waitFor(() => expect(document.querySelector('[data-studio-pick]')).toBeTruthy())

    act(() => useUiStore.getState().setPendingStudioOpen('design/plan-b.scene.json'))
    await waitFor(() => {
      const pick = document.querySelector('[data-studio-pick]') as HTMLSelectElement
      expect([...pick.options].map((o) => o.value)).toContain('design/plan-b.scene.json')
      expect(pick.value).toBe('design/plan-b.scene.json') // 打开请求即选中
    })
    expect(useUiStore.getState().pendingStudioOpen).toBeNull() // 消费后清空
  })

  it('工具切换与家具置入：点击「家具」→ 规格按钮 → update 调用', async () => {
    h.ds = { ...h.ds, scene: emptyScene() }
    render(<StudioPanel />)
    await waitFor(() => expect(document.querySelector('[data-studio-tool="furniture"]')).toBeTruthy())
    fireEvent.click(document.querySelector('[data-studio-tool="furniture"]')!)
    const sofaBtn = screen.getByTitle('置入沙发')
    fireEvent.click(sofaBtn)
    expect(h.ds.update).toHaveBeenCalledTimes(1)
  })

  it('选中操作条：surface 选择家具 → 操作条出现 → 右移触发 update', async () => {
    const scene = addFurniture(emptyScene(), 'sofa')
    h.surfaceSelectId = scene.furniture[0]!.id
    h.ds = { ...h.ds, scene }
    render(<StudioPanel />)
    // 操作条未选中时不出现
    expect(document.querySelector('[data-studio-ops]')).toBeNull()
    fireEvent.click(await screen.findByTestId('mock-surface'))
    expect(document.querySelector('[data-studio-ops]')).toBeTruthy()
    fireEvent.click(screen.getByTitle('右移 100mm'))
    expect(h.ds.update).toHaveBeenCalled()
  })

  it('视图切换：平面 ↔ 3D', async () => {
    h.ds = { ...h.ds, scene: emptyScene() }
    render(<StudioPanel />)
    expect(await screen.findByTestId('mock-surface')).toBeTruthy()
    expect(screen.queryByTestId('mock-plan')).toBeNull()
    fireEvent.click(document.querySelector('[data-studio-view-toggle]')!)
    expect(screen.getByTestId('mock-plan')).toBeTruthy()
  })

  it('保存：点击保存 → save 调用 + 成功 toast', async () => {
    h.ds = { ...h.ds, scene: emptyScene(), dirty: true }
    render(<StudioPanel />)
    await waitFor(() => expect(document.querySelector('[data-studio-save]')).toBeTruthy())
    fireEvent.click(document.querySelector('[data-studio-save]')!)
    await waitFor(() => expect(h.ds.save).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(vi.mocked(toast.success)).toHaveBeenCalled())
  })

  it('方案源未落盘（404）：错误卡展示「补落盘」引导，点击回填 @规方 指令', async () => {
    const insertSpy = vi.fn()
    useUiStore.setState({ insertToComposer: insertSpy as unknown as (text: string) => void })
    h.files = []
    h.containers = [{ name: 'layout', lines: ['方案源：design/plan-missing.scene.json'] }]
    h.ds = {
      ...h.ds,
      error: '方案源未落盘：design/plan-missing.scene.json 不存在（成员可能只声明未写入，可让其补落盘）',
      notFound: true,
    }
    render(<StudioPanel />)
    await waitFor(() => expect(document.querySelector('[data-studio-error]')).toBeTruthy())
    expect(screen.getByText(/方案源未落盘/)).toBeTruthy()
    // 未落盘时同时提供「重试」与「补落盘」两个动作
    fireEvent.click(screen.getByText('重试'))
    expect(h.ds.reload).toHaveBeenCalledTimes(1)
    fireEvent.click(document.querySelector('[data-studio-relink]')!)
    expect(insertSpy).toHaveBeenCalledTimes(1)
    expect(insertSpy.mock.calls[0]![0]).toContain('@规方')
    expect(insertSpy.mock.calls[0]![0]).toContain('design/plan-missing.scene.json')
  })

  it('成员补落盘（交付件版本变化）→ 未落盘方案自动重载（自愈）', async () => {
    h.files = []
    h.containers = [{ name: 'layout', lines: ['方案源：design/plan-missing.scene.json'] }]
    h.ds = { ...h.ds, error: '方案源未落盘：design/plan-missing.scene.json 不存在（成员可能只声明未写入，可让其补落盘）', notFound: true }
    render(<StudioPanel />)
    await waitFor(() => expect(document.querySelector('[data-studio-error]')).toBeTruthy())
    // 挂载首跑不触发重载（避免重复加载）
    expect(h.ds.reload).not.toHaveBeenCalled()
    act(() => useSessionStore.getState().bumpArtifacts())
    await waitFor(() => expect(h.ds.reload).toHaveBeenCalledTimes(1))
  })
})

describe('M65-C：方案书打印视图', () => {
  it('渲染组合页（封面 / 房间表 / 色卡 / 页脚声明）+ 关闭与 Esc', () => {
    const onClose = vi.fn()
    const { container } = render(
      <StudioPrintSheet
        scene={emptyScene('测试方案')}
        photoPaths={['design/render-1.png']}
        swatches={[{ name: '主色', hex: '#E8E0D4', usage: '墙面大面' }]}
        texture="哑光木纹"
        onClose={onClose}
      />,
    )
    expect(container.querySelector('[data-studio-print-sheet]')).toBeTruthy()
    expect(screen.getByText('测试方案')).toBeTruthy()
    expect(screen.getByText('客厅')).toBeTruthy()
    expect(screen.getByText('15.1㎡')).toBeTruthy()
    expect(screen.getByText('#E8E0D4')).toBeTruthy()
    expect(screen.getByText(/质感：哑光木纹/)).toBeTruthy()
    expect(container.textContent).toContain('示意表现')
    fireEvent.click(screen.getByTitle('关闭（Esc）'))
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})

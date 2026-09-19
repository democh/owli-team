/**
 * M31 修订：画布专业手感与能力门控前端测试——
 * - useMediaCapabilities 能力拆分（canImage / canVideo / canGenerate；未加载按无能力）；
 * - CanvasToolbar：媒体生成钮按能力门控 / 手型工具钮 / 网格吸附开关；
 * - NodeContextMenu：生成段按能力门控（全无 → 整段隐藏；仅生图 / 仅生视频 → 各自入口）；
 * - CanvasCreateMenu：提示词节点 hint 随能力切换。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as React from 'react'
import type { CanvasDoc, CanvasNode, MediaCapability, MediaProviderInfo } from '@multi-agent/shared'
import { createNode } from '../src/lib/canvas'
import { useCanvasStore } from '../src/stores/canvas-store'
import { useMediaStore } from '../src/stores/media-store'
import { CanvasToolbar } from '../src/components/canvas/CanvasToolbar'
import { CanvasCreateMenu } from '../src/components/canvas/CanvasCreateMenu'
import { NodeContextMenu } from '../src/components/canvas/NodeContextMenu'

const T0 = '2026-09-19T08:00:00.000Z'

function provider(capabilities: MediaCapability[]): MediaProviderInfo {
  return {
    connectionId: 'conn_test',
    connectionName: '测试媒体连接',
    provider: 'comfyui',
    capabilities,
    models: [],
    workflows: [],
  }
}

const FULL_PROVIDER = provider(['text2image', 'image2image', 'text2video', 'image2video', 'firstlast2video'])

function mkDoc(nodes: CanvasNode[]): CanvasDoc {
  return { v: 1, sessionId: 's_test', version: 1, updatedAt: T0, viewport: { x: 0, y: 0, zoom: 1 }, nodes, edges: [] }
}

function toolbarProps(overrides?: Partial<React.ComponentProps<typeof CanvasToolbar>>): React.ComponentProps<typeof CanvasToolbar> {
  return {
    onAdd: vi.fn(),
    onUpload: vi.fn(),
    onGenerate: vi.fn(),
    onSearch: vi.fn(),
    onMind: vi.fn(),
    onFit: vi.fn(),
    onExport: vi.fn(),
    onExportMind: vi.fn(),
    tool: 'select',
    onToolChange: vi.fn(),
    gridSnap: false,
    onGridSnapChange: vi.fn(),
    ...overrides,
  }
}

beforeEach(() => {
  // 能力门控夹具复位（beforeEach 时上轮组件已卸载，无 act 警告）
  useMediaStore.setState({ providers: [], providersLoaded: false })
  useCanvasStore.setState({ doc: null, selectedIds: [] })
})

describe('CanvasToolbar 能力门控与工具开关（M31 修订）', () => {
  it('未配置媒体能力：媒体生成钮不渲染', () => {
    render(<CanvasToolbar {...toolbarProps()} />)
    expect(screen.queryByLabelText('媒体生成（文生图 / 视频）')).not.toBeInTheDocument()
  })

  it('已配置媒体能力：媒体生成钮出现且点击回调', async () => {
    useMediaStore.setState({ providers: [FULL_PROVIDER], providersLoaded: true })
    const onGenerate = vi.fn()
    const user = userEvent.setup()
    render(<CanvasToolbar {...toolbarProps({ onGenerate })} />)
    const btn = screen.getByLabelText('媒体生成（文生图 / 视频）')
    expect(btn).toBeInTheDocument()
    await user.click(btn)
    expect(onGenerate).toHaveBeenCalledTimes(1)
  })

  it('仅配置生图（无视频能力）：媒体生成钮仍出现（canGenerate = 任一能力）', () => {
    useMediaStore.setState({ providers: [provider(['text2image'])], providersLoaded: true })
    render(<CanvasToolbar {...toolbarProps()} />)
    expect(screen.getByLabelText('媒体生成（文生图 / 视频）')).toBeInTheDocument()
  })

  it('手型工具钮：点击回调切到 hand；hand 态下再点切回 select', async () => {
    const onToolChange = vi.fn()
    const user = userEvent.setup()
    const { rerender } = render(<CanvasToolbar {...toolbarProps({ onToolChange, tool: 'select' })} />)
    const handBtn = screen.getByLabelText(/手型工具（H）/)
    await user.click(handBtn)
    expect(onToolChange).toHaveBeenCalledWith('hand')

    rerender(<CanvasToolbar {...toolbarProps({ onToolChange, tool: 'hand' })} />)
    await user.click(screen.getByLabelText(/手型工具（H）/))
    expect(onToolChange).toHaveBeenLastCalledWith('select')
  })

  it('网格吸附开关：整理下拉内切换回调（开启态文案反馈）', async () => {
    const onGridSnapChange = vi.fn()
    const user = userEvent.setup()
    render(<CanvasToolbar {...toolbarProps({ onGridSnapChange })} />)
    await user.click(screen.getByLabelText('整理与对齐（先框选多个节点）'))
    await user.click(screen.getByText('对齐网格 10px'))
    expect(onGridSnapChange).toHaveBeenCalledWith(true)
  })
})

describe('CanvasCreateMenu 提示词 hint 门控（M31 修订）', () => {
  it('未配置生成能力：hint 降级为「记录可复用的指令」，菜单本体保留', () => {
    render(<CanvasCreateMenu x={100} y={100} onPick={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByText('提示词节点')).toBeInTheDocument()
    expect(screen.getByText('记录可复用的指令')).toBeInTheDocument()
    expect(screen.queryByText('连到图片 / 视频生成')).not.toBeInTheDocument()
  })

  it('已配置生成能力：hint 恢复「连到图片 / 视频生成」', () => {
    useMediaStore.setState({ providers: [FULL_PROVIDER], providersLoaded: true })
    render(<CanvasCreateMenu x={100} y={100} onPick={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByText('连到图片 / 视频生成')).toBeInTheDocument()
  })
})

describe('NodeContextMenu 生成段能力门控（M31 修订）', () => {
  const imageNode = {
    ...createNode('image', { x: 0, y: 0 }, { artifact: 'canvas/media/a.png', source: 'generate', prompt: '一只猫' }),
    id: 'img_1',
  }

  function setup(): void {
    useCanvasStore.setState({ doc: mkDoc([imageNode]) })
  }

  it('未配置任何能力：生成段（用作生成输入 / 生成变体 / 首尾帧）整段不渲染', () => {
    setup()
    render(<NodeContextMenu nodeId="img_1" x={100} y={100} onClose={vi.fn()} onBeginEdit={vi.fn()} />)
    expect(screen.getByText('创建副本')).toBeInTheDocument() // 菜单本体在
    expect(screen.queryByText('用作生成输入')).not.toBeInTheDocument()
    expect(screen.queryByText('生成变体')).not.toBeInTheDocument()
    expect(screen.queryByText('设为首帧（视频）')).not.toBeInTheDocument()
    expect(screen.queryByText('设为尾帧（视频）')).not.toBeInTheDocument()
  })

  it('仅配置生图：出现「用作生成输入 / 生成变体」，视频首尾帧不出现', () => {
    setup()
    useMediaStore.setState({ providers: [provider(['text2image', 'image2image'])], providersLoaded: true })
    render(<NodeContextMenu nodeId="img_1" x={100} y={100} onClose={vi.fn()} onBeginEdit={vi.fn()} />)
    expect(screen.getByText('用作生成输入')).toBeInTheDocument()
    expect(screen.getByText('生成变体')).toBeInTheDocument()
    expect(screen.queryByText('设为首帧（视频）')).not.toBeInTheDocument()
  })

  it('仅配置生视频：出现「用作生成输入 / 首尾帧」，生成变体不出现', () => {
    setup()
    useMediaStore.setState({ providers: [provider(['text2video', 'image2video', 'firstlast2video'])], providersLoaded: true })
    render(<NodeContextMenu nodeId="img_1" x={100} y={100} onClose={vi.fn()} onBeginEdit={vi.fn()} />)
    expect(screen.getByText('用作生成输入')).toBeInTheDocument()
    expect(screen.getByText('设为首帧（视频）')).toBeInTheDocument()
    expect(screen.getByText('设为尾帧（视频）')).toBeInTheDocument()
    expect(screen.queryByText('生成变体')).not.toBeInTheDocument()
  })

  it('生成入口点击：注入输入素材并打开生成面板（已配置能力）', async () => {
    setup()
    useMediaStore.setState({ providers: [FULL_PROVIDER], providersLoaded: true })
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<NodeContextMenu nodeId="img_1" x={100} y={100} onClose={onClose} onBeginEdit={vi.fn()} />)
    await user.click(screen.getByText('生成变体'))
    const state = useMediaStore.getState()
    expect(state.panelOpen).toBe(true)
    expect(state.genRef.images).toEqual(['canvas/media/a.png'])
    expect(state.genRef.prompt).toBe('一只猫')
    expect(onClose).toHaveBeenCalled()
  })
})

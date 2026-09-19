/**
 * M31 修订：Agent ↔ 画布联动（前端消费侧）——
 * - ui-store：画布写入角标累计 / 切到画布清零；
 * - ws-store notify:canvas-changed：同会话且不在画布页 → 角标 +N；在画布页 / 他会话 / by=user → 不计；
 * - canvas-store handleRemoteChange(meta)：合流后 remoteFlash（touched 过滤仍存在的节点）、clearRemoteFlash；
 * - ToolCard：画布四工具语义标签 +「在画布查看」（切画布 / 无会话引导 / 只读与运行中无入口）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CanvasDoc, NotifyEnvelope, ToolCallRecord } from '@multi-agent/shared'
import { ToolCard } from '../src/components/chat/ToolCard'
import { useCanvasStore } from '../src/stores/canvas-store'
import { useSessionStore } from '../src/stores/session-store'
import { useUiStore } from '../src/stores/ui-store'
import { handleNotify } from '../src/stores/ws-store'

vi.mock('sonner', () => {
  const toastFn = vi.fn()
  return { toast: Object.assign(toastFn, { error: vi.fn(), success: vi.fn() }) }
})
import { toast } from 'sonner'

const SID = 's-link'
const T0 = '2026-09-19T08:00:00.000Z'
/** 通知 seq 全局递增（handleNotify 按会话去重水位：跨用例共享模块级 cursors） */
let seq = 1

function env(type: NotifyEnvelope['type'], sessionId: string, payload: Record<string, unknown>): NotifyEnvelope {
  return { v: 1, id: `n-${seq}`, seq: seq++, type, ts: T0, sessionId, payload }
}

function mkDoc(over: Partial<CanvasDoc> = {}): CanvasDoc {
  return { v: 1, sessionId: SID, version: 2, updatedAt: T0, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [], ...over }
}

function mkCall(over: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id: 'tc-1',
    name: 'canvas_write',
    args: { ops: [{ op: 'add_node' }] },
    status: 'ok',
    summary: '画布已更新（2 项操作，v3）',
    startedAt: T0,
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  useUiStore.setState({ mainTab: 'chat', newCanvasCount: 0, otherCanvasWrites: {} })
  useSessionStore.setState({ currentId: SID })
  useCanvasStore.setState({
    sessionId: undefined,
    doc: null,
    remoteFlash: undefined,
    nodeFlash: undefined,
    pendingAction: null,
    selectedIds: [],
  })
})

describe('画布写入角标（ui-store + ws-store 联动）', () => {
  it('notify:canvas-changed（agent / 同会话 / 非画布页）→ 按 touched 数累计；切到画布清零', () => {
    handleNotify(
      env('notify:canvas-changed', SID, { version: 3, by: 'agent', reason: 'ops', touched: { added: ['nd_a'], updated: [], removed: [] } }),
    )
    expect(useUiStore.getState().newCanvasCount).toBe(1)

    handleNotify(
      env('notify:canvas-changed', SID, { version: 4, by: 'agent', reason: 'media', touched: { added: ['nd_b', 'nd_c'], updated: ['nd_b'], removed: [] } }),
    )
    expect(useUiStore.getState().newCanvasCount).toBe(4) // 1 + (2 added + 1 updated)

    useUiStore.getState().setMainTab('canvas')
    expect(useUiStore.getState().newCanvasCount).toBe(0)
  })

  it('在画布页 / 他会话 / by=user：不计角标', () => {
    useUiStore.setState({ mainTab: 'canvas' })
    handleNotify(env('notify:canvas-changed', SID, { version: 3, by: 'agent', touched: { added: ['nd_a'], updated: [], removed: [] } }))
    expect(useUiStore.getState().newCanvasCount).toBe(0)

    useUiStore.setState({ mainTab: 'chat' })
    handleNotify(env('notify:canvas-changed', 's-other', { version: 3, by: 'agent', touched: { added: ['nd_a'], updated: [], removed: [] } }))
    expect(useUiStore.getState().newCanvasCount).toBe(0)

    handleNotify(env('notify:canvas-changed', SID, { version: 9, by: 'user', reason: 'save', touched: { added: [], updated: [], removed: [] } }))
    expect(useUiStore.getState().newCanvasCount).toBe(0)
  })

  it('无 touched 元信息（旧广播兼容）：最少计 1', () => {
    handleNotify(env('notify:canvas-changed', SID, { version: 3, by: 'agent' }))
    expect(useUiStore.getState().newCanvasCount).toBe(1)
  })

  it('他会话写入（M31 修订）：计会话列表小点；clearOtherCanvasWrite 清除', () => {
    handleNotify(
      env('notify:canvas-changed', 's-other', { version: 3, by: 'agent', touched: { added: ['nd_a'], updated: [], removed: [] } }),
    )
    expect(useUiStore.getState().newCanvasCount).toBe(0) // 不误计当前会话角标
    expect(useUiStore.getState().otherCanvasWrites['s-other']).toBe(1)
    useUiStore.getState().clearOtherCanvasWrite('s-other')
    expect(useUiStore.getState().otherCanvasWrites['s-other']).toBeUndefined()
  })
})

describe('远端写入闪环（canvas-store handleRemoteChange）', () => {
  it('合流后按 touched 过滤仍存在的节点设置 remoteFlash（actor 透传）；clearRemoteFlash 清除', async () => {
    const fresh = mkDoc({ version: 5, nodes: [{ id: 'nd_a', type: 'note', position: { x: 0, y: 0 }, data: { text: 'x' } }] })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ doc: fresh, mediaBound: true }) }) as unknown as Response),
    )
    useCanvasStore.setState({ sessionId: SID, doc: mkDoc({ version: 1, nodes: [] }) })

    useCanvasStore
      .getState()
      .handleRemoteChange(SID, 5, 'agent', { actor: 'pm', touched: { added: ['nd_a', 'nd_ghost'], updated: ['nd_b'], removed: [] } })

    await waitFor(() => expect(useCanvasStore.getState().doc?.version).toBe(5))
    // nd_ghost / nd_b 不在合流后的文档中 → 被过滤；仅 nd_a 闪环
    expect(useCanvasStore.getState().remoteFlash?.ids).toEqual(['nd_a'])
    expect(useCanvasStore.getState().remoteFlash?.actor).toBe('pm')

    useCanvasStore.getState().clearRemoteFlash()
    expect(useCanvasStore.getState().remoteFlash).toBeUndefined()
    vi.unstubAllGlobals()
  })
})

describe('僵尸占位自愈与通用闪环（M31 修订）', () => {
  it('reconcileStalePending：任务不在快照 → 标记中断；在快照 / 非 pending → 保持', () => {
    vi.useFakeTimers() // 自愈写回调度自动保存：fake 计时避免 teardown 后触发真实网络
    useCanvasStore.setState({
      sessionId: SID,
      doc: mkDoc({
        nodes: [
          { id: 'nd_z', type: 'image', position: { x: 0, y: 0 }, data: { pending: true, jobId: 'mj_lost' } },
          { id: 'nd_ok', type: 'image', position: { x: 300, y: 0 }, data: { pending: true, jobId: 'mj_alive' } },
          { id: 'nd_closed', type: 'image', position: { x: 600, y: 0 }, data: { pending: false, artifact: 'canvas/a.png' } },
        ],
      }),
    })
    const fixed = useCanvasStore.getState().reconcileStalePending(new Set(['mj_alive']))
    expect(fixed).toBe(1)
    const nodes = useCanvasStore.getState().doc!.nodes
    const zombie = nodes.find((n) => n.id === 'nd_z')!.data as { pending?: boolean; error?: string }
    expect(zombie.pending).toBe(false)
    expect(zombie.error).toContain('生成中断')
    expect((nodes.find((n) => n.id === 'nd_ok')!.data as { pending?: boolean }).pending).toBe(true) // 仍在快照 → 保留
    expect((nodes.find((n) => n.id === 'nd_closed')!.data as { error?: string }).error).toBeUndefined() // 非 pending 不动
    vi.useRealTimers()
  })

  it('pulseNodes / consumeNodeFlash：请求 → 消费闭环（空数组不发起）', () => {
    useCanvasStore.getState().pulseNodes([])
    expect(useCanvasStore.getState().nodeFlash).toBeUndefined()
    useCanvasStore.getState().pulseNodes(['nd_a', 'nd_b'])
    expect(useCanvasStore.getState().nodeFlash?.ids).toEqual(['nd_a', 'nd_b'])
    useCanvasStore.getState().consumeNodeFlash()
    expect(useCanvasStore.getState().nodeFlash).toBeUndefined()
  })
})

describe('ToolCard 画布入口（M31 修订）', () => {
  it('canvas_write（带 meta.canvasNodes）：点击「在画布查看」→ 切画布 + focus 精确请求', async () => {
    render(<ToolCard call={mkCall({ meta: { canvasNodes: ['nd_x', 'nd_y'] } })} />)
    expect(screen.getByText('画布写入')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /在画布查看/ }))
    expect(useUiStore.getState().mainTab).toBe('canvas')
    const action = useCanvasStore.getState().pendingAction
    expect(action?.kind).toBe('focus')
    expect(action?.nodeIds).toEqual(['nd_x', 'nd_y'])
  })

  it('canvas_write（无 meta）：仅切画布，不发 focus 请求', async () => {
    render(<ToolCard call={mkCall()} />)
    await userEvent.click(screen.getByRole('button', { name: /在画布查看/ }))
    expect(useUiStore.getState().mainTab).toBe('canvas')
    expect(useCanvasStore.getState().pendingAction).toBeNull()
  })

  it('无会话：toast 引导先选会话（不跳转）；media_generate 完成态同样有入口', async () => {
    useSessionStore.setState({ currentId: undefined })
    render(<ToolCard call={mkCall({ name: 'media_generate', summary: '已创建文生图任务 mj_x' })} />)
    expect(screen.getByText('生成图片')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /在画布查看/ }))
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(expect.stringContaining('先选择一个会话'))
    expect(useUiStore.getState().mainTab).toBe('chat')
  })

  it('canvas_read（只读）与运行中：无「在画布查看」入口；四工具语义标签齐全', () => {
    const { rerender } = render(<ToolCard call={mkCall({ name: 'canvas_read', status: 'ok', summary: '画布共 2 个节点' })} />)
    expect(screen.getByText('读取画布')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /在画布查看/ })).toBeNull()

    rerender(<ToolCard call={mkCall({ status: 'running' })} />)
    expect(screen.queryByRole('button', { name: /在画布查看/ })).toBeNull()

    rerender(<ToolCard call={mkCall({ name: 'media_video', summary: '已创建文生视频任务' })} />)
    expect(screen.getByText('生成视频')).toBeTruthy()
    expect(screen.getByRole('button', { name: /在画布查看/ })).toBeTruthy()
  })
})

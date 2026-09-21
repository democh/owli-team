/**
 * M45（R-1，ADR 0081）：轻回放测试。
 * - 纯函数：waveNodesOf（waveOf → 去重有序节点；单条波次成节；首消息锚点）·
 *   activeWaveIndexOf（首个可见行起向前，含 wave-sep 归属）· createTrailingThrottle（leading + trailing 合并 / cancel）·
 *   deriveRows 集成（结构键 → 行/波 → 节点）；
 * - 组件：WaveScrubber（刻度计数与序号 / 点选跳转 / prev·next 端点禁用 / 当前波高亮 / 连点合并 / 无活跃时「共 N 波」）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import type * as React from 'react'
import { WaveScrubber } from '../src/components/chat/WaveScrubber'
import { deriveRows } from '../src/lib/chat-rows'
import { activeWaveIndexOf, createTrailingThrottle, waveNodesOf, type WaveNode } from '../src/lib/wave-replay'

function node(index: number, firstMessageId: string, count = 1): WaveNode {
  return { key: `r${index}~0`, index, runId: `r${index}`, turnIndex: 0, firstMessageId, count }
}

const NODES: WaveNode[] = [node(1, 'a1'), node(2, 'a2', 3), node(3, 'a3')]

beforeEach(() => {
  vi.useRealTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

// ---------- 纯函数 ----------

describe('M45 · waveNodesOf（波次节点派生）', () => {
  it('去重有序（分隔行与成员行同源）+ 单条波次成节 + 首消息锚点与计数', () => {
    const waveOf = [
      null,
      { runId: 'r1', turnIndex: 0, memberIds: ['a1', 'b1'] },
      { runId: 'r1', turnIndex: 0, memberIds: ['a1', 'b1'] }, // 同波第二行（去重）
      null,
      { runId: 'r2', turnIndex: 0, memberIds: ['a2'] }, // 单条波次
      { runId: 'r3', turnIndex: 1, memberIds: ['a3', 'b3', 'c3'] },
    ]
    const nodes = waveNodesOf(waveOf)
    expect(nodes.map((n) => n.index)).toEqual([1, 2, 3])
    expect(nodes.map((n) => n.firstMessageId)).toEqual(['a1', 'a2', 'a3'])
    expect(nodes.map((n) => n.count)).toEqual([2, 1, 3])
    expect(nodes[2]!.key).toBe('r3~1')
  })

  it('空锚点波次跳过；无波次 → 空数组', () => {
    expect(waveNodesOf([null, { runId: 'r1', turnIndex: 0, memberIds: [] }])).toEqual([])
    expect(waveNodesOf([null, null])).toEqual([])
  })
})

describe('M45 · activeWaveIndexOf（活跃波次序号）', () => {
  const waveOf = [
    null,
    { runId: 'r1', turnIndex: 0, memberIds: ['a1'] },
    { runId: 'r1', turnIndex: 0, memberIds: ['a1'] }, // 同波成员行
    null,
    { runId: 'r2', turnIndex: 0, memberIds: ['a2'] },
  ]

  it('首个可见行起向前扫描（含同波重复行与 wave-sep 归属）', () => {
    expect(activeWaveIndexOf(waveOf, 0)).toBe(1)
    expect(activeWaveIndexOf(waveOf, 1)).toBe(1)
    expect(activeWaveIndexOf(waveOf, 2)).toBe(1)
    expect(activeWaveIndexOf(waveOf, 4)).toBe(2)
  })

  it('越界 / 全空 → undefined', () => {
    expect(activeWaveIndexOf(waveOf, 5)).toBeUndefined()
    expect(activeWaveIndexOf([null, null], 0)).toBeUndefined()
  })
})

describe('M45 · createTrailingThrottle（leading + trailing 合并）', () => {
  it('首次立即触发；窗口内连点合并为尾沿一次（取最新参数）', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const t = createTrailingThrottle<[string]>(fn, 150)
    t.run('a')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenLastCalledWith('a')
    t.run('b')
    t.run('c') // 覆盖 pending
    expect(fn).toHaveBeenCalledTimes(1)
    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(fn).toHaveBeenCalledTimes(2)
    expect(fn).toHaveBeenLastCalledWith('c')
    // 窗口过后再点 → 再次立即
    act(() => {
      vi.advanceTimersByTime(200)
    })
    t.run('d')
    expect(fn).toHaveBeenCalledTimes(3)
    expect(fn).toHaveBeenLastCalledWith('d')
  })

  it('cancel 丢弃尾沿', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const t = createTrailingThrottle<[string]>(fn, 150)
    t.run('a')
    t.run('b')
    t.cancel()
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('M45 · deriveRows 集成（结构键 → 节点）', () => {
  it('两条消息各成一波（单条波次）→ 两个节点，首消息锚点正确', () => {
    const order = ['u1', 'a1', 'u2', 'a2']
    const structureKey = ['user~~-1', 'agent~r1~0', 'user~~-1', 'agent~r2~0'].join('|')
    const { waveOf } = deriveRows(order, structureKey)
    const nodes = waveNodesOf(waveOf)
    expect(nodes).toHaveLength(2)
    expect(nodes[0]).toMatchObject({ index: 1, firstMessageId: 'a1', count: 1, key: 'r1~0' })
    expect(nodes[1]).toMatchObject({ index: 2, firstMessageId: 'a2' })
    expect(activeWaveIndexOf(waveOf, 3)).toBe(2)
  })
})

// ---------- 组件 ----------

describe('M45 · WaveScrubber（波次回放条）', () => {
  function renderScrubber(
    over: Partial<React.ComponentProps<typeof WaveScrubber>> = {},
    opts: { expand?: boolean } = {},
  ): {
    container: HTMLElement
    onJump: ReturnType<typeof vi.fn>
  } {
    const onJump = vi.fn()
    const { container } = render(<WaveScrubber nodes={NODES} onJump={onJump} {...over} />)
    // M79-AA：默认收起——除显式 expand:false 外先展开再断言
    if (opts.expand !== false) {
      fireEvent.click(container.querySelector('[data-wave-toggle]')!)
    }
    return { container, onJump }
  }

  it('M79-AA：默认收起（仅图标开关，无文字）；点击展开 / 收起', () => {
    const onJump = vi.fn()
    const { container } = render(<WaveScrubber nodes={NODES} onJump={onJump} />)
    const toggle = container.querySelector('[data-wave-toggle]') as HTMLButtonElement
    expect(toggle).toBeTruthy()
    expect(toggle.textContent).toBe('') // 不需要「回放」文字
    expect(container.querySelectorAll('[data-wave-tick]')).toHaveLength(0) // 默认隐藏
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(toggle)
    expect(container.querySelectorAll('[data-wave-tick]')).toHaveLength(3)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(toggle)
    expect(container.querySelectorAll('[data-wave-tick]')).toHaveLength(0)
  })

  it('刻度 = 波次节点；点选跳转首条成员消息；当前波高亮与计数', () => {
    const { container, onJump } = renderScrubber({ activeIndex: 2 })
    expect(container.querySelectorAll('[data-wave-tick]')).toHaveLength(3)
    expect(container.querySelector('[data-wave-current]')!.getAttribute('data-wave-tick')).toBe('2')
    expect(container.querySelector('.wave-scrubber-count')!.textContent).toBe('第 2/3 波')
    fireEvent.click(container.querySelector('[data-wave-tick="3"]')!)
    expect(onJump).toHaveBeenCalledWith('a3')
  })

  it('prev / next 端点禁用；点击 next 跳向下一波', () => {
    const at1 = renderScrubber({ activeIndex: 1 })
    expect((at1.container.querySelector('[data-wave-prev]') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(at1.container.querySelector('[data-wave-next]')!)
    expect(at1.onJump).toHaveBeenCalledWith('a2')
    at1.container.remove()

    const at3 = renderScrubber({ activeIndex: 3 })
    expect((at3.container.querySelector('[data-wave-next]') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(at3.container.querySelector('[data-wave-prev]')!)
    expect(at3.onJump).toHaveBeenCalledWith('a2')
    at3.container.remove()

    const none = renderScrubber()
    expect((none.container.querySelector('[data-wave-prev]') as HTMLButtonElement).disabled).toBe(true)
    expect((none.container.querySelector('[data-wave-next]') as HTMLButtonElement).disabled).toBe(true)
    expect(none.container.querySelector('.wave-scrubber-count')!.textContent).toBe('共 3 波')
  })

  it('连点经尾沿节流合并（首次立即 + 尾沿最新一次）', () => {
    vi.useFakeTimers()
    const { container, onJump } = renderScrubber()
    fireEvent.click(container.querySelector('[data-wave-tick="1"]')!)
    fireEvent.click(container.querySelector('[data-wave-tick="2"]')!)
    fireEvent.click(container.querySelector('[data-wave-tick="3"]')!)
    expect(onJump).toHaveBeenCalledTimes(1)
    expect(onJump).toHaveBeenCalledWith('a1')
    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(onJump).toHaveBeenCalledTimes(2)
    expect(onJump).toHaveBeenLastCalledWith('a3')
  })
})

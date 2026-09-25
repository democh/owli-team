/**
 * M85 划线圈：纯函数层（存储键 / 净化 / overlay 映射）+ 钩子（增删改 / 撤销重做 / 持久化）。
 * （KlineCanvas 集成段与工具条 / 样式栏 UI 已随用户决策删除——2026-09-25：底层保留、UI 下线。）
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import {
  buildManualOverlay,
  loadManualDrawings,
  MANUAL_MAX,
  sanitizeManualDrawings,
  saveManualDrawings,
  storeKeyOf,
  type ManualDrawing,
} from '../src/components/finance/chart/manual-drawings'
import { useManualDrawings } from '../src/components/finance/chart/useManualDrawings'

// ---------- fixtures ----------

const KEY = 'ma:kline-draw:v1:sh600519:day:qfq'

function makeDrawing(over: Partial<ManualDrawing> = {}): ManualDrawing {
  return {
    id: 'm1abc',
    kind: 'segment',
    points: [
      { ts: 1000, price: 10 },
      { ts: 2000, price: 12 },
    ],
    color: '#f59e0b',
    width: 1,
    dash: false,
    fill: false,
    text: '',
    locked: false,
    ...over,
  }
}

beforeEach(() => {
  window.localStorage.clear()
})

// ---------- 纯函数层 ----------

describe('M85 manual-drawings：存储键与净化', () => {
  it('存储键：symbol + period + adjust；无 symbol → undefined；缺省 day/qfq', () => {
    expect(storeKeyOf({ symbol: 'sh600519', period: 'day', adjust: 'qfq' })).toBe(KEY)
    expect(storeKeyOf({ symbol: 'sh600519' } as never)).toBe('ma:kline-draw:v1:sh600519:day:qfq')
    expect(storeKeyOf({ symbol: '  ' } as never)).toBeUndefined()
    expect(storeKeyOf({} as never)).toBeUndefined()
  })

  it('净化：白名单工具 / 数值点 / 色值正则 / 线宽钳制 / 文本截断 / 数量上限', () => {
    const raw = [
      makeDrawing({ id: 'a', kind: 'segment' }),
      makeDrawing({ id: 'b', kind: 'not-a-tool' as never }),
      { id: 'c', kind: 'segment', points: [{ ts: 'x', price: 1 }] },
      makeDrawing({ id: 'd', width: 99, color: 'red', text: 'x'.repeat(40), dash: 'yes' as never }),
      ...Array.from({ length: MANUAL_MAX + 5 }, (_, i) => makeDrawing({ id: `cap${i}` })),
    ]
    const out = sanitizeManualDrawings(raw)
    expect(out).toHaveLength(MANUAL_MAX)
    expect(out[0]!.id).toBe('a')
    expect(out.find((d) => d.id === 'b')).toBeUndefined()
    expect(out.find((d) => d.id === 'c')).toBeUndefined()
    const d = out.find((x) => x.id === 'd')!
    expect(d.width).toBe(4)
    expect(d.color).toBe('#f59e0b')
    expect(d.text).toHaveLength(24)
    expect(d.dash).toBe(false)
  })

  it('读写往返；JSON 破损 / 非对象 → 空表', () => {
    saveManualDrawings(KEY, [makeDrawing()])
    expect(loadManualDrawings(KEY)).toHaveLength(1)
    window.localStorage.setItem(KEY, '{broken')
    expect(loadManualDrawings(KEY)).toEqual([])
    window.localStorage.setItem(KEY, JSON.stringify({ v: 1, d: 'x' }))
    expect(loadManualDrawings(KEY)).toEqual([])
    expect(loadManualDrawings(undefined)).toEqual([])
  })
})

describe('M85 manual-drawings：overlay 映射', () => {
  it('线段 / 水平线：内置 overlay + 线样式', () => {
    const seg = buildManualOverlay(makeDrawing())
    expect(seg.name).toBe('segment')
    expect(seg.points).toEqual([
      { timestamp: 1000, value: 10 },
      { timestamp: 2000, value: 12 },
    ])
    expect((seg.styles as { line: { color: string; size: number } }).line).toMatchObject({ color: '#f59e0b', size: 1 })
    expect(buildManualOverlay(makeDrawing({ kind: 'hline', points: [{ ts: 1, price: 2 }] })).name).toBe('horizontalStraightLine')
  })

  it('矩形：交互变体 + 填充开关；文本：胶囊 + 点；测量：涨跌幅文本', () => {
    const rect = buildManualOverlay(makeDrawing({ kind: 'rect', fill: true }))
    expect(rect.name).toBe('rectZone')
    const rectExt = rect.extendData as { interactive: boolean; fill: string }
    expect(rectExt.interactive).toBe(true)
    expect(rectExt.fill).toBe('#f59e0b26')
    expect((buildManualOverlay(makeDrawing({ kind: 'rect', fill: false })).extendData as { fill: string }).fill).toBe('rgba(0,0,0,0)')

    const text = buildManualOverlay(makeDrawing({ kind: 'text', points: [{ ts: 1, price: 2 }], text: '支撑区' }))
    expect(text.name).toBe('textLabel')
    expect(text.extendData).toMatchObject({ text: '支撑区', dot: true, interactive: true })

    const measure = buildManualOverlay(makeDrawing({ kind: 'measure' }))
    expect(measure.name).toBe('measureBox')
    expect((measure.extendData as { text: string }).text).toContain('%')
    expect((measure.extendData as { text: string }).text).toContain('+20.00%')
  })

  it('新增三件：fibExt / pitchfork / volProfile 映射（交互变体 + 三点支撑）', () => {
    const three: Array<{ ts: number; price: number }> = [
      { ts: 1, price: 2 },
      { ts: 3, price: 4 },
      { ts: 5, price: 3 },
    ]
    const fibExt = buildManualOverlay(makeDrawing({ kind: 'fibExt', points: three, dash: true, width: 2 }))
    expect(fibExt.name).toBe('fibExtension')
    expect(fibExt.points).toHaveLength(3)
    expect(fibExt.extendData).toMatchObject({ interactive: true, dash: true, width: 2 })

    const fork = buildManualOverlay(makeDrawing({ kind: 'pitchfork', points: three }))
    expect(fork.name).toBe('pitchfork')
    expect(fork.points).toHaveLength(3)
    expect((fork.extendData as { interactive: boolean }).interactive).toBe(true)

    const vp = buildManualOverlay(makeDrawing({ kind: 'volProfile', points: [three[0]!, three[1]!] }))
    expect(vp.name).toBe('volProfile')
    expect(vp.extendData).toMatchObject({ interactive: true, color: '#f59e0b' })
  })

  it('存储净化：新工具在白名单内可往返；三点划线保留 3 点', () => {
    const list = [
      makeDrawing({ id: 'pf', kind: 'pitchfork', points: [{ ts: 1, price: 2 }, { ts: 3, price: 4 }, { ts: 5, price: 3 }] }),
      makeDrawing({ id: 'fe', kind: 'fibExt', points: [{ ts: 1, price: 2 }, { ts: 3, price: 4 }, { ts: 5, price: 3 }] }),
      makeDrawing({ id: 'vp', kind: 'volProfile' }),
    ]
    saveManualDrawings(KEY, list)
    const loaded = loadManualDrawings(KEY)
    expect(loaded.map((d) => d.kind)).toEqual(['pitchfork', 'fibExt', 'volProfile'])
    expect(loaded[0]!.points).toHaveLength(3)
  })
})

// ---------- 钩子 ----------

describe('M85 useManualDrawings：增删改 / 撤销重做 / 持久化', () => {
  it('add 默认值（取色轮转 / 矩形默认填充）+ update / remove / clear + undo / redo', () => {
    const { result } = renderHook(() => useManualDrawings(KEY))
    let id: string | undefined
    act(() => {
      id = result.current.add('segment', [
        { ts: 1, price: 2 },
        { ts: 3, price: 4 },
      ])
    })
    expect(id).toBeTruthy()
    expect(result.current.drawings).toHaveLength(1)
    expect(result.current.canUndo).toBe(true)
    expect(result.current.canRedo).toBe(false)

    act(() => result.current.update(id!, { color: '#059669', dash: true }))
    expect(result.current.drawings[0]).toMatchObject({ color: '#059669', dash: true })

    act(() => result.current.remove(id!))
    expect(result.current.drawings).toHaveLength(0)
    act(() => result.current.undo())
    expect(result.current.drawings).toHaveLength(1)
    act(() => result.current.redo())
    expect(result.current.drawings).toHaveLength(0)
    act(() => result.current.undo())
    act(() => result.current.clear())
    expect(result.current.drawings).toHaveLength(0)
    expect(result.current.canUndo).toBe(true)

    // 矩形默认填充
    act(() => {
      result.current.add('rect', [
        { ts: 1, price: 2 },
        { ts: 3, price: 4 },
      ])
    })
    expect(result.current.drawings[0]!.fill).toBe(true)
  })

  it('持久化：变更即落盘；预置满额 → add 拒绝', () => {
    const { result } = renderHook(() => useManualDrawings(KEY))
    act(() => {
      result.current.add('hline', [{ ts: 1, price: 2 }])
    })
    const stored = JSON.parse(window.localStorage.getItem(KEY)!) as { v: number; d: ManualDrawing[] }
    expect(stored.v).toBe(1)
    expect(stored.d).toHaveLength(1)

    saveManualDrawings(KEY, Array.from({ length: MANUAL_MAX }, (_, i) => makeDrawing({ id: `x${i}` })))
    const full = renderHook(() => useManualDrawings(KEY))
    // 预置写入事件同步到既有实例（包 act；仅验证内容，不重复断言）
    act(() => saveManualDrawings(KEY, Array.from({ length: MANUAL_MAX }, (_, i) => makeDrawing({ id: `x${i}` }))))
    expect(full.result.current.drawings).toHaveLength(MANUAL_MAX)
    let rejected: string | undefined = 'x'
    act(() => {
      rejected = full.result.current.add('hline', [{ ts: 1, price: 2 }])
    })
    expect(rejected).toBeUndefined()
    expect(full.result.current.drawings).toHaveLength(MANUAL_MAX)
  })

  it('键切换重载；外部写入（事件）同步', () => {
    saveManualDrawings('k:a', [makeDrawing({ id: 'ka' })])
    saveManualDrawings('k:b', [makeDrawing({ id: 'kb' }), makeDrawing({ id: 'kb2' })])
    const { result, rerender } = renderHook(({ k }) => useManualDrawings(k), { initialProps: { k: 'k:a' } })
    expect(result.current.drawings.map((d) => d.id)).toEqual(['ka'])
    rerender({ k: 'k:b' })
    expect(result.current.drawings.map((d) => d.id)).toEqual(['kb', 'kb2'])

    act(() => saveManualDrawings('k:b', [makeDrawing({ id: 'kb3' })]))
    expect(result.current.drawings.map((d) => d.id)).toEqual(['kb3'])
  })
})

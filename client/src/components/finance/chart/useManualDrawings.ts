/**
 * 手动划线状态钩子（M85）：增删改 / 撤销重做（≤50 步）/ localStorage 持久化 / 同源实例同步。
 *
 * - 键变化（换标的 / 周期 / 复权）→ 同步重载（渲染期状态调整，避免旧图列表误写入新键）；
 * - 每次列表变化即落盘（容量小；成功后广播事件，全屏 / 块内多实例自动一致）；
 * - add 返回新划线 id 供宿主选中（容量满 → undefined 且不入栈）。
 */
import * as React from 'react'
import {
  loadManualDrawings,
  MANUAL_CHANGED_EVENT,
  MANUAL_COLORS,
  MANUAL_MAX,
  nextManualId,
  saveManualDrawings,
  type ManualDrawing,
  type ManualPoint,
  type ManualTool,
} from './manual-drawings'

const HISTORY_CAP = 50

interface ManualState {
  list: ManualDrawing[]
  past: ManualDrawing[][]
  future: ManualDrawing[][]
}

export interface ManualDrawingsApi {
  drawings: ManualDrawing[]
  canUndo: boolean
  canRedo: boolean
  add: (tool: ManualTool, points: ManualPoint[]) => string | undefined
  update: (id: string, patch: Partial<Omit<ManualDrawing, 'id' | 'kind'>>) => void
  remove: (id: string) => void
  clear: () => void
  undo: () => void
  redo: () => void
}

function fresh(key: string | undefined): ManualState {
  return { list: loadManualDrawings(key), past: [], future: [] }
}

function push(prev: ManualState, list: ManualDrawing[]): ManualState {
  return { list, past: [...prev.past.slice(-(HISTORY_CAP - 1)), prev.list], future: [] }
}

export function useManualDrawings(key: string | undefined): ManualDrawingsApi {
  const [entry, setEntry] = React.useState<{ key: string | undefined; state: ManualState }>(() => ({ key, state: fresh(key) }))

  // 键变化：渲染期重置（官方「调整状态」模式；确保同一次提交即拿到新键的空/载入列表）
  if (entry.key !== key) {
    setEntry({ key, state: fresh(key) })
  }
  const state = entry.state
  const stateRef = React.useRef(state)
  stateRef.current = state

  // 持久化：列表变化即落盘（key 缺省 = 不落盘，仅内存）
  React.useEffect(() => {
    if (key) saveManualDrawings(key, state.list)
  }, [key, state.list])

  // 同源实例同步（全屏 / 重复打开同图）：事件内容一致时不触发重渲染（防自激循环）
  React.useEffect(() => {
    const onChanged = (e: Event): void => {
      if ((e as CustomEvent).detail !== key) return
      const stored = loadManualDrawings(key)
      setEntry((prev) => {
        if (prev.key !== key) return prev
        if (JSON.stringify(prev.state.list) === JSON.stringify(stored)) return prev
        return { key, state: { list: stored, past: prev.state.past, future: prev.state.future } }
      })
    }
    window.addEventListener(MANUAL_CHANGED_EVENT, onChanged)
    return () => window.removeEventListener(MANUAL_CHANGED_EVENT, onChanged)
  }, [key])

  const add = React.useCallback((tool: ManualTool, points: ManualPoint[]): string | undefined => {
    const cur = stateRef.current
    if (cur.list.length >= MANUAL_MAX || points.length === 0) return undefined
    const id = nextManualId()
    const drawing: ManualDrawing = {
      id,
      kind: tool,
      points: points.map((p) => ({ ts: p.ts, price: p.price })),
      color: MANUAL_COLORS[cur.list.length % MANUAL_COLORS.length] ?? MANUAL_COLORS[0],
      width: 1,
      dash: false,
      fill: tool === 'rect' || tool === 'measure',
      text: '',
      locked: false,
    }
    setEntry((prev) => ({ key: prev.key, state: push(prev.state, [...prev.state.list, drawing]) }))
    return id
  }, [])

  const update = React.useCallback((id: string, patch: Partial<Omit<ManualDrawing, 'id' | 'kind'>>): void => {
    setEntry((prev) => {
      const next = prev.state.list.map((d) => (d.id === id ? { ...d, ...patch, id: d.id, kind: d.kind } : d))
      if (next.every((d, i) => d === prev.state.list[i])) return prev
      return { key: prev.key, state: push(prev.state, next) }
    })
  }, [])

  const remove = React.useCallback((id: string): void => {
    setEntry((prev) => {
      const next = prev.state.list.filter((d) => d.id !== id)
      if (next.length === prev.state.list.length) return prev
      return { key: prev.key, state: push(prev.state, next) }
    })
  }, [])

  const clear = React.useCallback((): void => {
    setEntry((prev) => (prev.state.list.length === 0 ? prev : { key: prev.key, state: push(prev.state, []) }))
  }, [])

  const undo = React.useCallback((): void => {
    setEntry((prev) => {
      const { past, list, future } = prev.state
      const last = past[past.length - 1]
      if (!last) return prev
      return { key: prev.key, state: { list: last, past: past.slice(0, -1), future: [list, ...future] } }
    })
  }, [])

  const redo = React.useCallback((): void => {
    setEntry((prev) => {
      const { past, list, future } = prev.state
      const next = future[0]
      if (!next) return prev
      return { key: prev.key, state: { list: next, past: [...past, list], future: future.slice(1) } }
    })
  }, [])

  return {
    drawings: state.list,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    add,
    update,
    remove,
    clear,
    undo,
    redo,
  }
}

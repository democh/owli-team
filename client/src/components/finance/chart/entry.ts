/**
 * 图表入口（M83 §5.1）：唯一在运行时 import klinecharts 的模块组（动态 import → 独立 chunk）。
 *
 * createKlineChart(el, input) → KlineHandle：
 * - 生命周期：init 一次 → symbol/period 同步 → 静态数据快照回填 → 落图调度（raf）；
 * - 0 宽恢复修复：容器 display:none（宽度归零）恢复时 scrollToRealTime（v10 会把滚动钳负且不还原）；
 * - 指标切换：主图（MA/EMA/BOLL/KCB/SAR/ICHIMOKU/ST/DONCHIAN，isStack 共存）/
 *   副图（VOL/MACD/KDJ/RSI/ATR，固定 paneId「重复创建即替换」）+ 副图面高度分配；
 * - 阶段色带（phaseBand）：连续同相合并、range 不着色、序列钳制到 bars 范围；
 * - 落图（drawings/signal）与标注（annotations，legacy simpleTag）分组管理，先清后画；
 * - 导出：getConvertPictureUrl（含 overlay，白底 PNG）。
 */
import { dispose as kcDispose, init, type Chart, type KLineData, type Period } from 'klinecharts'
import type { Drawing, KlinePhase, KlinePhaseBand, MainIndicator, SignalSpec, SubIndicator } from '@multi-agent/shared'
import type { KlineAnnotation, KlineBar, KlineDataset } from '../../../lib/kline-spec'
import { allocateSubPaneHeight } from './layout'
import { PHASE_CN, PHASE_COLORS } from './phaseColors'
import { baseKlineOptions } from './theme'
import { registerMarketOverlays } from './overlays'
import { MAIN_PANE_INDICATOR_NAMES, registerMarketIndicators, SUB_INDICATOR_NAMES, subPaneIdOf } from './indicators'
import { applyDrawings } from './drawings'
import { buildManualOverlay, MANUAL_CUSTOM_TOOLS, MANUAL_GROUP, MANUAL_TOOLS, type ManualDrawing, type ManualPoint, type ManualTool } from './manual-drawings'

/** klinecharts 主图面 id（内部常量 PaneIdConstants.CANDLE） */
const CANDLE_PANE = 'candle_pane'
/** 阶段色带 overlay 组 */
const PHASE_GROUP = 'phase'
/** 标注（legacy annotations）overlay 组 */
const ANNOT_GROUP = 'annot'
/** 手动划线草图 overlay id（绘制中临时；onDrawEnd 后立即移除，由状态层重建） */
const DRAFT_ID = 'md-draft'
/** 草图独立组（不被 drawManual 的整组清理误伤） */
const DRAFT_GROUP = 'manual-draft'
/** MA 口径与服务端 fin_kline 对齐（自动算 5/10/20/60） */
const MA_CALC_PARAMS = [5, 10, 20, 60]

/** 手动划线事件（选择 / 拖拽后回报；由 React 层注入，抗闭包过期） */
export interface ManualEvents {
  onSelect?: (id: string | null) => void
  onMove?: (id: string, points: ManualPoint[]) => void
}

/** beginDraw 回调（落点完成 / 取消） */
export interface DrawCallbacks {
  onDone: (points: ManualPoint[]) => void
  onCancel?: () => void
}

export interface KlineChartInput {
  dataset: KlineDataset
  mainIndicator: MainIndicator | 'none'
  subIndicator: SubIndicator | 'none'
  showPhases: boolean
  phases?: KlinePhaseBand[]
  annotations?: KlineAnnotation[]
  drawings?: Drawing[]
  signal?: SignalSpec | null
  /** M85：手动划线（受控；本地持久化由 React 层钩子负责） */
  manual?: ManualDrawing[]
  label?: string
}

export interface KlineHandle {
  /** 局部更新（指标切换 / 色带开关 / 落图数据）——不重建图表 */
  update(
    patch: Partial<{
      mainIndicator: MainIndicator | 'none'
      subIndicator: SubIndicator | 'none'
      showPhases: boolean
      phases: KlinePhaseBand[]
      drawings: Drawing[]
      signal: SignalSpec | null
      manual: ManualDrawing[]
    }>,
  ): void
  /** 开始绘制（不带点创建草图 overlay；右键 / cancelDraw 取消） */
  beginDraw(tool: ManualTool, callbacks: DrawCallbacks): void
  /** 取消绘制中的草图 */
  cancelDraw(): void
  /** 注入手动划线事件（选择 / 拖拽回报） */
  setManualEvents(events: ManualEvents): void
  /** 截图导出（含 overlay，白底 PNG） */
  exportPng(filename: string): void
  resize(): void
  dispose(): void
}

function periodOf(period: string | undefined): Period {
  switch (period) {
    case 'week':
      return { span: 1, type: 'week' }
    case 'month':
      return { span: 1, type: 'month' }
    case 'min5':
      return { span: 5, type: 'minute' }
    case 'min15':
      return { span: 15, type: 'minute' }
    case 'min30':
      return { span: 30, type: 'minute' }
    case 'min60':
      return { span: 60, type: 'minute' }
    default:
      return { span: 1, type: 'day' }
  }
}

/** 价格精度：取样本内小数位最大值（上限 4；ETF 3 位 / 股票 2 位自适应） */
function pricePrecisionOf(bars: KlineBar[]): number {
  let precision = 0
  for (const bar of bars.slice(-40)) {
    for (const v of [bar.open, bar.high, bar.low, bar.close]) {
      const s = String(v)
      const dot = s.indexOf('.')
      if (dot >= 0) precision = Math.max(precision, Math.min(4, s.length - dot - 1))
    }
  }
  return precision
}

function triggerDownload(url: string, filename: string): void {
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/** 创建 K 线图（bars 为空抛错；失败由调用方转错误卡） */
export function createKlineChart(el: HTMLElement, input: KlineChartInput): KlineHandle {
  const bars = input.dataset.bars
  if (bars.length === 0) throw new Error('无 K 线数据')
  registerMarketOverlays()
  registerMarketIndicators()
  const chart: Chart | null = init(el, baseKlineOptions())
  if (!chart) throw new Error('K 线初始化失败')

  chart.setSymbol({
    ticker: input.label || input.dataset.name || input.dataset.symbol || 'K',
    pricePrecision: pricePrecisionOf(bars),
    volumePrecision: 0,
  })
  chart.setPeriod(periodOf(input.dataset.period))

  const data: KLineData[] = bars.map((bar) => ({
    timestamp: bar.timestamp,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    ...(bar.turnover !== undefined ? { turnover: bar.turnover } : {}),
  }))
  chart.setDataLoader({
    getBars: ({ type, callback }) => {
      // 静态快照：仅初始化一次性回填；不响应前/后向补数（避免反复空触发）
      if (type === 'init') callback(data, { forward: false, backward: false })
    },
  })

  // 运行时状态（受控于 React 层 update；画布永远由状态重建）
  const state = {
    mainIndicator: input.mainIndicator,
    subIndicator: input.subIndicator,
    showPhases: input.showPhases,
    phases: input.phases ?? [],
    drawings: input.drawings ?? [],
    signal: input.signal ?? null,
    manual: input.manual ?? [],
  }

  // 手动划线事件（React 层注入；实例内就地更新引用）
  let manualEvents: ManualEvents = {}

  /** 绘制草稿（自持）：点击收集落点，凑齐 N 点即完成——不依赖框架 progress overlay 的步数语义 */
  interface Draft {
    tool: ManualTool
    needed: number
    points: ManualPoint[]
    cbs: DrawCallbacks
    onPointerDown: (e: MouseEvent) => void
    onContext: (e: MouseEvent) => void
  }
  let draft: Draft | null = null

  /** 主图指标：先按名移除全部 → 创建目标（MA 用对齐口径；isStack 保持共存） */
  const setMainIndicator = (): void => {
    for (const name of MAIN_PANE_INDICATOR_NAMES) chart.removeIndicator({ paneId: CANDLE_PANE, name })
    if (state.mainIndicator === 'none') return
    const create =
      state.mainIndicator === 'MA'
        ? { name: 'MA', calcParams: MA_CALC_PARAMS, paneId: CANDLE_PANE }
        : { name: state.mainIndicator, paneId: CANDLE_PANE }
    chart.createIndicator(create as never, true)
  }

  /** 副图指标：按固定 paneId 全清 → 创建目标（重复创建即替换语义） */
  const setSubIndicator = (): void => {
    for (const name of SUB_INDICATOR_NAMES) chart.removeIndicator({ paneId: subPaneIdOf(name) })
    if (state.subIndicator === 'none') return
    chart.createIndicator({ name: state.subIndicator, paneId: subPaneIdOf(state.subIndicator) } as never)
  }

  /** 副图面高度分配（容器变化时重算；主图保底口径见 layout.ts） */
  const applyPaneHeights = (): void => {
    if (state.subIndicator === 'none') return
    const each = allocateSubPaneHeight(el.clientHeight, 1)
    if (each <= 0) return
    chart.setPaneOptions({ id: subPaneIdOf(state.subIndicator), height: each })
  }

  /** 阶段色带：连续同相合并（range 不着色；钳制到 bars 时间范围） */
  const drawPhaseBands = (): void => {
    chart.removeOverlay({ groupId: PHASE_GROUP })
    if (!state.showPhases || state.phases.length === 0) return
    const firstTs = data[0].timestamp
    const lastTs = data[data.length - 1].timestamp
    const lastClose = data[data.length - 1].close
    const segs: Array<{ phase: string; from: number; to: number }> = []
    for (const b of state.phases) {
      const last = segs[segs.length - 1]
      if (last && last.phase === b.phase) last.to = b.ts
      else segs.push({ phase: b.phase, from: b.ts, to: b.ts })
    }
    for (const s of segs) {
      if (s.phase === 'range') continue
      const from = Math.max(s.from, firstTs)
      const to = Math.min(s.to, lastTs)
      if (to < from) continue
      chart.createOverlay({
        name: 'phaseBand',
        groupId: PHASE_GROUP,
        points: [
          { timestamp: from, value: lastClose },
          { timestamp: to, value: lastClose },
        ],
        extendData: { color: `${PHASE_COLORS[s.phase as KlinePhase] ?? '#a1a1aa'}1f`, label: PHASE_CN[s.phase as KlinePhase] ?? '' },
      } as never)
    }
  }

  /** 标注（legacy annotations：simpleTag 全宽横线 + 轴侧标签） */
  const drawAnnotations = (): void => {
    chart.removeOverlay({ groupId: ANNOT_GROUP })
    const firstTs = data[0].timestamp
    for (const annotation of input.annotations ?? []) {
      if (typeof annotation.price !== 'number') continue
      chart.createOverlay({
        name: 'simpleTag',
        groupId: ANNOT_GROUP,
        points: [{ timestamp: firstTs, value: annotation.price }],
        ...(annotation.label ? { extendData: `${annotation.label} ${annotation.price}` } : {}),
      } as never)
    }
  }

  let raf = 0
  /** 落图调度：等一帧确保 resetData / 指标创建完成（ts→x 换算可用） */
  const scheduleOverlays = (): void => {
    cancelAnimationFrame(raf)
    raf = requestAnimationFrame(() => {
      drawAnnotations()
      drawPhaseBands()
      applyDrawings(chart, state.drawings, state.signal, data)
      drawManual()
    })
  }

  /** 已落点 overlay → 手动点（过滤绘制中的占位空点） */
  const readPoints = (event: unknown): ManualPoint[] => {
    const points = (event as { overlay?: { points?: Array<Partial<{ timestamp: number; value: number }>> } })?.overlay?.points ?? []
    const out: ManualPoint[] = []
    for (const p of points) {
      if (typeof p?.timestamp === 'number' && typeof p.value === 'number') out.push({ ts: p.timestamp, price: p.value })
    }
    return out
  }

  /** 停止绘制（移除监听 + 清预览；不触发回调） */
  const stopDraft = (): void => {
    if (draft) {
      el.removeEventListener('mousedown', draft.onPointerDown, true)
      el.removeEventListener('contextmenu', draft.onContext, true)
      draft = null
    }
    chart.removeOverlay({ groupId: DRAFT_GROUP })
  }

  /** 像素（容器相对）→ 数据点；不可换算返回 null */
  const toDataPoint = (clientX: number, clientY: number): ManualPoint | null => {
    const rect = el.getBoundingClientRect()
    const converted = chart.convertFromPixel([{ x: clientX - rect.left, y: clientY - rect.top }])
    const p = (Array.isArray(converted) ? converted[0] : converted) as Partial<{ timestamp: number; value: number }> | undefined
    if (!p || typeof p.timestamp !== 'number' || typeof p.value !== 'number') return null
    return { ts: p.timestamp, price: p.value }
  }

  /** 绘制中预览（静态 overlay；自定义工具降为不可交互） */
  const renderDraftPreview = (): void => {
    chart.removeOverlay({ groupId: DRAFT_GROUP })
    if (!draft) return
    const cfg = buildManualOverlay({
      id: DRAFT_ID,
      kind: draft.tool,
      points: draft.points,
      color: '#f59e0b',
      width: 1,
      dash: false,
      fill: draft.tool === 'rect' || draft.tool === 'measure',
      text: '',
      locked: false,
    })
    chart.createOverlay({
      id: DRAFT_ID,
      groupId: DRAFT_GROUP,
      name: cfg.name,
      points: cfg.points,
      lock: false,
      needDefaultPointFigure: true,
      ...(cfg.styles ? { styles: cfg.styles } : {}),
      ...(cfg.extendData && MANUAL_CUSTOM_TOOLS.has(draft.tool)
        ? { extendData: { ...(cfg.extendData as Record<string, unknown>), interactive: false } }
        : {}),
    } as never)
  }

  /** 手动划线：先清组后重建（受控；与分析 / 策略落图组隔离） */
  const drawManual = (): void => {
    chart.removeOverlay({ groupId: MANUAL_GROUP })
    for (const d of state.manual) {
      const cfg = buildManualOverlay(d)
      chart.createOverlay({
        id: `md-${d.id}`,
        groupId: MANUAL_GROUP,
        lock: d.locked,
        mode: 'weak_magnet',
        ...cfg,
        onSelected: () => manualEvents.onSelect?.(d.id),
        onDeselected: () => manualEvents.onSelect?.(null),
        onPressedMoveEnd: (event: unknown) => {
          const pts = readPoints(event)
          if (pts.length > 0) manualEvents.onMove?.(d.id, pts)
        },
        onRightClick: (event: unknown) => {
          ;(event as { preventDefault?: () => void }).preventDefault?.()
          manualEvents.onSelect?.(d.id)
        },
      } as never)
    }
  }

  /**
   * 手动层更新：id 集合不变（样式 / 拖动 / 撤销）→ 逐条就地覆盖（保留选中与交互态）；
   * 结构变化（新增 / 删除）或覆盖失败 → 整组重建。
   */
  const applyManualPatch = (prev: ManualDrawing[]): void => {
    const sameIds = prev.map((d) => d.id).join(',') === state.manual.map((d) => d.id).join(',')
    if (sameIds) {
      let ok = true
      for (const d of state.manual) {
        const cfg = buildManualOverlay(d)
        ok = chart.overrideOverlay({ id: `md-${d.id}`, lock: d.locked, mode: 'weak_magnet', ...cfg } as never) && ok
      }
      if (ok) return
    }
    drawManual()
  }

  setMainIndicator()
  setSubIndicator()
  applyPaneHeights()
  scheduleOverlays()

  let ro: ResizeObserver | undefined
  if (typeof ResizeObserver !== 'undefined') {
    let lastWidth = el.clientWidth
    ro = new ResizeObserver(() => {
      const width = el.clientWidth
      const restored = lastWidth === 0 && width > 0
      lastWidth = width
      applyPaneHeights()
      chart.resize()
      if (restored) requestAnimationFrame(() => chart.scrollToRealTime())
    })
    ro.observe(el)
  }

  return {
    update(patch): void {
      const prevSub = state.subIndicator
      const prevManual = state.manual
      // 结构层（指标 / 色带 / 落图 / 信号）任一项变化 → 整体重画；仅手动层 → 智能路径
      let structural = false
      if (patch.mainIndicator !== undefined) {
        state.mainIndicator = patch.mainIndicator
        structural = true
      }
      if (patch.subIndicator !== undefined) {
        state.subIndicator = patch.subIndicator
        structural = true
      }
      if (patch.showPhases !== undefined) {
        state.showPhases = patch.showPhases
        structural = true
      }
      if (patch.phases !== undefined) {
        state.phases = patch.phases
        structural = true
      }
      if (patch.drawings !== undefined) {
        state.drawings = patch.drawings
        structural = true
      }
      if (patch.signal !== undefined) {
        state.signal = patch.signal
        structural = true
      }
      if (patch.manual !== undefined) state.manual = patch.manual
      if (patch.mainIndicator !== undefined) setMainIndicator()
      if (patch.subIndicator !== undefined) {
        setSubIndicator()
        applyPaneHeights()
      } else if (prevSub !== state.subIndicator) {
        applyPaneHeights()
      }
      // 副图面高度可能因容器尺寸变化需重算（update 由 React 层在指标变更时调用）
      if (state.subIndicator !== 'none') applyPaneHeights()
      if (structural) scheduleOverlays()
      else if (patch.manual !== undefined) applyManualPatch(prevManual)
    },
    beginDraw(tool, callbacks): void {
      stopDraft()
      const needed = MANUAL_TOOLS.find((t) => t.key === tool)?.points ?? 2
      const onPointerDown = (event: MouseEvent): void => {
        if (!draft || event.button !== 0) return
        const point = toDataPoint(event.clientX, event.clientY)
        if (!point) return
        draft.points.push(point)
        if (draft.points.length >= draft.needed) {
          const pts = draft.points.slice()
          const cbs = draft.cbs
          stopDraft()
          cbs.onDone(pts)
        } else {
          renderDraftPreview()
        }
      }
      const onContext = (event: MouseEvent): void => {
        if (!draft) return
        event.preventDefault()
        const cbs = draft.cbs
        stopDraft()
        cbs.onCancel?.()
      }
      draft = { tool, needed, points: [], cbs: callbacks, onPointerDown, onContext }
      el.addEventListener('mousedown', onPointerDown, true)
      el.addEventListener('contextmenu', onContext, true)
    },
    cancelDraw(): void {
      stopDraft()
    },
    setManualEvents(events): void {
      manualEvents = events
    },
    exportPng(filename): void {
      const url = chart.getConvertPictureUrl(true, 'png', '#ffffff')
      if (url) triggerDownload(url, filename)
    },
    resize(): void {
      applyPaneHeights()
      chart.resize()
    },
    dispose(): void {
      cancelAnimationFrame(raf)
      ro?.disconnect()
      stopDraft()
      kcDispose(el)
    },
  }
}

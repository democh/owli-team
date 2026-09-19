/**
 * K 线渲染运行时（klinecharts v10 版本锁定；唯一接触 klinecharts 的模块，设计 D4）。
 * - 本模块只被 KlineBlock / 行情视图动态 import（独立 chunk，不进首屏）；
 * - v10 API 单点隔离：init / setSymbol / setPeriod / setDataLoader / createIndicator / createOverlay / resize / dispose；
 * - 主题对齐 md-light（A 股配色：涨红跌绿，与 KPI 卡组 --up/--down 同源互换）；
 * - ATR 为自注册指标（klinecharts 内置不含）；MA 口径与服务端 fin_kline 对齐（5/10/20/60）；
 * - 副图面高度按容器自适应分配（v10 主图只拿剩余高度，多副图会把蜡烛面挤为 0）。
 * - 标注走内置 simpleTag（全宽横线 + 轴侧标签）；数据为静态快照：
 *   getBars 仅 init 一次性回填（forward/backward 明确 more=false，不做无休止回补）。
 */
import { dispose as kcDispose, init, registerIndicator } from 'klinecharts'
import type { Chart, DeepPartial, KLineData, Period, Styles } from 'klinecharts'
import type { KlineAnnotation, KlineBar, KlineDataset, KlineIndicator } from './kline-spec'

/** A 股配色：涨红跌绿（应用 KPI 卡组同色互换） */
const UP_COLOR = '#dc2828'
const DOWN_COLOR = '#0fa975'
const NEUTRAL_COLOR = '#76808f'
const TEXT_COLOR = '#64748b'
const LINE_COLOR = '#e2e8f0'

const STYLES: DeepPartial<Styles> = {
  grid: {
    horizontal: { color: '#eef2f7' },
    vertical: { color: '#f1f5f9' },
  },
  candle: {
    bar: {
      upColor: UP_COLOR,
      downColor: DOWN_COLOR,
      upBorderColor: UP_COLOR,
      downBorderColor: DOWN_COLOR,
      upWickColor: UP_COLOR,
      downWickColor: DOWN_COLOR,
    },
    priceMark: {
      high: { color: TEXT_COLOR, textSize: 10 },
      low: { color: TEXT_COLOR, textSize: 10 },
      last: { upColor: UP_COLOR, downColor: DOWN_COLOR, text: { size: 11, color: '#ffffff' } },
    },
    tooltip: {
      // 图例只在悬停（crosshair 命中 pane）时显示：默认 showRule=always 会让
      // 标题+OHLC+MA+BOLL 四行图例常驻压在主图顶部（矮容器下遮挡近半可视区）
      showRule: 'follow_cross',
      title: { size: 11 },
      legend: { size: 11 },
      rect: { color: 'rgba(255, 255, 255, 0.96)', borderColor: LINE_COLOR, borderSize: 1 },
    },
  },
  indicator: {
    ohlc: { upColor: UP_COLOR, downColor: DOWN_COLOR, noChangeColor: NEUTRAL_COLOR },
    lastValueMark: { text: { size: 11, color: TEXT_COLOR } },
    // 与 candle 同口径：副图图例（VOL/MACD/RSI）也仅悬停显示，避免常驻遮挡
    tooltip: { showRule: 'follow_cross', title: { size: 11 }, legend: { size: 11 } },
  },
  xAxis: { axisLine: { color: LINE_COLOR }, tickLine: { color: LINE_COLOR }, tickText: { color: TEXT_COLOR, size: 11 } },
  yAxis: { axisLine: { color: LINE_COLOR }, tickLine: { color: LINE_COLOR }, tickText: { color: TEXT_COLOR, size: 11 } },
  separator: { color: LINE_COLOR },
  crosshair: {
    horizontal: { line: { color: NEUTRAL_COLOR }, text: { backgroundColor: NEUTRAL_COLOR } },
    vertical: { line: { color: NEUTRAL_COLOR }, text: { backgroundColor: NEUTRAL_COLOR } },
  },
}

/** 主图（蜡烛图面）指标；其余指标各自独立副图 */
const MAIN_PANE_INDICATORS = new Set<KlineIndicator>(['MA', 'EMA', 'BOLL'])
/** klinecharts 主图面 id（内部常量 PaneIdConstants.CANDLE） */
const CANDLE_PANE = 'candle_pane'
/** 副图面 id（固定命名，便于样式与复用） */
const PANE_ID: Record<string, string> = { VOL: 'vol_pane', MACD: 'macd_pane', RSI: 'rsi_pane', KDJ: 'kdj_pane', ATR: 'atr_pane' }

/**
 * 副图面高度分配（v10 布局语义：副图面各取 layout.pane.height（缺省 100px），
 * 主图蜡烛面只拿「剩余高度」——矮容器放 3 个副图时主图被挤为 0，蜡烛不可见）。
 * 策略：优先保障主图（≥50% 且 ≥96px，图例浮层 + 蜡烛需要主图占大头），
 * 其余由副图面均分（每面 30–140px）。
 * @returns 每个副图面的目标高度（px；容器高度不可用时返回 0 表示跳过）
 */
export function allocateSubPaneHeight(containerHeight: number, subPaneCount: number): number {
  if (subPaneCount <= 0 || containerHeight <= 0) return 0
  const candleFloor = Math.max(96, Math.round(containerHeight * 0.5))
  const each = Math.floor((containerHeight - candleFloor) / subPaneCount)
  return Math.max(30, Math.min(140, each))
}

/** MA 口径与服务端 fin_kline 对齐（自动算 5/10/20/60） */
const MA_CALC_PARAMS = [5, 10, 20, 60]

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

let atrRegistered = false

/** 注册 ATR（Wilder 平滑；klinecharts 内置指标不含 ATR，服务端口径 calcParams [14]） */
function ensureAtr(): void {
  if (atrRegistered) return
  registerIndicator<{ atr?: number }>({
    name: 'ATR',
    shortName: 'ATR',
    calcParams: [14],
    figures: [{ key: 'atr', title: 'ATR: ', type: 'line' }],
    calc: (dataList, indicator) => {
      const period = typeof indicator.calcParams[0] === 'number' ? indicator.calcParams[0] : 14
      const out: { atr?: number }[] = []
      const trs: number[] = []
      let atr: number | undefined
      let prevClose: number | undefined
      for (const bar of dataList) {
        const tr =
          prevClose === undefined
            ? bar.high - bar.low
            : Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose))
        trs.push(tr)
        if (trs.length > period) trs.shift()
        if (trs.length === period) {
          atr = atr === undefined ? trs.reduce((a, b) => a + b, 0) / period : (atr * (period - 1) + tr) / period
        }
        out.push(atr === undefined ? {} : { atr })
        prevClose = bar.close
      }
      return out
    },
  })
  atrRegistered = true
}

export interface KlineHandle {
  resize(): void
  dispose(): void
}

export interface KlineRenderInput {
  dataset: KlineDataset
  indicators: KlineIndicator[]
  annotations: KlineAnnotation[]
  /** 标的展示名（ticker；缺省 名称/代码） */
  label?: string
}

/** 创建 K 线图（bars 为空抛错；失败由调用方转错误卡） */
export function createKline(el: HTMLElement, input: KlineRenderInput): KlineHandle {
  const bars = input.dataset.bars
  if (bars.length === 0) throw new Error('无 K 线数据')
  ensureAtr()
  const chart: Chart | null = init(el, { locale: 'zh-CN' })
  if (!chart) throw new Error('K 线初始化失败')

  chart.setStyles(STYLES)
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

  // 副图面 id 收集（创建后统一分配高度，防主图被挤为 0）
  const subPaneIds: string[] = []
  const usedPanes = new Set<string>()
  for (const name of input.indicators) {
    const paneId = MAIN_PANE_INDICATORS.has(name) ? CANDLE_PANE : PANE_ID[name]
    // v10 isStack=false 会清空该面既有指标；同面多指标（如 MA+BOLL）需叠加创建
    chart.createIndicator(name === 'MA' ? { name, calcParams: MA_CALC_PARAMS, paneId } : { name, paneId }, usedPanes.has(paneId))
    usedPanes.add(paneId)
    if (paneId !== CANDLE_PANE && !subPaneIds.includes(paneId)) subPaneIds.push(paneId)
  }

  /** 按容器高度分配副图面高度（主图吃剩余空间；容器尺寸变化时重算） */
  const applyPaneHeights = (): void => {
    const each = allocateSubPaneHeight(el.clientHeight, subPaneIds.length)
    if (each <= 0) return
    for (const id of subPaneIds) chart.setPaneOptions({ id, height: each })
  }
  applyPaneHeights()

  // 标注（压力位 / 支撑位）：simpleTag = 全宽横线 + 轴侧标签
  const firstTs = data[0].timestamp
  for (const annotation of input.annotations) {
    if (typeof annotation.price !== 'number') continue
    chart.createOverlay({
      name: 'simpleTag',
      points: [{ timestamp: firstTs, value: annotation.price }],
      ...(annotation.label ? { extendData: `${annotation.label} ${annotation.price}` } : {}),
    })
  }

  let ro: ResizeObserver | undefined
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => {
      applyPaneHeights()
      chart.resize()
    })
    ro.observe(el)
  }
  return {
    resize: (): void => chart.resize(),
    dispose: (): void => {
      ro?.disconnect()
      kcDispose(el)
    },
  }
}

/**
 * 自定义 overlay 族（M83 §5.1；M85 增 measureBox 与交互变体）：registerOverlay 幂等注册。
 *
 * - labeledLine：全宽水平线 + 右侧胶囊标签（hline 落图：支撑 / 压力 / 量度目标）；
 * - rectZone：区域框（zone / rect：中枢 / 箱体，填充 + 边框 + 左上标签；手动划线走 interactive 变体）；
 * - textLabel：单点胶囊文本（textLabel：探底位等；手动文本走 interactive 变体）；
 * - phaseBand：全高阶段色带（阶段分析：窄段自动隐藏标签，防溢出）；
 * - positionTool：交易计划（信号落图：盈利区 / 风险区 / 入场线 / R:R）；
 * - polyline：N 点折线（策略轨迹）；
 * - measureBox：两点测量框（M85 划线圈：涨跌幅 + 价差；交互变体）。
 *
 * 纪律：纯显示图形一律 ignoreEvent: true（不抢十字光标 / 拖拽事件）；当 extendData.interactive=true 时
 * 主图形改为可交互（手动划线选择 / 拖拽），点图元由 needDefaultPointFigure 提供；
 * 类型以 `as never` 桥接（v10 类型偏严，项目统一模式）。
 */
import { registerOverlay } from 'klinecharts'

let registered = false

export const OVERLAY_NAMES = {
  labeledLine: 'labeledLine',
  rectZone: 'rectZone',
  textLabel: 'textLabel',
  phaseBand: 'phaseBand',
  positionTool: 'positionTool',
  polyline: 'polyline',
  measureBox: 'measureBox',
  fibExtension: 'fibExtension',
  pitchfork: 'pitchfork',
  volProfile: 'volProfile',
} as const

// ---------------------------------------------------------------- 工具

/** 颜色向黑混合（保证白字标签对比度） */
export function darken(color: string, ratio = 0.35): string {
  const hex = color.replace('#', '')
  if (hex.length !== 6) return color
  const r = Math.round(parseInt(hex.substring(0, 2), 16) * (1 - ratio))
  const g = Math.round(parseInt(hex.substring(2, 4), 16) * (1 - ratio))
  const b = Math.round(parseInt(hex.substring(4, 6), 16) * (1 - ratio))
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
}

/** hex + 两位 alpha（如 '#d97706' + '40' = 25% 透明） */
export function alphaHex(a: number): string {
  const v = Math.round(Math.min(1, Math.max(0, a)) * 255)
  return v.toString(16).padStart(2, '0')
}

/** 标签底色：按亮度自适应压深，返回半透明背景 */
function labelBg(color: string, bg?: string): string {
  const src = bg || color
  const hex = src.startsWith('rgb') ? null : src.replace('#', '')
  if (!hex || hex.length !== 6) return src
  let r = parseInt(hex.substring(0, 2), 16)
  let g = parseInt(hex.substring(2, 4), 16)
  let b = parseInt(hex.substring(4, 6), 16)
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  const k = Math.min(0.5, Math.max(0.15, 0.35 * (lum + 0.15)))
  r = Math.round(r * (1 - k))
  g = Math.round(g * (1 - k))
  b = Math.round(b * (1 - k))
  return `rgba(${r},${g},${b},0.95)`
}

interface TextFigureOpts {
  align?: 'left' | 'center' | 'right'
  baseline?: 'top' | 'middle' | 'bottom'
  bg?: string
  size?: number
  padding?: number
}

/** 白字 + 深色底 + 彩色描边的胶囊文本（统一标签视觉） */
function textFigure(x: number, y: number, text: string, color: string, opts?: TextFigureOpts): Record<string, unknown> {
  const size = opts?.size ?? 11
  const pad = opts?.padding ?? 3
  return {
    type: 'text',
    ignoreEvent: true,
    attrs: { x, y, text, align: opts?.align || 'left', baseline: opts?.baseline || 'top' },
    styles: {
      color: '#ffffff',
      size,
      weight: 'bold',
      family: 'system-ui, -apple-system, Helvetica Neue, Arial, sans-serif',
      backgroundColor: labelBg(color, opts?.bg),
      borderColor: color,
      borderSize: 1,
      borderRadius: 3,
      paddingLeft: pad + 1,
      paddingRight: pad + 1,
      paddingTop: pad - 1,
      paddingBottom: pad - 1,
    },
  }
}

interface FigureParams {
  coordinates: Array<{ x: number; y: number }>
  overlay: { extendData?: unknown }
  bounding: { width: number; height: number }
  yAxis?: { convertToPixel: (value: number) => number; convertFromPixel?: (y: number) => number } | null
  xAxis?: { convertToPixel?: (value: number) => number; convertFromPixel?: (x: number) => number } | null
  /** M85：量分 overlay 数据源（bars；jsdom 单测不构造） */
  chart?: { getDataList(): Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }> }
}

function extOf<T extends Record<string, unknown>>(p: FigureParams): T {
  return (p.overlay?.extendData ?? {}) as T
}

/** 像素空间：从 (px,py) 沿方向 (dx,dy) 延伸到 x=targetX（dx=0 时退回原点） */
function extendToX(px: number, py: number, dx: number, dy: number, targetX: number): { x: number; y: number } {
  if (dx === 0) return { x: px, y: py }
  const t = (targetX - px) / dx
  return { x: targetX, y: py + dy * t }
}

/** 价格文本（两位小数） */
function priceOf(v: number): string {
  return String(Math.round(v * 100) / 100)
}

/** 成交量文本（亿 / 万） */
function volText(v: number): string {
  if (v >= 1e8) return `${(v / 1e8).toFixed(2)}亿`
  if (v >= 1e4) return `${(v / 1e4).toFixed(1)}万`
  return String(Math.round(v))
}

// ---------------------------------------------------------------- 注册

/** 幂等注册全部自定义 overlay（每次 init 后调用安全） */
export function registerMarketOverlays(): void {
  if (registered) return
  registered = true

  // ① 全宽水平线 + 右侧胶囊标签（支撑 / 压力 / 量度目标）
  registerOverlay({
    name: OVERLAY_NAMES.labeledLine,
    totalStep: 1,
    createPointFigures: (params: unknown) => {
      const p = params as unknown as FigureParams
      const coord = p.coordinates[0]
      if (!coord) return []
      const ext = extOf<{ text?: string; color?: string; dash?: boolean }>(p)
      const color = ext.color || '#f59e0b'
      const y = coord.y
      const figures: Array<Record<string, unknown>> = [
        {
          type: 'line',
          ignoreEvent: true,
          attrs: { coordinates: [{ x: 0, y }, { x: p.bounding.width, y }] },
          styles: { color, size: 1, style: ext.dash ? 'dashed' : 'solid', dashedValue: [4, 4] },
        },
      ]
      if (ext.text) figures.push(textFigure(p.bounding.width - 4, y, ext.text, color, { align: 'right', baseline: 'middle' }))
      return figures
    },
  } as never)

  // ② 区域框（中枢 / 箱体）：填充 + 边框 + 左上标签（窄区自动隐藏标签）
  // totalStep=3：与内置两点工具对齐（手动绘制：落两点、末点双击完成）
  registerOverlay({
    name: OVERLAY_NAMES.rectZone,
    totalStep: 3,
    createPointFigures: (params: unknown) => {
      const p = params as unknown as FigureParams
      if (p.coordinates.length < 2) return []
      const x0 = Math.min(p.coordinates[0].x, p.coordinates[1].x)
      const x1 = Math.max(p.coordinates[0].x, p.coordinates[1].x)
      const y0 = Math.min(p.coordinates[0].y, p.coordinates[1].y)
      const y1 = Math.max(p.coordinates[0].y, p.coordinates[1].y)
      const ext = extOf<{ label?: string; color?: string; fill?: string; dash?: boolean; interactive?: boolean }>(p)
      const color = ext.color || '#8b5cf6'
      const borderStyle = ext.dash ? 'dashed' : 'solid'
      const figures: Array<Record<string, unknown>> = [
        {
          type: 'polygon',
          ignoreEvent: !ext.interactive,
          attrs: {
            coordinates: [
              { x: x0, y: y0 },
              { x: x1, y: y0 },
              { x: x1, y: y1 },
              { x: x0, y: y1 },
            ],
          },
          styles: {
            style: 'stroke_fill',
            color: ext.fill ?? `${color}1a`,
            borderColor: color,
            borderSize: 1,
            borderStyle,
            dashedValue: [4, 4],
          },
        },
      ]
      if (ext.label && x1 - x0 >= ext.label.length * 12 + 12 && y1 - y0 >= 16) {
        figures.push(textFigure(x0 + 6, y0 + 9, ext.label, color, { align: 'left', baseline: 'middle' }))
      }
      return figures
    },
  } as never)

  // ②b 两点测量框（M85 划线圈）：矩形 + 中心「涨跌幅 / 价差」胶囊文本
  registerOverlay({
    name: OVERLAY_NAMES.measureBox,
    totalStep: 3,
    createPointFigures: (params: unknown) => {
      const p = params as unknown as FigureParams
      if (p.coordinates.length < 2) return []
      const x0 = Math.min(p.coordinates[0].x, p.coordinates[1].x)
      const x1 = Math.max(p.coordinates[0].x, p.coordinates[1].x)
      const y0 = Math.min(p.coordinates[0].y, p.coordinates[1].y)
      const y1 = Math.max(p.coordinates[0].y, p.coordinates[1].y)
      const ext = extOf<{ color?: string; fill?: string; dash?: boolean; interactive?: boolean; text?: string }>(p)
      const color = ext.color || '#0ea5e9'
      const figures: Array<Record<string, unknown>> = [
        {
          type: 'polygon',
          ignoreEvent: !ext.interactive,
          attrs: {
            coordinates: [
              { x: x0, y: y0 },
              { x: x1, y: y0 },
              { x: x1, y: y1 },
              { x: x0, y: y1 },
            ],
          },
          styles: {
            style: 'stroke_fill',
            color: ext.fill ?? `${color}1a`,
            borderColor: color,
            borderSize: 1,
            borderStyle: ext.dash ? 'dashed' : 'solid',
            dashedValue: [4, 4],
          },
        },
      ]
      if (ext.text && x1 - x0 >= ext.text.length * 11 + 18 && y1 - y0 >= 16) {
        figures.push(textFigure((x0 + x1) / 2, (y0 + y1) / 2, ext.text, color, { align: 'center', baseline: 'middle' }))
      }
      return figures
    },
  } as never)

  // ③ 单点胶囊文本（探底位等；dot = 锚点小圆点）
  // totalStep=2：与内置单点工具对齐（手动文本：单击即完成）
  registerOverlay({
    name: OVERLAY_NAMES.textLabel,
    totalStep: 2,
    createPointFigures: (params: unknown) => {
      const p = params as unknown as FigureParams
      const coord = p.coordinates[0]
      if (!coord) return []
      const ext = extOf<{ text?: string; color?: string; dot?: boolean; interactive?: boolean }>(p)
      const color = ext.color || '#0ea5e9'
      const figures: Array<Record<string, unknown>> = []
      if (ext.dot) {
        figures.push({ type: 'circle', ignoreEvent: !ext.interactive, attrs: { x: coord.x, y: coord.y, r: 2.5 }, styles: { style: 'fill', color } })
      }
      if (ext.text) figures.push(textFigure(coord.x, coord.y - 8, ext.text, color, { align: 'center', baseline: 'bottom' }))
      return figures
    },
  } as never)

  // ④ 全高阶段色带（窄段自动隐藏标签）
  registerOverlay({
    name: OVERLAY_NAMES.phaseBand,
    totalStep: 1,
    createPointFigures: (params: unknown) => {
      const p = params as unknown as FigureParams
      if (p.coordinates.length < 2) return []
      const x0 = Math.min(p.coordinates[0].x, p.coordinates[1].x)
      const x1 = Math.max(p.coordinates[0].x, p.coordinates[1].x)
      if (x1 <= 0 || x0 >= p.bounding.width) return []
      const ext = extOf<{ color?: string; label?: string }>(p)
      const color = ext.color || '#a1a1aa'
      const figures: Array<Record<string, unknown>> = [
        {
          type: 'polygon',
          ignoreEvent: true,
          attrs: {
            coordinates: [
              { x: x0, y: 0 },
              { x: x1, y: 0 },
              { x: x1, y: p.bounding.height },
              { x: x0, y: p.bounding.height },
            ],
          },
          styles: { style: 'fill', color },
        },
      ]
      if (ext.label) {
        const labelWidth = ext.label.length * 12 + 14
        if (x1 - x0 >= labelWidth + 12) {
          figures.push(textFigure((x0 + x1) / 2, p.bounding.height - 12, ext.label, color, { align: 'center', baseline: 'middle' }))
        }
      }
      return figures
    },
  } as never)

  // ⑤ 交易计划（信号落图）：盈利区（红）/ 风险区（绿）/ 入场线 + R:R 标签
  registerOverlay({
    name: OVERLAY_NAMES.positionTool,
    totalStep: 1,
    createPointFigures: (params: unknown) => {
      const p = params as unknown as FigureParams
      if (p.coordinates.length < 2 || !p.yAxis) return []
      const x0 = Math.min(p.coordinates[0].x, p.coordinates[1].x)
      const x1 = Math.max(p.coordinates[0].x, p.coordinates[1].x)
      const ext = extOf<{
        entry?: number
        stop?: number
        target?: number
        entryText?: string
        stopText?: string
        targetText?: string
        rr?: number
      }>(p)
      if (typeof ext.entry !== 'number') return []
      const yE = p.yAxis.convertToPixel(ext.entry)
      const figures: Array<Record<string, unknown>> = []
      const up = '#dc2828'
      const down = '#0fa975'
      const zone = (ya: number, yb: number, color: string): Record<string, unknown> => ({
        type: 'polygon',
        ignoreEvent: true,
        attrs: {
          coordinates: [
            { x: x0, y: ya },
            { x: x1, y: ya },
            { x: x1, y: yb },
            { x: x0, y: yb },
          ],
        },
        styles: { style: 'fill', color: `${color}1f` },
      })
      if (typeof ext.target === 'number') {
        const yT = p.yAxis.convertToPixel(ext.target)
        figures.push(zone(Math.min(yE, yT), Math.max(yE, yT), up))
        figures.push({
          type: 'line',
          ignoreEvent: true,
          attrs: { coordinates: [{ x: x0, y: yT }, { x: x1, y: yT }] },
          styles: { color: up, size: 1, style: 'dashed', dashedValue: [4, 4] },
        })
        if (ext.targetText) figures.push(textFigure(x1 - 4, yT - 8, ext.targetText, up, { align: 'right', baseline: 'bottom' }))
      }
      if (typeof ext.stop === 'number') {
        const yS = p.yAxis.convertToPixel(ext.stop)
        figures.push(zone(Math.min(yE, yS), Math.max(yE, yS), down))
        figures.push({
          type: 'line',
          ignoreEvent: true,
          attrs: { coordinates: [{ x: x0, y: yS }, { x: x1, y: yS }] },
          styles: { color: down, size: 1, style: 'dashed', dashedValue: [4, 4] },
        })
        if (ext.stopText) figures.push(textFigure(x1 - 4, yS + 8, ext.stopText, down, { align: 'right', baseline: 'top' }))
      }
      // 入场实线 + 左标签 + R:R
      figures.push({
        type: 'line',
        ignoreEvent: true,
        attrs: { coordinates: [{ x: x0, y: yE }, { x: x1, y: yE }] },
        styles: { color: '#0ea5e9', size: 1, style: 'solid' },
      })
      if (ext.entryText) figures.push(textFigure(x0 + 4, yE - 7, ext.entryText, '#0ea5e9', { align: 'left', baseline: 'bottom' }))
      if (typeof ext.rr === 'number') {
        figures.push(textFigure((x0 + x1) / 2, yE + 8, `R:R ${ext.rr}`, '#0ea5e9', { align: 'center', baseline: 'top' }))
      }
      return figures
    },
  } as never)

  // ⑥ N 点折线（策略轨迹）
  registerOverlay({
    name: OVERLAY_NAMES.polyline,
    totalStep: 1,
    createPointFigures: (params: unknown) => {
      const p = params as unknown as FigureParams
      if (p.coordinates.length < 2) return []
      const ext = extOf<{ color?: string; dash?: boolean; width?: number }>(p)
      const color = ext.color || '#6366f1'
      return [
        {
          type: 'line',
          ignoreEvent: true,
          attrs: { coordinates: p.coordinates.map((c) => ({ x: c.x, y: c.y })) },
          styles: { color, size: ext.width ?? 1, style: ext.dash ? 'dashed' : 'solid', dashedValue: [4, 4] },
        },
      ]
    },
  } as never)

  // ⑦ 斐波那契扩展（M85 划线圈，三点 A/B/C：AB 趋势段 + C 回撤点 → 扩展位投影；totalStep=4）
  registerOverlay({
    name: OVERLAY_NAMES.fibExtension,
    totalStep: 4,
    createPointFigures: (params: unknown) => {
      const p = params as unknown as FigureParams
      const ext = extOf<{ color?: string; dash?: boolean; width?: number; interactive?: boolean }>(p)
      const color = ext.color || '#8b5cf6'
      const pts = p.coordinates
      const figures: Array<Record<string, unknown>> = []
      const aux = (from: { x: number; y: number }, to: { x: number; y: number }): Record<string, unknown> => ({
        type: 'line',
        ignoreEvent: true,
        attrs: { coordinates: [from, to] },
        styles: { color: `${color}99`, size: 1, style: 'dashed', dashedValue: [4, 4] },
      })
      if (pts.length >= 2) figures.push(aux(pts[0]!, pts[1]!))
      if (pts.length >= 3) figures.push(aux(pts[1]!, pts[2]!))
      if (pts.length < 3) return figures
      const [a, b, c] = pts as [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }]
      const right = p.bounding.width
      const levels = [0.618, 1, 1.272, 1.618]
      for (const r of levels) {
        const y = c.y + (b.y - a.y) * r
        if (y < -20 || y > p.bounding.height + 20) continue
        figures.push({
          type: 'line',
          ignoreEvent: !ext.interactive,
          attrs: { coordinates: [{ x: c.x, y }, { x: right, y }] },
          styles: { color, size: ext.width ?? 1, style: ext.dash ? 'dashed' : 'solid', dashedValue: [4, 4] },
        })
        const price = p.yAxis?.convertFromPixel ? p.yAxis.convertFromPixel(y) : undefined
        figures.push(textFigure(right - 4, y - (r === levels[0] ? -8 : 3), `${r}${typeof price === 'number' ? ` · ${priceOf(price)}` : ''}`, color, { align: 'right', baseline: r === levels[0] ? 'top' : 'bottom' }))
      }
      return figures
    },
  } as never)

  // ⑧ 安德鲁分叉线（M85 划线圈，三点 A/B/C：A→BC 中点为中线，过 B / C 作平行轨；totalStep=4）
  registerOverlay({
    name: OVERLAY_NAMES.pitchfork,
    totalStep: 4,
    createPointFigures: (params: unknown) => {
      const p = params as unknown as FigureParams
      const ext = extOf<{ color?: string; dash?: boolean; width?: number; interactive?: boolean }>(p)
      const color = ext.color || '#0ea5e9'
      const pts = p.coordinates
      const figures: Array<Record<string, unknown>> = []
      if (pts.length >= 2) {
        figures.push({
          type: 'line',
          ignoreEvent: true,
          attrs: { coordinates: [pts[0]!, pts[1]!] },
          styles: { color: `${color}99`, size: 1, style: 'dashed', dashedValue: [4, 4] },
        })
      }
      if (pts.length < 3) return figures
      const [a, b, c] = pts as [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }]
      const mid = { x: (b.x + c.x) / 2, y: (b.y + c.y) / 2 }
      const right = p.bounding.width
      const lineOf = (from: { x: number; y: number }, main: boolean): Record<string, unknown> => ({
        type: 'line',
        ignoreEvent: !ext.interactive,
        attrs: { coordinates: [from, extendToX(mid.x, mid.y, mid.x - a.x, mid.y - a.y, right)] },
        styles: {
          color: main ? color : `${color}b3`,
          size: ext.width ?? 1,
          style: main ? ext.dash ? 'dashed' : 'solid' : 'solid',
          dashedValue: [4, 4],
        },
      })
      figures.push(lineOf(a, true))
      figures.push(lineOf(b, false))
      figures.push(lineOf(c, false))
      return figures
    },
  } as never)

  // ⑨ 区间成交量分布（M85 划线圈，两点：时间 × 价格区间 → 右对齐水平量柱；数据取 chart.getDataList）
  registerOverlay({
    name: OVERLAY_NAMES.volProfile,
    totalStep: 3,
    createPointFigures: (params: unknown) => {
      const p = params as unknown as FigureParams
      const ext = extOf<{ color?: string; interactive?: boolean; buckets?: number }>(p)
      const color = ext.color || '#0ea5e9'
      if (p.coordinates.length < 2) return []
      const bars = p.chart?.getDataList() ?? []
      const xa = p.xAxis?.convertFromPixel
      const ya = p.yAxis?.convertFromPixel
      const y2p = p.yAxis?.convertToPixel
      if (bars.length === 0 || !xa || !ya || !y2p) return []
      const x0 = Math.min(p.coordinates[0]!.x, p.coordinates[1]!.x)
      const x1 = Math.max(p.coordinates[0]!.x, p.coordinates[1]!.x)
      const t0 = xa(x0)
      const t1 = xa(x1)
      if (!(typeof t0 === 'number' && typeof t1 === 'number') || t1 <= t0) return []
      const inRange = bars.filter((b) => b.timestamp >= t0 && b.timestamp <= t1)
      if (inRange.length === 0) return []
      const yTop = Math.min(p.coordinates[0]!.y, p.coordinates[1]!.y)
      const yBottom = Math.max(p.coordinates[0]!.y, p.coordinates[1]!.y)
      const pa = ya(yTop)
      const pb = ya(yBottom)
      if (!(typeof pa === 'number' && typeof pb === 'number')) return []
      const pMin = Math.min(pa, pb)
      const pMax = Math.max(pa, pb)
      if (pMax <= pMin) return []
      const buckets = Math.min(48, Math.max(8, ext.buckets ?? 24))
      const vols = new Array<number>(buckets).fill(0)
      let total = 0
      for (const b of inRange) {
        const typical = (b.high + b.low + b.close) / 3
        const idx = Math.min(buckets - 1, Math.max(0, Math.floor(((typical - pMin) / (pMax - pMin)) * buckets)))
        const v = typeof b.volume === 'number' && Number.isFinite(b.volume) ? Math.max(0, b.volume) : 0
        vols[idx] += v
        total += v
      }
      const maxVol = Math.max(...vols)
      if (maxVol <= 0) return []
      const step = (pMax - pMin) / buckets
      const span = (x1 - x0) * 0.85
      const figures: Array<Record<string, unknown>> = []
      for (let i = 0; i < buckets; i++) {
        if (vols[i]! <= 0) continue
        const yHi = y2p(pMin + (i + 1) * step)
        const yLo = y2p(pMin + i * step)
        const w = Math.max(1, (vols[i]! / maxVol) * span)
        figures.push({
          type: 'polygon',
          ignoreEvent: !ext.interactive,
          attrs: {
            coordinates: [
              { x: x1 - w, y: yHi },
              { x: x1, y: yHi },
              { x: x1, y: yLo },
              { x: x1 - w, y: yLo },
            ],
          },
          styles: { style: 'stroke_fill', color: `${color}33`, borderColor: color, borderSize: 0 },
        })
      }
      const first = inRange[0]!
      const last = inRange[inRange.length - 1]!
      const delta = first.close !== 0 ? ((last.close - first.close) / first.close) * 100 : 0
      const label = `量分 ${inRange.length}根 · 合 ${volText(total)} · ${delta >= 0 ? '+' : ''}${delta.toFixed(2)}%`
      if (x1 - x0 >= label.length * 11 + 16) {
        figures.push(textFigure(x1 - 4, yTop + 9, label, color, { align: 'right', baseline: 'middle' }))
      }
      return figures
    },
  } as never)
}

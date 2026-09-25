/**
 * 落图引擎（M83 §5.1）：shared `Drawing[]` + `SignalSpec` → klinecharts overlay。
 *
 * - kind 映射：hline→labeledLine（全宽线 + 右侧胶囊）、vline→verticalStraightLine、
 *   zone/rect→rectZone、segment→segment、trendline→straightLine、ray→rayLine、
 *   fibonacci→fibonacciLine、textLabel→textLabel、position→positionTool、
 *   polyline→polyline、未知→segment 兜底；
 * - signal → positionTool（几何 entry/stop/target + 百分比标签 + R:R）；
 * - 先清后画：清除已知落图组（analysis / strategy:* / 手工组）再逐条重建——
 *   数据来自受控 state / 快照，画布与数据不脱节（幂等重画）。
 * - 坐标口径：DrawingPoint.ts 为毫秒时间戳（与服务端 bars 同源），零日期解析（杜绝口径漂移）。
 */
import type { Chart } from 'klinecharts'
import type { Drawing, SignalSpec } from '@multi-agent/shared'
import { OVERLAY_NAMES } from './overlays'

/** 分析落图默认组（与服务端 analysis/drawings.ts 的 ANALYSIS_GROUP 一致） */
export const ANALYSIS_GROUP = 'analysis'

/** 已创建过的落图组（重画时精确清除，不误伤其他 overlay） */
const knownGroups = new Set<string>()

function priceText(v: number): string {
  return String(Math.round(v * 100) / 100)
}

function pctText(from: number, to: number): string {
  if (from === 0) return ''
  const pct = ((to - from) / from) * 100
  const text = pct.toFixed(2)
  return pct > 0 ? `+${text}%` : `${text}%`
}

interface OverlayCfg {
  name: string
  groupId: string
  points: Array<{ timestamp: number; value: number }>
  extendData?: unknown
  styles?: unknown
  lock?: boolean
}

function buildDrawing(d: Drawing): OverlayCfg | null {
  const groupId = d.groupId ?? ANALYSIS_GROUP
  const color = d.style?.color
  const dash = d.style?.dash
  const width = d.style?.width
  const pts = d.points ?? []
  const base = { groupId, lock: true }
  const lineStyles = { line: { ...(color ? { color } : {}), ...(width ? { size: width } : {}), style: dash ? 'dashed' : 'solid' } }

  switch (d.kind) {
    case 'hline': {
      if (pts.length < 1) return null
      return { ...base, name: OVERLAY_NAMES.labeledLine, points: [{ timestamp: pts[0].ts, value: pts[0].price }], extendData: { text: d.label, color, dash } }
    }
    case 'vline': {
      if (pts.length < 1) return null
      return { ...base, name: 'verticalStraightLine', points: [{ timestamp: pts[0].ts, value: pts[0].price }], styles: lineStyles }
    }
    case 'zone':
    case 'rect': {
      if (pts.length < 2) return null
      return {
        ...base,
        name: OVERLAY_NAMES.rectZone,
        points: [
          { timestamp: pts[0].ts, value: pts[0].price },
          { timestamp: pts[1].ts, value: pts[1].price },
        ],
        extendData: { label: d.label, color, fill: d.style?.fill, dash },
      }
    }
    case 'segment':
    case 'trendline':
    case 'ray':
    case 'fibonacci':
    case 'polyline': {
      const name =
        d.kind === 'segment' ? 'segment' : d.kind === 'trendline' ? 'straightLine' : d.kind === 'ray' ? 'rayLine' : d.kind === 'fibonacci' ? 'fibonacciLine' : OVERLAY_NAMES.polyline
      if (d.kind === 'polyline') {
        if (pts.length < 2) return null
        return { ...base, name, points: pts.map((p) => ({ timestamp: p.ts, value: p.price })), extendData: { color, dash, width } }
      }
      if (pts.length < 2) return null
      return {
        ...base,
        name,
        points: [
          { timestamp: pts[0].ts, value: pts[0].price },
          { timestamp: pts[1].ts, value: pts[1].price },
        ],
        styles: lineStyles,
      }
    }
    case 'textLabel': {
      if (pts.length < 1) return null
      return {
        ...base,
        name: OVERLAY_NAMES.textLabel,
        points: [{ timestamp: pts[0].ts, value: pts[0].price }],
        extendData: { text: d.label, color, dot: true },
      }
    }
    case 'position': {
      if (pts.length < 1 || typeof d.style?.stop !== 'number' || typeof d.style?.target !== 'number') return null
      const entry = pts[0].price
      const stop = d.style.stop
      const target = d.style.target
      const end = pts[pts.length - 1]
      return {
        ...base,
        name: OVERLAY_NAMES.positionTool,
        points: [
          { timestamp: pts[0].ts, value: entry },
          { timestamp: end.ts, value: end.price },
        ],
        extendData: {
          entry,
          stop,
          target,
          entryText: `入场 ${priceText(entry)}`,
          stopText: `止损 ${priceText(stop)}（${pctText(entry, stop)}）`,
          targetText: `目标 ${priceText(target)}（${pctText(entry, target)}）`,
        },
      }
    }
    default:
      // 未知 kind 兜底：两点线段
      if (pts.length < 2) return null
      return {
        ...base,
        name: 'segment',
        points: [
          { timestamp: pts[0].ts, value: pts[0].price },
          { timestamp: pts[1].ts, value: pts[1].price },
        ],
        styles: lineStyles,
      }
  }
}

/** 信号 → 交易计划（positionTool；仅 entry + stop/target 齐备时落图） */
function buildSignalOverlay(signal: SignalSpec, bars: Array<{ timestamp: number }>): OverlayCfg | null {
  const entry = signal.entry
  const stop = signal.stopLoss
  const target = signal.takeProfit.length > 0 ? signal.takeProfit[0] : null
  if (entry === null || (stop === null && target === null) || bars.length === 0) return null
  const startIdx = Math.max(0, bars.length - 40)
  const groupId = signal.groupId ?? ANALYSIS_GROUP
  return {
    name: OVERLAY_NAMES.positionTool,
    groupId,
    lock: true,
    points: [
      { timestamp: bars[startIdx].timestamp, value: entry },
      { timestamp: bars[bars.length - 1].timestamp, value: entry },
    ],
    extendData: {
      entry,
      ...(stop !== null ? { stop } : {}),
      ...(target !== null ? { target } : {}),
      entryText: `入场 ${priceText(entry)}`,
      ...(stop !== null ? { stopText: `止损 ${priceText(stop)}（${pctText(entry, stop)}）` } : {}),
      ...(target !== null ? { targetText: `目标 ${priceText(target)}（${pctText(entry, target)}）` } : {}),
      ...(signal.riskReward !== null ? { rr: signal.riskReward } : {}),
    },
  }
}

/**
 * 先清后画（幂等）：清除已知落图组 → 重建 drawings 与 signal。
 * 应在 resetData 完成后（requestAnimationFrame 内）调用。
 */
export function applyDrawings(chart: Chart | null, drawings: Drawing[], signal: SignalSpec | null | undefined, bars: Array<{ timestamp: number }>): void {
  if (!chart) return
  chart.removeOverlay({ groupId: ANALYSIS_GROUP })
  for (const g of knownGroups) chart.removeOverlay({ groupId: g })
  knownGroups.clear()

  for (const d of drawings) {
    const cfg = buildDrawing(d)
    if (!cfg) continue
    knownGroups.add(cfg.groupId)
    chart.createOverlay(cfg as never)
  }
  if (signal) {
    const cfg = buildSignalOverlay(signal, bars)
    if (cfg) {
      knownGroups.add(cfg.groupId)
      chart.createOverlay(cfg as never)
    }
  }
}

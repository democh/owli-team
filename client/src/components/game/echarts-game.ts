/**
 * 博弈图表运行时（evolve 演化曲线 / simulate 扇形与直方图，M34 §6.4）：
 * - 仅被 components/game 懒 chunk 引用；与 lib/chart.ts 共享 echarts 核心（注册互补，无重复打包）；
 * - mountOption：init/setOption/ResizeObserver → dispose（jsdom 无 ResizeObserver 时跳过）；
 * - 配色语义：多头蓝（#2563eb）/ 空头橙（#f97316），与矩阵热力双色域一致。
 */
import * as echarts from 'echarts/core'
import { BarChart, LineChart } from 'echarts/charts'
import { GridComponent, MarkLineComponent, MarkPointComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { EChartsCoreOption } from 'echarts/core'
import { fmtNum, fmtPct, PLAYER_LABELS, type EvolveResult, type SimulateResult } from './types'

export const LONG_COLOR = '#2563eb'
export const SHORT_COLOR = '#f97316'

const TEXT = { fontSize: 11, color: '#64748b' }

let installed = false

function ensureInstalled(): void {
  if (installed) return
  echarts.use([
    LineChart,
    BarChart,
    GridComponent,
    TooltipComponent,
    MarkLineComponent,
    MarkPointComponent,
    CanvasRenderer,
  ])
  installed = true
}

export interface GameChartHandle {
  dispose(): void
}

/** 在容器内挂载图表（重复调用方负责先 dispose） */
export function mountOption(el: HTMLElement, option: EChartsCoreOption): GameChartHandle {
  ensureInstalled()
  const chart = echarts.init(el, undefined, { renderer: 'canvas' })
  chart.setOption(option, { notMerge: true })
  let ro: ResizeObserver | undefined
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => chart.resize())
    ro.observe(el)
  }
  return {
    dispose(): void {
      ro?.disconnect()
      chart.dispose()
    },
  }
}

const GRID = { left: 6, right: 10, top: 16, bottom: 2, containLabel: true }

/** 演化曲线：多空比例 x vs 时间；稳定固定点标线（ESS），初值曲线叠加 */
export function buildEvolveOption(result: EvolveResult): EChartsCoreOption {
  const markLines = result.fixedPoints.map((point) => ({
    yAxis: point.x,
    lineStyle: { color: point.stable ? LONG_COLOR : '#94a3b8', type: point.stable ? 'dashed' : 'dotted', width: 1 },
    label: { formatter: `${point.stable ? 'ESS ' : ''}x=${fmtNum(point.x, 3)}`, position: 'insideEndTop', fontSize: 10, color: '#64748b' },
  }))
  return {
    tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
    grid: GRID,
    xAxis: { type: 'value', name: '时间', nameTextStyle: TEXT, axisLabel: TEXT, splitLine: { lineStyle: { color: '#f1f5f9' } } },
    yAxis: {
      type: 'value',
      name: `${PLAYER_LABELS.long}比例`,
      nameTextStyle: TEXT,
      min: 0,
      max: 1,
      axisLabel: { ...TEXT, formatter: (v: number) => `${Math.round(v * 100)}%` },
      splitLine: { lineStyle: { color: '#f1f5f9' } },
    },
    series: result.curves.map((curve, idx) => ({
      type: 'line',
      name: `x₀=${fmtNum(curve.x0, 2)}`,
      showSymbol: false,
      lineStyle: { width: idx === 0 ? 1.6 : 1, opacity: idx === 0 ? 1 : 0.55 },
      emphasis: { focus: 'series' },
      data: curve.points.map((p) => [p.t, p.x]),
      ...(idx === 0 ? { markLine: { silent: true, symbol: 'none', data: markLines } } : {}),
    })),
  }
}

/** 价格路径扇形图：P5–P95 / P25–P75 分位带 + P50 中位 + 抽样路径 */
export function buildFanOption(result: SimulateResult): EChartsCoreOption {
  const rounds = result.bands.rounds
  const span = (lo: number[], hi: number[]) => hi.map((v, i) => v - lo[i])
  return {
    tooltip: { trigger: 'axis' },
    grid: GRID,
    xAxis: { type: 'category', data: rounds, name: '轮次', nameTextStyle: TEXT, axisLabel: { ...TEXT, interval: Math.max(1, Math.floor(rounds.length / 6)) } },
    yAxis: { type: 'value', scale: true, axisLabel: TEXT, splitLine: { lineStyle: { color: '#f1f5f9' } } },
    series: [
      { type: 'line', name: 'P5', data: result.bands.p5, showSymbol: false, lineStyle: { opacity: 0 }, stack: 'band95', silent: true },
      {
        type: 'line',
        name: 'P5–P95',
        data: span(result.bands.p5, result.bands.p95),
        showSymbol: false,
        lineStyle: { opacity: 0 },
        stack: 'band95',
        areaStyle: { color: 'rgba(37, 99, 235, 0.12)' },
        silent: true,
      },
      { type: 'line', name: 'P25', data: result.bands.p25, showSymbol: false, lineStyle: { opacity: 0 }, stack: 'band75', silent: true },
      {
        type: 'line',
        name: 'P25–P75',
        data: span(result.bands.p25, result.bands.p75),
        showSymbol: false,
        lineStyle: { opacity: 0 },
        stack: 'band75',
        areaStyle: { color: 'rgba(37, 99, 235, 0.2)' },
        silent: true,
      },
      { type: 'line', name: 'P50 中位', data: result.bands.p50, showSymbol: false, lineStyle: { width: 1.8, color: LONG_COLOR } },
      ...result.samplePaths.slice(0, 12).map((path, idx) => ({
        type: 'line' as const,
        name: `样本 ${idx + 1}`,
        data: path,
        showSymbol: false,
        silent: true,
        lineStyle: { width: 0.6, opacity: 0.22, color: '#94a3b8' },
      })),
    ],
  }
}

/** 终值分布直方图 */
export function buildHistogramOption(result: SimulateResult): EChartsCoreOption {
  return {
    tooltip: { trigger: 'axis' },
    grid: GRID,
    xAxis: {
      type: 'category',
      data: result.finalHistogram.map((bin) => fmtNum(bin.binStart, 2)),
      axisLabel: { ...TEXT, interval: Math.max(1, Math.floor(result.finalHistogram.length / 6)) },
    },
    yAxis: { type: 'value', name: '路径数', nameTextStyle: TEXT, axisLabel: TEXT, splitLine: { lineStyle: { color: '#f1f5f9' } } },
    series: [
      {
        type: 'bar',
        name: '终值分布',
        data: result.finalHistogram.map((bin) => bin.count),
        barMaxWidth: 16,
        itemStyle: { color: 'rgba(37, 99, 235, 0.55)', borderRadius: [2, 2, 0, 0] },
      },
    ],
  }
}

/** 事件概率 chips 文案（simulate；顺序固定） */
export function simulateEventChips(result: SimulateResult): Array<{ label: string; value: string }> {
  return [
    { label: '挤空', value: fmtPct(result.events.squeeze, 1) },
    { label: '踩踏', value: fmtPct(result.events.crash, 1) },
    { label: '僵持', value: fmtPct(result.events.stalemate, 1) },
  ]
}

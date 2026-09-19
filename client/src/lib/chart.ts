/**
 * Chart 渲染运行时（echarts 按需 + 懒加载）：
 * - 本模块只被 ChartBlock 动态 import（独立 chunk，不进首屏）；
 * - echarts 用静态命名导入（而非动态命名空间），随懒 chunk 一起精确 tree-shake：
 *   core + bar/line/pie/scatter + grid/tooltip/legend/title + canvas；
 * - createChart：init/setOption/ResizeObserver → 返回 dispose（组件卸载/遮挡层关闭时调用）。
 * 纯解析逻辑在 lib/chart-spec（零依赖），可被主包安全引用。
 */
import * as echarts from 'echarts/core'
import { BarChart, LineChart, PieChart, ScatterChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TitleComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { EChartsCoreOption } from 'echarts/core'
import type { ChartSpec } from './chart-spec'
import { FONT_SANS } from './fonts'

const PALETTE = ['#2563eb', '#0ea5e9', '#8b5cf6', '#10b981', '#f59e0b', '#f43f5e', '#14b8a6', '#f97316']

function buildOption(spec: ChartSpec): EChartsCoreOption {
  const { kind, title, unit } = spec
  const textStyle = { fontSize: 11, color: '#64748b' }
  const head = {
    color: PALETTE,
    title: title
      ? { text: title, left: 4, top: 2, textStyle: { fontSize: 13, fontWeight: 600, color: '#0f172a' } }
      : undefined,
  }
  if (kind === 'pie') {
    return {
      ...head,
      tooltip: { trigger: 'item', ...(unit ? { formatter: `{b}: {c} ${unit}（{d}%）` } : {}) },
      legend: { bottom: 0, icon: 'circle', textStyle, type: 'scroll' },
      series: [
        {
          type: 'pie',
          radius: ['36%', '62%'],
          center: ['50%', title ? '50%' : '46%'],
          itemStyle: { borderColor: '#fff', borderWidth: 1 },
          label: { fontSize: 11, color: '#475569' },
          data: spec.labels.map((name, i) => ({ name, value: spec.series[0]?.data[i] ?? 0 })),
        },
      ],
    }
  }
  const category = {
    type: 'category',
    data: spec.labels,
    axisLabel: textStyle,
    axisTick: { show: false },
    axisLine: { lineStyle: { color: '#e2e8f0' } },
  }
  const value = {
    type: 'value',
    axisLabel: { ...textStyle, ...(unit ? { formatter: `{value} ${unit}` } : {}) },
    splitLine: { lineStyle: { color: '#eef2f7' } },
  }
  const horizontal = spec.horizontal && kind === 'bar'
  return {
    ...head,
    tooltip: { trigger: 'axis' },
    legend: spec.series.length > 1 ? { bottom: 0, icon: 'circle', textStyle, type: 'scroll' } : undefined,
    grid: {
      left: 4,
      right: 8,
      top: title ? 30 : 8,
      bottom: spec.series.length > 1 ? 24 : 2,
      containLabel: true,
    },
    xAxis: horizontal ? value : category,
    yAxis: horizontal ? category : value,
    series: spec.series.map((s) => ({
      name: s.name,
      type: kind === 'area' ? 'line' : kind,
      smooth: kind !== 'bar' && kind !== 'scatter',
      symbol: kind === 'scatter' ? 'circle' : 'none',
      symbolSize: kind === 'scatter' ? 7 : undefined,
      areaStyle: kind === 'area' ? { opacity: 0.16 } : undefined,
      stack: spec.stack ? 'total' : undefined,
      barMaxWidth: 32,
      emphasis: { focus: 'series' },
      data: s.data,
    })),
  }
}

export interface ChartHandle {
  dispose(): void
}

let installed = false

function ensureInstalled(): void {
  if (installed) return
  echarts.use([
    BarChart,
    LineChart,
    PieChart,
    ScatterChart,
    GridComponent,
    TooltipComponent,
    LegendComponent,
    TitleComponent,
    CanvasRenderer,
  ])
  installed = true
}

let themeRegistered = false

/** 注册图表主题（字体对齐 app；只做一次） */
function ensureTheme(): void {
  if (themeRegistered) return
  echarts.registerTheme('md-light', {
    textStyle: { fontFamily: FONT_SANS },
  })
  themeRegistered = true
}

/** 在容器内创建图表；ResizeObserver 守卫（jsdom 无此 API 时跳过监听） */
export function createChart(el: HTMLElement, spec: ChartSpec): ChartHandle {
  ensureInstalled()
  ensureTheme()
  const chart = echarts.init(el, 'md-light', { renderer: 'canvas' })
  chart.setOption(buildOption(spec), { notMerge: true })
  let ro: ResizeObserver | undefined
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => {
      chart.resize()
    })
    ro.observe(el)
  }
  return {
    dispose(): void {
      ro?.disconnect()
      chart.dispose()
    },
  }
}

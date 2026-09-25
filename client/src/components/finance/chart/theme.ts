/**
 * 图表主题（M83 §5.1）：色板 / 大数格式化 / 中文 tooltip / 统一 K 线样式。
 *
 * 以项目 md-light 为源（涨红跌绿，与 KPI 卡组 --up/--down 同源）；吸收 klinecharts v10 手册：
 * - compareRule: 'previous_close'（国内行情习惯：收盘 > 昨收为红）；
 * - indicator.bars 副图柱同色口径（默认主题为绿涨红跌，必须显式覆盖）；
 * - tooltip showRule: 'follow_cross'（悬停才显示，避免常驻图例压住矮容器主图）；
 * - separator 增强 + 极淡横向网格（纵向网格关闭降噪）。
 */
import type { DeepPartial, Options, Styles } from 'klinecharts'

/** 色板（与 lib 内原主题一致：涨红跌绿） */
export const CHART = {
  up: '#dc2828',
  down: '#0fa975',
  flat: '#76808f',
  axisText: '#64748b',
  gridLine: 'rgba(15, 23, 42, 0.04)',
  gridStrong: '#e2e8f0',
  crossLine: '#94a3b8',
  crossLabelBg: '#475569',
} as const

/** 等宽字体栈（数值展示） */
export const MONO_FONT = 'ui-monospace, SFMono-Regular, Menlo, monospace'

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function fmt2(v: number | undefined): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(2) : '—'
}

function fmtPct(v: number): string {
  const text = v.toFixed(2)
  return v > 0 ? `+${text}%` : `${text}%`
}

/** 大数格式化（同时作为 formatter.formatBigNumber：亿 / 万） */
export function fmtBigNumber(value: string | number): string {
  const v = typeof value === 'string' ? Number(value) : value
  if (!Number.isFinite(v)) return '—'
  const sign = v < 0 ? '-' : ''
  const abs = Math.abs(v)
  if (abs >= 1e8) return `${sign}${(abs / 1e8).toFixed(2)}亿`
  if (abs >= 1e4) return `${sign}${(abs / 1e4).toFixed(2)}万`
  return `${sign}${abs.toFixed(0)}`
}

/** 中文 tooltip（OHLC + 涨跌幅带色 + 成交量缩写；分钟级自动带时分） */
function buildTooltipLegend(data: unknown): Array<{ title: string; value: string | { text: string; color?: string } }> {
  const input = data as {
    current?: { timestamp?: number; open?: number; high?: number; low?: number; close?: number; volume?: number }
    prev?: { close?: number }
  }
  const cur = input?.current
  if (!cur || typeof cur.close !== 'number') return []
  const ts = typeof cur.timestamp === 'number' ? cur.timestamp : 0
  const d = new Date(ts)
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
  const time = d.getHours() !== 0 || d.getMinutes() !== 0 ? `${date} ${pad2(d.getHours())}:${pad2(d.getMinutes())}` : date
  const prevClose = input?.prev?.close
  const change = typeof prevClose === 'number' && prevClose > 0 ? ((cur.close - prevClose) / prevClose) * 100 : null
  const chgColor = change === null ? CHART.flat : change > 0 ? CHART.up : change < 0 ? CHART.down : CHART.flat
  const rows: Array<{ title: string; value: string | { text: string; color?: string } }> = [
    { title: '时间', value: time },
    { title: '开盘', value: fmt2(cur.open) },
    { title: '最高', value: fmt2(cur.high) },
    { title: '最低', value: fmt2(cur.low) },
    { title: '收盘', value: { text: fmt2(cur.close), color: chgColor } },
  ]
  if (change !== null) rows.push({ title: '涨跌幅', value: { text: fmtPct(change), color: chgColor } })
  if (typeof cur.volume === 'number') rows.push({ title: '成交量', value: fmtBigNumber(cur.volume) })
  return rows
}

/** 统一样式（红涨绿跌三处显式覆盖：candle.bar / priceMark.last / indicator.bars） */
export function baseKlineStyles(): DeepPartial<Styles> {
  return {
    grid: {
      show: true,
      horizontal: { show: true, color: CHART.gridLine },
      vertical: { show: false },
    },
    candle: {
      type: 'candle_solid',
      bar: {
        compareRule: 'previous_close',
        upColor: CHART.up,
        downColor: CHART.down,
        noChangeColor: CHART.flat,
        upBorderColor: CHART.up,
        downBorderColor: CHART.down,
        noChangeBorderColor: CHART.flat,
        upWickColor: CHART.up,
        downWickColor: CHART.down,
        noChangeWickColor: CHART.flat,
      },
      priceMark: {
        high: { color: CHART.axisText, textSize: 10 },
        low: { color: CHART.axisText, textSize: 10 },
        last: {
          show: true,
          compareRule: 'previous_close',
          upColor: CHART.up,
          downColor: CHART.down,
          noChangeColor: CHART.flat,
          line: { show: true, style: 'dashed', dashedValue: [4, 4], size: 1 },
          text: { show: true, color: '#ffffff', size: 11 },
        },
      },
      tooltip: {
        showRule: 'follow_cross',
        title: { size: 11 },
        legend: {
          size: 11,
          template: buildTooltipLegend as never,
        },
        rect: { color: 'rgba(255, 255, 255, 0.96)', borderColor: CHART.gridStrong, borderSize: 1 },
      },
    },
    indicator: {
      ohlc: { upColor: CHART.up, downColor: CHART.down, noChangeColor: CHART.flat },
      // 副图柱状（VOL / MACD 柱）与主图同口径；klinecharts 默认绿涨红跌，必须显式覆盖
      bars: [{ upColor: CHART.up, downColor: CHART.down, noChangeColor: CHART.flat }],
      lastValueMark: { text: { size: 11, color: CHART.axisText } },
      tooltip: { showRule: 'follow_cross', title: { size: 11 }, legend: { size: 11 } },
    },
    separator: { size: 2, color: CHART.gridStrong, fill: true },
    xAxis: {
      axisLine: { show: false },
      tickLine: { show: false },
      tickText: { color: CHART.axisText, size: 11 },
    },
    yAxis: {
      axisLine: { show: false },
      tickLine: { show: false },
      tickText: { color: CHART.axisText, size: 11 },
    },
    crosshair: {
      horizontal: {
        line: { color: CHART.crossLine, style: 'dashed', dashedValue: [4, 4] },
        text: { color: '#ffffff', backgroundColor: CHART.crossLabelBg },
      },
      vertical: {
        line: { color: CHART.crossLine, style: 'dashed', dashedValue: [4, 4] },
        text: { color: '#ffffff', backgroundColor: CHART.crossLabelBg },
      },
    },
  }
}

/** init 基础选项：中文 locale + 大数格式化 + 统一样式 */
export function baseKlineOptions(): Options {
  return {
    locale: 'zh-CN',
    formatter: { formatBigNumber: fmtBigNumber },
    styles: baseKlineStyles(),
  }
}

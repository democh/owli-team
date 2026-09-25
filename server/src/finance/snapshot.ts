/**
 * 图表快照（M34 §3.4）：K 线结果落盘为可复现会话资产（进交付件体系，可版本 diff）。
 *
 * 命名：`<dir>/<symbol>-<period>-<yyyymmddHHMM>.json`（时间为北京时间）。
 * schema：chart-snapshot —— kind / symbol / name / period / adjust / meta（来源、抓取时间、条数）/ bars
 * / indicators（渲染开关）/ annotations（价格线等标注）。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Drawing, KlineAnalysis, KlineRender, SignalSpec } from '@multi-agent/shared'
import { formatCnDateTime, type Adjust, type Period } from './period.js'
import type { KlineBar, KlineSeries } from './types.js'

export interface ChartAnnotation {
  /** 如 priceLine（压力/支撑位） */
  type: string
  price?: number
  label?: string
}

export interface ChartSnapshot {
  kind: 'kline'
  symbol: string
  name: string
  period: Period
  adjust: Adjust
  meta: {
    /** 实际来源（东财 / baostock / akshare…） */
    source: string
    /** 数据时间（ISO8601） */
    asOf: string
    bars: number
    /** 降级 / 口径说明（可选） */
    note?: string
  }
  bars: KlineBar[]
  indicators?: string[]
  annotations?: ChartAnnotation[]
  /** M83：渲染配置（主图 / 副图 / 阶段色带） */
  render?: KlineRender
  /** M83：落图数据（分析 / 策略产出；kind 白名单见 shared DRAWING_KINDS） */
  drawings?: Drawing[]
  /** M83：策略信号（交易计划落图；缺省 = 无信号或未触发） */
  signal?: SignalSpec
  /** M83：K 线分析结论（分析面板数据源） */
  analysis?: KlineAnalysis
}

export interface WriteSnapshotResult {
  /** 会话工作区内相对路径（交付件引用用） */
  path: string
  /** 磁盘绝对路径 */
  absPath: string
  bytes: number
}

/** 回测快照（M34 §3.4：fin_backtest 结果落盘为可复现资产；M83：DSL 策略记录源码） */
export interface BacktestSnapshot {
  kind: 'backtest'
  symbol: string
  name: string
  meta: {
    source: string
    asOf: string
    template: string
    params: Record<string, number>
    range: { from: string; to: string; bars: number }
    feeRate: number
    slippage: number
    /** M83：template='dsl' 时的策略源码（复现用） */
    dsl?: string
    note?: string
  }
  metrics: unknown
  trades: unknown[]
  equity: unknown[]
  notes?: string[]
}

/** 筛选快照（M34 §3.4：fin_screen 结果落盘为可复现资产） */
export interface ScreenSnapshot {
  kind: 'screen'
  meta: {
    source: string
    asOf: string
    conditions: unknown[]
    orderBy?: { field: string; desc?: boolean }
    total: number
    matched: number
    limit: number
    note?: string
  }
  rows: unknown[]
}

/** KlineSeries → chart-snapshot（meta 记录来源与口径；bars 保持升序；M83 可选携带渲染/落图/信号/分析） */
export function buildKlineSnapshot(
  series: KlineSeries,
  opts: {
    indicators?: string[]
    annotations?: ChartAnnotation[]
    note?: string
    render?: KlineRender
    drawings?: Drawing[]
    signal?: SignalSpec
    analysis?: KlineAnalysis
  } = {},
): ChartSnapshot {
  const snapshot: ChartSnapshot = {
    kind: 'kline',
    symbol: series.symbol,
    name: series.name,
    period: series.period,
    adjust: series.adjust,
    meta: {
      source: series.source,
      asOf: series.asOf,
      bars: series.bars.length,
      ...(opts.note ? { note: opts.note } : {}),
    },
    bars: series.bars.map((bar) => ({ ...bar })),
  }
  if (opts.indicators && opts.indicators.length > 0) snapshot.indicators = [...opts.indicators]
  if (opts.annotations && opts.annotations.length > 0) snapshot.annotations = [...opts.annotations]
  if (opts.render) snapshot.render = { ...opts.render }
  if (opts.drawings && opts.drawings.length > 0) snapshot.drawings = opts.drawings.map((d) => ({ ...d }))
  if (opts.signal) snapshot.signal = { ...opts.signal }
  if (opts.analysis) snapshot.analysis = opts.analysis
  return snapshot
}

/** 北京时间戳 yyyymmddHHMM（快照文件名用） */
export function snapshotStamp(date: Date = new Date()): string {
  return formatCnDateTime(date.getTime()).replace(/[-: ]/g, '')
}

/** 快照文件名（symbol/period 理论安全，仍做净化防御） */
export function snapshotFilename(symbol: string, period: Period, date: Date = new Date()): string {
  const safe = symbol.replace(/[^A-Za-z0-9._-]/g, '_')
  return `${safe}-${period}-${snapshotStamp(date)}.json`
}

/** 回测快照文件名：`<symbol>-backtest-<yyyymmddHHMM>.json` */
export function backtestSnapshotFilename(symbol: string, date: Date = new Date()): string {
  const safe = symbol.replace(/[^A-Za-z0-9._-]/g, '_')
  return `${safe}-backtest-${snapshotStamp(date)}.json`
}

/** 筛选快照文件名：`screen-<yyyymmddHHMM>.json` */
export function screenSnapshotFilename(date: Date = new Date()): string {
  return `screen-${snapshotStamp(date)}.json`
}

/** 相对目录净化（拒绝绝对路径与 `..`，统一正斜杠） */
function safeDir(dir: string): string {
  const cleaned = dir.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\.\.\//g, '')
  return cleaned.replace(/\/+$/, '') || 'charts'
}

/**
 * 写快照到会话工作区（目录自动创建）。
 * @returns 相对路径（如 charts/sh600519-day-202609181030.json）与字节数
 */
export function writeChartSnapshot(
  workspace: string,
  dir: string,
  snapshot: ChartSnapshot,
  opts: { now?: Date; filename?: string } = {},
): Promise<WriteSnapshotResult> {
  const filename = opts.filename ?? snapshotFilename(snapshot.symbol, snapshot.period, opts.now ?? new Date())
  return writeJsonSnapshot(workspace, dir, filename, snapshot)
}

/** 通用 JSON 快照写入（回测 / 筛选 / 博弈等 chart-snapshot 姊妹 schema 共用） */
export async function writeJsonSnapshot(
  workspace: string,
  dir: string,
  filename: string,
  data: unknown,
): Promise<WriteSnapshotResult> {
  const relDir = safeDir(dir)
  const rel = path.posix.join(relDir, filename)
  const absPath = path.join(workspace, relDir, filename)
  const content = `${JSON.stringify(data, null, 2)}\n`
  await mkdir(path.dirname(absPath), { recursive: true })
  await writeFile(absPath, content, 'utf8')
  return { path: rel, absPath, bytes: Buffer.byteLength(content, 'utf8') }
}

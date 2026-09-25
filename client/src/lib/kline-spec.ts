/**
 * Kline 块配置解析（纯函数；可被主包安全静态引用）。
 * ```kline 代码块 → KlineSpec；宽松校验 + 面向用户的中文错误信息。
 *
 * JSON 形状（src 快照引用与 data 内联数据至少一项；渲染优先 data）：
 * {
 *   "src": "charts/sh600519-day-202609181030.json",     // 会话工作区相对路径（快照）
 *   "data": { "kind":"kline","symbol":"sh600519","name":"贵州茅台","period":"day","adjust":"qfq",
 *             "bars":[{ "timestamp":1757952000000,"open":1450,"high":1468,"low":1442,"close":1461,"volume":28300 }] },
 *   "indicators": ["MA","VOL","MACD"],                  // 渲染面板（缺省 ["MA","VOL"]；用于推导主/副图）
 *   "annotations": [{ "type":"priceLine","price":1500,"label":"压力位" }],
 *   "title": "贵州茅台 日K（前复权）",
 *   // M83 扩展（全部可选；旧块零影响）：
 *   "mainIndicator": "MA",                              // 主图指标（枚举；'none' 关闭）
 *   "subIndicator": "VOL",                               // 副图指标（枚举；'none' 关闭）
 *   "showPhases": true,                                  // 阶段色带（缺省：analysis 存在时 true）
 *   "drawings": [ ... ],                                 // 落图（shared Drawing 契约）
 *   "signal": { ... },                                   // 策略信号（交易计划落图）
 *   "analysis": { ... }                                  // 分析结论（分析面板数据源）
 * }
 * 简写：`"data"` 也接受直接给 bars 数组（[ { timestamp, open, high, low, close, volume } ]）。
 *
 * 归一承诺：返回的 bars 按 timestamp 升序（乱序输入亦自动排序）；volume 缺省 0、turnover 可选。
 * M83 解析策略：bars / indicators / mainIndicator / subIndicator 非法 → 显式报错（模型自纠）；
 * drawings / signal / analysis / showPhases 非法 → 降级忽略并收集 warnings（主图不受影响）。
 */
import {
  KLINE_RENDER_INDICATORS,
  MAIN_INDICATORS,
  SUB_INDICATORS,
  type Drawing,
  type KlineAnalysis,
  type KlineRenderIndicator,
  type MainIndicator,
  type SignalSpec,
  type SubIndicator,
} from '@multi-agent/shared'
import { parseDrawings, parseKlineAnalysis, parseSignal } from './kline-analysis'

export const KLINE_INDICATORS = KLINE_RENDER_INDICATORS
export type KlineIndicator = KlineRenderIndicator

/** 缺省指标面板（与 fin_kline 工具默认一致） */
export const DEFAULT_KLINE_INDICATORS: readonly KlineIndicator[] = ['MA', 'VOL']

/** 主图缺省推导：按 legacy indicators 顺序取第一个主图成员；无 → 'MA' */
export function deriveMainIndicator(indicators: readonly string[]): MainIndicator | 'none' {
  for (const name of indicators) {
    if ((MAIN_INDICATORS as readonly string[]).includes(name)) return name as MainIndicator
  }
  return 'MA'
}

/** 副图缺省推导：按 legacy indicators 顺序取第一个副图成员；无 → 'VOL' */
export function deriveSubIndicator(indicators: readonly string[]): SubIndicator | 'none' {
  for (const name of indicators) {
    if ((SUB_INDICATORS as readonly string[]).includes(name)) return name as SubIndicator
  }
  return 'VOL'
}

/** 周期白名单（C3 行情 Tab 周期切换复用；与 server period.ts 的 PERIODS 对齐） */
export const KLINE_PERIODS = ['day', 'week', 'month', 'min5', 'min15', 'min30', 'min60'] as const
export type KlinePeriod = (typeof KLINE_PERIODS)[number]

/** 复权口径（与 server period.ts 的 ADJUSTS 对齐） */
export const KLINE_ADJUSTS = ['qfq', 'hfq', 'none'] as const
export type KlineAdjust = (typeof KLINE_ADJUSTS)[number]

/** 周期 / 复权中文标签（渲染标题用；周期取值与 server period.ts 对齐） */
export const KLINE_PERIOD_LABELS: Record<string, string> = {
  day: '日K',
  week: '周K',
  month: '月K',
  min5: '5分',
  min15: '15分',
  min30: '30分',
  min60: '60分',
}

export const KLINE_ADJUST_LABELS: Record<string, string> = {
  qfq: '前复权',
  hfq: '后复权',
  none: '不复权',
}

export interface KlineBar {
  /** 毫秒时间戳（日线为当日 00:00 北京时间） */
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  /** 成交量（手；缺省 0） */
  volume: number
  /** 成交额（元；源缺省时省略） */
  turnover?: number
}

export interface KlineAnnotation {
  /** 如 priceLine（压力 / 支撑位） */
  type: string
  price?: number
  label?: string
}

/** 内联数据集（同 chart-snapshot schema 的元信息 + bars） */
export interface KlineDataset {
  kind?: string
  symbol?: string
  name?: string
  period?: string
  adjust?: string
  bars: KlineBar[]
}

export interface KlineSpec {
  /** 快照路径（会话工作区相对；与 data 至少一项） */
  src?: string
  /** 内联数据（渲染优先；无 src 时必填） */
  data?: KlineDataset
  indicators: KlineIndicator[]
  annotations: KlineAnnotation[]
  title?: string
  /** M83：主图指标（缺省按 indicators 推导） */
  mainIndicator?: MainIndicator | 'none'
  /** M83：副图指标（缺省按 indicators 推导） */
  subIndicator?: SubIndicator | 'none'
  /** M83：阶段色带（缺省：analysis 存在时 true） */
  showPhases?: boolean
  /** M83：落图（降级字段；缺省 []） */
  drawings: Drawing[]
  /** M83：策略信号（降级字段；缺省 null） */
  signal: SignalSpec | null
  /** M83：分析结论（降级字段；解析失败时缺省） */
  analysis?: KlineAnalysis
  /** M83：增强字段降级警告（主契约错误仍走显式 error） */
  warnings: string[]
}

export type KlineParseResult = { ok: true; spec: KlineSpec } | { ok: false; error: string }

/** 数值兼容解析：number / 数字字符串 / null → number | null | undefined（对齐 chart-spec） */
function toNumber(v: unknown): number | null | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  if (v === null) return null
  return undefined
}

/** 会话工作区相对路径防御（拒绝绝对路径与 `..` 上跳；与 server snapshot.ts safeDir 同口径） */
function isSafeRelPath(p: string): boolean {
  if (p.startsWith('/') || p.startsWith('\\') || /^[a-zA-Z]:/.test(p)) return false
  return !p.split(/[\\/]/).some((seg) => seg === '..')
}

function parseBars(raw: unknown, label: string): { ok: true; bars: KlineBar[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: `${label} 必须是数组（[{ timestamp, open, high, low, close, volume }]）` }
  if (raw.length === 0) return { ok: false, error: `${label} 为空：至少需要 1 根 K 线` }
  const bars: KlineBar[] = []
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i]
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return { ok: false, error: `${label}[${i}] 必须是对象（{ timestamp, open, high, low, close, volume }）` }
    }
    const row = item as Record<string, unknown>
    const bar: Partial<KlineBar> = {}
    let missing = ''
    for (const key of ['timestamp', 'open', 'high', 'low', 'close'] as const) {
      const n = toNumber(row[key])
      if (typeof n !== 'number') {
        missing = key
        break
      }
      bar[key] = n
    }
    if (missing) return { ok: false, error: `${label}[${i}] 缺少有效数值字段：${missing}` }
    const volume = toNumber(row.volume)
    bar.volume = typeof volume === 'number' ? volume : 0
    const turnover = toNumber(row.turnover)
    if (typeof turnover === 'number') bar.turnover = turnover
    bars.push(bar as KlineBar)
  }
  // 渲染要求时间升序：乱序输入自动排序（同 timestamp 保持原序）
  bars.sort((a, b) => a.timestamp - b.timestamp)
  return { ok: true, bars }
}

export function parseKlineSpec(source: string): KlineParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(source)
  } catch (err) {
    return { ok: false, error: `JSON 解析失败：${(err as Error).message}` }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: '顶层结构必须是 JSON 对象（如 {"src":"charts/xxx.json","indicators":["MA","VOL"]}）' }
  }
  const obj = raw as Record<string, unknown>

  // src（可选；提供时须为安全工作区相对路径）
  let src: string | undefined
  if (obj.src !== undefined && obj.src !== null) {
    if (typeof obj.src !== 'string' || obj.src.trim() === '') {
      return { ok: false, error: 'src 必须是非空字符串（快照路径，如 charts/sh600519-day-202609181030.json）' }
    }
    src = obj.src.trim()
    if (!isSafeRelPath(src)) {
      return { ok: false, error: `src 必须是会话工作区相对路径（不可使用绝对路径或 ..）：${src}` }
    }
  }

  // data（可选；对象形态为数据集，数组形态为 bars 简写）
  let data: KlineDataset | undefined
  if (obj.data !== undefined && obj.data !== null) {
    if (Array.isArray(obj.data)) {
      const parsed = parseBars(obj.data, 'data')
      if (!parsed.ok) return parsed
      data = { bars: parsed.bars }
    } else if (typeof obj.data === 'object') {
      const row = obj.data as Record<string, unknown>
      const parsed = parseBars(row.bars, 'data.bars')
      if (!parsed.ok) return parsed
      data = {
        bars: parsed.bars,
        ...(typeof row.kind === 'string' ? { kind: row.kind } : {}),
        ...(typeof row.symbol === 'string' ? { symbol: row.symbol } : {}),
        ...(typeof row.name === 'string' ? { name: row.name } : {}),
        ...(typeof row.period === 'string' ? { period: row.period } : {}),
        ...(typeof row.adjust === 'string' ? { adjust: row.adjust } : {}),
      }
    } else {
      return { ok: false, error: 'data 必须是对象（含 bars）或 bars 数组简写' }
    }
  }

  if (!src && !data) {
    return { ok: false, error: '缺少 src（快照路径）或 data（内联数据）：两者至少提供一项' }
  }

  // indicators（缺省 MA+VOL；未知指标显式报错便于模型自我修正）
  let indicators: KlineIndicator[] = [...DEFAULT_KLINE_INDICATORS]
  if (obj.indicators !== undefined && obj.indicators !== null) {
    if (!Array.isArray(obj.indicators)) {
      return { ok: false, error: `indicators 必须是数组（可选：${KLINE_INDICATORS.join(' / ')}）` }
    }
    const out: KlineIndicator[] = []
    for (const name of obj.indicators) {
      const normalized = typeof name === 'string' ? name.trim().toUpperCase() : ''
      if (!(KLINE_INDICATORS as readonly string[]).includes(normalized)) {
        return { ok: false, error: `不支持的指标 "${String(name)}"（可选：${KLINE_INDICATORS.join(' / ')}）` }
      }
      if (!out.includes(normalized as KlineIndicator)) out.push(normalized as KlineIndicator)
    }
    indicators = out.length > 0 ? out : [...DEFAULT_KLINE_INDICATORS]
  }

  // annotations（可选；类型必填，≤20 条与工具护栏一致）
  const annotations: KlineAnnotation[] = []
  if (obj.annotations !== undefined && obj.annotations !== null) {
    if (!Array.isArray(obj.annotations)) {
      return { ok: false, error: 'annotations 必须是数组（[{ "type":"priceLine","price":1500,"label":"压力位" }]）' }
    }
    if (obj.annotations.length > 20) {
      return { ok: false, error: `annotations 最多 20 条（收到 ${obj.annotations.length} 条）` }
    }
    for (let i = 0; i < obj.annotations.length; i++) {
      const item = obj.annotations[i]
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        return { ok: false, error: `annotations[${i}] 必须是对象（{ type, price?, label? }）` }
      }
      const row = item as Record<string, unknown>
      const type = typeof row.type === 'string' ? row.type.trim() : ''
      if (!type) return { ok: false, error: `annotations[${i}].type 必填（如 priceLine）` }
      const price = toNumber(row.price)
      if (price === null || price === undefined) {
        if (row.price !== undefined && row.price !== null) {
          return { ok: false, error: `annotations[${i}].price 必须是数字` }
        }
      }
      const annotation: KlineAnnotation = { type }
      if (typeof price === 'number') annotation.price = price
      if (typeof row.label === 'string' && row.label.trim()) annotation.label = row.label.trim()
      annotations.push(annotation)
    }
  }

  // M83 渲染字段：主图 / 副图（枚举显式校验）+ 阶段开关（类型不符降级）
  // 兼容 render 对象形态：server klineBlockTemplate / 分析快照统一生成 { render: { ... } }（顶层字段优先）
  const renderObj =
    typeof obj.render === 'object' && obj.render !== null && !Array.isArray(obj.render)
      ? (obj.render as Record<string, unknown>)
      : {}
  const rawMainIndicator = obj.mainIndicator ?? renderObj.mainIndicator
  const rawSubIndicator = obj.subIndicator ?? renderObj.subIndicator
  const rawShowPhases = obj.showPhases ?? renderObj.showPhases
  let mainIndicator: MainIndicator | 'none' | undefined
  if (rawMainIndicator !== undefined && rawMainIndicator !== null) {
    const v = typeof rawMainIndicator === 'string' ? rawMainIndicator.trim().toUpperCase() : ''
    if (v !== 'NONE' && !(MAIN_INDICATORS as readonly string[]).includes(v)) {
      return { ok: false, error: `不支持的主图指标 "${String(rawMainIndicator)}"（可选：none / ${MAIN_INDICATORS.join(' / ')}）` }
    }
    mainIndicator = v === 'NONE' ? 'none' : (v as MainIndicator)
  }
  let subIndicator: SubIndicator | 'none' | undefined
  if (rawSubIndicator !== undefined && rawSubIndicator !== null) {
    const v = typeof rawSubIndicator === 'string' ? rawSubIndicator.trim().toUpperCase() : ''
    if (v !== 'NONE' && !(SUB_INDICATORS as readonly string[]).includes(v)) {
      return { ok: false, error: `不支持的副图指标 "${String(rawSubIndicator)}"（可选：none / ${SUB_INDICATORS.join(' / ')}）` }
    }
    subIndicator = v === 'NONE' ? 'none' : (v as SubIndicator)
  }
  const warnings: string[] = []
  let showPhases: boolean | undefined
  if (rawShowPhases !== undefined && rawShowPhases !== null) {
    if (typeof rawShowPhases === 'boolean') showPhases = rawShowPhases
    else warnings.push('showPhases 应为布尔值（已忽略）')
  }

  // M83 增强字段（降级策略：非法丢弃 + warnings，主图不受影响）
  const drawingsParsed = parseDrawings(obj.drawings)
  warnings.push(...drawingsParsed.warnings)
  const signalParsed = parseSignal(obj.signal)
  warnings.push(...signalParsed.warnings)
  const analysisParsed = parseKlineAnalysis(obj.analysis)
  warnings.push(...analysisParsed.warnings)

  const title = typeof obj.title === 'string' && obj.title.trim() ? obj.title.trim() : undefined
  return {
    ok: true,
    spec: {
      ...(src ? { src } : {}),
      ...(data ? { data } : {}),
      indicators,
      annotations,
      ...(title ? { title } : {}),
      ...(mainIndicator !== undefined ? { mainIndicator } : {}),
      ...(subIndicator !== undefined ? { subIndicator } : {}),
      ...(showPhases !== undefined ? { showPhases } : {}),
      drawings: drawingsParsed.value ?? [],
      signal: signalParsed.value ?? null,
      ...(analysisParsed.value ? { analysis: analysisParsed.value } : {}),
      warnings,
    },
  }
}

/** 渲染标题缺省组合：`<名称> <周期>（<复权>）`（数据缺项时优雅降级） */
export function klineDefaultTitle(data: KlineDataset | undefined): string {
  if (!data) return 'K 线'
  const name = data.name || data.symbol || 'K 线'
  const period = data.period ? KLINE_PERIOD_LABELS[data.period] ?? data.period : ''
  const adjust = data.adjust ? KLINE_ADJUST_LABELS[data.adjust] ?? data.adjust : ''
  const head = period ? `${name} ${period}` : name
  return adjust ? `${head}（${adjust}）` : head
}

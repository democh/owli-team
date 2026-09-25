/**
 * 手动划线圈（M83 批 E-1 / M85）：工具注册表 + overlay 映射 + 本地持久化（纯函数层，零 klinecharts 依赖）。
 *
 * - 工具集（9）：线段 / 射线 / 直线 / 水平线 / 垂直线 / 矩形 / 斐波那契 / 文本 / 测量；
 * - 与「分析落图」的分组隔离：手动划线固定 groupId='manual'（entry 层专用清理，不受
 *   applyDrawings 的先清后画影响；分析 / 策略落图组与手动组互不可见地共存）；
 * - 持久化：localStorage `ma:kline-draw:v1:<symbol>:<period>:<adjust>`（无 symbol 的内联块不落盘）；
 *   JSON 形态 `{ v:1, d: ManualDrawing[] }`，读取时全量净化（白名单 / 数值钳制 / 数量上限）；
 * - 坐标系：与 shared Drawing 同口径（毫秒时间戳 + 价格），不做任何日期解析。
 */
import type { KlineDataset } from '../../../lib/kline-spec'
import { OVERLAY_NAMES } from './overlays'

export type ManualTool = 'segment' | 'ray' | 'line' | 'hline' | 'vline' | 'rect' | 'fib' | 'fibExt' | 'pitchfork' | 'text' | 'measure' | 'volProfile'

export interface ManualPoint {
  ts: number
  price: number
}

export interface ManualDrawing {
  id: string
  kind: ManualTool
  points: ManualPoint[]
  color: string
  width: number
  dash: boolean
  /** 矩形 / 测量：是否填充 */
  fill: boolean
  /** 文本工具内容（其余工具忽略） */
  text: string
  locked: boolean
}

/** 工具注册表（points = 落点次数；顺序即工具条顺序；多点工具「依次点击 N 点即完成」（自持绘制，见 entry）；dividerBefore 为工具条分组分隔） */
export const MANUAL_TOOLS: ReadonlyArray<{ key: ManualTool; label: string; points: 1 | 2 | 3; hint: string; dividerBefore?: boolean }> = [
  { key: 'segment', label: '线段', points: 2, hint: '依次点击两点画线段' },
  { key: 'ray', label: '射线', points: 2, hint: '依次点击两点画射线（首点为端点）' },
  { key: 'line', label: '直线', points: 2, hint: '依次点击两点定直线' },
  { key: 'hline', label: '水平线', points: 1, hint: '单击定水平线' },
  { key: 'vline', label: '垂直线', points: 1, hint: '单击定垂直线' },
  { key: 'rect', label: '矩形', points: 2, hint: '依次点击对角两点画矩形', dividerBefore: true },
  { key: 'fib', label: '斐波', points: 2, hint: '依次点击两点画斐波那契回撤' },
  { key: 'fibExt', label: '扩展', points: 3, hint: '依次点击三点画斐波那契扩展（AB 趋势段 + C 回撤点）' },
  { key: 'pitchfork', label: '分叉', points: 3, hint: '依次点击三点画安德鲁分叉线（A→BC 中点 + 平行轨）' },
  { key: 'text', label: '文本', points: 1, hint: '单击落点后在样式栏输入文字', dividerBefore: true },
  { key: 'measure', label: '测量', points: 2, hint: '依次点击两点测量涨跌幅与价差' },
  { key: 'volProfile', label: '量分', points: 2, hint: '依次点击两点看区间成交量分布' },
]

/** 自定义 overlay 工具（需 interactive 变体；归 entry 草图示拼装） */
export const MANUAL_CUSTOM_TOOLS: ReadonlySet<ManualTool> = new Set(['rect', 'text', 'measure', 'fibExt', 'pitchfork', 'volProfile'])

/** 工具 → klinecharts overlay 名（内置 6 + 自定义 3；自定义走交互变体 interactive:true） */
export const OVERLAY_OF_TOOL: Record<ManualTool, string> = {
  segment: 'segment',
  ray: 'rayLine',
  line: 'straightLine',
  hline: 'horizontalStraightLine',
  vline: 'verticalStraightLine',
  rect: OVERLAY_NAMES.rectZone,
  fib: 'fibonacciLine',
  fibExt: OVERLAY_NAMES.fibExtension,
  pitchfork: OVERLAY_NAMES.pitchfork,
  text: OVERLAY_NAMES.textLabel,
  measure: OVERLAY_NAMES.measureBox,
  volProfile: OVERLAY_NAMES.volProfile,
}

/** 色板（首个为缺省） */
export const MANUAL_COLORS: readonly string[] = ['#f59e0b', '#dc2626', '#0ea5e9', '#059669', '#8b5cf6', '#64748b']

/** 手动划线 overlay 组（entry 专用清理；不参与 applyDrawings 的 knownGroups） */
export const MANUAL_GROUP = 'manual'

/** 单图上限（超限拒绝新增，防 localStorage 膨胀） */
export const MANUAL_MAX = 100

export const MANUAL_CHANGED_EVENT = 'ma:kline-draw-changed'

const STORE_PREFIX = 'ma:kline-draw:v1:'
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** 生成划线 id（时间戳 + 随机后缀；无需全局唯一，仅图内唯一） */
export function nextManualId(): string {
  let suffix = ''
  for (let i = 0; i < 4; i++) suffix += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)]
  return `m${Date.now().toString(36)}${suffix}`
}

/** 存储键（无 symbol 返回 undefined → 不启用持久化） */
export function storeKeyOf(dataset: Pick<KlineDataset, 'symbol' | 'period' | 'adjust'>): string | undefined {
  const symbol = dataset.symbol?.trim()
  if (!symbol) return undefined
  return `${STORE_PREFIX}${symbol}:${dataset.period ?? 'day'}:${dataset.adjust ?? 'qfq'}`
}

function isTool(v: unknown): v is ManualTool {
  return typeof v === 'string' && (MANUAL_TOOLS as ReadonlyArray<{ key: string }>).some((t) => t.key === v)
}

/** 读取净化：白名单工具 / 数值点 / 色值正则 / 钳制线宽 / 上限裁剪 */
export function sanitizeManualDrawings(raw: unknown): ManualDrawing[] {
  if (!Array.isArray(raw)) return []
  const out: ManualDrawing[] = []
  for (const item of raw) {
    if (out.length >= MANUAL_MAX) break
    if (typeof item !== 'object' || item === null) continue
    const row = item as Record<string, unknown>
    if (typeof row.id !== 'string' || row.id.trim() === '' || !isTool(row.kind)) continue
    if (!Array.isArray(row.points)) continue
    const points: ManualPoint[] = []
    for (const p of row.points) {
      if (typeof p !== 'object' || p === null) continue
      const pt = p as Record<string, unknown>
      if (typeof pt.ts !== 'number' || !Number.isFinite(pt.ts)) continue
      if (typeof pt.price !== 'number' || !Number.isFinite(pt.price)) continue
      points.push({ ts: pt.ts, price: pt.price })
      if (points.length >= 3) break
    }
    if (points.length === 0) continue
    const width = typeof row.width === 'number' && Number.isFinite(row.width) ? Math.min(4, Math.max(1, Math.round(row.width))) : 1
    const color = typeof row.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(row.color) ? row.color : MANUAL_COLORS[0]
    out.push({
      id: row.id.trim(),
      kind: row.kind,
      points,
      color,
      width,
      dash: row.dash === true,
      fill: row.fill === true,
      text: typeof row.text === 'string' ? row.text.slice(0, 24) : '',
      locked: row.locked === true,
    })
  }
  return out
}

/** 读取（键无效 / 存储不可用 / JSON 破损 → 空表） */
export function loadManualDrawings(key: string | undefined): ManualDrawing[] {
  if (!key) return []
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null) return []
    return sanitizeManualDrawings((parsed as Record<string, unknown>).d)
  } catch {
    return []
  }
}

/** 写入（失败静默——存储满 / 隐私模式不阻断交互；成功后广播同源事件做实例间同步） */
export function saveManualDrawings(key: string | undefined, list: ManualDrawing[]): void {
  if (!key) return
  try {
    window.localStorage.setItem(key, JSON.stringify({ v: 1, d: list }))
    window.dispatchEvent(new CustomEvent(MANUAL_CHANGED_EVENT, { detail: key }))
  } catch {
    /* 忽略：存储不可用不阻断划线 */
  }
}

/** 手动划线 → klinecharts createOverlay 参数（回调 / id / groupId 由 entry 层补） */
export interface ManualOverlayCfg {
  name: string
  points: Array<{ timestamp: number; value: number }>
  styles?: unknown
  extendData?: unknown
  needDefaultPointFigure: boolean
}

export function buildManualOverlay(d: ManualDrawing): ManualOverlayCfg {
  const pts = d.points.map((p) => ({ timestamp: p.ts, value: p.price }))
  const line = { color: d.color, size: d.width, style: d.dash ? 'dashed' : 'solid', dashedValue: [4, 4] }
  const base = { name: OVERLAY_OF_TOOL[d.kind], points: pts, needDefaultPointFigure: true }
  switch (d.kind) {
    case 'segment':
    case 'ray':
    case 'line':
    case 'hline':
    case 'vline':
    case 'fib':
      return { ...base, styles: { line } }
    case 'rect':
      return { ...base, extendData: { color: d.color, fill: d.fill ? `${d.color}26` : 'rgba(0,0,0,0)', dash: d.dash, interactive: true } }
    case 'text':
      return { ...base, extendData: { text: d.text || undefined, color: d.color, dot: true, interactive: true } }
    case 'measure': {
      const a = d.points[0]
      const b = d.points[d.points.length - 1]
      let text: string | undefined
      if (a && b) {
        const delta = b.price - a.price
        const pct = a.price !== 0 ? (delta / a.price) * 100 : 0
        const sign = delta >= 0 ? '+' : ''
        text = `${sign}${pct.toFixed(2)}% · ${sign}${(Math.round(delta * 100) / 100).toFixed(2)}`
      }
      return { ...base, extendData: { color: d.color, fill: d.fill ? `${d.color}1f` : 'rgba(0,0,0,0)', dash: d.dash, interactive: true, ...(text ? { text } : {}) } }
    }
    case 'fibExt':
    case 'pitchfork':
      return { ...base, extendData: { color: d.color, dash: d.dash, width: d.width, interactive: true } }
    case 'volProfile':
      return { ...base, extendData: { color: d.color, interactive: true } }
    default:
      return { ...base, styles: { line } }
  }
}

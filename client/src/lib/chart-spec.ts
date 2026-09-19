/**
 * Chart 配置解析（纯函数，零依赖；可被主包安全静态引用）。
 * ```chart 代码块 → ChartSpec；宽松校验 + 面向用户的中文错误信息。
 * JSON 形状：
 * {
 *   "type": "bar" | "line" | "area" | "pie" | "scatter",   // 缺省 bar
 *   "title": "标题", "unit": "万元",
 *   "labels": ["A", "B"],
 *   "series": [{ "name": "系列1", "data": [1, 2] }],       // 也支持顶层简写 { "name", "data" }
 *   "stack": true, "horizontal": true
 * }
 */

const CHART_KINDS = ['bar', 'line', 'area', 'pie', 'scatter'] as const
export type ChartKind = (typeof CHART_KINDS)[number]

export interface ChartSpec {
  kind: ChartKind
  title?: string
  unit?: string
  labels: string[]
  series: { name: string; data: (number | null)[] }[]
  stack: boolean
  horizontal: boolean
}

export type ParseResult = { ok: true; spec: ChartSpec } | { ok: false; error: string }

function toNumber(v: unknown): number | null | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  if (v === null) return null
  return undefined
}

export function parseChartSpec(source: string): ParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(source)
  } catch (err) {
    return { ok: false, error: `JSON 解析失败：${(err as Error).message}` }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: '顶层结构必须是 JSON 对象（如 {"type":"bar","labels":[...],"series":[...]}）' }
  }
  const obj = raw as Record<string, unknown>

  const typeRaw = typeof obj.type === 'string' ? obj.type.toLowerCase() : 'bar'
  if (!(CHART_KINDS as readonly string[]).includes(typeRaw)) {
    return { ok: false, error: `不支持的图表类型 "${String(obj.type)}"（可选：${CHART_KINDS.join(' / ')}）` }
  }
  const kind = typeRaw as ChartKind

  const rawSeries = obj.series ?? (obj.data !== undefined ? [{ name: obj.name, data: obj.data }] : undefined)
  if (!Array.isArray(rawSeries) || rawSeries.length === 0) {
    return { ok: false, error: '缺少 series 数据（或顶层简写 data）' }
  }

  const labels = Array.isArray(obj.labels) ? obj.labels.map((v) => String(v)) : []

  const series: ChartSpec['series'] = []
  for (let i = 0; i < rawSeries.length; i++) {
    const item = rawSeries[i] as Record<string, unknown> | unknown[] | undefined
    const dataRaw = Array.isArray(item) ? item : (item as Record<string, unknown> | undefined)?.data
    if (!Array.isArray(dataRaw)) {
      return { ok: false, error: `series[${i}].data 必须是数组` }
    }
    const data: (number | null)[] = []
    for (const point of dataRaw) {
      // 支持 [x, y] 点对（scatter 常用）与 {value, name} 形式
      const candidate =
        Array.isArray(point) && point.length >= 2
          ? point[1]
          : typeof point === 'object' && point !== null
            ? (point as Record<string, unknown>).value
            : point
      const n = toNumber(candidate)
      if (n === undefined) return { ok: false, error: `series[${i}] 含非数字数据项：${JSON.stringify(point)}` }
      data.push(n)
    }
    const name =
      (typeof item === 'object' && item !== null && !Array.isArray(item) && typeof item.name === 'string'
        ? item.name
        : '') || `系列 ${i + 1}`
    series.push({ name, data })
  }

  // pie：名称优先取数据项上的 name，其次 labels，最后序号
  if (kind === 'pie') {
    const firstRaw = rawSeries[0]
    const firstData = Array.isArray(firstRaw) ? firstRaw : (firstRaw as Record<string, unknown> | undefined)?.data
    const names = (Array.isArray(firstData) ? firstData : []).map((p, idx) => {
      if (typeof p === 'object' && p !== null && !Array.isArray(p)) {
        const n = (p as Record<string, unknown>).name
        if (typeof n === 'string' && n) return n
      }
      return labels[idx] ?? `第 ${idx + 1} 项`
    })
    labels.length = 0
    labels.push(...names)
  } else if (labels.length === 0) {
    const count = Math.max(...series.map((s) => s.data.length))
    for (let i = 0; i < count; i++) labels.push(String(i + 1))
  }

  return {
    ok: true,
    spec: {
      kind,
      title: typeof obj.title === 'string' && obj.title ? obj.title : undefined,
      unit: typeof obj.unit === 'string' && obj.unit ? obj.unit : undefined,
      labels,
      series: kind === 'pie' ? series.slice(0, 1) : series,
      stack: obj.stack === true,
      horizontal: obj.horizontal === true,
    },
  }
}

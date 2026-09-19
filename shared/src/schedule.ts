/**
 * M35：定时任务内核（纯函数，零依赖）——cron 解析 / 下次触发计算 / 规格校验 / 中文描述。
 *
 * 设计要点：
 * - cron 为 5 段（分 时 日 月 周）：支持 `*` / `n` / `a-b` / `a,b,c` / `* /n` / `a-b/n`；
 *   日与周同时受限时取并集（标准 cron 语义）；周日可用 0 或 7；
 * - 时区经 Intl.DateTimeFormat 做「UTC ↔ 墙钟」换算（不引入 tz 数据库）；搜索在墙钟域内按天步进
 *   （上限约 4 年，覆盖闰日模式），结果再经两次偏移修正落回 UTC 时刻；
 * - DST 空洞（春季跳过的小时）：返回顺延一档的合法时刻；二义时刻（秋季回拨）：取较早那一档；
 * - 服务端与前端共用本模块（触发计算 / 校验 / 描述三处同源，不产生第二份实现）。
 */
import type { ScheduleSpec } from './types.js'

// ---------- cron 解析 ----------

/** 解析后的 cron 字段（取值已排序去重） */
export interface CronFields {
  minute: number[]
  hour: number[]
  dom: number[]
  month: number[]
  dow: number[]
  /** 原始字段非 `*`（标准 cron 语义：日与周同时受限时取并集） */
  domRestricted: boolean
  dowRestricted: boolean
}

export type CronParseResult = { ok: true; fields: CronFields } | { ok: false; error: string }

const CRON_RANGES: Array<{ name: string; min: number; max: number }> = [
  { name: '分', min: 0, max: 59 },
  { name: '时', min: 0, max: 23 },
  { name: '日', min: 1, max: 31 },
  { name: '月', min: 1, max: 12 },
  { name: '周', min: 0, max: 7 },
]

/** 单字段解析：`*` / `* /n` / `n` / `a-b` / `a-b/n` / 逗号列表；返回排序去重数组或错误信息（注：写 * /n 时中间隔空格以避免提前终止本注释） */
function parseField(raw: string, name: string, min: number, max: number): { ok: true; values: number[] } | { ok: false; error: string } {
  const values = new Set<number>()
  for (const part of raw.split(',')) {
    const token = part.trim()
    if (token === '') return { ok: false, error: `cron ${name} 字段包含空项` }
    let step = 1
    let body = token
    const slash = token.indexOf('/')
    if (slash >= 0) {
      body = token.slice(0, slash)
      const stepRaw = token.slice(slash + 1)
      if (!/^\d+$/.test(stepRaw) || Number(stepRaw) === 0) {
        return { ok: false, error: `cron ${name} 字段步长非法：「${token}」（需为正整数）` }
      }
      step = Number(stepRaw)
    }
    let lo: number
    let hi: number
    if (body === '*') {
      lo = min
      hi = max
    } else if (/^\d+$/.test(body)) {
      lo = Number(body)
      // `n` 带步长（如 5/10）按「n 至区间上界」展开（宽松兼容；纯 n 时 hi=lo）
      hi = slash >= 0 ? max : Number(body)
    } else {
      const range = /^(\d+)-(\d+)$/.exec(body)
      if (!range) return { ok: false, error: `cron ${name} 字段非法：「${token}」（支持 * / n / a-b / a-b/n）` }
      lo = Number(range[1])
      hi = Number(range[2])
    }
    if (lo < min || hi > max || lo > hi) {
      return { ok: false, error: `cron ${name} 字段越界：「${token}」（合法范围 ${min}-${max}）` }
    }
    for (let v = lo; v <= hi; v += step) values.add(v)
  }
  if (values.size === 0) return { ok: false, error: `cron ${name} 字段为空` }
  return { ok: true, values: [...values].sort((a, b) => a - b) }
}

/** 解析 5 段 cron 表达式（分 时 日 月 周） */
export function parseCron(expr: string): CronParseResult {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) {
    return { ok: false, error: `cron 表达式需 5 段（分 时 日 月 周），收到 ${parts.length} 段：「${expr}」` }
  }
  const parsed: number[][] = []
  for (let i = 0; i < 5; i++) {
    const range = CRON_RANGES[i]
    const result = parseField(parts[i], range.name, range.min, range.max)
    if (!result.ok) return result
    parsed.push(result.values)
  }
  // 周日归一：7 → 0
  const dow = [...new Set(parsed[4].map((v) => (v === 7 ? 0 : v)))].sort((a, b) => a - b)
  return {
    ok: true,
    fields: {
      minute: parsed[0],
      hour: parsed[1],
      dom: parsed[2],
      month: parsed[3],
      dow,
      domRestricted: parts[2].trim() !== '*',
      dowRestricted: parts[4].trim() !== '*',
    },
  }
}

// ---------- 时区换算（Intl，零依赖） ----------

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function tzFormatter(tz: string): Intl.DateTimeFormat | undefined {
  const cached = formatterCache.get(tz)
  if (cached) return cached
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatterCache.set(tz, dtf)
    return dtf
  } catch {
    return undefined
  }
}

/** 时区是否合法（IANA 名，可由 Intl 识别） */
export function isValidTimezone(tz: string): boolean {
  return tzFormatter(tz) !== undefined
}

/** 服务器 / 浏览器默认时区（Intl 识别失败时回退 UTC） */
export function serverTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

interface WallClock {
  y: number
  mo: number
  d: number
  hh: number
  mm: number
  ss: number
}

function wallClockOf(instant: Date, dtf: Intl.DateTimeFormat): WallClock {
  const parts = dtf.formatToParts(instant)
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return { y: get('year'), mo: get('month'), d: get('day'), hh: get('hour'), mm: get('minute'), ss: get('second') }
}

/** 指定 UTC 瞬时在 tz 的时区偏移（毫秒；调用方保证 instantMs 对齐到秒） */
function tzOffsetMs(instantMs: number, dtf: Intl.DateTimeFormat): number {
  const wc = wallClockOf(new Date(instantMs), dtf)
  const asUtc = Date.UTC(wc.y, wc.mo - 1, wc.d, wc.hh, wc.mm, wc.ss)
  return asUtc - instantMs
}

/** 墙钟 → UTC 瞬时（双步偏移修正 + 自洽验证）
 *  - 普通时刻：首步即自洽；
 *  - 秋令二义（墙钟出现两次）：取较早那一档；
 *  - 春令空洞（墙钟不存在）：返回顺延一档的合法时刻（Temporal compatible 语义）。
 */
function fromWallClock(y: number, mo: number, d: number, hh: number, mm: number, dtf: Intl.DateTimeFormat): Date {
  const asUtc = Date.UTC(y, mo - 1, d, hh, mm)
  const off1 = tzOffsetMs(asUtc, dtf)
  const inst1 = asUtc - off1
  const off2 = tzOffsetMs(inst1, dtf)
  if (off2 === off1) return new Date(inst1)
  const inst2 = asUtc - off2
  const off3 = tzOffsetMs(inst2, dtf)
  if (off3 === off2) return new Date(inst2)
  // 两个候选都不自洽：请求墙钟落在 DST 空洞，返回顺延解
  return new Date(inst1)
}

/** 日历日期的星期（0=周日；与 tz 无关，按日历日计算） */
function utcDow(y: number, mo: number, d: number): number {
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay()
}

function daysInMonth(y: number, mo: number): number {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate()
}

// ---------- 下次触发计算 ----------

/** 搜索上限（天）：约 4 年，覆盖「2 月 29 日」闰日模式 */
const MAX_SEARCH_DAYS = 1466

/** 日字段匹配（日与周同时受限 → 并集） */
function dayMatches(fields: CronFields, dom: number, dow: number): boolean {
  const domOk = fields.dom.includes(dom)
  const dowOk = fields.dow.includes(dow)
  if (fields.domRestricted && fields.dowRestricted) return domOk || dowOk
  if (fields.domRestricted) return domOk
  if (fields.dowRestricted) return dowOk
  return true
}

/** 下一次 cron 触发时刻（严格晚于 from；无解 / 时区非法返回 null） */
export function nextCronAt(fields: CronFields, from: Date, tz: string): Date | null {
  const dtf = tzFormatter(tz)
  if (!dtf) return null
  const wc = wallClockOf(from, dtf)
  let y = wc.y
  let mo = wc.mo
  let d = wc.d
  let hh = wc.hh
  let mm = wc.mm
  // 候选起点 = 墙钟下一分钟
  mm += 1
  if (mm >= 60) {
    mm = 0
    hh += 1
  }
  if (hh >= 24) {
    hh = 0
    d += 1
  }
  if (d > daysInMonth(y, mo)) {
    d = 1
    mo += 1
  }
  if (mo > 12) {
    mo = 1
    y += 1
  }

  for (let step = 0; step <= MAX_SEARCH_DAYS; step++) {
    if (fields.month.includes(mo) && dayMatches(fields, d, utcDow(y, mo, d))) {
      for (const h of fields.hour) {
        if (step === 0 && h < hh) continue
        for (const min of fields.minute) {
          if (step === 0 && h === hh && min < mm) continue
          const inst = fromWallClock(y, mo, d, h, min, dtf)
          if (inst.getTime() > from.getTime()) return inst
        }
      }
    }
    d += 1
    if (d > daysInMonth(y, mo)) {
      d = 1
      mo += 1
      if (mo > 12) {
        mo = 1
        y += 1
      }
    }
    hh = 0
    mm = 0
  }
  return null
}

/** 规格的时区（显式 tz 优先，缺省回退默认时区） */
export function resolveScheduleTimezone(spec: ScheduleSpec, defaultTz: string): string {
  const explicit = spec.tz?.trim()
  return explicit && explicit.length > 0 ? explicit : defaultTz
}

/** 下一次触发时刻（once 返回其时刻；cron 严格晚于 from；非法返回 null） */
export function nextScheduleAt(spec: ScheduleSpec, from: Date, defaultTz: string): Date | null {
  if (spec.kind === 'once') {
    if (!spec.at) return null
    const t = new Date(spec.at)
    return Number.isNaN(t.getTime()) ? null : t
  }
  if (!spec.expr) return null
  const parsed = parseCron(spec.expr)
  if (!parsed.ok) return null
  return nextCronAt(parsed.fields, from, resolveScheduleTimezone(spec, defaultTz))
}

// ---------- 规格校验 ----------

export interface ScheduleSpecValidation {
  ok: boolean
  error?: string
  /** 计算出的下次触发时刻（ok=true 时必在） */
  next?: Date
  /** 归一化后的时区（ok=true 时必在） */
  timezone?: string
}

/**
 * 校验调度规格：非法时区 / 非法表达式 / 过去时刻 / 高频护栏（连续两次间隔 ≥ minGapMs）。
 * 服务端创建 / 更新 / 恢复（resume）与前端表单预检共用。
 */
export function validateScheduleSpec(
  spec: ScheduleSpec,
  opts: { defaultTz: string; minGapMs: number; now?: Date },
): ScheduleSpecValidation {
  const now = opts.now ?? new Date()
  const timezone = resolveScheduleTimezone(spec, opts.defaultTz)
  if (!isValidTimezone(timezone)) {
    return { ok: false, error: `时区「${timezone}」非法（需 IANA 时区名，如 Asia/Shanghai）` }
  }
  if (spec.kind === 'once') {
    if (!spec.at) return { ok: false, error: '一次性任务缺少触发时刻（at）' }
    const t = new Date(spec.at)
    if (Number.isNaN(t.getTime())) return { ok: false, error: `触发时刻非法：${spec.at}` }
    if (t.getTime() <= now.getTime() + 60_000) {
      return { ok: false, error: '一次性任务的触发时刻必须是未来时间（至少 1 分钟后）' }
    }
    return { ok: true, next: t, timezone }
  }
  if (!spec.expr) return { ok: false, error: '循环任务缺少 cron 表达式（expr）' }
  const parsed = parseCron(spec.expr)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  const next = nextCronAt(parsed.fields, now, timezone)
  if (!next) return { ok: false, error: '表达式在未来约 4 年内无触发时刻（请检查月份 / 日期组合）' }
  const following = nextCronAt(parsed.fields, next, timezone)
  if (following) {
    const gap = following.getTime() - next.getTime()
    if (gap < opts.minGapMs) {
      const gapMin = Math.round(gap / 60_000)
      const minGapMin = Math.max(1, Math.round(opts.minGapMs / 60_000))
      return { ok: false, error: `触发间隔 ${gapMin} 分钟小于下限 ${minGapMin} 分钟（防高频失控）` }
    }
  }
  return { ok: true, next, timezone }
}

// ---------- 中文描述 ----------

const WEEK_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** 绝对时刻的墙钟文本（YYYY-MM-DD HH:mm，按 tz 渲染） */
export function formatWallTime(instant: Date, tz: string): string {
  const dtf = tzFormatter(tz)
  if (!dtf) return instant.toISOString()
  const wc = wallClockOf(instant, dtf)
  return `${wc.y}-${pad2(wc.mo)}-${pad2(wc.d)} ${pad2(wc.hh)}:${pad2(wc.mm)}`
}

/** 规则的中文描述（工具回灌 / 通知文案 / 前端展示共用）：如「每天 09:00」「每 30 分钟」 */
export function describeScheduleSpec(spec: ScheduleSpec, opts: { tz?: string } = {}): string {
  const tz = opts.tz ?? spec.tz ?? serverTimezone()
  if (spec.kind === 'once') {
    if (!spec.at) return '一次性（时刻缺失）'
    const t = new Date(spec.at)
    if (Number.isNaN(t.getTime())) return `一次性 ${spec.at}`
    return `一次性 ${formatWallTime(t, isValidTimezone(tz) ? tz : serverTimezone())}`
  }
  const expr = (spec.expr ?? '').trim()
  const parts = expr.split(/\s+/)
  if (parts.length !== 5) return `cron「${expr}」`
  const [mi, ho, dom, mon, dow] = parts
  const single = (s: string): boolean => /^\d+$/.test(s)
  const all = (s: string): boolean => s === '*'
  const hm = (m: string, h: string): string => `${pad2(Number(h))}:${pad2(Number(m))}`
  if (all(mi) && all(ho) && all(dom) && all(mon) && all(dow)) return '每分钟'
  const everyN = (s: string): number | undefined => {
    const m = /^\*\/(\d+)$/.exec(s)
    return m ? Number(m[1]) : undefined
  }
  const miStep = everyN(mi)
  if (miStep !== undefined && all(ho) && all(dom) && all(mon) && all(dow)) return `每 ${miStep} 分钟`
  if (single(mi) && all(ho) && all(dom) && all(mon) && all(dow)) return `每小时第 ${Number(mi)} 分`
  const hoStep = everyN(ho)
  if (mi === '0' && hoStep !== undefined && all(dom) && all(mon) && all(dow)) return `每 ${hoStep} 小时`
  if (single(mi) && single(ho) && all(dom) && all(mon) && dow === '1-5') return `工作日 ${hm(mi, ho)}`
  if (single(mi) && single(ho) && all(dom) && all(mon) && single(dow)) {
    return `每${WEEK_NAMES[Number(dow) % 7]} ${hm(mi, ho)}`
  }
  if (single(mi) && single(ho) && all(dom) && all(mon) && all(dow)) return `每天 ${hm(mi, ho)}`
  if (single(mi) && single(ho) && single(dom) && all(mon) && all(dow)) return `每月 ${Number(dom)} 日 ${hm(mi, ho)}`
  return `cron「${expr}」`
}

/**
 * 金融工具共享助手（M34 §5 工具集契约）。
 *
 * - `financeGuard`：FINANCE_ENABLED=false / 未装配网关时的统一「未启用」提示；
 * - `resolveFinSymbol`：主数据（SymbolMaster 适配）+ parseSymbol 归一 + 失败候选提示；
 * - 数值格式化（金额亿/万、百分比、北京时区时间）与消息块模板（kline / game）；
 * - `approveWrite`：写操作审批门（fin_watch / fin_env install；拒绝 / 超时 / 取消三态区分）。
 */
import type { ApprovalOutcome } from '../approval.js'
import type { FinanceGateway } from '../finance/gateway.js'
import { formatCnDate, formatCnDateTime } from '../finance/period.js'
import { parseSymbol, type AssetType, type FinSymbol, type SymbolMaster, type SymbolMasterRow } from '../finance/symbol.js'
import { toolAbortError, type ToolResult, type ToolRuntime } from './registry.js'

export const FINANCE_DISABLED_SUMMARY =
  '金融数据未启用（FINANCE_ENABLED=false 或网关未装配）：请在 .env 设置 FINANCE_ENABLED=true 后重启服务'

export type FinanceGuard = { ok: true; gateway: FinanceGateway } | { ok: false; result: ToolResult }

/** 运行期网关守卫（工具首行调用；缺省 = 未启用提示，不抛错） */
export function financeGuard(ctx: ToolRuntime): FinanceGuard {
  if (!ctx.finance) return { ok: false, result: { ok: false, summary: FINANCE_DISABLED_SUMMARY } }
  return { ok: true, gateway: ctx.finance }
}

/** 资产类型中文标签（工具展示与摘要共用） */
export const TYPE_LABELS: Record<AssetType, string> = {
  stock: '股票',
  etf: 'ETF',
  fund: '场外基金',
  index: '指数',
}

/** 场内优先的品种排序（同名代码消歧：股票 / ETF 优先于指数 / 场外基金） */
const TYPE_RANK: Record<AssetType, number> = { stock: 0, etf: 1, index: 2, fund: 3 }

/** 主数据行 → SymbolMaster 适配（byCode 场内优先；search 打分：代码精确 > 前缀 > 名称精确 > 名称包含） */
export function buildMaster(rows: SymbolMasterRow[]): SymbolMaster {
  const byCodeAll = new Map<string, SymbolMasterRow[]>()
  for (const row of rows) {
    const list = byCodeAll.get(row.code)
    if (list) list.push(row)
    else byCodeAll.set(row.code, [row])
  }
  for (const list of byCodeAll.values()) list.sort((a, b) => TYPE_RANK[a.type] - TYPE_RANK[b.type])
  return {
    byCode(code, type) {
      const list = byCodeAll.get(code)
      if (!list || list.length === 0) return undefined
      if (type) return list.find((row) => row.type === type)
      return list[0]
    },
    search(query, limit = 8) {
      const q = query.trim()
      if (!q) return []
      const scored: Array<{ row: SymbolMasterRow; score: number }> = []
      for (const row of rows) {
        let score = -1
        if (row.code === q) score = 0
        else if (row.code.startsWith(q)) score = 1
        else if (row.name === q) score = 2
        else if (row.name.includes(q)) score = 3
        else if (row.code.includes(q)) score = 4
        if (score >= 0) scored.push({ row, score })
      }
      scored.sort((a, b) => a.score - b.score || a.row.code.localeCompare(b.row.code))
      return scored.slice(0, limit).map((s) => s.row)
    },
  }
}

/** 主数据加载（失败返回 undefined：离线 / 源不可用时走内置兜底，不阻断工具） */
export async function loadMaster(gateway: FinanceGateway): Promise<SymbolMaster | undefined> {
  try {
    const res = await gateway.symbolMaster()
    return buildMaster(res.data)
  } catch {
    return undefined
  }
}

export type SymbolResolve = { ok: true; symbol: FinSymbol } | { ok: false; result: ToolResult }

/** 归一化标的（主数据优先；失败附在线候选检索，便于模型自我修正） */
export async function resolveFinSymbol(
  gateway: FinanceGateway,
  raw: string,
  opts: { type?: AssetType } = {},
): Promise<SymbolResolve> {
  const master = await loadMaster(gateway)
  const parsed = parseSymbol(raw, { ...opts, master })
  if (!parsed.ok) {
    let detail: string | undefined
    try {
      const found = await gateway.search(raw, { limit: 5 })
      if (found.data.length > 0) {
        detail = `候选：${found.data
          .map((row) => `${row.name}（${row.exchange ?? ''}${row.code}｜${TYPE_LABELS[row.type]}）`)
          .join('、')}`
      }
    } catch {
      // 检索失败不影响错误返回
    }
    return { ok: false, result: { ok: false, summary: parsed.error, ...(detail ? { detail } : {}) } }
  }
  const symbol = parsed.symbol
  if (!symbol.name) {
    try {
      const found = await gateway.search(symbol.code, { limit: 5 })
      const hit = found.data.find((row) => row.code === symbol.code)
      if (hit) symbol.name = hit.name
    } catch {
      // 名称补全失败：保持代码展示
    }
  }
  return { ok: true, symbol }
}

// ---------------------------------------------------------------- 格式化（工具回灌文本）

/** 数值（千分位 + 固定小数；缺省 —） */
export function fmtNum(value: number | undefined | null, digits = 2): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—'
  return value.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

/** 百分比（+2.35% / -1.20%；入参已是百分数） */
export function fmtPct(value: number | undefined | null, digits = 2): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—'
  const text = value.toFixed(digits)
  return value > 0 ? `+${text}%` : `${text}%`
}

/** 金额人话（元 → 亿 / 万） */
export function fmtAmount(value: number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  if (abs >= 1e8) return `${(value / 1e8).toFixed(2)} 亿`
  if (abs >= 1e4) return `${(value / 1e4).toFixed(2)} 万`
  return value.toFixed(2)
}

/** 成交量（手 → 万手 / 手） */
export function fmtVolume(value: number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—'
  return Math.abs(value) >= 1e4 ? `${(value / 1e4).toFixed(2)} 万手` : `${value.toFixed(0)} 手`
}

/** ISO 时间 → 北京时间文本（解析失败原样返回） */
export function fmtAsOf(iso: string): string {
  const ts = Date.parse(iso)
  return Number.isFinite(ts) ? `${formatCnDateTime(ts)}（北京时间）` : iso
}

/** K 线 bar 时间戳 → 北京日期 */
export function fmtBarTime(ts: number): string {
  return formatCnDate(ts)
}

/** Markdown 表格（首行表头 + 分隔行；单元格内容含 `|` 时替换为 `\|`） */
export function mdTable(header: string[], rows: string[][]): string {
  const escape = (cell: string): string => cell.replace(/\|/g, '\\|')
  const lines = [`| ${header.map(escape).join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`]
  for (const row of rows) lines.push(`| ${row.map(escape).join(' | ')} |`)
  return lines.join('\n')
}

/** 错误文本（工具 catch 分支统一用） */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 溯源行（数据附录纪律：来源 / asOf / 缓存 / 降级说明） */
export function sourceLine(input: { source: string; asOf: string; cache?: string; degraded?: string }): string {
  const parts = [`来源 ${input.source}`, `asOf ${fmtAsOf(input.asOf)}`]
  if (input.cache) parts.push(`cache ${input.cache}`)
  if (input.degraded) parts.push(`降级：${input.degraded}`)
  return parts.join('｜')
}

// ---------------------------------------------------------------- 消息块模板

/** kline 消息块模板（模型复制到回复；src 为会话工作区相对路径） */
export function klineBlockTemplate(title: string, src: string, indicators: string[]): string {
  const body = JSON.stringify({ src, indicators })
  return ['```kline title="' + title + '"', body, '```'].join('\n')
}

/** game 消息块模板（模型复制到回复；model 供渲染内核选视图） */
export function gameBlockTemplate(title: string, src: string, model: string): string {
  const body = JSON.stringify({ src, model })
  return ['```game title="' + title + '"', body, '```'].join('\n')
}

// ---------------------------------------------------------------- 审批门 / 中断

export type WriteApproval = { ok: true; feedback?: string } | { ok: false; result: ToolResult }

/** 写操作审批门（拒绝 / 超时 / 取消三态区分；审批通道缺省 = 阻止写操作——安全默认） */
export async function approveWrite(
  ctx: ToolRuntime,
  action: string,
  detail: string,
  options?: string[],
): Promise<WriteApproval> {
  if (!ctx.requestApproval) {
    return {
      ok: false,
      result: { ok: false, summary: '审批通道未启用：写操作已阻止（安全默认；需在支持审批的运行环境中执行）' },
    }
  }
  const outcome: ApprovalOutcome = await ctx.requestApproval(action, detail, options)
  if (outcome.decision === 'approve' || outcome.decision === 'custom') {
    return { ok: true, ...(outcome.feedback ? { feedback: outcome.feedback } : {}) }
  }
  if (outcome.cancelled) {
    return { ok: false, result: { ok: false, summary: '审批已取消（运行停止），操作未执行' } }
  }
  if (outcome.timedOut) {
    return { ok: false, result: { ok: false, summary: '等待用户批准超时（视为拒绝），操作未执行' } }
  }
  return { ok: false, result: { ok: false, summary: `用户未批准：${outcome.feedback ?? '（未给出原因）'}` } }
}

/** 写盘前中断检查（快照写入等副作用前调用；中断时抛 AbortError 由工具护栏识别） */
export function throwIfAborted(ctx: ToolRuntime): void {
  if (ctx.signal?.aborted) throw toolAbortError()
}

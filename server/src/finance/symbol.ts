/**
 * 金融符号模型（M34 §4）：多源输入 → FinSymbol 归一化。
 *
 * 支持的输入形态：
 *   - 纯 6 位代码：600519 / 000001 / 159915（前缀推断板块；歧义段交给主数据/显式 type）
 *   - 带交易所前缀：sh600519 / SZ159915 / bj430047
 *   - 后缀形态：600519.SH / 000001.SZ / 600519.SS
 *   - 东财 secid：1.600519（沪）/ 0.000001（深/北）
 *   - 名称 / 拼音首字母：贵州茅台 / gzmt（需主数据；离线时内置常见指数名兜底）
 *
 * 消歧原则：主数据（证券列表）优先于前缀推断；显式 type 优先于推断；
 * 000/001 段默认按深市股票解释（平安银行），指数/场外基金需显式 type 或主数据命中。
 */

export type AssetType = 'stock' | 'etf' | 'fund' | 'index'
export type Exchange = 'sh' | 'sz' | 'bj'

export interface FinSymbol {
  type: AssetType
  /** 归一化代码：6 位数字 */
  code: string
  /** 交易所（场外基金无） */
  exchange?: Exchange
  /** 展示规范：sh600519 / sz159915 / 159915(深ETF) / 000001(场外基金) */
  symbol: string
  name?: string
  /** 东财 secid：1.600519 / 0.000001 */
  secid?: string
}

/** 主数据行（证券列表；gateway 惰性拉取并缓存） */
export interface SymbolMasterRow {
  code: string
  name: string
  type: AssetType
  exchange?: Exchange
}

/** 主数据查询接口（由 gateway 注入实现；symbol 模块自身零网络）
 *  约定：无 type 时返回最佳匹配（同名多品种时场内优先于场外基金）；无命中返回 undefined */
export interface SymbolMaster {
  byCode(code: string, type?: AssetType): SymbolMasterRow | undefined
  search(query: string, limit?: number): SymbolMasterRow[]
}

export type SymbolParseResult = { ok: true; symbol: FinSymbol } | { ok: false; error: string }

const CODE_RE = /^\d{6}$/

/** 场内指数内置表（离线兜底；在线时主数据优先） */
const BUILTIN_INDEX: Record<string, { exchange: Exchange; name: string }> = {
  '000001': { exchange: 'sh', name: '上证指数' },
  '000016': { exchange: 'sh', name: '上证50' },
  '000300': { exchange: 'sh', name: '沪深300' },
  '000688': { exchange: 'sh', name: '科创50' },
  '000852': { exchange: 'sh', name: '中证1000' },
  '000905': { exchange: 'sh', name: '中证500' },
  '399001': { exchange: 'sz', name: '深证成指' },
  '399005': { exchange: 'sz', name: '中小100' },
  '399006': { exchange: 'sz', name: '创业板指' },
  '399300': { exchange: 'sz', name: '沪深300(深)' },
  '899050': { exchange: 'bj', name: '北证50' },
}

/** 名称 → 内置指数（含常用别名） */
const BUILTIN_INDEX_NAMES: Record<string, string> = {
  上证指数: '000001',
  上证综指: '000001',
  上证50: '000016',
  沪深300: '000300',
  中证500: '000905',
  中证1000: '000852',
  科创50: '000688',
  深证成指: '399001',
  中小100: '399005',
  创业板指: '399006',
  北证50: '899050',
}

/** 前缀 → 资产类型（歧义段 000/001 按深市股票；399 为深证指数） */
export function inferAssetType(code: string): AssetType | undefined {
  if (!CODE_RE.test(code)) return undefined
  if (/^399/.test(code)) return 'index' // 深证指数
  if (/^(600|601|603|605|688|689)/.test(code)) return 'stock' // 沪主板 / 科创
  if (/^(000|001|002|003|300|301|302)/.test(code)) return 'stock' // 深主板 / 创业
  if (/^(43|83|87|88|92)/.test(code)) return 'stock' // 北交所
  if (/^(51|56|58)/.test(code)) return 'etf' // 沪 ETF（510-518 / 560-563 / 588-589）
  if (/^159/.test(code)) return 'etf' // 深 ETF
  if (/^16/.test(code)) return 'etf' // 深 LOF
  return undefined
}

/** 交易所推断（type 已知时） */
export function inferExchange(code: string, type: AssetType): Exchange | undefined {
  if (!CODE_RE.test(code)) return undefined
  if (type === 'fund') return undefined // 场外基金无交易所
  if (type === 'index') {
    if (/^399/.test(code)) return 'sz'
    if (/^000/.test(code)) return 'sh'
    if (/^899/.test(code)) return 'bj'
    return undefined
  }
  if (/^(60|68|90|51|56|58)/.test(code)) return 'sh'
  if (/^(00|30|20|15|16|39)/.test(code)) return 'sz'
  if (/^(43|83|87|88|92|899)/.test(code)) return 'bj'
  return undefined
}

/** 东财 secid（1=沪，0=深/北） */
export function toSecid(exchange: Exchange | undefined, code: string): string | undefined {
  if (!exchange) return undefined
  return `${exchange === 'sh' ? '1' : '0'}.${code}`
}

export function fromSecid(secid: string): { exchange?: Exchange; code: string } | undefined {
  const m = /^([01])\.(\d{6})$/.exec(secid.trim())
  if (!m) return undefined
  return { exchange: m[1] === '1' ? 'sh' : 'sz', code: m[2] }
}

/** 展示规范（symbol 字段） */
export function formatSymbol(input: { type: AssetType; code: string; exchange?: Exchange }): string {
  if (input.type === 'fund' && !input.exchange) return input.code
  return `${input.exchange ?? ''}${input.code}`
}

/** 组装 FinSymbol（统一出口：symbol / secid 派生一致） */
export function buildFinSymbol(
  row: { code: string; name?: string; type: AssetType; exchange?: Exchange },
  name?: string,
): FinSymbol {
  const exchange = row.exchange ?? inferExchange(row.code, row.type)
  return {
    type: row.type,
    code: row.code,
    exchange,
    symbol: formatSymbol({ type: row.type, code: row.code, exchange }),
    name: name ?? row.name,
    secid: toSecid(exchange, row.code),
  }
}

function ok(symbol: FinSymbol): SymbolParseResult {
  return { ok: true, symbol }
}

function fail(raw: string): SymbolParseResult {
  return {
    ok: false,
    error: `无法识别标的「${raw}」：请使用 6 位代码（600519 / sh600519）或先用 fin_search 检索名称`,
  }
}

/** 带显式 type 的代码归一（含内置指数与场外基金） */
function fromCode(code: string, type: AssetType, name?: string): SymbolParseResult {
  if (!CODE_RE.test(code)) return { ok: false, error: `代码「${code}」应为 6 位数字` }
  if (type === 'index') {
    const builtin = BUILTIN_INDEX[code]
    const exchange = builtin?.exchange ?? inferExchange(code, 'index')
    if (!exchange) return { ok: false, error: `指数代码「${code}」无法判定交易所（支持 000xxx 沪 / 399xxx 深 / 899xxx 北）` }
    return ok(buildFinSymbol({ code, name: name ?? builtin?.name ?? '', type: 'index', exchange }))
  }
  if (type === 'fund') {
    return ok(buildFinSymbol({ code, name: name ?? '', type: 'fund' }))
  }
  const exchange = inferExchange(code, type)
  if (!exchange) return { ok: false, error: `代码「${code}」无法判定交易所（请检查代码或改用 fin_search）` }
  return ok(buildFinSymbol({ code, name: name ?? '', type, exchange }))
}

/**
 * 归一化入口。
 * opts.type：用户/工具显式声明的资产类型（优先级最高，其次主数据，最后前缀推断）。
 * opts.master：证券主数据（在线缓存）；缺省时离线兜底（内置指数表 + 前缀推断）。
 */
export function parseSymbol(raw: string, opts: { type?: AssetType; master?: SymbolMaster } = {}): SymbolParseResult {
  const input = raw.trim()
  if (!input) return { ok: false, error: '标的不能为空' }

  // 1) 交易所前缀：sh600519 / SZ159915 / bj430047
  let m = /^(sh|sz|bj)\s*(\d{6})$/i.exec(input)
  if (m) {
    const exchange = m[1].toLowerCase() as Exchange
    const code = m[2]
    const type = opts.type ?? inferAssetType(code) ?? 'stock'
    if (type === 'fund') return fromCode(code, 'fund')
    return ok(buildFinSymbol({ code, type, exchange }))
  }

  // 2) 后缀形态：600519.SH / 000001.SZ / 600519.SS（SS = 上交所）
  m = /^(\d{6})\.(sh|sz|bj|ss)$/i.exec(input)
  if (m) {
    const code = m[1]
    const rawEx = m[2].toLowerCase()
    const exchange: Exchange = rawEx === 'ss' ? 'sh' : (rawEx as Exchange)
    const type = opts.type ?? inferAssetType(code) ?? 'stock'
    if (type === 'fund') return fromCode(code, 'fund')
    return ok(buildFinSymbol({ code, type, exchange }))
  }

  // 3) 东财 secid：1.600519 / 0.000001
  m = /^([01])\.(\d{6})$/.exec(input)
  if (m) {
    const code = m[2]
    const exchange: Exchange = m[1] === '1' ? 'sh' : 'sz'
    const type = opts.type ?? inferAssetType(code) ?? 'stock'
    // 0.xxxxxx 段若为北交所代码，纠正交易所
    const ex = type === 'stock' && /^(43|83|87|88|92)/.test(code) ? 'bj' : exchange
    return ok(buildFinSymbol({ code, type, exchange: ex }))
  }

  // 4) 纯 6 位数字
  if (CODE_RE.test(input)) {
    // 主数据优先（消歧：000001 = 平安银行 vs 上证指数 vs 场外基金）
    const hit = opts.master?.byCode(input, opts.type)
    if (hit) return ok(buildFinSymbol(hit))
    if (opts.type) return fromCode(input, opts.type)
    const type = inferAssetType(input)
    if (!type) {
      return {
        ok: false,
        error: `代码「${input}」无法确定品种：请指定 type（stock/etf/fund/index）或先用 fin_search 检索`,
      }
    }
    return fromCode(input, type)
  }

  // 5) 名称 / 拼音（主数据）
  if (opts.master) {
    const rows = opts.master.search(input, 8)
    if (rows.length === 1) return ok(buildFinSymbol(rows[0]))
    if (rows.length > 1) {
      const top = rows.slice(0, 5).map((r) => `${r.name}（${formatSymbol(r)}）`).join('、')
      return { ok: false, error: `「${raw}」命中多个标的：${top}……请使用完整代码指定` }
    }
  }

  // 6) 内置指数名称兜底（离线可用）
  const builtinCode = BUILTIN_INDEX_NAMES[input]
  if (builtinCode) return fromCode(builtinCode, 'index')

  return fail(raw)
}

/** 资产类型白名单（tuple 常量：zod enum / 路由参数校验直接复用） */
export const ASSET_TYPES = ['stock', 'etf', 'fund', 'index'] as const satisfies readonly AssetType[]

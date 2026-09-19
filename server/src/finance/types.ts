/**
 * 金融数据模型（M34）：源适配器 / 网关 / 工具层共用的类型契约。
 *
 * 单位约定（与各源原始口径对齐后统一）：
 *   - volume：手；turnover：元；marketCap / floatMarketCap：元；
 *   - changePct / turnoverRate：百分比数值（如 2.35 表示 +2.35%）；
 *   - timestamp：毫秒时间戳；asOf：ISO8601（数据时间或最近可得时间，带时区）。
 */

import type { Adjust, Period } from './period.js'
import type { AssetType, Exchange } from './symbol.js'

export type { Adjust, Period }

export interface Quote {
  /** 归一 symbol（sh600519 / sz159915 / 000001 场外） */
  symbol: string
  code: string
  name: string
  price: number
  prevClose: number
  open: number
  high: number
  low: number
  /** 涨跌额 */
  change: number
  /** 涨跌幅 %（+2.35 = 涨 2.35%） */
  changePct: number
  /** 成交量（手） */
  volume: number
  /** 成交额（元） */
  turnover: number
  /** 换手率 % */
  turnoverRate?: number
  marketCap?: number
  floatMarketCap?: number
  pe?: number
  pb?: number
  /** 数据时间（源上标注或抓取时间） */
  asOf: string
  /** 实际来源（eastmoney / tencent / sina / akshare / baostock…） */
  source: string
}

export interface KlineBar {
  /** 毫秒时间戳（日线为当日 00:00 北京时间） */
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  /** 成交量（手） */
  volume: number
  /** 成交额（元；源缺省时省略） */
  turnover?: number
}

export interface KlineSeries {
  symbol: string
  name: string
  period: Period
  adjust: Adjust
  bars: KlineBar[]
  source: string
  asOf: string
}

export interface NewsItem {
  title: string
  url: string
  /** 信源名称（如「东方财富」「新浪财经」），另附等级用于分析标注 */
  source: string
  publishedAt?: string
  summary?: string
  /** 信源等级：official=交易所/公司公告；media=财经媒体；aggregator=聚合转载 */
  tier?: 'official' | 'media' | 'aggregator'
  /** 关联标的（公告场景） */
  symbol?: string
}

export interface FundProfile {
  code: string
  name: string
  kind: 'etf' | 'fund'
  /** 规模（亿元） */
  scale?: number
  /** 管理费率 % */
  feeRate?: number
  /** 跟踪指数（ETF/指数基金） */
  trackingIndex?: string
  holdings?: Array<{ name: string; code?: string; weightPct: number }>
  dividends?: Array<{ date: string; amount: number }>
  /** 阶段收益 %（近 1/3/6/12 月）；净值类为区间涨幅 */
  returns?: { m1?: number; m3?: number; m6?: number; y1?: number }
  source: string
  asOf: string
}

/** 场外基金净值序列（天天基金 / akshare） */
export interface FundNavPoint {
  timestamp: number
  /** 单位净值 */
  nav: number
  /** 累计净值 */
  cumNav?: number
  /** 日涨跌幅 % */
  changePct?: number
}

export interface FundNavSeries {
  code: string
  name: string
  points: FundNavPoint[]
  source: string
  asOf: string
}

/** 财务报告期数据（baostock 报表精简口径） */
export interface FundamentalPeriod {
  /** 报告期 yyyy-MM-dd */
  period: string
  revenue?: number
  netProfit?: number
  roe?: number
  grossMargin?: number
  debtRatio?: number
  eps?: number
  bps?: number
  ocfPerShare?: number
  [key: string]: string | number | undefined
}

export interface FundamentalSeries {
  symbol: string
  name: string
  periods: FundamentalPeriod[]
  source: string
  asOf: string
}

/** 筛选底表行（M34 §5.1 fin_screen）：主数据 + 快照字段（部分源可能缺省行情字段） */
export interface ScreenRow {
  code: string
  name: string
  type: AssetType
  exchange?: Exchange
  /** 最新价（元） */
  price?: number
  /** 涨跌幅 % */
  changePct?: number
  /** 成交量（手） */
  volume?: number
  /** 成交额（元） */
  turnover?: number
  /** 换手率 % */
  turnoverRate?: number
  /** 市盈率（动态） */
  pe?: number
  /** 市净率 */
  pb?: number
  /** 总市值（元） */
  marketCap?: number
  /** 流通市值（元） */
  floatMarketCap?: number
}

/** 快照缓存命中信息（工具结果 `cache` 字段） */
export type CacheState = 'hit' | 'miss' | 'stale'

/** 数据网关统一返回（工具层包装为 detail / 快照） */
export interface GatewayResult<T> {
  data: T
  /** 实际来源 */
  source: string
  asOf: string
  cache: CacheState
  /** 降级发生的说明（主源失败切备源等） */
  degraded?: string
}

/** 能力名（路由降级链的键） */
export type FinanceCapability =
  | 'quote'
  | 'kline'
  | 'indicator'
  | 'fundamental'
  | 'fund_profile'
  | 'fund_nav'
  | 'news'
  | 'screen'
  | 'search'

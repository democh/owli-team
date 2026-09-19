/**
 * 源适配器基础设施（M34）：Fetcher 注入（fixture 回放可测）+ 财务源上下文 + 数值解析。
 *
 * 设计：所有源适配器不直接调用全局 fetch，而是接受 Fetcher（默认 antiBotFetch），
 * 测试注入 fake fetcher 即完成「fixture 回放」；解析函数为纯函数单独可测。
 */
import { antiBotFetch, type AntiBotRequest, type AntiBotResponse } from '../tools/http.js'

export type Fetcher = (req: AntiBotRequest) => Promise<AntiBotResponse>

/** 默认 Fetcher：反爬模块（限速 / 冷却 / 退避 / GBK 解码） */
export const defaultFetcher: Fetcher = (req) => antiBotFetch(req)

export interface SourceCtx {
  fetcher?: Fetcher
  signal?: AbortSignal
  /** 同域最小间隔（ms；0 = 复用 antiBotFetch 默认） */
  minIntervalMs?: number
  /** 单次请求超时（ms） */
  timeoutMs?: number
  /** 浏览器 UA 覆盖 */
  userAgent?: string
}

/** 源适配器统一守卫：注入的 fetcher 或默认 antiBotFetch */
export function resolveFetcher(ctx: SourceCtx = {}): Fetcher {
  return ctx.fetcher ?? defaultFetcher
}

/** 安全数值解析：'1,234.5' / '2.35%' / '' / '-' → number | undefined */
export function num(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v !== 'string') return undefined
  const cleaned = v.replace(/[%,，\s]/g, '')
  if (cleaned === '' || cleaned === '-' || cleaned === '--') return undefined
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : undefined
}

export function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v)
}

/** JSON 宽松解析（部分接口非严格 JSON / JSONP 包裹；失败抛带片段错误） */
export function parseJsonLoose<T = unknown>(text: string): T {
  const trimmed = text.trim()
  try {
    return JSON.parse(trimmed) as T
  } catch {
    // JSONP：callback({...}); → 提取首个 { 到末尾可用 } 段
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as T
      } catch {
        // fallthrough
      }
    }
    throw new Error(`响应不是合法 JSON（${trimmed.slice(0, 80)}…）`)
  }
}

/** 域内批量分片（东财 secids 一次 ≤100 较稳） */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

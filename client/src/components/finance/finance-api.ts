/**
 * 金融投研前端数据通道（M34 §6.4）：/api/finance/* 类型化封装。
 * - 统一错误口径：HTTP 非 2xx → 取 `{ error }` 中文文案抛 Error（对齐既有路由约定）；
 * - 主区「行情」Tab 已撤除（ADR 0098）：本模块仅保留画布 GameNode / 会话 game 块共用的
 *   runGame（POST /api/finance/game）；K 线拉取由 K 线块 / 画布节点直连 GET /api/finance/kline。
 */
import type { GameModelName } from '../../lib/game-spec'

export interface GameRunResult {
  model: GameModelName
  topic: string
  symbol?: string
  seed: number
  params: Record<string, unknown>
  result: unknown
  stats: Record<string, unknown>
  narrative: string
  warnings?: string[]
  /** 路由补充字段 */
  modelLabel?: string
  note?: string
}

// ---------------------------------------------------------------- 请求封装

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  const body = (await res.json().catch(() => undefined)) as (T & { error?: string }) | undefined
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`)
  if (body === undefined) throw new Error('响应不是有效 JSON')
  return body
}

function post<T>(url: string, payload: unknown): Promise<T> {
  return request<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

// ---------------------------------------------------------------- 端点封装

export function runGame(input: {
  action: GameModelName
  topic: string
  symbol?: string
  params?: Record<string, unknown>
  seed?: number
}): Promise<GameRunResult> {
  return post('/api/finance/game', {
    action: input.action,
    topic: input.topic,
    ...(input.symbol ? { symbol: input.symbol } : {}),
    ...(input.params && Object.keys(input.params).length > 0 ? { params: input.params } : {}),
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
  })
}

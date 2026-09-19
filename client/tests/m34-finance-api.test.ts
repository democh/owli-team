/**
 * M34 批 C3：runGame（画布 GameNode / 会话 game 块共用）——POST /api/finance/game 请求装配与错误口径。
 * 说明：主区「行情」Tab（FinanceView）与 trading-hours 已撤除（ADR 0098），原 m34-finance-view.test.tsx
 * 中的面板用例一并移除；本文件承接 runGame 契约部分。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runGame } from '../src/components/finance/finance-api'

const fetchMock = vi.fn()

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

// ---------- fixtures ----------

const MATRIX_RESULT = {
  actions: ['aggressive', 'hold', 'retreat'],
  payoffs: [
    [{ long: -1.2, short: 0.8 }, { long: 0.6, short: -0.3 }, { long: 1.1, short: -0.7 }],
    [{ long: -0.4, short: 0.5 }, { long: 0.2, short: 0.1 }, { long: 0.7, short: -0.5 }],
    [{ long: -0.9, short: 0.9 }, { long: -0.2, short: 0.4 }, { long: 0.3, short: 0.2 }],
  ],
  pureNash: [{ long: 'hold', short: 'hold' }],
  mixedNash: [],
  dominant: {},
  gameType: 'chicken',
  gameTypeLabel: '懦夫博弈',
}
const MATRIX_STATS = { gameType: 'chicken', gameTypeLabel: '懦夫博弈', pureNashCount: 1, mixedNashCount: 0 }

const GAME_RUN_MATRIX = {
  model: 'matrix',
  topic: '多空双方在关键价位的攻守取舍',
  seed: 20260918,
  params: { capital: [1e8, 1e8], priceImpact: 0.06, carryCost: 0.03, conflictCost: 0.05, retreatLoss: 0.03 },
  result: MATRIX_RESULT,
  stats: MATRIX_STATS,
  narrative: '懦夫博弈：先退让方损失最小',
  modelLabel: '静态矩阵博弈',
}

/** 通用路由 mock；overrides 可覆盖单个端点（返回 undefined 表示走默认） */
function mockRoutes(overrides: Record<string, () => Response> = {}): void {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input)
    for (const [key, handler] of Object.entries(overrides)) {
      if (url.includes(key)) return handler()
    }
    if (url.startsWith('/api/finance/game')) return jsonResponse(GAME_RUN_MATRIX)
    return jsonResponse({ error: `unexpected ${url}` }, 404)
  })
}

function callsFor(fragment: string): Array<[RequestInfo | URL, RequestInit | undefined]> {
  return fetchMock.mock.calls.filter((call) => String(call[0]).includes(fragment)) as Array<[RequestInfo | URL, RequestInit | undefined]>
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('runGame 博弈推演契约（画布 GameNode / 会话 game 块共用）', () => {
  it('POST /api/finance/game：action / topic / symbol / params / seed 装配与结果透传', async () => {
    mockRoutes()
    const res = await runGame({
      action: 'matrix',
      topic: '多空双方在关键价位的攻守取舍',
      symbol: 'sh600519',
      params: { priceImpact: 0.06 },
      seed: 20260918,
    })
    const [url, init] = callsFor('/api/finance/game')[0]
    expect(String(url)).toBe('/api/finance/game')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({
      action: 'matrix',
      topic: '多空双方在关键价位的攻守取舍',
      symbol: 'sh600519',
      params: { priceImpact: 0.06 },
      seed: 20260918,
    })
    expect(res.result).toEqual(MATRIX_RESULT)
    expect(res.seed).toBe(20260918)
  })

  it('缺省可选字段不进请求体；服务端错误取 { error } 中文文案', async () => {
    mockRoutes()
    await runGame({ action: 'evolve', topic: '信号跟随演化', params: {} })
    const body = JSON.parse(String(callsFor('/api/finance/game')[0]?.[1]?.body)) as Record<string, unknown>
    expect(body).toEqual({ action: 'evolve', topic: '信号跟随演化' })

    mockRoutes({ '/api/finance/game': () => jsonResponse({ error: '参数越界：priceImpact 超出 [0,1]' }, 400) })
    await expect(runGame({ action: 'matrix', topic: '越界推演', params: { priceImpact: 2 } })).rejects.toThrow(
      '参数越界：priceImpact 超出 [0,1]',
    )
  })
})

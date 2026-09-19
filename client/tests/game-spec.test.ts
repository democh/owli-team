/**
 * game-spec 解析器（M34 §5.4，批 C1）：```game 块 → GameSpec 纯函数。
 * 契约：src / data 至少一项；model 必填（大小写归一，缺省容忍 data.model 兜底）；
 * data 字段结构化透传（topic/seed/meta/stats/narrative/result）；src 拒绝绝对路径与 `..`。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_GAME_SEED,
  GAME_MODEL_LABELS,
  GAME_MODELS,
  gameDefaultTitle,
  parseGameSpec,
} from '../src/lib/game-spec'

describe('parseGameSpec：src / data 通道', () => {
  it('最小 src 引用：model 必填解析成功', () => {
    const r = parseGameSpec('{"src":"charts/game-maotai-duikang-202609181030.json","model":"simulate"}')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.spec.model).toBe('simulate')
    expect(r.spec.src).toBe('charts/game-maotai-duikang-202609181030.json')
    expect(r.spec.data).toBeUndefined()
  })

  it('内联 matrix 数据：字段结构化透传', () => {
    const r = parseGameSpec(
      JSON.stringify({
        model: 'matrix',
        data: {
          kind: 'game',
          model: 'matrix',
          topic: '茅台多空对峙推演',
          symbol: 'sh600519',
          seed: 20260918,
          meta: { params: { capital: 100 }, asOf: '2026-09-18T10:30:00+08:00' },
          stats: { gameType: 'chicken' },
          narrative: '懦夫博弈：先退让方损失最小',
          result: { equilibria: [] },
        },
      }),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.spec.model).toBe('matrix')
    expect(r.spec.data?.topic).toBe('茅台多空对峙推演')
    expect(r.spec.data?.seed).toBe(20260918)
    expect(r.spec.data?.meta?.asOf).toBe('2026-09-18T10:30:00+08:00')
    expect(r.spec.data?.stats?.gameType).toBe('chicken')
    expect(r.spec.data?.narrative).toContain('先退让方')
    expect(r.spec.data?.result).toEqual({ equilibria: [] })
  })

  it('顶层 model 缺失时由 data.model 兜底；大小写归一', () => {
    const derived = parseGameSpec('{"src":"charts/game-a-202609181030.json","data":{"model":"Evolve"}}')
    expect(derived.ok).toBe(true)
    if (derived.ok) expect(derived.spec.model).toBe('evolve')

    const upper = parseGameSpec('{"src":"charts/game-a-202609181030.json","model":"SIMULATE"}')
    expect(upper.ok).toBe(true)
    if (upper.ok) expect(upper.spec.model).toBe('simulate')
  })

  it('title 透传（trim），空白忽略', () => {
    const r = parseGameSpec('{"src":"charts/game-a-202609181030.json","model":"matrix","title":"  对峙  "}')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.spec.title).toBe('对峙')

    const blank = parseGameSpec('{"src":"charts/game-a-202609181030.json","model":"matrix","title":"   "}')
    expect(blank.ok).toBe(true)
    if (blank.ok) expect(blank.spec.title).toBeUndefined()
  })
})

describe('parseGameSpec：护栏与错误信息', () => {
  it('缺 src 与 data → 明确报缺', () => {
    const r = parseGameSpec('{"model":"matrix"}')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('缺少 src（快照路径）或 data（内联数据）')
  })

  it('不支持的模型 → 中文错误列举可选值', () => {
    const r = parseGameSpec('{"src":"charts/game-a.json","model":"auction"}')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('不支持的博弈模型 "auction"')
      expect(r.error).toContain('matrix / sequence / evolve / simulate')
    }

    const absent = parseGameSpec('{"src":"charts/game-a.json"}')
    expect(absent.ok).toBe(false)
    if (!absent.ok) expect(absent.error).toContain('（缺失）')
  })

  it('JSON 语法错误 / 顶层非对象 / data 非对象 → 中文错误', () => {
    const syntax = parseGameSpec('{oops}')
    expect(syntax.ok).toBe(false)
    if (!syntax.ok) expect(syntax.error).toContain('JSON 解析失败')

    const arr = parseGameSpec('[1]')
    expect(arr.ok).toBe(false)
    if (!arr.ok) expect(arr.error).toContain('顶层结构必须是 JSON 对象')

    const badData = parseGameSpec('{"model":"matrix","data":42}')
    expect(badData.ok).toBe(false)
    if (!badData.ok) expect(badData.error).toContain('data 必须是对象')
  })

  it('src 拒绝绝对路径与 .. 上跳', () => {
    for (const src of ['/tmp/game.json', '../game.json', 'charts/../../game.json']) {
      const r = parseGameSpec(JSON.stringify({ src, model: 'matrix' }))
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toContain('会话工作区相对路径')
    }
  })

  it('data 脏字段静默过滤（seed 非有限数 / stats 非对象 / result null）', () => {
    const r = parseGameSpec(
      JSON.stringify({ model: 'matrix', data: { seed: 'x', stats: [1], result: null, narrative: 7 } }),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.spec.data?.seed).toBeUndefined()
    expect(r.spec.data?.stats).toBeUndefined()
    expect(r.spec.data?.result).toBeUndefined()
    expect(r.spec.data?.narrative).toBeUndefined()
  })
})

describe('game-spec：标签与标题', () => {
  it('模型清单与中文标签覆盖 server 口径；默认种子一致', () => {
    expect(GAME_MODELS).toEqual(['matrix', 'sequence', 'evolve', 'simulate'])
    expect(GAME_MODEL_LABELS.matrix).toBe('静态矩阵博弈')
    expect(GAME_MODEL_LABELS.sequence).toBe('序贯博弈（逆向归纳）')
    expect(GAME_MODEL_LABELS.evolve).toBe('演化博弈（复制动态）')
    expect(GAME_MODEL_LABELS.simulate).toBe('ABM 蒙特卡洛')
    expect(DEFAULT_GAME_SEED).toBe(20260918)
  })

  it('gameDefaultTitle：主题 + 模型标签组合，缺项降级', () => {
    expect(gameDefaultTitle({ model: 'simulate', data: { topic: '茅台多空对峙推演' } })).toBe(
      '茅台多空对峙推演 · ABM 蒙特卡洛',
    )
    expect(gameDefaultTitle({ model: 'matrix', title: '对局' })).toBe('对局 · 静态矩阵博弈')
    expect(gameDefaultTitle({ model: 'evolve' })).toBe('博弈推演 · 演化博弈（复制动态）')
  })
})

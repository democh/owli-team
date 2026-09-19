/**
 * M63-C golden：大六壬（daliuren）——九宗门全谱 + 天地盘 / 四课 / 三传 / 天将 / 遁干。
 *
 * 口径锁定（卡面声明）：时家·中气换将·贵人顺逆法·涉害归地（顺数计克）比较。
 * 十例覆盖：重审 / 元首 / 比用 / 涉害 / 遥克 / 昴星 / 别责 / 八专 / 伏吟 / 反吟。
 */
import { describe, expect, it } from 'vitest'
import { computeDaliuren } from '../src/pan/daliuren.js'
import { PanError } from '../src/pan/types.js'

const run = (at: string): ReturnType<typeof computeDaliuren> => computeDaliuren({ at })

describe('M63-C golden：大六壬（九宗门全谱）', () => {
  it('① 涉害课（复等取支上神）：2026-11-05 14:30 癸未日 · 月将太冲卯', () => {
    const r = run('2026-11-05 14:30')
    expect(r.pillars).toEqual({ year: '丙午', month: '戊戌', day: '癸未', hour: '己未' })
    expect(r.jiang).toEqual({ zhi: '卯', name: '太冲' })
    expect(r.zhongQi.name).toBe('霜降')
    expect(r.keti.name).toBe('涉害课')
    expect(r.ke).toEqual([
      { idx: 1, label: '一课', upper: '酉', lower: '癸', lowerIsGan: true },
      { idx: 2, label: '二课', upper: '巳', lower: '酉', lowerIsGan: false },
      { idx: 3, label: '三课', upper: '卯', lower: '未', lowerIsGan: false },
      { idx: 4, label: '四课', upper: '亥', lower: '卯', lowerIsGan: false },
    ])
    expect(r.chuan.map((c) => [c.zhi, c.dunGan, c.jiang])).toEqual([
      ['卯', '己', '贵人'],
      ['亥', '乙', '勾陈'],
      ['未', '癸', '太常'],
    ])
    // 昼贵卯逆布（临地盘未）
    expect(r.guiRen).toEqual({ zhi: '卯', kind: '昼贵', direction: '逆布', di: '未' })
  })

  it('② 重审课（下贼上）：2026-01-03 03:00 丁丑日 · 三传递取', () => {
    const r = run('2026-01-03 03:00')
    expect(r.pillars.day).toBe('丁丑')
    expect(r.dayNight).toBe('夜占')
    expect(r.keti.name).toBe('重审课')
    expect(r.chuan.map((c) => c.zhi)).toEqual(['子', '亥', '戌'])
    expect(r.chuan[0]).toMatchObject({ dunGan: '丙', jiang: '玄武' })
  })

  it('③ 元首课（上克下）：2026-01-03 21:00 丁丑日', () => {
    const r = run('2026-01-03 21:00')
    expect(r.keti.name).toBe('元首课')
    expect(r.chuan.map((c) => c.zhi)).toEqual(['卯', '巳', '未'])
  })

  it('④ 比用课（知一）：2026-01-03 15:00 丁丑日', () => {
    const r = run('2026-01-03 15:00')
    expect(r.keti.name).toContain('比用课')
    expect(r.chuan.map((c) => c.zhi)).toEqual(['巳', '戌', '卯'])
  })

  it('⑤ 遥克课（蒿矢）：2026-01-09 07:00 癸未日', () => {
    const r = run('2026-01-09 07:00')
    expect(r.keti.name).toBe('遥克课')
    expect(r.keti.note).toContain('蒿矢')
    expect(r.chuan.map((c) => c.zhi)).toEqual(['未', '辰', '丑'])
  })

  it('⑥ 伏吟课（阴日自信 · 刑取）：2026-01-03 01:00 丁丑日 · 月将丑', () => {
    const r = run('2026-01-03 01:00')
    expect(r.jiang.zhi).toBe('丑')
    expect(r.pillars.hour).toBe('辛丑')
    expect(r.keti.name).toBe('伏吟课')
    expect(r.keti.note).toContain('自信')
    // 初=支上（丑）→ 中=刑(丑)=戌 → 末=刑(戌)=未
    expect(r.chuan.map((c) => c.zhi)).toEqual(['丑', '戌', '未'])
  })

  it('⑦ 反吟课（取日支驿马 · 刑冲取）：2026-01-03 13:00 丁丑日 · 月将丑', () => {
    const r = run('2026-01-03 13:00')
    expect(r.keti.name).toBe('反吟课')
    // 初=驿马（丑局巳酉丑→亥）→ 中=自刑取冲（亥→巳）→ 末=刑(巳)=申（旬空无遁干）
    expect(r.chuan.map((c) => c.zhi)).toEqual(['亥', '巳', '申'])
    expect(r.chuan[2]).toMatchObject({ dunGan: null, kong: true })
  })

  it('⑧ 昴星课（阴日冬蛇掩目）：2026-01-03 07:00 丁丑日', () => {
    const r = run('2026-01-03 07:00')
    expect(r.keti.name).toBe('昴星课')
    expect(r.keti.note).toContain('冬蛇掩目')
    // 初=天盘酉下神（子）→ 中=支上（戌）→ 末=干上（辰）
    expect(r.chuan.map((c) => c.zhi)).toEqual(['子', '戌', '辰'])
  })

  it('⑨ 八专课（阳日顺数三神 · 中末皆干上）：2026-02-15 21:00 庚申日', () => {
    const r = run('2026-02-15 21:00')
    expect(r.pillars.day).toBe('庚申')
    expect(r.keti.name).toBe('八专课')
    // 干上酉 → 顺数三神（酉→戌→亥）= 亥；中末皆干上酉
    expect(r.chuan.map((c) => c.zhi)).toEqual(['亥', '酉', '酉'])
  })

  it('⑩ 别责课（阴日支三合前一位）：2026-01-27 05:00 辛丑日', () => {
    const r = run('2026-01-27 05:00')
    expect(r.keti.name).toBe('别责课')
    expect(r.keti.note).toContain('支三合前一位')
    // 丑局（巳酉丑）前一位 = 巳（旬空）；中末皆干上未
    expect(r.chuan.map((c) => c.zhi)).toEqual(['巳', '未', '未'])
    expect(r.chuan[0]).toMatchObject({ kong: true, dunGan: null })
  })

  it('⑪ 天地盘结构：月将加时（逆查一一对应）+ 十二天将全布 + 旬遁表', () => {
    const r = run('2026-11-05 14:30')
    expect(r.pan.diToTian).toHaveLength(12)
    // 月将卯临占时未
    expect(r.pan.diToTian.find((x) => x.di === '未')!.tian).toBe('卯')
    // 天盘→地盘反查与正查自洽
    for (const { di, tian } of r.pan.diToTian) expect(r.pan.tianToDi[tian]).toBe(di)
    // 十二天将每神各一将
    expect(new Set(Object.values(r.pan.jiangOf)).size).toBe(12)
    expect(r.pan.jiangOf['卯']).toBe('贵人')
    // 旬首与旬空（癸未日 → 甲戌旬 / 空申酉）
    expect(r.warnings.some((w) => w.includes('甲戌'))).toBe(true)
    expect(r.warnings.some((w) => w.includes('申酉'))).toBe(true)
  })

  it('⑫ 非法输入 → 结构化错误', () => {
    expect(() => run('abc')).toThrow(PanError)
    expect(() => run('2026-13-40 99:00')).toThrow(PanError)
  })
})

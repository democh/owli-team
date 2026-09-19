/**
 * M66 续完善测试：历法基础（calendar）+ 择日排盘（zeri）——golden 与边界。
 *
 * - 日干支锚点：2000-01-01 = 戊午 / 2024-01-01 = 甲子（公开已知）/ 2026-09-19 = 丙申（JDN 链推）；
 * - 节气近似与月建：2026-02 立春 = 4 日 / 2026-09 白露 = 7 日；2026-09-19 → 酉月；2024-01-01 → 子月（小寒前）；
 * - 建除：酉月申日 → 闭（2026-09-19）；子月子日 → 建（2024-01-01）；
 * - 冲煞：丙申日 → 冲虎 / 煞南（申子辰局）；
 * - computeZeri golden：2026-09-20..28 搬家入宅——逐日评分与推荐序（9/22 满 5 · 9/28 成 5 · 9/24 定 4）；
 * - 边界：事项 / 日期 / 区间（>31 天）报错。
 */
import { describe, expect, it } from 'vitest'
import { PanError } from '../src/pan/types.js'
import { dayGanzhi, jdnOf, jieDayOf, monthZhiOf, parseDate } from '../src/pan/calendar.js'
import { computeZeri, scoreOf } from '../src/pan/zeri.js'

describe('M66 续完善：历法基础（calendar）', () => {
  it('JDN 与日干支锚点：2000-01-01 戊午 / 2024-01-01 甲子 / 2026-09-19 丙申', () => {
    expect(jdnOf(2000, 1, 1)).toBe(2451545)
    expect(dayGanzhi(2000, 1, 1).name).toBe('戊午')
    expect(dayGanzhi(2000, 1, 1).index).toBe(54)
    expect(dayGanzhi(2024, 1, 1).name).toBe('甲子')
    expect(dayGanzhi(2024, 1, 1).index).toBe(0)
    expect(dayGanzhi(2026, 9, 19).name).toBe('丙申')
    expect(dayGanzhi(2026, 9, 19).zhiIndex).toBe(8)
  })

  it('节气近似与月建：立春 / 白露日期；酉月与子月（节前）', () => {
    expect(jieDayOf(2026, 2)).toBe(4) // 立春 2/4
    expect(jieDayOf(2026, 9)).toBe(7) // 白露 9/7
    const mz = monthZhiOf(2026, 9, 19)
    expect(mz.zhi).toBe('酉')
    expect(mz.beforeJie).toBe(false)
    const xiao = monthZhiOf(2024, 1, 1)
    expect(xiao.zhi).toBe('子')
    expect(xiao.beforeJie).toBe(true)
    expect(parseDate('2026-09-19')).toEqual({ y: 2026, m: 9, d: 19 })
    expect(parseDate('2026-02-30')).toBeUndefined()
    expect(parseDate('20260919')).toBeUndefined()
  })
})

describe('M66 续完善：择日排盘（zeri）', () => {
  it('建除与冲煞：酉月申日 → 闭（冲虎 煞南）；子月子日 → 建', () => {
    const r = computeZeri({ purpose: '搬家入宅', from: '2026-09-19', to: '2026-09-19' })
    expect(r.days).toHaveLength(1)
    const d = r.days[0]!
    expect(d.ganzhi).toBe('丙申')
    expect(d.jianchu).toBe('闭')
    expect(d.chong).toBe('冲虎')
    expect(d.sha).toBe('南')
    expect(d.weekday).toBe('周六')

    const j = computeZeri({ purpose: '祭祀祈福', from: '2024-01-01', to: '2024-01-01' })
    expect(j.days[0]!.jianchu).toBe('建')
  })

  it('评分 golden：搬家入宅 2026-09-20..28 逐日与推荐序', () => {
    const r = computeZeri({ purpose: '搬家入宅', from: '2026-09-20', to: '2026-09-28' })
    expect(r.days).toHaveLength(9)
    const score = new Map(r.days.map((d) => [d.date, d.score]))
    expect(score.get('2026-09-20')).toBe(3) // 丁酉·建
    expect(score.get('2026-09-21')).toBe(2) // 戊戌·除（忌出行）
    expect(score.get('2026-09-22')).toBe(5) // 己亥·满（宜祭祀 + 吉组）
    expect(score.get('2026-09-24')).toBe(4) // 辛丑·定（宜安床祭祀 + 吉组；忌出行）
    expect(score.get('2026-09-25')).toBe(2) // 壬寅·执（忌移徙）
    expect(score.get('2026-09-26')).toBe(1) // 癸卯·破（诸事慎用）
    expect(score.get('2026-09-28')).toBe(5) // 乙巳·成（宜入宅 + 吉组）

    expect(r.recommended.map((d) => d.date)).toEqual(['2026-09-22', '2026-09-28', '2026-09-24'])
    expect(r.recommended[0]!.jianchu).toBe('满')
    // 冲煞抽样：辛丑 → 冲羊 / 煞东（巳酉丑局）
    const chou = r.days.find((d) => d.date === '2026-09-24')!
    expect(chou.chong).toBe('冲羊')
    expect(chou.sha).toBe('东')
    // 合规：破日表述不含恐吓词
    const po = r.days.find((d) => d.date === '2026-09-26')!
    expect(po.note).toContain('传统列为诸事慎用日')
    expect(po.note).not.toContain('大凶')
    expect(r.notes.some((n) => n.includes('不构成对吉凶的必然判断'))).toBe(true)
  })

  it('边界：事项 / 日期格式 / 区间超限报错（PanError）', () => {
    expect(() => computeZeri({ purpose: '搬家', from: '2026-09-20', to: '2026-09-28' })).toThrowError(PanError)
    expect(() => computeZeri({ purpose: '搬家入宅', from: '2026/09/20', to: '2026-09-28' })).toThrowError(PanError)
    expect(() => computeZeri({ purpose: '搬家入宅', from: '2026-09-28', to: '2026-09-20' })).toThrowError(PanError)
    expect(() => computeZeri({ purpose: '搬家入宅', from: '2026-01-01', to: '2026-12-31' })).toThrowError(PanError)
    expect(scoreOf('破', '出行远行')).toBe(1)
    expect(scoreOf('成', '嫁娶婚庆')).toBe(5)
  })
})

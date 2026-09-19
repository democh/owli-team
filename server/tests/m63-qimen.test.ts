/**
 * M63-D golden：奇门遁甲（qimen）——拆补定局 / 地盘三奇六仪 / 值符值使 / 转盘天盘 / 八门飞宫 / 八神。
 *
 * 口径锁定（卡面声明）：时家转盘·拆补法（符头候简化）·中宫寄坤。
 * 基准例 2026-11-05 14:30（癸未日己未时）：阴 5 局——全盘已逐项手工验算（地盘逆飞 / 转盘 k=7 逆一位 / 八神逆布）。
 */
import { describe, expect, it } from 'vitest'
import { computeQimen } from '../src/pan/qimen.js'
import { PanError } from '../src/pan/types.js'

const run = (at: string): ReturnType<typeof computeQimen> => computeQimen({ at })
const gongOf = (r: ReturnType<typeof computeQimen>, n: number): ReturnType<typeof computeQimen>['gongs'][number] =>
  r.gongs.find((g) => g.num === n)!

describe('M63-D golden：奇门遁甲（拆补 · 时家转盘）', () => {
  const r = run('2026-11-05 14:30')

  it('① 定局：阴 5 局 · 霜降上元 · 符头己卯（拆补 9 日）', () => {
    expect(r.pillars).toEqual({ year: '丙午', month: '戊戌', day: '癸未', hour: '己未' })
    expect(r.ding).toMatchObject({ dun: '阴遁', ju: 5, qi: '霜降', yuan: '上元', futou: '己卯' })
    expect(r.ding.note).toContain('9 日')
  })

  it('② 值符值使与旬首：天英临巽 / 景门 / 甲寅旬空子丑', () => {
    expect(r.zhiFu).toEqual({ star: '天英', gong: 9 })
    expect(r.zhiShi).toEqual({ men: '景门', gong: 4 })
    expect(r.xunShou).toEqual({ jia: '甲寅', yi: '癸', kong: ['子', '丑'] })
  })

  it('③ 九宫全盘锁值（阴 5 局：地盘逆飞 + 转盘逆一位 + 八神逆布）', () => {
    const expectRow = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => {
      const g = gongOf(r, n)
      return [g.name, g.shen, g.star, g.men, g.tianGan, g.diGan, g.kong]
    })
    expect(expectRow).toEqual([
      ['坎', '六合', '天任', '生门', '丁', '壬', true],
      ['坤', '九地', '天柱', '惊门', '丙', '辛', false],
      ['震', '螣蛇', '天辅', '杜门', '己', '庚', false],
      ['巽', '值符', '天英', '景门', '癸', '己', false],
      ['中', '', '天禽（寄坤）', '', '', '戊', false],
      ['乾', '白虎', '天蓬', '休门', '壬', '乙', false],
      ['兑', '玄武', '天心', '开门', '乙', '丙', false],
      ['艮', '太阴', '天冲', '伤门', '庚', '丁', true],
      ['离', '九天', '天芮（禽随）', '死门', '辛', '癸', false],
    ])
  })

  it('④ 伏吟样例：冬至下元阳 4 局 · 值符天禽寄坤 · 天盘同地盘（2026-01-01 00:30）', () => {
    const v = run('2026-01-01 00:30')
    expect(v.pillars.day).toBe('乙亥')
    expect(v.ding).toMatchObject({ dun: '阳遁', ju: 4, qi: '冬至', yuan: '下元' })
    expect(v.zhiFu).toEqual({ star: '天禽', gong: 5 })
    expect(v.zhiShi).toEqual({ men: '死门', gong: 7 })
    // 天盘干 = 地盘干（伏吟：k=0）
    for (const n of [1, 2, 3, 4, 6, 7, 8, 9]) {
      const g = gongOf(v, n)
      expect(g.tianGan).toBe(g.diGan)
    }
    // 旬空申酉 → 坤（申）与兑（酉）标空
    expect(gongOf(v, 2).kong).toBe(true)
    expect(gongOf(v, 7).kong).toBe(true)
  })

  it('⑤ 拆补接气：立冬（11-07）后符头仍属霜降（甲申中元 → 阴 8 局）', () => {
    const j = run('2026-11-08 12:00')
    expect(j.ding).toMatchObject({ dun: '阴遁', ju: 8, qi: '霜降', yuan: '中元', futou: '甲申' })
    expect(j.ding.note).toContain('归上一节气')
  })

  it('⑥ 结构不变量：九宫 9 条 / 八神八门各不重复 / 九星含天禽', () => {
    expect(r.gongs).toHaveLength(9)
    expect(new Set(r.gongs.map((g) => g.num)).size).toBe(9)
    const shens = r.gongs.filter((g) => g.shen !== '').map((g) => g.shen)
    expect(shens).toHaveLength(8)
    expect(new Set(shens).size).toBe(8)
    const mens = r.gongs.filter((g) => g.men !== '').map((g) => g.men)
    expect(mens).toHaveLength(8)
    expect(new Set(mens).size).toBe(8)
    expect(r.gongs.some((g) => g.star.includes('天禽'))).toBe(true)
    // 地盘九干 = 六仪三奇全集
    expect(new Set(r.gongs.map((g) => g.diGan))).toEqual(new Set(['戊', '己', '庚', '辛', '壬', '癸', '丁', '丙', '乙']))
  })

  it('⑦ 非法输入 → 结构化错误', () => {
    expect(() => run('abc')).toThrow(PanError)
    expect(() => run('2026-13-40 99:00')).toThrow(PanError)
  })

  it('⑧ 置闰对照（续完善）：芒种窗口日两口径不同（2022-06-25 拆补阴 9 / 置闰阳 6·闰）', () => {
    const r = run('2022-06-25 10:00')
    // 拆补：夏至上元阴 9 局
    expect(r.ding).toMatchObject({ dun: '阴遁', ju: 9, qi: '夏至', yuan: '上元' })
    // 置闰：芒种窗口第 5 天 → 重复芒种上元（阳遁 6 局；沿用被重复节遁性）
    expect(r.ding.zhirun).toMatchObject({ dun: '阳遁', ju: 6, qi: '芒种', yuan: '上元', leap: true })
    expect(r.ding.zhirun.note).toContain('置闰窗口第 5 天')
  })

  it('⑨ 置闰对照：非窗口日两口径一致；大雪窗口（2027-12-28）阴遁 7·闰', () => {
    // 基准例（2026-11-05）：两口径一致（零回归）
    expect(run('2026-11-05 14:30').ding.zhirun).toMatchObject({ ju: 5, leap: false })
    // 大雪窗口第 7 天 → 重复大雪中元（阴遁 7 局）
    const w = run('2027-12-28 10:00')
    expect(w.ding.zhirun).toMatchObject({ dun: '阴遁', ju: 7, qi: '大雪', yuan: '中元', leap: true })
  })
})

/**
 * M63-A golden：八字深化（神煞 / 柱间关系 / 小运 / 流月）+ 紫微流年层 + 六爻 v2（伏神 / 月日关系 / 回头生克）。
 *
 * 基准例与 m51-pan.test.ts 同参（1990-05-12 14:30 男 → 庚午 辛巳 丁丑 丁未），
 * 纯计算零 IO；口径见 docs/metaphysics-deepening-design.md 附录 A.1 / A.5。
 */
import { describe, expect, it } from 'vitest'
import { computeBazi } from '../src/pan/bazi.js'
import { computeGua } from '../src/pan/gua.js'
import { PanError } from '../src/pan/types.js'
import { computeZiwei } from '../src/pan/ziwei.js'

const BIRTH = { birth: '1990-05-12 14:30', calendar: 'solar', gender: 'male', trueSolarTime: false } as const

// ---------------------------------------------------------------------------
// 八字 v2
// ---------------------------------------------------------------------------

describe('M63-A golden：八字 神煞 / 柱间关系 / 小运 / 流月', () => {
  const r = computeBazi({ ...BIRTH })

  it('① 神煞 18 种逐柱命中（基准例 9 项）', () => {
    expect(r.shenSha).toEqual([
      { name: '禄神', basis: '日干', pillars: ['年'] },
      { name: '羊刃', basis: '日干', pillars: ['时'] },
      { name: '红艳', basis: '日干', pillars: ['时'] },
      { name: '天德贵人', basis: '月支', pillars: ['月'] },
      { name: '月德贵人', basis: '月支', pillars: ['年'] },
      { name: '桃花', basis: '日支', pillars: ['年'] },
      { name: '华盖', basis: '日支', pillars: ['日'] },
      { name: '将星', basis: '年支', pillars: ['年'] },
      { name: '亡神', basis: '年支', pillars: ['月'] },
    ])
  })

  it('② 柱间关系（四柱两两 + 三会）：午丑害 / 午未合 / 丑未冲 / 丑未刑 / 巳午未三会火方', () => {
    const four = r.relations.filter((x) => x.pair !== '大运' && x.pair !== '流年')
    expect(four).toEqual([
      { scope: '地支', type: '相害', pair: '年日', label: '午丑害' },
      { scope: '地支', type: '六合', pair: '年时', label: '午未合' },
      { scope: '地支', type: '六冲', pair: '日时', label: '丑未冲' },
      { scope: '地支', type: '相刑', pair: '日时', label: '丑未刑' },
      { scope: '地支', type: '三会', pair: '月年时', label: '巳午未三会火方' },
    ])
  })

  it('③ 运岁作用存在且逐项标注命中柱位（大运 / 流年按当前时间动态）', () => {
    const daYun = r.relations.filter((x) => x.pair === '大运')
    const liuNian = r.relations.filter((x) => x.pair === '流年')
    expect(daYun.length).toBeGreaterThan(0)
    expect(liuNian.length).toBeGreaterThan(0)
    for (const x of [...daYun, ...liuNian]) {
      expect(x.label).toMatch(/（[年月日时]）$/)
    }
  })

  it('④ 小运 10 步（连续岁数、干支两字；与当前大运对齐）', () => {
    expect(r.xiaoYun).toHaveLength(10)
    expect(r.xiaoYun.every((x) => x.ganZhi.length === 2)).toBe(true)
    const ages = r.xiaoYun.map((x) => x.age)
    expect(ages).toEqual([...Array(10)].map((_, i) => ages[0]! + i))
    const cur = r.daYun.find((d) => d.isCurrent)!
    expect(ages[0]).toBeGreaterThanOrEqual(cur.startAge)
    expect(ages[9]).toBeLessThanOrEqual(cur.endAge)
  })

  it('⑤ 流月：liuYueOf=2026 → 十二流月（正月庚寅 → 腊月辛丑，五虎遁丙年起庚）', () => {
    const r2 = computeBazi({ ...BIRTH }, { liuYueOf: '2026' })
    expect(r2.liuYueOf).toBe('2026 丙午')
    expect(r2.liuYue).toHaveLength(12)
    expect(r2.liuYue![0]).toEqual({ month: '正月', ganZhi: '庚寅' })
    expect(r2.liuYue![11]).toEqual({ month: '腊月', ganZhi: '辛丑' })
    // 缺省不输出
    expect(computeBazi({ ...BIRTH }).liuYue).toBeNull()
    expect(computeBazi({ ...BIRTH }).liuYueOf).toBeNull()
  })

  it('⑥ 流月请求非法年份 → 结构化错误', () => {
    expect(() => computeBazi({ ...BIRTH }, { liuYueOf: '1800' })).toThrow(PanError)
    expect(() => computeBazi({ ...BIRTH }, { liuYueOf: '1800' })).toThrow(/未找到指定流年/)
  })

  it('⑦ 旧调用等价：不传选项时既有字段零变化', () => {
    expect(r.pillars.year.ganZhi).toBe('庚午')
    expect(r.daYun).toHaveLength(8)
    expect(r.liuNian).toHaveLength(10)
  })
})

// ---------------------------------------------------------------------------
// 紫微 v2（流年层）
// ---------------------------------------------------------------------------

describe('M63-A golden：紫微流年层（horoscopeYear）', () => {
  it('① 2026 流年：丙午 / 流年命宫财帛（壬午）/ 四化 禄天同 权天机 科文昌 忌廉贞', () => {
    const r = computeZiwei({ ...BIRTH }, { horoscopeYear: '2026' })
    expect(r.horoscope).toEqual({
      year: 2026,
      ganZhi: '丙午',
      soulPalaceName: '财帛',
      soulPalaceGanZhi: '壬午',
      mutagenStars: [
        { mutagen: '禄', star: '天同' },
        { mutagen: '权', star: '天机' },
        { mutagen: '科', star: '文昌' },
        { mutagen: '忌', star: '廉贞' },
      ],
    })
  })

  it('② 缺省无流年层（向后兼容）', () => {
    expect(computeZiwei({ ...BIRTH }).horoscope).toBeNull()
  })

  it('③ 非法年份 → 结构化错误', () => {
    expect(() => computeZiwei({ ...BIRTH }, { horoscopeYear: 'abcd' })).toThrow(PanError)
  })
})

// ---------------------------------------------------------------------------
// 六爻 v2（伏神 / 月日关系 / 回头生克）
// ---------------------------------------------------------------------------

describe('M63-A golden：六爻 v2（伏神 / 月日 / 回头）', () => {
  // 固定起卦日 2026-01-01：子月 乙亥日（卦气与附录 A.4 同参）
  const DATE = '2026-01-01'

  it('① 基准（数字 17、28 → 天雷无妄）：月破 / 旺衰档 / 无伏神（五亲齐）', () => {
    const r = computeGua({ method: 'number', numbers: [17, 28], date: DATE, question: '测试占问' })
    const byPos = (p: number) => r.lines.find((l) => l.pos === p)!
    // 九四（午火）与月建子相冲 + 令克（水克火）→ 月破·死
    expect(byPos(4).dayRelations).toEqual(['月破', '死'])
    // 初九（子水）与月建同 → 旺
    expect(byPos(1).dayRelations).toEqual(['旺'])
    // 六二（寅木）令生 → 相
    expect(byPos(2).dayRelations).toEqual(['相'])
    // 五亲齐 → 无伏神
    expect(r.lines.every((l) => l.fuShen === undefined)).toBe(true)
  })

  it('② 伏神：数字 5、1 → 风天小畜（缺官鬼，伏于三爻 辛酉）', () => {
    const r = computeGua({ method: 'number', numbers: [5, 1], date: DATE })
    expect(r.ben.name).toBe('风天小畜')
    const fu = r.lines.find((l) => l.fuShen)
    expect(fu?.pos).toBe(3)
    expect(fu?.fuShen).toEqual({ liuQin: '官鬼', ganZhi: '辛酉', wuxing: '金' })
    // 每爻均带月日关系标签（旺衰简档至少一档）
    expect(r.lines.every((l) => (l.dayRelations?.length ?? 0) > 0)).toBe(true)
  })

  it('③ 日破：风天小畜六五（巳火）静爻与日辰亥相冲 + 衰（水克火）→ 日破', () => {
    const r = computeGua({ method: 'number', numbers: [5, 1], date: DATE })
    const l5 = r.lines.find((l) => l.pos === 5)!
    expect(l5.liuQin).toBe('子孙')
    expect(l5.dayRelations).toEqual(['日破', '死'])
  })

  it('④ 回头泄：数字 1、3 → 天火同人（九四 壬午火 → 变辛未土）', () => {
    const r = computeGua({ method: 'number', numbers: [1, 3], date: DATE })
    expect(r.ben.name).toBe('天火同人')
    expect(r.dongYao).toEqual([4])
    const l4 = r.lines.find((l) => l.pos === 4)!
    expect(l4.ganZhi).toBe('壬午')
    expect(l4.bianGanZhi).toBe('辛未')
    expect(l4.bianHint).toBe('回头泄')
  })

  it('⑤ 回头克 + 伏神：数字 6、3 → 水火既济（六三 己亥水 → 变庚辰土 · 伏神妻财戊午）', () => {
    const r = computeGua({ method: 'number', numbers: [6, 3], date: DATE })
    expect(r.ben.name).toBe('水火既济')
    expect(r.dongYao).toEqual([3])
    const l3 = r.lines.find((l) => l.pos === 3)!
    expect(l3.ganZhi).toBe('己亥')
    expect(l3.bianGanZhi).toBe('庚辰')
    expect(l3.bianHint).toBe('回头克')
    expect(l3.fuShen).toEqual({ liuQin: '妻财', ganZhi: '戊午', wuxing: '火' })
  })

  it('⑥ 回头生：数字 9、10 → 天泽履（初九 丁巳火 → 变戊寅木）', () => {
    // 履 = 内兑(110) 外乾(111)：n1=9（9%8=1 乾）、n2=10（10%8=2 兑）→ 动爻 mod(19,6)=1
    // 初九 丁巳火 → 内卦 110→010（坎）→ 变戊寅木（木生火 → 回头生）
    const r = computeGua({ method: 'number', numbers: [9, 10], date: DATE })
    expect(r.ben.name).toBe('天泽履')
    expect(r.dongYao).toEqual([1])
    const l1 = r.lines.find((l) => l.pos === 1)!
    expect(l1.ganZhi).toBe('丁巳')
    expect(l1.bianGanZhi).toBe('戊寅')
    expect(l1.bianHint).toBe('回头生')
  })
})

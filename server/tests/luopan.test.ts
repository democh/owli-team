/**
 * M66-A 测试：罗盘排盘算法域（luopan）——golden 案例与精度边界。
 *
 * - 二十四山：度数分段边界（352.5/7.5/172.5 等）与环形区间（子山跨 0°）；
 * - 方位词解析：坐向互检（冲突报错）与仅给朝向；
 * - 八宅 golden：壬山丙向 → 坎宅（东四宅）八宫九星全表逐项；
 * - 玄空 golden：三元九运（2026 → 九运）+ 流年入中星（2024 三碧 / 2025 二黑 / 2026 一白）+ 飞布轨迹；
 * - 数据等级：磁偏角仅 A 级可用；C 级缺省与声明文案；年份越界报错。
 */
import { describe, expect, it } from 'vitest'
import { PanError } from '../src/pan/types.js'
import {
  bazhaiOf,
  computeLuopan,
  feixingOf,
  flyFrom,
  mountainOf,
  norm360,
  opposite,
  pitchOf,
  resolveOrientation,
  yearStarOf,
  yunOf,
} from '../src/pan/luopan.js'

describe('M66-A：罗盘算法域', () => {
  it('二十四山：分段边界与环形区间（子山跨 0°）', () => {
    expect(mountainOf(0).name).toBe('子')
    expect(mountainOf(7.4).name).toBe('子')
    expect(mountainOf(7.6).name).toBe('癸')
    expect(mountainOf(15).name).toBe('癸')
    expect(mountainOf(172.4).name).toBe('丙')
    expect(mountainOf(172.5).name).toBe('午')
    expect(mountainOf(359.9).name).toBe('子')
    // 环形区间：子 [352.5, 7.5)
    const zi = mountainOf(355)
    expect(zi.name).toBe('子')
    expect(zi.range).toEqual([352.5, 7.5])
    expect(norm360(-10)).toBe(350)
    expect(opposite(345)).toBe(165)
  })

  it('方位词解析：坐北朝南 / 仅朝向 / 冲突报错', () => {
    const s = resolveOrientation('坐北朝南')
    expect(s.facingDeg).toBe(180)
    expect(s.sittingDeg).toBe(0)
    expect(resolveOrientation('朝东南').facingDeg).toBe(135)
    expect(() => resolveOrientation('坐北朝东')).toThrowError(PanError)
    expect(() => resolveOrientation('朝上')).toThrowError(PanError)
    expect(() => resolveOrientation('')).toThrowError(PanError)
  })

  it('八宅 golden：壬山丙向（坐 345°）→ 坎宅 · 东四宅 · 八宫九星全表', () => {
    const b = bazhaiOf(345) // 坐山壬 → 坎
    expect(b.house).toBe('坎')
    expect(b.houseName).toBe('坎宅')
    expect(b.group).toBe('东四宅')
    // 大游年歌「坎五天生延绝祸六」自本宫起顺时针：坎伏位 → 艮五鬼 → 震天医 → 巽生气 → 离延年 → 坤绝命 → 兑祸害 → 乾六煞
    expect(b.palaces.map((p) => [p.gua, p.star])).toEqual([
      ['坎', '伏位'],
      ['艮', '五鬼'],
      ['震', '天医'],
      ['巽', '生气'],
      ['离', '延年'],
      ['坤', '绝命'],
      ['兑', '祸害'],
      ['乾', '六煞'],
    ])
    expect(b.palaces.filter((p) => p.luck === '吉').map((p) => p.star)).toEqual(['伏位', '天医', '生气', '延年'])
    // 西四宅对照：乾山（坐 315°）→ 乾宅
    expect(bazhaiOf(315).house).toBe('乾')
    expect(bazhaiOf(315).group).toBe('西四宅')
  })

  it('玄空 golden：三元九运 + 流年入中星 + 飞布轨迹', () => {
    expect(yunOf(2023)).toBe(8)
    expect(yunOf(2024)).toBe(9)
    expect(yunOf(2043)).toBe(9)
    expect(yunOf(2044)).toBe(1) // 环回下一周期
    // 流年入中星：2024 三碧 / 2025 二黑 / 2026 一白（公式 golden）
    expect(yearStarOf(2024)).toBe(3)
    expect(yearStarOf(2025)).toBe(2)
    expect(yearStarOf(2026)).toBe(1)
    // 飞布：2026 一白入中 → 中1 乾2 兑3 艮4 离5 坎6 坤7 震8 巽9
    const pan = flyFrom(1)
    expect(pan.map((p) => [p.palace, p.star])).toEqual([
      ['中', 1],
      ['乾', 2],
      ['兑', 3],
      ['艮', 4],
      ['离', 5],
      ['坎', 6],
      ['坤', 7],
      ['震', 8],
      ['巽', 9],
    ])
    const f = feixingOf(2026)
    expect(f.yun).toBe(9)
    expect(f.yunRange).toEqual([2024, 2043])
    expect(f.yearName).toBe('一白')
  })

  it('兼向判定（续完善）：±4.5° 下卦带 / 3° 兼向带；仅 A 级启用', () => {
    // 345° = 壬山中心 → 下卦；350° → 偏离 5° → 兼向；340° → 偏离 5°（另一侧）→ 兼向；348° → 3° → 下卦
    expect(pitchOf(345)).toEqual({ offset: 0, kind: '下卦' })
    expect(pitchOf(348)).toEqual({ offset: 3, kind: '下卦' })
    expect(pitchOf(349.5)).toEqual({ offset: 4.5, kind: '下卦' })
    expect(pitchOf(350)).toEqual({ offset: 5, kind: '兼向' })
    expect(pitchOf(340)).toEqual({ offset: 5, kind: '兼向' })

    // B / C 级：未判定（含提示）
    const c = computeLuopan({ facing: '170', year: 2026 })
    expect(c.pitch.kind).toBe('未判定')
    expect(c.pitch.offset).toBeNull()
    expect(c.pitch.note).toContain('A 级')
    // A 级下卦态（朝 177 → 坐 357 → 子山中心 3°）
    const a1 = computeLuopan({ facing: '177', quality: 'A', year: 2026 })
    expect(a1.sitting.name).toBe('子')
    expect(a1.pitch.kind).toBe('下卦')
    expect(a1.pitch.note).toContain('下卦排盘')
    // A 级兼向态（朝 170 → 坐 350 → 壬山偏离中心 5°）
    const a2 = computeLuopan({ facing: '170', quality: 'A', year: 2026 })
    expect(a2.sitting.name).toBe('壬')
    expect(a2.pitch.kind).toBe('兼向')
    expect(a2.pitch.note).toContain('替卦')
    expect(a2.pitch.note).toContain('专业复核')
  })

  it('综合盘：C 级缺省 + 声明文案；磁偏角仅 A 级；年份越界报错', () => {
    const r = computeLuopan({ facing: '坐北朝南', year: 2026 })
    expect(r.quality).toBe('C')
    expect(r.facing.name).toBe('午')
    expect(r.sitting.name).toBe('子')
    expect(r.bazhai.house).toBe('坎')
    expect(r.notes.some((n) => n.includes('C 级'))).toBe(true)
    expect(r.notes.some((n) => n.includes('坐山派'))).toBe(true)
    expect(r.notes.some((n) => n.includes('不承诺'))).toBe(true)

    expect(() => computeLuopan({ facing: '172', quality: 'B', declination: 5 })).toThrowError(PanError)
    const a = computeLuopan({ facing: '172', quality: 'A', declination: -3, year: 2026 })
    expect(a.orientation.facingDeg).toBe(175) // 172 − (−3) = 175
    expect(a.notes.some((n) => n.includes('磁偏角修正'))).toBe(true)

    expect(() => computeLuopan({ facing: '172', year: 1800 })).toThrowError(PanError)
    expect(() => computeLuopan({ facing: '172', declination: 30, quality: 'A' })).toThrowError(PanError)
  })
})

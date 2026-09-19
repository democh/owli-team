/**
 * M63-E golden：七政四余（qizheng）——七政 / 四余近似分级 / 十二宫 / 命宫 / 庙旺。
 *
 * 基准：1990-05-12 14:30 Asia/Shanghai 31.23N/121.47E（与 m51/m63 同源）。
 * 强校准：命宫输出与该盘真实上升（ASC 处女 16.0° = 巳宫）一致。
 */
import { describe, expect, it } from 'vitest'
import { computeQizheng } from '../src/pan/qizheng.js'
import { PanError } from '../src/pan/types.js'

const BIRTH = {
  birth: '1990-05-12 14:30',
  timezone: 'Asia/Shanghai',
  latitude: 31.23,
  longitude: 121.47,
}

describe('M63-E golden：七政四余', () => {
  const r = computeQizheng(BIRTH)

  it('① 命宫与七政（锁定值；与本命盘同源）', () => {
    expect(r.mingGong).toBe('巳') // 与该盘真实上升（处女=巳宫）一致
    expect(r.bodies).toHaveLength(11)
    const sun = r.bodies.find((b) => b.name === '太阳')!
    expect(sun.gong).toBe('酉')
    expect(sun.lon).toBeCloseTo(51.24, 1)
    expect(sun.degInGong).toBeCloseTo(21.24, 1)
    // 太阴（中法名）；水星与土星逆行（与本命盘一致）
    const moon = r.bodies.find((b) => b.name === '太阴')!
    expect(moon.gong).toBe('寅')
    expect(moon.lon).toBeCloseTo(257.62, 1)
    expect(r.bodies.find((b) => b.name === '水星')!.retro).toBe(true)
    expect(r.bodies.find((b) => b.name === '土星')!.retro).toBe(true)
  })

  it('② 四余近似分级：罗计对冲 + 恒逆行 + 近似标注', () => {
    const luo = r.bodies.find((b) => b.name === '罗睺')!
    const ji = r.bodies.find((b) => b.name === '计都')!
    // 罗计正对（角距 180°）
    expect(Math.abs(((luo.lon - ji.lon + 540) % 360) - 180)).toBeCloseTo(180, 3)
    expect(luo.note).toContain('平交点')
    expect(luo.retro).toBe(true)
    expect(ji.retro).toBe(true)
    const yuebo = r.bodies.find((b) => b.name === '月孛')!
    expect(yuebo.note).toContain('平远地点')
    expect(yuebo.retro).toBe(true)
    const ziqi = r.bodies.find((b) => b.name === '紫炁')!
    expect(ziqi.note).toContain('争议口径')
    expect(ziqi.retro).toBe(false)
    // 四余全部有近似标注
    for (const name of ['罗睺', '计都', '月孛', '紫炁']) {
      expect(r.bodies.find((b) => b.name === name)!.note).toBeTruthy()
    }
  })

  it('③ 十二宫：命宫起逆布 + 宫主 / 落宫星曜', () => {
    expect(r.palaces).toHaveLength(12)
    const names = r.palaces.map((p) => p.name)
    expect(names).toEqual(['命宫', '财帛', '兄弟', '田宅', '男女', '奴仆', '夫妻', '疾厄', '迁移', '官禄', '福德', '相貌'])
    // 命宫巳 → 财帛辰 → 兄弟卯（地支逆序）
    expect(r.palaces[0]).toMatchObject({ name: '命宫', gong: '巳', sign: '处女', lord: '水星' })
    expect(r.palaces[1]!.gong).toBe('辰')
    expect(r.palaces[2]!.gong).toBe('卯')
    // 太阳 / 水星落迁移（酉宫）
    const qianyi = r.palaces.find((p) => p.name === '迁移')!
    expect(qianyi.gong).toBe('酉')
    expect(qianyi.bodies).toEqual(['太阳', '水星'])
    // 全 12 宫宫支无重复
    expect(new Set(r.palaces.map((p) => p.gong)).size).toBe(12)
  })

  it('④ 卯时生人：命宫 = 太阳宫（口径锚点）', () => {
    const dawn = computeQizheng({ ...BIRTH, birth: '1990-05-12 06:00' })
    const sun = dawn.bodies.find((b) => b.name === '太阳')!
    expect(dawn.mingGong).toBe(sun.gong)
  })

  it('⑤ 庙旺表（七政齐全）+ 口径声明', () => {
    expect(r.miaoWang).toHaveLength(7)
    expect(r.miaoWang.find((m) => m.star === '太阳')).toEqual({ star: '太阳', miao: '戌', wang: '巳' })
    expect(r.warnings.some((w) => w.includes('不列二十八宿度'))).toBe(true)
    expect(r.warnings.some((w) => w.includes('命宫'))).toBe(true)
  })

  it('⑥ 结构化错误：缺时区 / 非法时间', () => {
    expect(() => computeQizheng({ ...BIRTH, timezone: '' })).toThrow(PanError)
    expect(() => computeQizheng({ ...BIRTH, birth: 'abc' })).toThrow(PanError)
  })
})

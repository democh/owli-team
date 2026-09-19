/**
 * M78 golden：塔罗抽牌复现三元组（seed + cut + picks）——见 docs/tarot-ritual-design.md §5 / §12.1。
 *
 * 覆盖：
 * - 缺省兼容：cut/picks 缺省 == 显式 (0, [0..N-1])，与 M69 旧版逐位一致（既有 golden 不动）；
 * - cut/picks golden：真实输出回填（seed=456 三组 + single/cross 向量）；
 * - cut 旋转等价：cut=c 后位置 0 == 无切时位置 26×c（「牌带正逆位」随牌走）；
 * - 校验：cut 越界 / picks 重复 / 长度不符 / 越界 拒绝；
 * - 工具壳：execute 输出复现三元组；detail 含三元组行；「::: cards」卡模板行契约不变。
 */
import { describe, expect, it } from 'vitest'
import { createTarotTools, drawTarot } from '../src/tools/tarot.js'

describe('M78 golden：tarot_draw 复现三元组', () => {
  it('缺省兼容：cut/picks 缺省 == 显式 (0, [0..N-1])，与旧版逐位一致', () => {
    const legacy = drawTarot('three', 456)
    expect(legacy.cards.map((c) => `${c.name}|${c.orientation}`)).toEqual(['死神|逆位', '星币国王|逆位', '宝剑七|逆位'])
    expect(legacy.cut).toBe(0)
    expect(legacy.picks).toEqual([0, 1, 2])
    expect(drawTarot('three', 456, 0, [0, 1, 2])).toEqual(legacy)
  })

  it('cut/picks golden（seed=456 · picks=[7,23,61] · cut=1/2）与同参复现', () => {
    const a = drawTarot('three', 456, 1, [7, 23, 61])
    expect(a.cards.map((c) => `${c.name}|${c.orientation}`)).toEqual(['审判|正位', '圣杯国王|逆位', '权杖五|逆位'])
    const b = drawTarot('three', 456, 2, [7, 23, 61])
    expect(b.cards.map((c) => `${c.name}|${c.orientation}`)).toEqual(['圣杯十|逆位', '权杖王后|逆位', '权杖国王|逆位'])
    expect(a.picks).toEqual([7, 23, 61])
    expect(drawTarot('three', 456, 1, [7, 23, 61])).toEqual(a)
  })

  it('cut 旋转等价：cut=c 后位置 0 == 无切时位置 26×c（牌带正逆位随牌走）', () => {
    expect(drawTarot('single', 456, 1, [0]).cards[0]).toEqual(drawTarot('single', 456, 0, [26]).cards[0])
    expect(drawTarot('single', 456, 2, [0]).cards[0]).toEqual(drawTarot('single', 456, 0, [52]).cards[0])
  })

  it('single / cross 向量（seed=99 · picks=[42]；seed=77777 · cut=2 · picks=[4,15,26,37,48]）', () => {
    expect(drawTarot('single', 99, 0, [42]).cards.map((c) => `${c.name}|${c.orientation}`)).toEqual(['宝剑九|逆位'])
    expect(drawTarot('cross', 77777, 2, [4, 15, 26, 37, 48]).cards.map((c) => `${c.name}|${c.orientation}`)).toEqual([
      '世界|逆位',
      '太阳|逆位',
      '星币五|逆位',
      '圣杯十|正位',
      '皇后|逆位',
    ])
  })

  it('校验：cut 越界 / picks 重复 / 长度不符 / 越界 拒绝', () => {
    expect(() => drawTarot('three', 456, 3, [0, 1, 2])).toThrow('切牌参数须为 0 / 1 / 2')
    expect(() => drawTarot('three', 456, -1, [0, 1, 2])).toThrow('切牌参数须为 0 / 1 / 2')
    expect(() => drawTarot('three', 456, 0, [0, 0, 2])).toThrow('选牌参数无效')
    expect(() => drawTarot('three', 456, 0, [0, 1])).toThrow('选牌参数无效')
    expect(() => drawTarot('three', 456, 0, [0, 1, 78])).toThrow('选牌参数无效')
  })

  it('工具壳：execute 输出复现三元组；detail 含三元组行；cards 卡模板行契约不变', async () => {
    const [tool] = createTarotTools()
    const res = await tool!.execute({ spread: 'three', seed: 456, cut: 1, picks: [7, 23, 61] }, {} as never)
    expect(res.ok).toBe(true)
    expect(res.summary).toContain('切牌 1')
    expect(res.summary).toContain('选牌 [7,23,61]')
    expect(res.detail).toContain('复现三元组：seed=456 · cut=1 · picks=[7,23,61]')
    expect(res.detail).toContain('::: cards 三张牌阵')
    expect(res.detail).toContain('- 过去 | 审判 | 正位 |')
    // 校验失败路径：进 drawTarot 抛错 → ok:false
    const bad = await tool!.execute({ spread: 'three', seed: 456, cut: 9 }, {} as never)
    expect(bad.ok).toBe(false)
    expect(bad.summary).toContain('切牌参数')
  })
})

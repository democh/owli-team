/**
 * M69 golden：场景玩法工具（dice_roll 掷骰 / tarot_draw 抽牌）。
 *
 * 覆盖（docs/scene-expansion-v2-design.md §4）：
 * - 骰式解析与规范化（d20 / 3d6+2 / 2d10-1）、同种子逐位复现、骰面范围、边界拒绝、卡模板；
 * - 塔罗 78 张全表（大阿卡纳 + 小阿卡纳生成）、三牌阵张数、同种子复现、不重复、正逆位结构、卡模板；
 * - 工具壳：tier=deferred / readOnly / execute 返回结构。纯计算零 IO。
 */
import { describe, expect, it } from 'vitest'
import { createDiceTools, diceDetail, rollDice } from '../src/tools/dice.js'
import { createTarotTools, drawTarot, tarotDetail } from '../src/tools/tarot.js'

describe('M69 golden：dice_roll', () => {
  it('骰式解析与规范化（省略骰数 → 1d；修正符号）', () => {
    expect(rollDice('d20', 1).formula).toBe('d20')
    expect(rollDice('3d6+2', 1).formula).toBe('3d6+2')
    expect(rollDice('2D10 - 1', 1).formula).toBe('2d10-1')
    expect(rollDice(' 1d100 ', 1).formula).toBe('d100')
  })

  it('同种子逐位复现（golden：3d6+2 seed=88521 → 3+1+4=8，+2 总 10）', () => {
    const a = rollDice('3d6+2', 88521)
    expect(a.rolls).toEqual([3, 1, 4])
    expect(a.total).toBe(10)
    expect(a.seed).toBe(88521)
    const b = rollDice('3d6+2', 88521)
    expect(b).toEqual(a)
  })

  it('golden：d20-2 seed=12345 → 骰面 20，总 18', () => {
    const r = rollDice('d20-2', 12345)
    expect(r.rolls).toEqual([20])
    expect(r.total).toBe(18)
    expect(r.modifier).toBe(-2)
  })

  it('骰面范围与总数公式（不带种子多跑随机样本）', () => {
    for (let i = 0; i < 20; i++) {
      const r = rollDice('4d12+5')
      expect(r.rolls).toHaveLength(4)
      for (const v of r.rolls) {
        expect(v).toBeGreaterThanOrEqual(1)
        expect(v).toBeLessThanOrEqual(12)
      }
      expect(r.total).toBe(r.rolls.reduce((s, v) => s + v, 0) + 5)
      expect(r.seed).toBeGreaterThan(0)
    }
  })

  it('边界拒绝：非法骰式 / 骰数 / 面数 / 修正超限', () => {
    expect(() => rollDice('6')).toThrow('无法解析')
    expect(() => rollDice('d6d6')).toThrow('无法解析')
    expect(() => rollDice('0d6')).toThrow('骰数超出范围')
    expect(() => rollDice('101d6')).toThrow('骰数超出范围')
    expect(() => rollDice('d1')).toThrow('骰面超出范围')
    expect(() => rollDice('d1001')).toThrow('骰面超出范围')
    expect(() => rollDice('d6+99999')).toThrow('修正值超出范围')
  })

  it('卡模板：骰式行 + 明细行 + ::: roll 容器（种子回显）', () => {
    const d = diceDetail(rollDice('3d6+2', 88521), '攀爬检定')
    expect(d).toContain('::: roll 攀爬检定')
    expect(d).toContain('骰式：3d6+2 | 种子：88521')
    expect(d).toContain('明细：3 + 1 + 4 | 修正：+2 | 总值：10')
    expect(d).toContain(':::')
    // 无 label：用骰式作标题
    expect(diceDetail(rollDice('d20', 9))).toContain('::: roll d20')
  })

  it('工具壳：tier=deferred / readOnly / execute 返回 ok', async () => {
    const [tool] = createDiceTools()
    expect(tool?.name).toBe('dice_roll')
    expect(tool?.tier).toBe('deferred')
    expect(tool?.readOnly).toBe(true)
    const res = await tool!.execute({ formula: '2d6+1', seed: 6655 }, {} as never)
    expect(res.ok).toBe(true)
    expect(res.summary).toContain('种子 6655')
    expect(res.detail).toContain('::: roll')
  })
})

describe('M69 golden：tarot_draw', () => {
  it('三牌阵张数与结构（golden：seed=456 → 死神·逆 / 星币国王·逆 / 宝剑七·逆）', () => {
    const r = drawTarot('three', 456)
    expect(r.spreadName).toBe('三张牌阵')
    expect(r.cards.map((c) => c.position)).toEqual(['过去', '现在', '未来'])
    expect(r.cards.map((c) => `${c.name}|${c.orientation}`)).toEqual(['死神|逆位', '星币国王|逆位', '宝剑七|逆位'])
    expect(r.cards[0]?.keywords).toEqual(['结束', '转化', '重生'])
    expect(r.seed).toBe(456)
  })

  it('五张十字阵（golden：seed=77777）与同种子复现', () => {
    const r = drawTarot('cross', 77777)
    expect(r.cards).toHaveLength(5)
    expect(r.cards.map((c) => c.position)).toEqual(['核心', '横越', '根基', '过去', '未来'])
    expect(r.cards.map((c) => c.name)).toEqual(['星币五', '星币王后', '死神', '星币九', '宝剑首牌'])
    expect(drawTarot('cross', 77777)).toEqual(r)
  })

  it('单张牌阵 + 78 张全表约束（不重复 / 关键词三枚 / 正逆位枚举）', () => {
    expect(drawTarot('single', 3).cards).toHaveLength(1)
    for (let s = 1; s <= 30; s++) {
      const r = drawTarot('cross', s * 1234 + 7)
      const names = r.cards.map((c) => c.name)
      expect(new Set(names).size).toBe(5)
      for (const c of r.cards) {
        expect(['正位', '逆位']).toContain(c.orientation)
        expect(c.keywords).toHaveLength(3)
      }
    }
  })

  it('大 / 小阿卡纳混合抽取（全表覆盖抽样）', () => {
    const seenMajor = new Set<string>()
    const seenMinor = new Set<string>()
    for (let s = 1; s <= 120; s++) {
      for (const c of drawTarot('cross', s * 4093 + 11).cards) {
        if (c.name.includes('权杖') || c.name.includes('圣杯') || c.name.includes('宝剑') || c.name.includes('星币')) seenMinor.add(c.name)
        else seenMajor.add(c.name)
      }
    }
    // 120 组 × 5 张样本内，小阿卡纳覆盖四种花色（大阿卡纳覆盖≥5 张）
    expect(seenMinor.size).toBeGreaterThan(40)
    expect(seenMajor.size).toBeGreaterThan(5)
  })

  it('卡模板：牌位行 + ::: cards 容器 + 非法牌阵拒绝', () => {
    const d = tarotDetail(drawTarot('three', 456), '这个项目')
    expect(d).toContain('::: cards 三张牌阵')
    expect(d).toContain('- 过去 | 死神 | 逆位 | 结束 · 转化 · 重生')
    expect(d).toContain('所问：这个项目')
    expect(d).toContain('种子：456')
    expect(() => drawTarot('celtic')).toThrow('牌阵无法识别')
  })

  it('工具壳：tier=deferred / readOnly / execute 返回 ok', async () => {
    const [tool] = createTarotTools()
    expect(tool?.name).toBe('tarot_draw')
    expect(tool?.tier).toBe('deferred')
    expect(tool?.readOnly).toBe(true)
    const res = await tool!.execute({ spread: 'single', seed: 99 }, {} as never)
    expect(res.ok).toBe(true)
    expect(res.detail).toContain('::: cards')
  })
})

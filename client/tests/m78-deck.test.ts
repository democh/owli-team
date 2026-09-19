/**
 * M78 交叉向量：客户端复现层（deck.ts）与 server tarot_draw 逐位同源——见 docs/tarot-ritual-design.md §6 / §12.2。
 *
 * 期望值与 server/tests/m78-tarot-ritual.test.ts 字面相同（任一端表/算法变更必须同步另一端并更新两侧向量）。
 * 覆盖：golden 五组（缺省兼容 / cut / picks / single / cross）+ 旋转等价 + slug 映射 78 项 + 牌阵结构。
 */
import { describe, expect, it } from 'vitest'
import { DECK, DECK_SIZE, MAJOR_COUNT, RANKS, SPREADS, SPREAD_LIST, SUITS, cardSlugOf, ritualDraw } from '../src/components/chat/md-ext/tarot/deck'

const fmt = (cards: ReturnType<typeof ritualDraw>): string[] => cards.map((c) => `${c.name}|${c.orientation}`)

describe('M78 交叉向量：deck.ts ↔ tarot_draw', () => {
  it('缺省兼容（seed=456 三张阵，与 server 既有 golden 一致）', () => {
    expect(fmt(ritualDraw('three', 456, 0, [0, 1, 2]))).toEqual(['死神|逆位', '星币国王|逆位', '宝剑七|逆位'])
  })

  it('cut/picks golden（seed=456 · picks=[7,23,61] · cut=1/2）', () => {
    expect(fmt(ritualDraw('three', 456, 1, [7, 23, 61]))).toEqual(['审判|正位', '圣杯国王|逆位', '权杖五|逆位'])
    expect(fmt(ritualDraw('three', 456, 2, [7, 23, 61]))).toEqual(['圣杯十|逆位', '权杖王后|逆位', '权杖国王|逆位'])
  })

  it('single / cross 向量（seed=99 · picks=[42]；seed=77777 · cut=2 · picks=[4,15,26,37,48]）', () => {
    expect(fmt(ritualDraw('single', 99, 0, [42]))).toEqual(['宝剑九|逆位'])
    expect(fmt(ritualDraw('cross', 77777, 2, [4, 15, 26, 37, 48]))).toEqual(['世界|逆位', '太阳|逆位', '星币五|逆位', '圣杯十|正位', '皇后|逆位'])
  })

  it('cut 旋转等价：cut=c 后位置 0 == 无切时位置 26×c（牌带正逆位随牌走）', () => {
    expect(ritualDraw('single', 456, 1, [0])[0]).toEqual(ritualDraw('single', 456, 0, [26])[0])
    expect(ritualDraw('single', 456, 2, [0])[0]).toEqual(ritualDraw('single', 456, 0, [52])[0])
  })

  it('78 张表：张数 / slug 唯一且规则正确 / 大牌序号连续 / 小牌花色阶数完整', () => {
    expect(DECK).toHaveLength(DECK_SIZE)
    expect(MAJOR_COUNT).toBe(22)
    // slug 全表唯一
    const slugs = DECK.map((c) => c.slug)
    expect(new Set(slugs).size).toBe(DECK_SIZE)
    // 大牌 00-21
    expect(slugs.slice(0, 22)).toEqual(Array.from({ length: 22 }, (_, i) => `major-${String(i).padStart(2, '0')}`))
    // 小牌：四花色 × 14 阶
    const suitSlugs = ['wands', 'cups', 'swords', 'pents']
    for (const s of suitSlugs) {
      expect(slugs.filter((x) => x.startsWith(`${s}-`))).toHaveLength(14)
    }
    // 关键词：每张 3 枚；cardSlugOf 与表一致
    for (const c of DECK) {
      expect(c.keywords).toHaveLength(3)
      expect(cardSlugOf(c.name)).toBe(c.slug)
    }
    expect(cardSlugOf('不存在的牌')).toBe('')
  })

  it('牌阵结构：三阵张数与牌位语义（positions/hints 对齐）', () => {
    expect(SPREAD_LIST.map((s) => s.id)).toEqual(['single', 'three', 'cross'])
    expect(SPREADS.single.positions).toEqual(['当下'])
    expect(SPREADS.three.positions).toEqual(['过去', '现在', '未来'])
    expect(SPREADS.cross.positions).toEqual(['核心', '横越', '根基', '过去', '未来'])
    for (const id of ['single', 'three', 'cross'] as const) {
      expect(SPREADS[id].hints).toHaveLength(SPREADS[id].positions.length)
    }
    // 花色与阶名（与 server 一致）
    expect(SUITS.map((s) => s.name)).toEqual(['权杖', '圣杯', '宝剑', '星币'])
    expect(RANKS).toHaveLength(14)
  })
})

/**
 * M54-C t3：盘面对照差异分析单测（§5.3）——纯函数，无组件。
 * 覆盖：八字（日主/逐柱/五行/起运缺省）、紫微（逐宫主星集合 + 四化 + 中宫）、
 * 星盘（行星落点 + 上升）、卦（本卦变卦 + 爻模式）；异 kind → null（仅并排）。
 */
import { describe, expect, it } from 'vitest'
import { diffPan } from '../src/components/chat/md-ext/pan/diff'
import type {
  BaziModel,
  GuaModel,
  GuaYao,
  NatalModel,
  ZiweiModel,
  ZiweiPalace,
  ZiweiStar,
} from '../src/components/chat/md-ext/pan/model'

// ---------------------------------------------------------------------------
// 八字
// ---------------------------------------------------------------------------

const baziA: BaziModel = {
  kind: 'bazi',
  pillars: [
    { name: '年', gan: '庚', zhi: '午' },
    { name: '月', gan: '辛', zhi: '巳' },
    { name: '日', gan: '丁', zhi: '丑' },
    { name: '时', gan: '丁', zhi: '未' },
  ],
  wuxing: { 木: 0, 火: 4, 土: 2, 金: 2, 水: 0 },
  dayMaster: { gan: '丁', yinYang: '阴火' },
  daYun: [{ ganZhi: '甲申', ages: [29, 38], years: [2018, 2027], current: true }],
  liuNian: [],
  detail: [],
}

const baziB: BaziModel = {
  ...baziA,
  pillars: [baziA.pillars[0], baziA.pillars[1], { name: '日', gan: '乙', zhi: '巳' }, baziA.pillars[3]],
  wuxing: { 木: 1, 火: 4, 土: 1, 金: 2, 水: 0 },
  dayMaster: { gan: '乙', yinYang: '阴木' },
}

// ---------------------------------------------------------------------------
// 紫微
// ---------------------------------------------------------------------------

const ZHI = '子丑寅卯辰巳午未申酉戌亥'.split('')
const ZW_NAMES = ['命宫', '兄弟', '夫妻', '子女', '财帛', '疾厄', '迁移', '交友', '官禄', '田宅', '福德', '父母']

function zwPalace(i: number, stars: ZiweiStar[]): ZiweiPalace {
  return {
    name: ZW_NAMES[i]!,
    gan: '甲',
    zhi: ZHI[i]!,
    zhiIndex: i,
    stars,
    assist: '',
    misc: '',
    daXian: { range: [i * 10, i * 10 + 9], current: false },
    shenGong: false,
    raw: '',
  }
}

function zwModel(ming: ZiweiStar[], brother: ZiweiStar[]): ZiweiModel {
  return {
    kind: 'ziwei',
    palaces: ZW_NAMES.map((_, i) => zwPalace(i, i === 0 ? ming : i === 1 ? brother : [])),
    center: { wuXingJu: '土五局', mingZhu: '武曲', shenZhu: '天相', siHua: [{ mutagen: '禄', star: '太阳' }] },
    detail: [],
  }
}

// ---------------------------------------------------------------------------
// 星盘 / 卦
// ---------------------------------------------------------------------------

const natalA: NatalModel = {
  kind: 'natal',
  planets: [
    { name: '太阳', sign: '金牛', deg: 21.5, lon: 51.5, house: 10, retro: false },
    { name: '月亮', sign: '天蝎', deg: 3.2, lon: 213.2, retro: true },
  ],
  cusps: null,
  asc: 130.5,
  aspects: [],
  detail: [],
}

const natalB: NatalModel = {
  ...natalA,
  planets: [{ ...natalA.planets[0]!, deg: 22.1, lon: 52.1 }, natalA.planets[1]!],
}

function yao(pos: GuaYao['pos'], yin: boolean, extra: Partial<GuaYao> = {}): GuaYao {
  return { pos, yin, dong: false, kong: false, liuShen: '青龙', liuQin: '兄弟', ganZhi: '庚子', wuXing: '水', ...extra }
}

const guaA: GuaModel = {
  kind: 'gua',
  ben: '水雷屯',
  bianName: '山雷颐',
  yao: [
    yao(1, false),
    yao(2, true),
    yao(3, true),
    yao(4, true),
    yao(5, false, { dong: true, shiYing: '应' }),
    yao(6, true, { dong: true }),
  ],
  detail: [],
}

const guaB: GuaModel = {
  kind: 'gua',
  ben: '水雷屯',
  bianName: '山雷颐',
  yao: [yao(1, false), yao(2, true), yao(3, true), yao(4, true), yao(5, false), yao(6, true)],
  detail: [],
}

// ---------------------------------------------------------------------------

describe('diffPan 盘面对照差异', () => {
  it('八字：日主 / 逐柱 / 五行 / 起运（缺省破折号）；相同柱不标差异', () => {
    const rows = diffPan(baziA, baziB)!
    expect(rows.map((r) => r.label)).toEqual(['日主', '年柱', '月柱', '日柱', '时柱', '五行', '起运'])
    expect(rows[0]!.diff).toBe(true) // 日主 丁（阴火）→ 乙（阴木）
    expect(rows[0]!.a).toBe('丁（阴火）')
    expect(rows[1]!.diff).toBe(false) // 年柱同
    expect(rows[2]!.diff).toBe(false) // 月柱同
    expect(rows[3]!.diff).toBe(true) // 日柱 丁丑 → 乙巳
    expect(rows[3]!.a).toBe('丁丑')
    expect(rows[3]!.b).toBe('乙巳')
    expect(rows[5]!.diff).toBe(true) // 五行计数
    expect(rows[6]!.a).toBe('—') // 起运缺省
  })

  it('紫微：逐宫主星集合（四化入值）+ 中宫 + 生年四化', () => {
    const a = zwModel([{ name: '紫微' }, { name: '天府' }], [])
    const b = zwModel([{ name: '紫微', mutagen: '权' }], [{ name: '天魁' }])
    const rows = diffPan(a, b)!
    expect(rows.map((r) => r.label)).toEqual([...ZW_NAMES, '中宫', '生年四化'])
    expect(rows[0]!.a).toBe('紫微、天府')
    expect(rows[0]!.b).toBe('紫微(权)')
    expect(rows[0]!.diff).toBe(true)
    expect(rows[1]!.a).toBe('空宫')
    expect(rows[1]!.b).toBe('天魁')
    expect(rows[2]!.diff).toBe(false) // 夫妻宫同空
    expect(rows[12]!.a).toBe('土五局 武曲 天相') // 中宫
    expect(rows[12]!.diff).toBe(false)
    expect(rows[13]!.diff).toBe(false) // 生年四化同
  })

  it('星盘：逐行星落点（逆行标注）+ 上升', () => {
    const rows = diffPan(natalA, natalB)!
    expect(rows.map((r) => r.label)).toEqual(['太阳', '月亮', '上升'])
    expect(rows[0]!.diff).toBe(true)
    expect(rows[0]!.a).toBe('金牛21.5°')
    expect(rows[0]!.b).toBe('金牛22.1°')
    expect(rows[1]!.diff).toBe(false)
    expect(rows[1]!.a).toBe('天蝎3.2° 逆')
    expect(rows[2]!.a).toBe('狮子10.5°')
  })

  it('卦：本卦变卦 + 逐爻模式（阴阳 · 动 · 世应）', () => {
    const rows = diffPan(guaA, guaB)!
    expect(rows.map((r) => r.label)).toEqual(['本卦', '初爻', '二爻', '三爻', '四爻', '五爻', '上爻'])
    expect(rows[0]!.diff).toBe(false)
    expect(rows[0]!.a).toBe('水雷屯 → 山雷颐')
    expect(rows[1]!.diff).toBe(false)
    expect(rows[5]!.diff).toBe(true) // 五爻：动+应 → 静
    expect(rows[5]!.a).toBe('▬▬▬ 动 应')
    expect(rows[5]!.b).toBe('▬▬▬')
    expect(rows[6]!.diff).toBe(true) // 上爻：动 → 静
  })

  it('异 kind → null（调用方仅并排，不做差异）', () => {
    expect(diffPan(baziA, guaA)).toBeNull()
    expect(diffPan(guaA, natalA)).toBeNull()
  })
})

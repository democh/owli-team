/**
 * M51-E：六爻 / 梅花易数起卦装卦（自研，规则代码化，种子可复现）。
 *
 * - 起卦：time 梅花时间起卦（农历年月日时）/ coin 三枚铜钱摇卦（种子复现）/ number 两数起卦；
 * - 装卦：京房八宫（卦宫 / 世应）→ 纳甲（干支）→ 六亲（按卦宫五行）→ 六神（按日干）；
 * - 变卦 / 互卦 / 梅花体用；卦用固定种子复现（design §6.1）。
 *
 * 爻位约定：内部 bits 字符串从初爻（索引 0）到上爻（索引 5），'1' = 阳、'0' = 阴。
 */
import { Solar } from 'lunar-typescript'
import { PanError, parseDateTime, WuXingKey, ZHI_WUXING } from './types.js'

const WUXING_CN: Record<WuXingKey, string> = { wood: '木', fire: '火', earth: '土', metal: '金', water: '水' }
const SHENG: Record<WuXingKey, WuXingKey> = { wood: 'fire', fire: 'earth', earth: 'metal', metal: 'water', water: 'wood' }
const KE: Record<WuXingKey, WuXingKey> = { wood: 'earth', earth: 'water', water: 'fire', fire: 'metal', metal: 'wood' }

// ---------------------------------------------------------------------------
// 静态表：八卦 / 先天数 / 京房八宫 / 纳甲 / 六神
// ---------------------------------------------------------------------------

/** 三爻卦（键 = 初→上 的 0/1 串；先天五行） */
export const TRIGRAM_BY_BITS: Record<string, { name: string; nature: string; element: WuXingKey }> = {
  '111': { name: '乾', nature: '天', element: 'metal' },
  '110': { name: '兑', nature: '泽', element: 'metal' },
  '101': { name: '离', nature: '火', element: 'fire' },
  '100': { name: '震', nature: '雷', element: 'wood' },
  '011': { name: '巽', nature: '风', element: 'wood' },
  '010': { name: '坎', nature: '水', element: 'water' },
  '001': { name: '艮', nature: '山', element: 'earth' },
  '000': { name: '坤', nature: '地', element: 'earth' },
}

/** 先天八卦数（梅花起卦用）：乾1 兑2 离3 震4 巽5 坎6 艮7 坤8（索引 0 占位） */
const TRIGRAM_BY_NUM: string[] = ['', '111', '110', '101', '100', '011', '010', '001', '000']

/** 地支数（子1 … 亥12） */
const ZHI_NUM: Record<string, number> = {
  子: 1, 丑: 2, 寅: 3, 卯: 4, 辰: 5, 巳: 6, 午: 7, 未: 8, 申: 9, 酉: 10, 戌: 11, 亥: 12,
}

/** 京房八宫首卦（重卦 bits） */
const PALACE_ORDER: Array<{ name: string; bits: string }> = [
  { name: '乾', bits: '111111' },
  { name: '坎', bits: '010010' },
  { name: '艮', bits: '001001' },
  { name: '震', bits: '100100' },
  { name: '巽', bits: '011011' },
  { name: '离', bits: '101101' },
  { name: '坤', bits: '000000' },
  { name: '兑', bits: '110110' },
]

/** 六十四卦标准全名（键 = 初→上 bits；重卦「X为Y」，余为「上象+下象+卦名」） */
export const HEX_NAMES: Record<string, string> = {
  // 上乾（天）
  '111111': '乾为天', '110111': '天泽履', '101111': '天火同人', '100111': '天雷无妄',
  '011111': '天风姤', '010111': '天水讼', '001111': '天山遁', '000111': '天地否',
  // 上坤（地）
  '111000': '地天泰', '110000': '地泽临', '101000': '地火明夷', '100000': '地雷复',
  '011000': '地风升', '010000': '地水师', '001000': '地山谦', '000000': '坤为地',
  // 上震（雷）
  '111100': '雷天大壮', '110100': '雷泽归妹', '101100': '雷火丰', '100100': '震为雷',
  '011100': '雷风恒', '010100': '雷水解', '001100': '雷山小过', '000100': '雷地豫',
  // 上巽（风）
  '111011': '风天小畜', '110011': '风泽中孚', '101011': '风火家人', '100011': '风雷益',
  '011011': '巽为风', '010011': '风水涣', '001011': '风山渐', '000011': '风地观',
  // 上坎（水）
  '111010': '水天需', '110010': '水泽节', '101010': '水火既济', '100010': '水雷屯',
  '011010': '水风井', '010010': '坎为水', '001010': '水山蹇', '000010': '水地比',
  // 上离（火）
  '111101': '火天大有', '110101': '火泽睽', '101101': '离为火', '100101': '火雷噬嗑',
  '011101': '火风鼎', '010101': '火水未济', '001101': '火山旅', '000101': '火地晋',
  // 上艮（山）
  '111001': '山天大畜', '110001': '山泽损', '101001': '山火贲', '100001': '山雷颐',
  '011001': '山风蛊', '010001': '山水蒙', '001001': '艮为山', '000001': '山地剥',
  // 上兑（泽）
  '111110': '泽天夬', '110110': '兑为泽', '101110': '泽火革', '100110': '泽雷随',
  '011110': '泽风大过', '010110': '泽水困', '001110': '泽山咸', '000110': '泽地萃',
}

/** 纳甲（内卦：初→三 的干支） */
const NAJIA_INNER: Record<string, string[]> = {
  '111': ['甲子', '甲寅', '甲辰'],
  '110': ['丁巳', '丁卯', '丁丑'],
  '101': ['己卯', '己丑', '己亥'],
  '100': ['庚子', '庚寅', '庚辰'],
  '011': ['辛丑', '辛亥', '辛酉'],
  '010': ['戊寅', '戊辰', '戊午'],
  '001': ['丙辰', '丙午', '丙申'],
  '000': ['乙未', '乙巳', '乙卯'],
}

/** 纳甲（外卦：四→上 的干支） */
const NAJIA_OUTER: Record<string, string[]> = {
  '111': ['壬午', '壬申', '壬戌'],
  '110': ['丁亥', '丁酉', '丁未'],
  '101': ['己酉', '己未', '己巳'],
  '100': ['庚午', '庚申', '庚戌'],
  '011': ['辛未', '辛巳', '辛卯'],
  '010': ['戊申', '戊戌', '戊子'],
  '001': ['丙戌', '丙子', '丙寅'],
  '000': ['癸丑', '癸亥', '癸酉'],
}

/** 六神（初爻起按日干取首，顺序固定） */
const LIU_SHEN = ['青龙', '朱雀', '勾陈', '腾蛇', '白虎', '玄武']

const YAO_POS_NAME = ['初', '二', '三', '四', '五', '上']

// ---------------------------------------------------------------------------
// 六十四卦表（生成：宫首卦五变 + 游魂 + 归魂）
// ---------------------------------------------------------------------------

export interface GuaHexagram {
  bits: string
  name: string
  palace: string
  palaceElement: WuXingKey
  /** 世爻位置（1-6） */
  shi: number
  /** 应爻位置（1-6，世之对宫） */
  ying: number
}

/** 六十四卦查表（键 = 初→上 bits；共 64 项，golden 测试断言） */
export const HEXAGRAMS: Record<string, GuaHexagram> = (() => {
  const map: Record<string, GuaHexagram> = {}
  const flip = (s: string, i: number): string => s.slice(0, i) + (s[i] === '1' ? '0' : '1') + s.slice(i + 1)
  const nameOf = (bits: string): string => {
    if (HEX_NAMES[bits]) return HEX_NAMES[bits]!
    const lower = TRIGRAM_BY_BITS[bits.slice(0, 3)]!
    const upper = TRIGRAM_BY_BITS[bits.slice(3)]!
    return `${upper.nature}${lower.nature}`
  }
  for (const seed of PALACE_ORDER) {
    const element = TRIGRAM_BY_BITS[seed.bits.slice(0, 3)]!.element
    let cur = seed.bits
    const seq: Array<{ bits: string; shi: number }> = [{ bits: cur, shi: 6 }] // 本宫
    cur = flip(cur, 0); seq.push({ bits: cur, shi: 1 }) // 一世
    cur = flip(cur, 1); seq.push({ bits: cur, shi: 2 }) // 二世
    cur = flip(cur, 2); seq.push({ bits: cur, shi: 3 }) // 三世
    cur = flip(cur, 3); seq.push({ bits: cur, shi: 4 }) // 四世
    cur = flip(cur, 4); seq.push({ bits: cur, shi: 5 }) // 五世
    cur = flip(cur, 3); seq.push({ bits: cur, shi: 4 }) // 游魂（四爻再变）
    cur = seed.bits.slice(0, 3) + cur.slice(3); seq.push({ bits: cur, shi: 3 }) // 归魂（内卦归本宫）
    for (const item of seq) {
      map[item.bits] = {
        bits: item.bits,
        name: nameOf(item.bits),
        palace: seed.name,
        palaceElement: element,
        shi: item.shi,
        ying: item.shi > 3 ? item.shi - 3 : item.shi + 3,
      }
    }
  }
  return map
})()

// ---------------------------------------------------------------------------
// 六亲 / 六神
// ---------------------------------------------------------------------------

function liuQinOf(palaceEl: WuXingKey, yaoEl: WuXingKey): string {
  if (palaceEl === yaoEl) return '兄弟'
  if (SHENG[yaoEl] === palaceEl) return '父母'
  if (SHENG[palaceEl] === yaoEl) return '子孙'
  if (KE[yaoEl] === palaceEl) return '官鬼'
  return '妻财'
}

/** 日干 → 六神在初爻的起首索引 */
function liuShenStart(dayGan: string): number {
  if (dayGan === '甲' || dayGan === '乙') return 0
  if (dayGan === '丙' || dayGan === '丁') return 1
  if (dayGan === '戊') return 2
  if (dayGan === '己') return 3
  if (dayGan === '庚' || dayGan === '辛') return 4
  return 5
}

// ---------------------------------------------------------------------------
// M63-A：伏神 / 月建日辰关系 / 回头生克
// ---------------------------------------------------------------------------

/** 地支相冲对 */
const ZHI_CHONG_PAIRS: Array<[string, string]> = [
  ['子', '午'], ['丑', '未'], ['寅', '申'], ['卯', '酉'], ['辰', '戌'], ['巳', '亥'],
]

const isChong = (a: string, b: string): boolean =>
  ZHI_CHONG_PAIRS.some(([x, y]) => (x === a && y === b) || (x === b && y === a))

const ALL_QIN = ['父母', '兄弟', '子孙', '妻财', '官鬼']

/**
 * 伏神（附录 A.5）：本宫首卦（八宫各一）的六亲配置；本卦所缺之亲伏于首卦该亲首个爻位。
 * 返回 Map<爻位 1-6, 伏神>。
 */
function computeFuShen(bits: string, hex: GuaHexagram): Map<number, { liuQin: string; ganZhi: string; wuxing: string }> {
  const map = new Map<number, { liuQin: string; ganZhi: string; wuxing: string }>()
  const inner = NAJIA_INNER[bits.slice(0, 3)]!
  const outer = NAJIA_OUTER[bits.slice(3)]!
  const present = new Set<string>()
  for (let i = 0; i < 6; i++) {
    const gz = i < 3 ? inner[i]! : outer[i - 3]!
    present.add(liuQinOf(hex.palaceElement, ZHI_WUXING[gz.charAt(1)] ?? 'earth'))
  }
  const seedBits = PALACE_ORDER.find((p) => p.name === hex.palace)?.bits
  if (!seedBits) return map
  const sInner = NAJIA_INNER[seedBits.slice(0, 3)]!
  const sOuter = NAJIA_OUTER[seedBits.slice(3)]!
  for (const qin of ALL_QIN) {
    if (present.has(qin)) continue
    for (let i = 0; i < 6; i++) {
      const gz = i < 3 ? sInner[i]! : sOuter[i - 3]!
      const el = ZHI_WUXING[gz.charAt(1)] ?? 'earth'
      if (liuQinOf(hex.palaceElement, el) === qin) {
        map.set(i + 1, { liuQin: qin, ganZhi: gz, wuxing: WUXING_CN[el] })
        break
      }
    }
  }
  return map
}

/**
 * 月建 / 日辰关系（附录 A.5）：
 * - 月破 = 爻支与月建相冲；
 * - 静爻与日辰相冲：旺相 → 暗动、衰囚 → 日破；
 * - 旺相休囚死简档（以月建五行为令：当令旺 / 令生相 / 生令休 / 克令囚 / 令克死）。
 */
function dayRelationTags(zhi: string, isDong: boolean, monthZhi: string, dayZhi: string): string[] {
  const tags: string[] = []
  const el = ZHI_WUXING[zhi] ?? 'earth'
  const monthEl = ZHI_WUXING[monthZhi] ?? 'earth'
  const strong = el === monthEl || SHENG[monthEl] === el
  if (isChong(zhi, monthZhi)) tags.push('月破')
  if (!isDong && isChong(zhi, dayZhi)) tags.push(strong ? '暗动' : '日破')
  if (el === monthEl) tags.push('旺')
  else if (SHENG[monthEl] === el) tags.push('相')
  else if (SHENG[el] === monthEl) tags.push('休')
  else if (KE[el] === monthEl) tags.push('囚')
  else tags.push('死')
  return tags
}

/** 回头生克（附录 A.5）：变爻对动爻——生我回头生 / 克我回头克 / 我生回头泄 */
function bianHintOf(own: WuXingKey, bian: WuXingKey): '回头生' | '回头克' | '回头泄' | undefined {
  if (SHENG[bian] === own) return '回头生'
  if (KE[bian] === own) return '回头克'
  if (SHENG[own] === bian) return '回头泄'
  return undefined
}

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface GuaInfo {
  name: string
  bits: string
  upper: string
  upperNature: string
  /** 上卦五行（八卦先天五行，中文字） */
  upperElement: string
  lower: string
  lowerNature: string
  lowerElement: string
  palace: string
  palaceElement: string
  shi: number
  ying: number
}

export interface GuaLine {
  pos: number
  /** 爻位名（初 / 二 / … / 上） */
  label: string
  /** 爻题（初九 / 六二 / … / 上六；位名与九六按通行书法） */
  title: string
  yinYang: '阳' | '阴'
  dong: boolean
  /** 纳甲干支（如「甲子」） */
  ganZhi: string
  zhi: string
  wuxing: string
  liuQin: string
  liuShen: string
  /** 世 / 应 / '' */
  shiYing: string
  /** 爻支落旬空（按日辰旬空） */
  kongWang: boolean
  /** 动爻变卦后纳甲 */
  bianGanZhi?: string
  /** 动爻变卦后五行（中文） */
  bianWuxing?: string
  bianLiuQin?: string
  /** 伏神（本宫首卦所缺六亲：六亲 + 干支 + 五行；仅缺失亲所在爻位；M63-A） */
  fuShen?: { liuQin: string; ganZhi: string; wuxing: string }
  /** 月建 / 日辰关系标签（月破 / 日破 / 暗动 + 旺相休囚死简档；M63-A） */
  dayRelations?: string[]
  /** 回头生克标注（变爻对动爻：回头生 / 回头克 / 回头泄；M63-A） */
  bianHint?: '回头生' | '回头克' | '回头泄'
}

/** 卦气：起卦时刻四柱 + 日辰旬空 */
export interface GuaDayInfo {
  /** 起卦时刻四柱（年 / 月 / 日 / 时干支） */
  pillars: { year: string; month: string; day: string; hour: string }
  /** 日辰旬空（两支，如「子丑」） */
  xunKong: string
  /** 农历日描述（如「二〇二五年冬月十三」） */
  lunar: string
}

export interface TiYongInfo {
  ti: string
  yong: string
  tiElement: string
  yongElement: string
  relation: string
  note: string
}

export interface GuaInput {
  method: 'time' | 'coin' | 'number'
  /** 起卦时间 'YYYY-MM-DD HH:mm'（time 方式必填；coin / number 用于六神日干，缺省当天） */
  date?: string
  /** 摇卦随机种子（同种子结果可复现；缺省按当前时间派生） */
  seed?: number
  /** 数字起卦的两个数（method=number 必填） */
  numbers?: [number, number]
  /** 所问之事（回显，便于存档） */
  question?: string
}

export interface GuaResult {
  input: { method: string; question: string; date: string; seed?: number; numbers?: [number, number] }
  methodLabel: string
  /** 卦气：起卦时刻四柱 + 日辰旬空（装卦依据） */
  dayInfo: GuaDayInfo
  ben: GuaInfo
  bian: GuaInfo
  hu: GuaInfo
  /** 错卦（六爻全变） */
  cuo: GuaInfo
  /** 综卦（六爻颠倒） */
  zong: GuaInfo
  dongYao: number[]
  dongYaoLabel: string[]
  /** 各爻 6/7/8/9（仅摇卦；6 老阴 / 7 少阳 / 8 少阴 / 9 老阳） */
  yaoDigits: number[] | null
  lines: GuaLine[]
  tiYong: TiYongInfo | null
  warnings: string[]
}

// ---------------------------------------------------------------------------
// 起卦
// ---------------------------------------------------------------------------

/** 时间起卦（梅花）：农历年支数 + 月 + 日 → 上卦；再加时辰数 → 下卦；总数 → 动爻 */
function qiGuaByTime(date: string): { bits: string; dong: number; lunarDesc: string } {
  const t = parseDateTime(date, '起卦时间')
  const lunar = Solar.fromYmdHms(t.y, t.m, t.d, t.hh, t.mm, 0).getLunar()
  const yearNum = ZHI_NUM[lunar.getYearZhi()] ?? 1
  const monthNum = Math.abs(lunar.getMonth())
  const dayNum = lunar.getDay()
  const timeNum = ZHI_NUM[lunar.getTimeZhi()] ?? 1
  const sum1 = yearNum + monthNum + dayNum
  const sum2 = sum1 + timeNum
  const upperIdx = sum1 % 8 === 0 ? 8 : sum1 % 8
  const lowerIdx = sum2 % 8 === 0 ? 8 : sum2 % 8
  const dong = sum2 % 6 === 0 ? 6 : sum2 % 6
  return {
    bits: TRIGRAM_BY_NUM[lowerIdx]! + TRIGRAM_BY_NUM[upperIdx]!,
    dong,
    lunarDesc: `${lunar.getYearInGanZhi()}年${lunar.getMonthInChinese()}月${lunar.getDayInChinese()}日 ${lunar.getTimeZhi()}时（${lunar.getMonthInChinese()}月为农历）`,
  }
}

/** mulberry32（确定性 PRNG；种子可复现） */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 摇卦：三枚铜钱 × 六爻（自初爻起）；背 = 3、字 = 2，和为 6/9 为动爻 */
function qiGuaByCoin(seed: number): { bits: string; dongSet: number[]; yaoDigits: number[] } {
  const rand = mulberry32(seed)
  const chars: string[] = []
  const dongSet: number[] = []
  const yaoDigits: number[] = []
  for (let i = 0; i < 6; i++) {
    const coins = [0, 0, 0].map(() => (rand() < 0.5 ? 2 : 3))
    const sum = coins[0]! + coins[1]! + coins[2]!
    yaoDigits.push(sum)
    if (sum === 6) { chars.push('0'); dongSet.push(i + 1) } // 老阴
    else if (sum === 9) { chars.push('1'); dongSet.push(i + 1) } // 老阳
    else chars.push(sum === 7 ? '1' : '0') // 少阳 / 少阴
  }
  return { bits: chars.join(''), dongSet, yaoDigits }
}

/** 数字起卦（梅花）：n1 % 8 → 上卦；n2 % 8 → 下卦；n1 + n2 % 6 → 动爻 */
function qiGuaByNumber(numbers: [number, number]): { bits: string; dong: number } {
  const [n1, n2] = numbers
  if (!Number.isFinite(n1) || !Number.isFinite(n2)) {
    throw new PanError(`数字起卦参数非法：${JSON.stringify(numbers)}`, '请提供两个有限数字，如 numbers: [17, 28]')
  }
  const mod = (n: number, m: number): number => {
    const r = n % m
    return r === 0 ? m : r < 0 ? r + m : r
  }
  const upperIdx = mod(n1, 8)
  const lowerIdx = mod(n2, 8)
  const dong = mod(n1 + n2, 6)
  return { bits: TRIGRAM_BY_NUM[lowerIdx]! + TRIGRAM_BY_NUM[upperIdx]!, dong }
}

// ---------------------------------------------------------------------------
// 装卦 / 组装
// ---------------------------------------------------------------------------

function toGuaInfo(bits: string): GuaInfo {
  const h = HEXAGRAMS[bits]
  if (!h) throw new PanError(`内部错误：未知卦象 ${bits}`, '请反馈该案例（六十四卦枚举表缺项）')
  const lower = TRIGRAM_BY_BITS[bits.slice(0, 3)]!
  const upper = TRIGRAM_BY_BITS[bits.slice(3)]!
  return {
    name: h.name,
    bits,
    upper: upper.name,
    upperNature: upper.nature,
    upperElement: WUXING_CN[upper.element],
    lower: lower.name,
    lowerNature: lower.nature,
    lowerElement: WUXING_CN[lower.element],
    palace: h.palace,
    palaceElement: WUXING_CN[h.palaceElement],
    shi: h.shi,
    ying: h.ying,
  }
}

function buildLines(
  bits: string,
  hex: GuaHexagram,
  dongSet: Set<number>,
  bianBits: string,
  dayGan: string,
  kongSet: Set<string>,
  extras: { monthZhi: string; dayZhi: string; fuShen: Map<number, { liuQin: string; ganZhi: string; wuxing: string }> },
): GuaLine[] {
  const inner = NAJIA_INNER[bits.slice(0, 3)]!
  const outer = NAJIA_OUTER[bits.slice(3)]!
  const bianInner = NAJIA_INNER[bianBits.slice(0, 3)]!
  const bianOuter = NAJIA_OUTER[bianBits.slice(3)]!
  const shenStart = liuShenStart(dayGan)
  return Array.from({ length: 6 }, (_, i) => {
    const isInner = i < 3
    const ganZhi = isInner ? inner[i]! : outer[i - 3]!
    const zhi = ganZhi.charAt(1)
    const el = ZHI_WUXING[zhi] ?? 'earth'
    const line: GuaLine = {
      pos: i + 1,
      label: YAO_POS_NAME[i]!,
      title: yaoTitle(bits[i] === '1', i + 1),
      yinYang: bits[i] === '1' ? '阳' : '阴',
      dong: dongSet.has(i + 1),
      ganZhi,
      zhi,
      wuxing: WUXING_CN[el],
      liuQin: liuQinOf(hex.palaceElement, el),
      liuShen: LIU_SHEN[(shenStart + i) % 6]!,
      shiYing: hex.shi === i + 1 ? '世' : hex.ying === i + 1 ? '应' : '',
      kongWang: kongSet.has(zhi),
      dayRelations: dayRelationTags(zhi, dongSet.has(i + 1), extras.monthZhi, extras.dayZhi),
    }
    const fu = extras.fuShen.get(i + 1)
    if (fu) line.fuShen = fu
    if (line.dong) {
      const bg = isInner ? bianInner[i]! : bianOuter[i - 3]!
      const bianEl = ZHI_WUXING[bg.charAt(1)] ?? 'earth'
      line.bianGanZhi = bg
      line.bianWuxing = WUXING_CN[bianEl]
      line.bianLiuQin = liuQinOf(hex.palaceElement, bianEl)
      const hint = bianHintOf(el, bianEl)
      if (hint) line.bianHint = hint
    }
    return line
  })
}

/** 爻题（初九 / 六二 / … / 上六） */
function yaoTitle(yang: boolean, pos: number): string {
  const label = YAO_POS_NAME[pos - 1]!
  if (pos === 1 || pos === 6) return `${label}${yang ? '九' : '六'}`
  return `${yang ? '九' : '六'}${label}`
}

/** 梅花体用：单动爻时，动爻所在卦为用、另一卦为体 */
function buildTiYong(bits: string, dong: number): TiYongInfo {
  const dongLower = dong <= 3
  const tiBits = dongLower ? bits.slice(3) : bits.slice(0, 3)
  const yongBits = dongLower ? bits.slice(0, 3) : bits.slice(3)
  const ti = TRIGRAM_BY_BITS[tiBits]!
  const yong = TRIGRAM_BY_BITS[yongBits]!
  let relation: string
  let note: string
  if (ti.element === yong.element) {
    relation = '体用比和'
    note = '体用同气，顺遂和谐'
  } else if (SHENG[yong.element] === ti.element) {
    relation = '用生体'
    note = '得外力之助，事易成'
  } else if (SHENG[ti.element] === yong.element) {
    relation = '体生用'
    note = '我泄于彼，费力耗神'
  } else if (KE[ti.element] === yong.element) {
    relation = '体克用'
    note = '我制于彼，事可成但需主动'
  } else {
    relation = '用克体'
    note = '彼制于我，逢阻难成'
  }
  return {
    ti: ti.name,
    yong: yong.name,
    tiElement: WUXING_CN[ti.element],
    yongElement: WUXING_CN[yong.element],
    relation,
    note,
  }
}

function fmtToday(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 起卦时刻的卦气信息（四柱 / 日辰旬空 / 农历描述；装卦与空亡判定依据） */
function dayInfoOf(date: string): GuaDayInfo {
  const t = parseDateTime(date, '起卦日期')
  const lunar = Solar.fromYmdHms(t.y, t.m, t.d, t.hh, t.mm, 0).getLunar()
  return {
    pillars: {
      year: lunar.getYearInGanZhi(),
      month: lunar.getMonthInGanZhi(),
      day: lunar.getDayInGanZhi(),
      hour: lunar.getTimeInGanZhi(),
    },
    xunKong: lunar.getDayXunKong(),
    lunar: lunar.toString(),
  }
}

const METHOD_LABEL: Record<GuaInput['method'], string> = {
  time: '时间起卦（梅花）',
  coin: '摇卦（三枚铜钱）',
  number: '数字起卦（梅花）',
}

/** 起卦装卦（golden 测试入口） */
export function computeGua(input: GuaInput): GuaResult {
  if (input.method !== 'time' && input.method !== 'coin' && input.method !== 'number') {
    throw new PanError(`未知起卦方式：${String(input.method)}`, 'method 取 time（时间）/ coin（摇卦）/ number（数字）之一')
  }
  const warnings: string[] = []
  let bits: string
  let dongSet: number[]
  let yaoDigits: number[] | null = null
  let dateUsed: string
  let seedUsed: number | undefined
  const numbersUsed = input.numbers

  if (input.method === 'time') {
    if (!input.date) throw new PanError('时间起卦必须提供起卦时间（date）', '如 "2026-09-19 10:30"（按农历年月日时起卦）')
    const g = qiGuaByTime(input.date)
    bits = g.bits
    dongSet = [g.dong]
    dateUsed = input.date
    warnings.push(`时间起卦按农历：${g.lunarDesc}`)
  } else if (input.method === 'coin') {
    seedUsed = input.seed ?? Date.now() % 2147483647
    if (input.seed === undefined) {
      warnings.push('未提供随机种子（seed），已按当前时间派生（结果不可复现）；如需复现请显式提供 seed')
    }
    const g = qiGuaByCoin(seedUsed)
    bits = g.bits
    dongSet = g.dongSet
    yaoDigits = g.yaoDigits
    dateUsed = input.date ?? fmtToday()
    if (!input.date) warnings.push(`未提供起卦日期，六神按今日（${dateUsed}）日干推算`)
  } else {
    if (!input.numbers) throw new PanError('数字起卦必须提供两个数字（numbers）', '如 numbers: [17, 28]（第一个数定上卦、第二个定下卦）')
    const g = qiGuaByNumber(input.numbers)
    bits = g.bits
    dongSet = [g.dong]
    dateUsed = input.date ?? fmtToday()
    if (!input.date) warnings.push(`未提供起卦日期，六神按今日（${dateUsed}）日干推算`)
  }

  // 卦气（四柱 / 旬空）：装卦六神按日干、空亡按日旬空判定
  const dayInfo = dayInfoOf(dateUsed)
  const dayGan = dayInfo.pillars.day.charAt(0)

  const benHex = HEXAGRAMS[bits]
  if (!benHex) throw new PanError(`内部错误：未知卦象 ${bits}`, '请反馈该案例（六十四卦枚举表缺项）')
  const dongArr = [...new Set(dongSet)].sort((a, b) => a - b)

  // 变卦（动爻取反）
  const flip = (s: string, i: number): string => s.slice(0, i) + (s[i] === '1' ? '0' : '1') + s.slice(i + 1)
  let bianBits = bits
  for (const pos of dongArr) bianBits = flip(bianBits, pos - 1)

  // 互卦（二三四爻为下卦、三四五爻为上卦）；错卦（六爻全变）；综卦（六爻颠倒）
  const huBits = bits.slice(1, 4) + bits.slice(2, 5)
  const cuoBits = bits.split('').map((c) => (c === '1' ? '0' : '1')).join('')
  const zongBits = [...bits].reverse().join('')

  const dongSetObj = new Set(dongArr)
  const kongSet = new Set(dayInfo.xunKong.split(''))
  // M63-A：伏神（本宫首卦所缺六亲）+ 月建 / 日辰（月破 / 日破 / 暗动与旺衰简档）
  const fuShen = computeFuShen(bits, benHex)
  const monthZhi = dayInfo.pillars.month.charAt(1)
  const dayZhi = dayInfo.pillars.day.charAt(1)
  const lines = buildLines(bits, benHex, dongSetObj, bianBits, dayGan, kongSet, { monthZhi, dayZhi, fuShen })
  const tiYong = dongArr.length === 1 ? buildTiYong(bits, dongArr[0]!) : null

  return {
    input: {
      method: input.method,
      question: input.question ?? '',
      date: dateUsed,
      ...(seedUsed !== undefined ? { seed: seedUsed } : {}),
      ...(numbersUsed ? { numbers: numbersUsed } : {}),
    },
    methodLabel: METHOD_LABEL[input.method],
    dayInfo,
    ben: toGuaInfo(bits),
    bian: toGuaInfo(bianBits),
    hu: toGuaInfo(huBits),
    cuo: toGuaInfo(cuoBits),
    zong: toGuaInfo(zongBits),
    dongYao: dongArr,
    dongYaoLabel: dongArr.map((pos) => yaoTitle(bits[pos - 1] === '1', pos)),
    yaoDigits,
    lines,
    tiYong,
    warnings,
  }
}

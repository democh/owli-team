/**
 * M66-A：罗盘排盘算法域（纯计算，零依赖）——二十四山定盘 / 八宅游年 / 三元九运与流年飞星。
 *
 * 口径（设计 §10.1；与合规声明配套——先盘后论、文化研习参考定位）：
 * - 二十四山：周天度数 0° = 正北；每山 15°，序列自子山起顺时针：
 *   子癸丑艮寅甲卯乙辰巽巳丙午丁未坤申庚酉辛戌乾亥壬；坐向互成 180°；
 * - 八宅：**以坐山论宅**（与「以门论宅」派差异由输出声明）；大游年歌诀推八宫九星；
 * - 玄空：三元九运（九运 2024–2043）+ 运盘 + 流年飞星（洛书顺飞轨迹）；v1 下卦口径（兼向替卦不做）。
 */
import { PanError } from './types.js'

// ---------------------------------------------------------------- 二十四山

/** 二十四山（自子山起顺时针，每山 15°） */
export const MOUNTAINS_24 = [
  '子', '癸', '丑', '艮', '寅', '甲', '卯', '乙', '辰', '巽', '巳', '丙',
  '午', '丁', '未', '坤', '申', '庚', '酉', '辛', '戌', '乾', '亥', '壬',
] as const
export type Mountain24 = (typeof MOUNTAINS_24)[number]

/** 归一化到 [0, 360) */
export function norm360(deg: number): number {
  return ((deg % 360) + 360) % 360
}

export interface MountainHit {
  name: Mountain24
  /** 山中心度数（子 0 / 癸 15 / …） */
  center: number
  /** 覆盖区间 [start, end)（跨 0° 的「子」山以 [352.5, 360) ∪ [0, 7.5) 表达为 [352.5, 7.5) 环形区间） */
  range: [number, number]
}

/** 度数 → 二十四山（归一后左闭右开；子山区间为环形 [352.5, 7.5)） */
export function mountainOf(deg: number): MountainHit {
  const d = norm360(deg)
  // 子山中心 0：区间 [352.5, 360) ∪ [0, 7.5)
  const shifted = norm360(d + 7.5) // 以 -7.5 为界平移：子 [0,15) 癸 [15,30) …
  const idx = Math.floor(shifted / 15) % 24
  const name = MOUNTAINS_24[idx]!
  const center = idx === 0 ? 0 : idx * 15
  const start = norm360(center - 7.5)
  const end = norm360(center + 7.5)
  return { name, center, range: [start, end] }
}

/** 对向度数（＋180 归一） */
export function opposite(deg: number): number {
  return norm360(deg + 180)
}

// ---------------------------------------------------------------- 方位词与输入解析

/** 八方位词 → 度数（面朝方向） */
const DIR_WORDS: Record<string, number> = {
  北: 0, 东北: 45, 东: 90, 东南: 135, 南: 180, 西南: 225, 西: 270, 西北: 315,
}

export interface Orientation {
  /** 朝向（面朝方向；0° = 正北，顺时针） */
  facingDeg: number
  /** 坐（坐山方向 = 朝向对向） */
  sittingDeg: number
  /** 来源（度数 / 方位词） */
  source: '度数' | '方位词'
  /** 原文回显 */
  raw: string
}

/**
 * 解析朝向输入：
 * - 度数："172" / "172.5"（0–360，允许一位小数）；
 * - 方位词："坐北朝南" / "坐西北向东南" / "朝南" / "向东南"（坐与向需互成 180°，冲突则报错）。
 */
export function resolveOrientation(input: string): Orientation {
  const raw = input.trim()
  if (raw === '') throw new PanError('朝向为空', '请输入朝向：度数（如「172」）或方位词（如「坐北朝南」）')
  const num = /^(\d{1,3}(?:\.\d)?|360(?:\.0)?)$/.exec(raw)
  if (num) {
    const deg = norm360(Number(num[1]))
    return { facingDeg: deg, sittingDeg: opposite(deg), source: '度数', raw }
  }
  // 方位词：坐 X 朝/向 Y（也支持仅给一个）
  const sittingM = /坐\s*([东南西北]{1,2}|北|南)\s*(?:朝|向)\s*([东南西北]{1,2})/.exec(raw)
  const facingM = /^(?:朝|向)\s*([东南西北]{1,2})$/.exec(raw)
  const dirName = (s: string): number | undefined => DIR_WORDS[s]
  if (sittingM) {
    const sittingW = dirName(sittingM[1]!)
    const facingW = dirName(sittingM[2]!)
    if (sittingW === undefined || facingW === undefined) {
      throw new PanError(`方位词无法识别：「${raw}」`, '支持八方位（北 / 东北 / 东 / 东南 / 南 / 西南 / 西 / 西北），如「坐北朝南」')
    }
    if (Math.abs(norm360(facingW - opposite(sittingW))) > 0.001) {
      throw new PanError(
        `坐向冲突：坐${sittingM[1]}与向${sittingM[2]}不互成 180°`,
        '传统坐向互成 180°（如「坐北朝南」）；请核对方位词或直接给度数',
      )
    }
    return { facingDeg: facingW, sittingDeg: opposite(facingW), source: '方位词', raw }
  }
  if (facingM) {
    const w = dirName(facingM[1]!)
    if (w === undefined) {
      throw new PanError(`方位词无法识别：「${raw}」`, '支持八方位（北 / 东北 / 东 / 东南 / 南 / 西南 / 西 / 西北）')
    }
    return { facingDeg: w, sittingDeg: opposite(w), source: '方位词', raw }
  }
  throw new PanError(
    `朝向无法解析：「${raw}」`,
    '请输入度数（如「172」）或方位词（如「坐北朝南」「朝南」）；带磁偏角修正请另附 declination',
  )
}

// ---------------------------------------------------------------- 八宅游年（以坐山论宅）

export type Gua8 = '坎' | '艮' | '震' | '巽' | '离' | '坤' | '兑' | '乾'

/** 二十四山 → 所属卦（三山一卦） */
const GUA_BY_MOUNTAIN: Record<Mountain24, Gua8> = {
  壬: '坎', 子: '坎', 癸: '坎',
  丑: '艮', 艮: '艮', 寅: '艮',
  甲: '震', 卯: '震', 乙: '震',
  辰: '巽', 巽: '巽', 巳: '巽',
  丙: '离', 午: '离', 丁: '离',
  未: '坤', 坤: '坤', 申: '坤',
  庚: '兑', 酉: '兑', 辛: '兑',
  戌: '乾', 乾: '乾', 亥: '乾',
}

/** 后天八卦顺时针序（自北坎起） */
const CLOCKWISE: Gua8[] = ['坎', '艮', '震', '巽', '离', '坤', '兑', '乾']

/** 卦 → 方位名 */
export const GUA_DIR: Record<Gua8, string> = {
  坎: '北', 艮: '东北', 震: '东', 巽: '东南', 离: '南', 坤: '西南', 兑: '西', 乾: '西北',
}

/** 大游年歌（宅卦 → 本宫伏位后、自本宫下一宫起顺时针的七字九星缩写） */
const YOU_NIAN: Record<Gua8, string> = {
  坎: '五天生延绝祸六',
  艮: '六绝祸生延天五',
  震: '延生祸绝五天六',
  巽: '天五六祸生绝延',
  离: '六五绝延祸生天',
  坤: '天延绝生祸五六',
  兑: '生祸延绝六五天',
  乾: '六天五祸绝延生',
}

const STAR_OF_CHAR: Record<string, { star: string; luck: '吉' | '凶' }> = {
  生: { star: '生气', luck: '吉' },
  天: { star: '天医', luck: '吉' },
  延: { star: '延年', luck: '吉' },
  绝: { star: '绝命', luck: '凶' },
  五: { star: '五鬼', luck: '凶' },
  六: { star: '六煞', luck: '凶' },
  祸: { star: '祸害', luck: '凶' },
}

/** 九星参考语（渲染与解读共用；「凶」表述统一为「参考上偏慎用」——合规纪律） */
export const STAR_NOTE: Record<string, string> = {
  生气: '传统观点视为旺气方（活动 / 主位常参考）',
  天医: '传统观点视为康养方（休息 / 静养常参考）',
  延年: '传统观点视为和睦方（起居 / 会客常参考）',
  伏位: '本宅本宫（稳定位，常作参考起点）',
  绝命: '传统观点列为慎用方位（宜作辅助功能）',
  五鬼: '传统观点列为慎用方位（宜作辅助功能）',
  六煞: '传统观点列为慎用方位（宜作辅助功能）',
  祸害: '传统观点列为慎用方位（宜作辅助功能）',
}

export interface BazhaiPalace {
  gua: Gua8
  dir: string
  star: string
  luck: '吉' | '凶'
}

export interface BazhaiResult {
  /** 宅卦（以坐山论） */
  house: Gua8
  houseName: string
  group: '东四宅' | '西四宅'
  /** 八宫九星（按后天八卦顺时针序，自宅卦起） */
  palaces: BazhaiPalace[]
}

/** 八宅游年（坐山 → 宅卦 → 八宫九星；流派：坐山派） */
export function bazhaiOf(sittingDeg: number): BazhaiResult {
  const sitting = mountainOf(sittingDeg)
  const house = GUA_BY_MOUNTAIN[sitting.name]
  const group: BazhaiResult['group'] = ['坎', '离', '震', '巽'].includes(house) ? '东四宅' : '西四宅'
  const startIdx = CLOCKWISE.indexOf(house)
  const chars = YOU_NIAN[house]
  const palaces: BazhaiPalace[] = []
  for (let i = 0; i < 8; i++) {
    const gua = CLOCKWISE[(startIdx + i) % 8]!
    const star = i === 0 ? '伏位' : STAR_OF_CHAR[chars[i - 1]!]!.star
    const luck: '吉' | '凶' = i === 0 ? '吉' : STAR_OF_CHAR[chars[i - 1]!]!.luck
    palaces.push({ gua, dir: GUA_DIR[gua], star, luck })
  }
  return { house, houseName: `${house}宅`, group, palaces }
}

// ---------------------------------------------------------------- 兼向判定（续完善：仅 A 级启用）

/**
 * 兼向判定（§10.1 续完善）——二十四山每山 15°，山中心 ±4.5° 为下卦（正向）带，两侧各 3° 为兼向带。
 * 仅 A 级数据（现场 / 专业测量）启用；v1 只判定与声明——替卦排盘需专业复核（不做）。
 */
export interface PitchJudgement {
  /** A 级：'下卦' | '兼向'；B / C 级：'未判定' */
  kind: '下卦' | '兼向' | '未判定'
  /** 坐山偏离山中心度数（未判定时 null） */
  offset: number | null
  note: string
}

/** 坐向偏离山中心的最小距离（0–7.5°）与下卦 / 兼向分档（≤ 4.5° = 下卦） */
export function pitchOf(sittingDeg: number): { offset: number; kind: '下卦' | '兼向' } {
  const m = mountainOf(sittingDeg)
  const raw = Math.abs(norm360(sittingDeg - m.center))
  const offset = raw > 180 ? 360 - raw : raw
  return { offset: Math.round(offset * 10) / 10, kind: offset <= 4.5 ? '下卦' : '兼向' }
}

// ---------------------------------------------------------------- 玄空：三元九运与飞星

/** 洛书顺飞轨迹（中宫起） */
const FLY_ORDER = ['中', '乾', '兑', '艮', '离', '坎', '坤', '震', '巽'] as const

export type FlyPosition = (typeof FLY_ORDER)[number]

export interface FlyPalace {
  palace: FlyPosition
  dir: string
  star: number
}

const FLY_DIR: Record<FlyPosition, string> = {
  中: '中',
  乾: '西北', 兑: '西', 艮: '东北', 离: '南', 坎: '北', 坤: '西南', 震: '东', 巽: '东南',
}

/** 入中星 → 九宫飞布（洛书顺飞：中 → 乾 → 兑 → 艮 → 离 → 坎 → 坤 → 震 → 巽，星号递增循环） */
export function flyFrom(centerStar: number): FlyPalace[] {
  const c = ((Math.trunc(centerStar) - 1) % 9 + 9) % 9 + 1
  return FLY_ORDER.map((p, i) => ({ palace: p, dir: FLY_DIR[p], star: ((c - 1 + i) % 9) + 1 }))
}

/** 三元九运：1864 起二十一年一运；九运 2024–2043（越界环回下一周期） */
export function yunOf(year: number): number {
  const n = Math.floor((year - 1864) / 20)
  return ((n % 9) + 9) % 9 + 1
}

/** 运起止年（当前周期内） */
export function yunRange(yun: number, refYear: number): [number, number] {
  const cycle = Math.floor((refYear - 1864) / 180)
  const base = 1864 + cycle * 180
  const start = base + (yun - 1) * 20
  return [start, start + 19]
}

/** 流年入中星：((11 − 年数字和 mod 9 − 1) mod 9) + 1（golden：2024 三碧 / 2025 二黑 / 2026 一白） */
export function yearStarOf(year: number): number {
  const sum = String(year)
    .split('')
    .reduce((n, ch) => n + Number(ch), 0)
  return ((11 - (sum % 9) - 1) % 9 + 9) % 9 + 1
}

const STAR_NAME: Record<number, string> = {
  1: '一白', 2: '二黑', 3: '三碧', 4: '四绿', 5: '五黄', 6: '六白', 7: '七赤', 8: '八白', 9: '九紫',
}

export function starName(star: number): string {
  return STAR_NAME[star] ?? String(star)
}

export interface FeixingResult {
  yun: number
  yunRange: [number, number]
  yunCenter: number
  yunPan: FlyPalace[]
  year: number
  yearCenter: number
  yearName: string
  yearPan: FlyPalace[]
}

/** 玄空飞星（运盘 + 流年盘；下卦口径） */
export function feixingOf(year: number): FeixingResult {
  const yun = yunOf(year)
  const yearCenter = yearStarOf(year)
  return {
    yun,
    yunRange: yunRange(yun, year),
    yunCenter: yun,
    yunPan: flyFrom(yun),
    year,
    yearCenter,
    yearName: starName(yearCenter),
    yearPan: flyFrom(yearCenter),
  }
}

// ---------------------------------------------------------------- 数据等级（精度边界声明）

export type DataQuality = 'A' | 'B' | 'C'

export const QUALITY_LABEL: Record<DataQuality, string> = {
  A: 'A 级（现场罗盘 / 专业测量；磁偏角修正仅在有数据时启用）',
  B: 'B 级（手机指南针，典型误差 ±5°–10°）',
  C: 'C 级（口头方位描述，按八方位最近似落盘——精度粗，结论供方向性参考）',
}

/** 综合盘（工具输出的一等公民；渲染与文本共用） */
export interface LuopanResult {
  label: string
  quality: DataQuality
  declination?: number
  orientation: Orientation
  facing: MountainHit
  sitting: MountainHit
  bazhai: BazhaiResult
  feixing: FeixingResult
  /** 兼向判定（续完善；A 级可判，B/C 级未判定） */
  pitch: PitchJudgement
  /** 精度与口径声明（固定段） */
  notes: string[]
}

export interface LuopanInput {
  /** 朝向：度数或方位词（「坐北朝南」） */
  facing: string
  quality?: DataQuality
  year?: number
  declination?: number
  label?: string
}

/** 罗盘排盘（唯一口径；禁止模型心算兜底） */
export function computeLuopan(input: LuopanInput): LuopanResult {
  const quality = input.quality ?? 'C'
  const year = input.year ?? new Date().getFullYear()
  if (!Number.isInteger(year) || year < 1900 || year > 2100) {
    throw new PanError(`年份越界：「${input.year}」`, 'year 需为 1900–2100 的整数')
  }
  let declination: number | undefined
  if (input.declination !== undefined) {
    if (!Number.isFinite(input.declination) || Math.abs(input.declination) > 20) {
      throw new PanError(`磁偏角不合法：「${input.declination}」`, 'declination 为 −20°–20° 的数值（本地磁偏角可查专业地图）')
    }
    if (quality !== 'A') {
      throw new PanError('磁偏角修正仅适用于 A 级数据', 'B / C 级数据请勿启用 declination（声明精度上限不达标）')
    }
    declination = input.declination
  }
  // 真北修正：磁测朝向 − 磁偏角（东偏为正的常规记法下，按用户提供约定原样记录并在声明中标注）
  const base = resolveOrientation(input.facing)
  const facingDeg = declination !== undefined ? norm360(base.facingDeg - declination) : base.facingDeg
  const orientation: Orientation = declination !== undefined ? { ...base, facingDeg, sittingDeg: opposite(facingDeg) } : base
  const notes = [
    `数据等级：${QUALITY_LABEL[quality]}`,
    '流派口径：八宅·坐山派（与「以门论宅」派存在差异）；玄空·下卦为主（兼向判定仅 A 级启用；替卦排盘需专业复核）',
    '定位为传统堪舆文化研习与参考（不承诺吉凶必应）；涉结构拆改 / 采光通风等实际问题请结合专业意见',
  ]
  if (declination !== undefined) {
    notes.splice(1, 0, `磁偏角修正：−${declination}°（磁测 ${base.facingDeg.toFixed(1)}° → 真北 ${facingDeg.toFixed(1)}°）`)
  }
  const pitchBase = pitchOf(opposite(facingDeg))
  const pitch: PitchJudgement =
    quality === 'A'
      ? {
          kind: pitchBase.kind,
          offset: pitchBase.offset,
          note:
            pitchBase.kind === '下卦'
              ? `坐向在正向带（±4.5°）内（偏离 ${pitchBase.offset.toFixed(1)}°）——按下卦排盘`
              : `坐向偏离正向 ${pitchBase.offset.toFixed(1)}°——传统需替卦；替卦排盘需专业复核（本盘按下卦呈现）`,
        }
      : { kind: '未判定', offset: null, note: '数据等级不足（B / C 级）——兼向判定需 A 级现场测量（含磁偏角）' }
  return {
    label: (input.label ?? '').trim() || '阳宅罗盘',
    quality,
    ...(declination !== undefined ? { declination } : {}),
    orientation,
    facing: mountainOf(facingDeg),
    sitting: mountainOf(opposite(facingDeg)),
    bazhai: bazhaiOf(opposite(facingDeg)),
    feixing: feixingOf(year),
    pitch,
    notes,
  }
}

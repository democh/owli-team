/**
 * M63-C：大六壬计算（自研，时家课式）——天地盘 / 四课 / 三传（九宗门）/ 十二天将 / 遁干。
 *
 * 口径（设计 docs/metaphysics-deepening-design.md 附录 A.2，卡面固定声明）：
 * - 月将：中气换将（霜降后用卯将等）；
 * - 四课：日干寄宫（甲寅乙辰丙戊巳丁己未庚申辛戌壬亥癸丑）+ 逐层取天盘上神；
 * - 三传：九宗门（伏吟/反吟 → 贼克 → 比用 → 涉害（归地·顺数计克）→ 遥克 → 昴星/别责/八专）；
 *   中末常规「上神递取」，特殊课按其规则（昴星：中支上末干上；别责/八专：中末皆干上；伏吟/反吟：刑取·自刑取冲）；
 * - 天将：昼贵/夜贵（占时卯~申昼取阳贵、酉~寅夜取阴贵）+ 贵人临地盘亥子丑寅卯辰顺布 / 巳午未申酉戌逆布；
 * - 遁干：按旬遁（旬空二支无遁干）。
 * 只输出结构事实（课体名 + 依据），不做吉凶断语（合规红线）。
 */
import { Solar } from 'lunar-typescript'
import { PanError, parseDateTime } from './types.js'

const ZHI = '子丑寅卯辰巳午未申酉戌亥'
const GAN = '甲乙丙丁戊己庚辛壬癸'
const ZHI_WX: Record<string, 'wood' | 'fire' | 'earth' | 'metal' | 'water'> = {
  寅: 'wood', 卯: 'wood', 巳: 'fire', 午: 'fire',
  辰: 'earth', 戌: 'earth', 丑: 'earth', 未: 'earth',
  申: 'metal', 酉: 'metal', 亥: 'water', 子: 'water',
}
const GAN_WX: Record<string, 'wood' | 'fire' | 'earth' | 'metal' | 'water'> = {
  甲: 'wood', 乙: 'wood', 丙: 'fire', 丁: 'fire', 戊: 'earth',
  己: 'earth', 庚: 'metal', 辛: 'metal', 壬: 'water', 癸: 'water',
}
const SHENG: Record<string, string> = { wood: 'fire', fire: 'earth', earth: 'metal', metal: 'water', water: 'wood' }
const KE: Record<string, string> = { wood: 'earth', earth: 'water', water: 'fire', fire: 'metal', metal: 'wood' }

/** 地支克（a 克 b） */
const zhiKe = (a: string, b: string): boolean => KE[ZHI_WX[a] ?? 'earth'] === (ZHI_WX[b] ?? 'earth')
const ganKeZhi = (g: string, z: string): boolean => KE[GAN_WX[g] ?? 'earth'] === (ZHI_WX[z] ?? 'earth')
const zhiKeGan = (z: string, g: string): boolean => KE[ZHI_WX[z] ?? 'earth'] === (GAN_WX[g] ?? 'earth')

/** 日干寄宫（甲寄寅…癸寄丑） */
const JI_GONG: Record<string, string> = {
  甲: '寅', 乙: '辰', 丙: '巳', 戊: '巳', 丁: '未', 己: '未', 庚: '申', 辛: '戌', 壬: '亥', 癸: '丑',
}
/** 天干五合（甲合己…） */
const GAN_HE: Record<string, string> = {
  甲: '己', 己: '甲', 乙: '庚', 庚: '乙', 丙: '辛', 辛: '丙', 丁: '壬', 壬: '丁', 戊: '癸', 癸: '戊',
}
/** 相刑（自刑映射自身） */
const XING: Record<string, string> = {
  子: '卯', 卯: '子', 寅: '巳', 巳: '申', 申: '寅', 丑: '戌', 戌: '未', 未: '丑',
  辰: '辰', 午: '午', 酉: '酉', 亥: '亥',
}
const SELF_XING = new Set(['辰', '午', '酉', '亥'])
/** 相冲 */
const CHONG: Record<string, string> = {
  子: '午', 午: '子', 丑: '未', 未: '丑', 寅: '申', 申: '寅',
  卯: '酉', 酉: '卯', 辰: '戌', 戌: '辰', 巳: '亥', 亥: '巳',
}
/** 三合局（含驿马位） */
const SAN_HE_JU: Array<{ ju: [string, string, string]; ma: string }> = [
  { ju: ['寅', '午', '戌'], ma: '申' },
  { ju: ['申', '子', '辰'], ma: '寅' },
  { ju: ['巳', '酉', '丑'], ma: '亥' },
  { ju: ['亥', '卯', '未'], ma: '巳' },
]
const maOf = (zhi: string): string => SAN_HE_JU.find((j) => j.ju.includes(zhi))?.ma ?? '寅'
const sanHeNext = (zhi: string): string => {
  const g = SAN_HE_JU.find((j) => j.ju.includes(zhi))
  if (!g) return zhi
  const i = g.ju.indexOf(zhi)
  return g.ju[(i + 1) % 3]!
}

/** 十二天将（序） */
const JIANG = ['贵人', '螣蛇', '朱雀', '六合', '勾陈', '青龙', '天空', '白虎', '太常', '玄武', '太阴', '天后']
/** 贵人口诀：[阳贵, 阴贵]（甲戊庚牛羊 / 乙己鼠猴乡 / 丙丁猪鸡位 / 壬癸兔蛇藏 / 六辛逢马虎） */
const GUI: Record<string, [string, string]> = {
  甲: ['丑', '未'], 戊: ['丑', '未'], 庚: ['丑', '未'],
  乙: ['子', '申'], 己: ['子', '申'],
  丙: ['亥', '酉'], 丁: ['亥', '酉'],
  壬: ['卯', '巳'], 癸: ['卯', '巳'],
  辛: ['午', '寅'],
}
/** 月将（中气换将；中气 → 月将支） */
const ZHONG_QI_JIANG: Array<[string, string]> = [
  ['雨水', '亥'], ['春分', '戌'], ['谷雨', '酉'], ['小满', '申'],
  ['夏至', '未'], ['大暑', '午'], ['处暑', '巳'], ['秋分', '辰'],
  ['霜降', '卯'], ['小雪', '寅'], ['冬至', '丑'], ['大寒', '子'],
]
/** 月将名（十二神） */
const JIANG_NAME: Record<string, string> = {
  亥: '登明', 戌: '河魁', 酉: '从魁', 申: '传送', 未: '小吉', 午: '胜光',
  巳: '太乙', 辰: '天罡', 卯: '太冲', 寅: '功曹', 丑: '大吉', 子: '神后',
}

// ---------------------------------------------------------------------------

export interface DaliurenInput {
  /** 起课时刻 'YYYY-MM-DD HH:mm' */
  at: string
  /** IANA 时区（缺省按本地时钟；干支历按钟表时间换算） */
  timezone?: string
}

export interface DaliurenKe {
  idx: 1 | 2 | 3 | 4
  label: string
  upper: string
  lower: string
  /** 下神为日干（一课） */
  lowerIsGan: boolean
}

export interface DaliurenChuan {
  name: '初传' | '中传' | '末传'
  zhi: string
  /** 旬遁天干（旬空 → null） */
  dunGan: string | null
  jiang: string
  kong: boolean
}

export interface DaliurenResult {
  input: { at: string; timezone: string | null }
  pillars: { year: string; month: string; day: string; hour: string }
  dayGan: string
  dayZhi: string
  hourZhi: string
  dayNight: '昼占' | '夜占'
  jiang: { zhi: string; name: string }
  zhongQi: { name: string; date: string }
  pan: {
    /** 地盘支 → 天盘神 */
    diToTian: Array<{ di: string; tian: string }>
    /** 天盘神 → 地盘宫 */
    tianToDi: Record<string, string>
    /** 天盘神 → 所乘天将 */
    jiangOf: Record<string, string>
  }
  ke: DaliurenKe[]
  chuan: DaliurenChuan[]
  keti: { name: string; note: string }
  guiRen: { zhi: string; kind: '昼贵' | '夜贵'; direction: '顺布' | '逆布'; di: string }
  warnings: string[]
}

/** 起课时刻最近中气（中气换将依据）——取 T 与 T-40 天两张农历节气表合并的中文键 */
function prevZhongQi(y: number, m: number, d: number, hh: number, mm: number): { name: string; date: string } {
  const targets = new Set(ZHONG_QI_JIANG.map(([n]) => n))
  const tMs = Date.UTC(y, m - 1, d, hh, mm)
  const collect = (offsetDays: number): Array<{ name: string; ms: number; text: string }> => {
    const base = new Date(tMs - offsetDays * 86_400_000)
    const lunar = Solar.fromYmdHms(
      base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), 12, 0, 0,
    ).getLunar()
    const table = lunar.getJieQiTable() as Record<string, { getYear: () => number; getMonth: () => number; getDay: () => number; getHour: () => number; getMinute: () => number }>
    const out: Array<{ name: string; ms: number; text: string }> = []
    for (const [key, solar] of Object.entries(table)) {
      if (!targets.has(key)) continue
      const sy = solar.getYear()
      const sm = solar.getMonth()
      const sd = solar.getDay()
      const sh = solar.getHour()
      const smi = solar.getMinute()
      const ms = Date.UTC(sy, sm - 1, sd, sh, smi)
      const p = (n: number): string => String(n).padStart(2, '0')
      out.push({ name: key, ms, text: `${sy}-${p(sm)}-${p(sd)} ${p(sh)}:${p(smi)}` })
    }
    return out
  }
  const all = [...collect(0), ...collect(40)]
  const prev = all.filter((x) => x.ms <= tMs).sort((a, b) => b.ms - a.ms)[0]
  if (!prev) throw new PanError('中气定位失败（节气表异常）', '请反馈该案例（日期与时刻）')
  return { name: prev.name, date: prev.text }
}

/** 60 甲子旬遁：返回旬首 + 旬空二支 + 支→遁干 映射（旬空二支 → null） */
function xunDun(dayGan: string, dayZhi: string): { xunShou: string; kong: [string, string]; dun: Record<string, string | null> } {
  const g = GAN.indexOf(dayGan)
  const z = ZHI.indexOf(dayZhi)
  const shouZhi = (z - g + 12) % 12
  const dun: Record<string, string | null> = {}
  for (let k = 0; k < 12; k++) {
    const zhi = ZHI[(shouZhi + k) % 12]!
    dun[zhi] = k <= 9 ? GAN[k]! : null
  }
  const kong: [string, string] = [ZHI[(shouZhi + 10) % 12]!, ZHI[(shouZhi + 11) % 12]!]
  return { xunShou: `甲${ZHI[shouZhi]}`, kong, dun }
}

/**
 * 三传取法（九宗门；返回初传 + 课体 + 中末规则标记）
 * middleEnd: 'chain' = 上神递取；'maoxing' = 中支上末干上；'ganBoth' = 中末皆干上；'xing' = 刑取（自刑取冲）
 */
function decideChu(
  ke: DaliurenKe[],
  dayGan: string,
  dayZhi: string,
  jiangZhi: string,
  hourZhi: string,
  tianOf: Record<string, string>,
): { chu: string; keti: string; note: string; middleEnd: 'chain' | 'maoxing' | 'ganBoth' | 'xing' } {
  const ganYang = '甲丙戊庚壬'.includes(dayGan)
  const jiGong = JI_GONG[dayGan]!

  // 伏吟：月将 = 占时（天地盘重合）
  if (jiangZhi === hourZhi) {
    const chu = ganYang ? tianOf[jiGong]! : tianOf[dayZhi]!
    return {
      chu,
      keti: '伏吟课',
      note: ganYang ? '自任（阳日取干上神）' : '自信（阴日取支上神）',
      middleEnd: 'xing',
    }
  }
  // 反吟：月将冲占时（天地盘对冲）
  if (jiangZhi === CHONG[hourZhi]) {
    const chu = maOf(dayZhi)
    return { chu, keti: '反吟课', note: `取日支驿马 ${chu}`, middleEnd: 'xing' }
  }

  // 贼克：下贼上优先，其次上克下
  const zei = ke.filter((k) => {
    const lowerZhi = k.lowerIsGan ? JI_GONG[dayGan]! : k.lower
    return zhiKe(lowerZhi, k.upper)
  })
  const keDown = ke.filter((k) => {
    const lowerZhi = k.lowerIsGan ? JI_GONG[dayGan]! : k.lower
    return zhiKe(k.upper, lowerZhi)
  })
  const pool = zei.length > 0 ? zei : keDown
  const poolKind = zei.length > 0 ? '贼' : '克'

  if (pool.length === 1) {
    const name = poolKind === '贼' ? '重审课' : '元首课'
    return {
      chu: pool[0]!.upper,
      keti: name,
      note: poolKind === '贼' ? '一上一下克，下贼上取用' : '一上克下取用',
      middleEnd: 'chain',
    }
  }

  if (pool.length > 1) {
    // 比用：取与日干同阴阳者
    const yinYang = (zhi: string): '阳' | '阴' => (ZHI.indexOf(zhi) % 2 === 0 ? '阳' : '阴')
    const bi = pool.filter((k) => yinYang(k.upper) === (ganYang ? '阳' : '阴'))
    if (bi.length === 1) {
      return { chu: bi[0]!.upper, keti: '比用课（知一）', note: `${pool.length} 课相敌，取与日干同阴阳者`, middleEnd: 'chain' }
    }
    // 涉害：归地·顺数计克（含起点与终点；只计克我）
    const depth = (upper: string): number => {
      const home = ZHI.indexOf(upper)
      const di = ZHI.indexOf(tianToDiOf(tianOf, upper))
      let n = 0
      let i = home
      for (let step = 0; step <= 12; step++) {
        if (zhiKe(ZHI[i]!, upper)) n += 1
        if (i === di) break
        i = (i + 1) % 12
      }
      return n
    }
    const cand = (bi.length > 0 ? bi : pool).map((k) => ({ upper: k.upper, d: depth(k.upper) }))
    const max = Math.max(...cand.map((c) => c.d))
    const deep = cand.filter((c) => c.d === max)
    if (deep.length === 1) {
      return {
        chu: deep[0]!.upper,
        keti: '涉害课',
        note: `涉害归地·顺数计克（最深 ${max} 克）`,
        middleEnd: 'chain',
      }
    }
    // 复等：取干上神（阳日）/ 支上神（阴日）
    const chu = deep.some((c) => c.upper === ke[0]!.upper)
      ? ke[0]!.upper
      : deep.some((c) => c.upper === ke[2]!.upper)
        ? ke[2]!.upper
        : deep[0]!.upper
    return { chu, keti: '涉害课', note: `涉害相等，复等取${ganYang ? '干' : '支'}上神`, middleEnd: 'chain' }
  }

  // 遥克：无上下克 → 上神克日干（蒿矢）/ 日干克上神（弹射）
  const yaoKe = ke.filter((k) => zhiKeGan(k.upper, dayGan))
  const yaoShe = ke.filter((k) => ganKeZhi(dayGan, k.upper))
  if (yaoKe.length > 0 || yaoShe.length > 0) {
    const kind = yaoKe.length > 0 ? '蒿矢（上神克日干）' : '弹射（日干克上神）'
    const cands = yaoKe.length > 0 ? yaoKe : yaoShe
    const yinYang = (zhi: string): '阳' | '阴' => (ZHI.indexOf(zhi) % 2 === 0 ? '阳' : '阴')
    const bi = cands.filter((k) => yinYang(k.upper) === (ganYang ? '阳' : '阴'))
    const chu = (bi[0] ?? cands[0])!.upper
    return { chu, keti: '遥克课', note: `${kind}取用`, middleEnd: 'chain' }
  }

  // 八专：日干寄宫 = 日支（无克无遥）
  if (jiGong === dayZhi) {
    const ganShang = tianOf[jiGong]!
    const idx = ZHI.indexOf(ganShang)
    const chu = ZHI[(idx + (ganYang ? 2 : -2) + 24) % 12]!
    return {
      chu,
      keti: '八专课',
      note: `阳日顺数三神 / 阴日逆数三神（${ganYang ? '顺' : '逆'}）`,
      middleEnd: 'ganBoth',
    }
  }

  // 四课不全（下神集合有重复——寄宫 / 一上 / 日支 / 三上 四者去重后 < 4；伏吟与八专已前置拦截）→ 别责
  const lowers = [jiGong, ke[0]!.upper, dayZhi, ke[2]!.upper]
  const notFull = new Set(lowers).size < 4
  if (notFull) {
    let chu: string
    if (ganYang) {
      const heGan = GAN_HE[dayGan]!
      chu = tianOf[JI_GONG[heGan]!]!
    } else {
      chu = sanHeNext(dayZhi)
    }
    return {
      chu,
      keti: '别责课',
      note: ganYang ? '阳日取干合上神' : '阴日取支三合前一位',
      middleEnd: 'ganBoth',
    }
  }

  // 昴星
  const chu = ganYang ? tianOf['酉']! : tianToDiOf(tianOf, '酉')
  return {
    chu,
    keti: '昴星课',
    note: ganYang ? '虎视（阳日取地盘酉上神）' : '冬蛇掩目（阴日取天盘酉下神）',
    middleEnd: 'maoxing',
  }
}

/** 天盘神 → 地盘宫（反查） */
function tianToDiOf(tianOf: Record<string, string>, tianZhi: string): string {
  for (const di of ZHI) {
    if (tianOf[di] === tianZhi) return di
  }
  return '子'
}

/** 刑取（自刑取冲） */
const xingNext = (zhi: string): string => (SELF_XING.has(zhi) ? CHONG[zhi]! : XING[zhi]!)

/** 计算大六壬课（golden 测试入口） */
export function computeDaliuren(input: DaliurenInput): DaliurenResult {
  const t = parseDateTime(input.at, '起课时间')
  const warnings: string[] = []
  let lunar: ReturnType<ReturnType<typeof Solar.fromYmdHms>['getLunar']>
  try {
    lunar = Solar.fromYmdHms(t.y, t.m, t.d, t.hh, t.mm, 0).getLunar()
  } catch (err) {
    throw new PanError(`起课时间转换失败：${err instanceof Error ? err.message : String(err)}`, '请核对起课时间（YYYY-MM-DD HH:mm）')
  }
  const yearGz = lunar.getYearInGanZhi()
  const monthGz = lunar.getMonthInGanZhi()
  const dayGz = lunar.getDayInGanZhi()
  const hourGz = lunar.getTimeInGanZhi()
  const dayGan = dayGz.charAt(0)
  const dayZhi = dayGz.charAt(1)
  const hourZhi = hourGz.charAt(1)

  // 月将（中气换将）
  const zq = prevZhongQi(t.y, t.m, t.d, t.hh, t.mm)
  const jiangEntry = ZHONG_QI_JIANG.find(([n]) => n === zq.name)
  if (!jiangEntry) throw new PanError(`中气「${zq.name}」无月将映射`, '请反馈该案例')
  const jiangZhi = jiangEntry[1]

  // 天地盘（月将加时）
  const mIdx = ZHI.indexOf(jiangZhi)
  const hIdx = ZHI.indexOf(hourZhi)
  const tianOf: Record<string, string> = {}
  const diToTian: Array<{ di: string; tian: string }> = []
  for (let i = 0; i < 12; i++) {
    const di = ZHI[i]!
    const tian = ZHI[(mIdx + i - hIdx + 24) % 12]!
    tianOf[di] = tian
    diToTian.push({ di, tian })
  }

  // 四课
  const jiGong = JI_GONG[dayGan]!
  const k1u = tianOf[jiGong]!
  const k2u = tianOf[k1u]!
  const k3u = tianOf[dayZhi]!
  const k4u = tianOf[k3u]!
  const ke: DaliurenKe[] = [
    { idx: 1, label: '一课', upper: k1u, lower: dayGan, lowerIsGan: true },
    { idx: 2, label: '二课', upper: k2u, lower: k1u, lowerIsGan: false },
    { idx: 3, label: '三课', upper: k3u, lower: dayZhi, lowerIsGan: false },
    { idx: 4, label: '四课', upper: k4u, lower: k3u, lowerIsGan: false },
  ]

  // 十二天将（昼贵/夜贵 + 顺逆布）
  const isDay = ['卯', '辰', '巳', '午', '未', '申'].includes(hourZhi)
  const [yangGui, yinGui] = GUI[dayGan]!
  const guiZhi = isDay ? yangGui : yinGui
  const guiDi = tianToDiOf(tianOf, guiZhi)
  const forward = ['亥', '子', '丑', '寅', '卯', '辰'].includes(guiDi)
  const jiangOf: Record<string, string> = {}
  const gIdx = ZHI.indexOf(guiZhi)
  for (let i = 0; i < 12; i++) {
    const z = ZHI[(gIdx + (forward ? i : -i) + 24) % 12]!
    jiangOf[z] = JIANG[i]!
  }

  // 三传（九宗门）
  const { chu, keti, note, middleEnd } = decideChu(ke, dayGan, dayZhi, jiangZhi, hourZhi, tianOf)
  const ganShang = k1u
  const zhiShang = k3u
  let zhuanZhi: string[]
  if (middleEnd === 'chain') {
    const zhong = tianOf[chu]!
    const mo = tianOf[zhong]!
    zhuanZhi = [chu, zhong, mo]
  } else if (middleEnd === 'maoxing') {
    zhuanZhi = [chu, zhiShang, ganShang]
  } else if (middleEnd === 'ganBoth') {
    zhuanZhi = [chu, ganShang, ganShang]
  } else {
    const zhong = xingNext(chu)
    const mo = xingNext(zhong)
    zhuanZhi = [chu, zhong, mo]
  }

  // 遁干（旬遁）
  const { xunShou, kong, dun } = xunDun(dayGan, dayZhi)
  const chuan: DaliurenChuan[] = (['初传', '中传', '末传'] as const).map((name, i) => {
    const zhi = zhuanZhi[i]!
    const dg = dun[zhi] ?? null
    return {
      name,
      zhi,
      dunGan: dg,
      jiang: jiangOf[zhi] ?? '',
      kong: kong.includes(zhi),
    }
  })

  const result: DaliurenResult = {
    input: { at: input.at, timezone: input.timezone ?? null },
    pillars: { year: yearGz, month: monthGz, day: dayGz, hour: hourGz },
    dayGan,
    dayZhi,
    hourZhi,
    dayNight: isDay ? '昼占' : '夜占',
    jiang: { zhi: jiangZhi, name: JIANG_NAME[jiangZhi]! },
    zhongQi: zq,
    pan: {
      diToTian,
      tianToDi: (() => {
        const m: Record<string, string> = {}
        for (const { di, tian } of diToTian) m[tian] = di
        return m
      })(),
      jiangOf,
    },
    ke,
    chuan,
    keti: { name: keti, note },
    guiRen: { zhi: guiZhi, kind: isDay ? '昼贵' : '夜贵', direction: forward ? '顺布' : '逆布', di: guiDi },
    warnings: [
      ...warnings,
      `旬首 ${xunShou}；旬空 ${kong[0]}${kong[1]}`,
      '口径：时家·中气换将·贵人顺逆法·涉害归地比较',
    ],
  }
  return result
}

/**
 * M51-E：四柱八字计算（lunar-typescript 封装）。
 *
 * 输入公历 / 农历（负月号表达闰月）+ 时辰 + 性别 + 真太阳时校正；
 * 输出四柱 / 十神（干与支藏）/ 藏干 / 五行统计 / 起运与大运 / 流年序。
 */
import { Lunar, Solar } from 'lunar-typescript'
import { computeRelations, computeShenSha, type BaziRelationItem, type BaziShenShaItem, type PillarSlot } from './bazi_extra.js'
import {
  applyTrueSolarTime,
  BirthInput,
  fmtDateTime,
  GAN_WUXING,
  PanError,
  parseDateTime,
  WuXingKey,
  ZHI_WUXING,
} from './types.js'

/** 单柱：干支 + 十神（干 / 支藏干十神） + 藏干 + 纳音 + 旬空 + 地势 */
export interface Pillar {
  ganZhi: string
  gan: string
  zhi: string
  /** 天干十神（日柱为「日主」） */
  shiShenGan: string
  /** 地支藏干及其十神 */
  hideGan: Array<{ gan: string; shiShen: string; wuxing: WuXingKey }>
  /** 纳音 */
  naYin: string
  /** 旬空（该柱干支所在旬的空亡两支，如「戌亥」） */
  xunKong: string
  /** 地势（十二长生；以日干对柱支） */
  diShi: string
}

export interface DaYunItem {
  ganZhi: string
  startAge: number
  endAge: number
  startYear: number
  endYear: number
  /** 当前所处大运（按当前公历年落入） */
  isCurrent: boolean
}

export interface LiuNianItem {
  year: number
  ganZhi: string
  age: number
  /** 流年旬空 */
  xunKong: string
  /** 当前公历年 */
  isCurrent: boolean
}

/** 四柱之外的命理宫位（胎元 / 胎息 / 命宫 / 身宫；干支 + 纳音） */
export interface ExtraPillar {
  ganZhi: string
  naYin: string
}

/** 小运（起运后逐年一步；源自 lunar-typescript DaYun.getXiaoYun） */
export interface XiaoYunItem {
  ganZhi: string
  age: number
  year: number
}

/** 流月（按节气分月；源自 lunar-typescript LiuNian.getLiuYue） */
export interface LiuYueItem {
  /** 中文月序（正 / 二 / … / 腊） */
  month: string
  ganZhi: string
}

/** computeBazi 可选项（M63-A） */
export interface BaziOptions {
  /** 指定流年（年份如 '2026' 或干支如 '丙午'）——输出该年 12 流月 */
  liuYueOf?: string
}

export interface BaziResult {
  /** 输入回显（校正前后 + 校正量分钟） */
  input: {
    birth: string
    calendar: string
    gender: string
    corrected: string
    trueSolar: boolean
    /** 真太阳时校正量（分钟；未校正 / 跳过 → null） */
    correction: number | null
  }
  /** 校正后对应的公历年月日时分 */
  solar: string
  lunar: string
  /** 四柱 */
  pillars: { year: Pillar; month: Pillar; day: Pillar; hour: Pillar }
  /** 日主（日干） */
  dayMaster: string
  /** 五行统计（四柱干支 8 字计数） */
  wuxing: Record<WuXingKey, number>
  /** 胎元 / 胎息 / 命宫 / 身宫（四柱之外的传统命理四宫） */
  taiYuan: ExtraPillar
  taiXi: ExtraPillar
  mingGong: ExtraPillar
  shenGong: ExtraPillar
  /** 大运顺逆（阳男阴女顺行） */
  forward: boolean
  /** 生肖 / 公历星座 */
  shengXiao: string
  xingZuo: string
  /** 起运 */
  startLuck: { years: number; months: number; days: number; date: string }
  /** 大运列表（约 8 步） */
  daYun: DaYunItem[]
  /** 当前大运的流年序（无当前时间 → 首运前 10 年） */
  liuNian: LiuNianItem[]
  /** 神煞（18 种，逐柱命中制；M63-A） */
  shenSha: BaziShenShaItem[]
  /** 柱间关系 + 运岁作用（M63-A） */
  relations: BaziRelationItem[]
  /** 小运（当前大运内 10 步；M63-A） */
  xiaoYun: XiaoYunItem[]
  /** 流月（liuYueOf 指定流年时输出 12 条；缺省 null） */
  liuYue: LiuYueItem[] | null
  /** 流月回显（请求的流年标识） */
  liuYueOf: string | null
  warnings: string[]
}

const WUXING_LABEL: Record<WuXingKey, string> = { wood: '木', fire: '火', earth: '土', metal: '金', water: '水' }

export function wuxingLabel(key: WuXingKey): string {
  return WUXING_LABEL[key]
}

/** 出生输入 → 农历对象（含真太阳时校正；lunar-typescript Lunar 实例） */
export function toLunar(input: BirthInput): {
  lunar: Lunar
  corrected: string
  warnings: string[]
  correction: number | null
} {
  const t = parseDateTime(input.birth, '出生时间')
  // 真太阳时校正作用于「钟表时刻」——先按原始时刻取公历日 + 均时差，再校正后重排
  const { corrected, warnings, correctionMinutes } = applyTrueSolarTime(input, t)
  let lunar: Lunar
  if (input.calendar === 'solar') {
    // 用 fromYmdHms 显式传参，避免 Date 本地时区漂移
    lunar = Solar.fromYmdHms(corrected.y, corrected.m, corrected.d, corrected.hh, corrected.mm, 0).getLunar()
  } else {
    const month = input.isLeapMonth ? -t.m : t.m
    try {
      lunar = Lunar.fromYmdHms(corrected.y, month, corrected.d, corrected.hh, corrected.mm, 0)
    } catch {
      throw new PanError(
        `农历日期转换失败：${corrected.y}-${input.isLeapMonth ? '闰' : ''}${t.m}-${t.d}`,
        input.isLeapMonth
          ? '请确认该年该月确实存在闰月（闰月号用负月表达；如 2020 年闰四月 → isLeapMonth=true + 月 4）'
          : '请核对农历年月日；如为闰月请置 isLeapMonth=true',
      )
    }
  }
  return { lunar, corrected: fmtDateTime(corrected), warnings, correction: correctionMinutes }
}

/** 计算四柱八字（golden 测试入口） */
export function computeBazi(input: BirthInput, opts?: BaziOptions): BaziResult {
  const { lunar, corrected, warnings, correction } = toLunar(input)
  const ec = lunar.getEightChar()
  const genderNum = input.gender === 'male' ? 1 : 0

  const mkPillar = (idx: 'Year' | 'Month' | 'Day' | 'Time'): Pillar => {
    const gan = ec[`get${idx}Gan`]() as string
    const zhi = ec[`get${idx}Zhi`]() as string
    const shiShenGan = idx === 'Day' ? '日主' : (ec[`get${idx}ShiShenGan`]() as string)
    const hides = ec[`get${idx}HideGan`]() as string[]
    const shiShens = ec[`get${idx}ShiShenZhi`]() as string[]
    const hideGan = hides.map((g, i) => ({
      gan: g,
      shiShen: shiShens[i] ?? '',
      wuxing: GAN_WUXING[g] ?? 'earth',
    }))
    return {
      ganZhi: `${gan}${zhi}`,
      gan,
      zhi,
      shiShenGan,
      hideGan,
      naYin: (ec[`get${idx}NaYin`]() as string) ?? '',
      xunKong: (ec[`get${idx}XunKong`]() as string) ?? '',
      diShi: (ec[`get${idx}DiShi`]() as string) ?? '',
    }
  }

  const pillars = {
    year: mkPillar('Year'),
    month: mkPillar('Month'),
    day: mkPillar('Day'),
    hour: mkPillar('Time'),
  }

  // 五行统计：四柱 8 字（干 + 支）计数
  const wuxing: Record<WuXingKey, number> = { wood: 0, fire: 0, earth: 0, metal: 0, water: 0 }
  for (const p of [pillars.year, pillars.month, pillars.day, pillars.hour]) {
    wuxing[GAN_WUXING[p.gan] ?? 'earth'] += 1
    wuxing[ZHI_WUXING[p.zhi] ?? 'earth'] += 1
  }

  // 大运 / 流年
  const yun = ec.getYun(genderNum)
  const startYear = yun.getStartYear()
  const startMonth = yun.getStartMonth()
  const startDay = yun.getStartDay()
  const startSolar = yun.getStartSolar()
  const startLuck = {
    years: startYear,
    months: startMonth,
    days: startDay,
    date: startSolar ? startSolar.toYmd() : '',
  }
  const daYunAll = yun.getDaYun()
  const nowYear = new Date().getFullYear()
  const daYun: DaYunItem[] = daYunAll.slice(1, 9).map((d) => {
    const startYear = d.getStartYear()
    const endYear = d.getEndYear()
    return {
      ganZhi: d.getGanZhi(),
      startAge: d.getStartAge(),
      endAge: d.getEndAge(),
      startYear,
      endYear,
      isCurrent: nowYear >= startYear && nowYear <= endYear,
    }
  })
  // 当前大运（按当前年份落入；无匹配 → 第一步）
  const current = daYunAll
    .slice(1)
    .find((d) => nowYear >= d.getStartYear() && nowYear <= d.getEndYear()) ?? daYunAll[1]
  const liuNian: LiuNianItem[] = current
    ? (
        current.getLiuNian() as Array<{
          getYear: () => number
          getGanZhi: () => string
          getAge: () => number
          getXunKong: () => string
        }>
      ).map((l) => ({
        year: l.getYear(),
        ganZhi: l.getGanZhi(),
        age: l.getAge(),
        xunKong: l.getXunKong(),
        isCurrent: l.getYear() === nowYear,
      }))
    : []

  // M63-A：神煞（18 种）+ 柱间关系（含运岁作用：当前大运 / 当前流年）
  const slots: PillarSlot[] = [
    { position: '年', gan: pillars.year.gan, zhi: pillars.year.zhi },
    { position: '月', gan: pillars.month.gan, zhi: pillars.month.zhi },
    { position: '日', gan: pillars.day.gan, zhi: pillars.day.zhi },
    { position: '时', gan: pillars.hour.gan, zhi: pillars.hour.zhi },
  ]
  const shenSha = computeShenSha(slots)
  const currentLiuNian = liuNian.find((l) => l.isCurrent)
  const relations = computeRelations(slots, {
    ...(current ? { daYun: current.getGanZhi() } : {}),
    ...(currentLiuNian ? { liuNian: currentLiuNian.ganZhi } : {}),
  })

  // M63-A：小运（当前大运内 10 步；与既有 Yun 同源）
  const xiaoYun: XiaoYunItem[] = current
    ? (
        current.getXiaoYun() as Array<{ getGanZhi: () => string; getAge: () => number; getYear: () => number }>
      ).map((x) => ({ ganZhi: x.getGanZhi(), age: x.getAge(), year: x.getYear() }))
    : []

  // M63-A：流月（liuYueOf 指定流年——遍历全部大运找匹配年份 / 干支）
  let liuYue: LiuYueItem[] | null = null
  let liuYueOf: string | null = null
  if (opts?.liuYueOf) {
    const target = opts.liuYueOf.trim()
    type LiuNianLike = { getYear: () => number; getGanZhi: () => string; getLiuYue: () => Array<{ getMonthInChinese: () => string; getGanZhi: () => string }> }
    let found: LiuNianLike | null = null
    for (const d of daYunAll.slice(1)) {
      const hit = (d.getLiuNian() as unknown as LiuNianLike[]).find(
        (l) => String(l.getYear()) === target || l.getGanZhi() === target,
      )
      if (hit) {
        found = hit
        break
      }
    }
    if (found) {
      liuYueOf = `${found.getYear()} ${found.getGanZhi()}`
      liuYue = found.getLiuYue().map((ly) => ({ month: `${ly.getMonthInChinese()}月`, ganZhi: ly.getGanZhi() }))
    } else {
      throw new PanError(
        `未找到指定流年「${target}」`,
        'liuYueOf 用年份（如 2026）或干支（如 丙午）；请确认该年在本盘流年范围内',
      )
    }
  }

  return {
    input: {
      birth: input.birth,
      calendar: input.calendar === 'solar' ? '公历' : `农历${input.isLeapMonth ? '（闰月）' : ''}`,
      gender: input.gender === 'male' ? '男' : '女',
      corrected,
      trueSolar: input.trueSolarTime !== false,
      correction,
    },
    solar: lunar.getSolar().toYmdHms(),
    lunar: lunar.toString(),
    pillars,
    dayMaster: pillars.day.gan,
    wuxing,
    taiYuan: { ganZhi: ec.getTaiYuan(), naYin: ec.getTaiYuanNaYin() },
    taiXi: { ganZhi: ec.getTaiXi(), naYin: ec.getTaiXiNaYin() },
    mingGong: { ganZhi: ec.getMingGong(), naYin: ec.getMingGongNaYin() },
    shenGong: { ganZhi: ec.getShenGong(), naYin: ec.getShenGongNaYin() },
    forward: yun.isForward(),
    shengXiao: lunar.getYearShengXiao(),
    xingZuo: lunar.getSolar().getXingZuo(),
    startLuck,
    daYun,
    liuNian,
    shenSha,
    relations,
    xiaoYun,
    liuYue,
    liuYueOf,
    warnings,
  }
}

/**
 * M66 续完善：择日（日课）排盘域——建除十二神 / 冲煞 / 事项宜忌评分（纯计算，零依赖）。
 *
 * 口径与声明（合规统一）：
 * - 主轴 = 建除十二神（月建随节气月，日支顺推）+ 日支冲煞（冲生肖 / 煞方按三合局）；
 * - 评分 1–5 仅反映传统宜忌参考（不承诺吉凶必应）；「破日」表述为「诸事慎用日（宜静不宜动）」；
 * - 玄空 / 奇门择日不涉（v1）；区间上限 31 天；节气为近似公式——边界日建议以专业历书复核。
 */
import { PanError } from './types.js'
import {
  WEEK_LABEL,
  ZODIAC,
  dayGanzhi,
  fmtDate,
  monthZhiOf,
  nextDay,
  parseDate,
  weekdayOf,
} from './calendar.js'

/** 事项门类（v1 八类） */
export const ZERI_PURPOSES = [
  '搬家入宅',
  '动土装修',
  '开市开业',
  '嫁娶婚庆',
  '签约合作',
  '安床布置',
  '出行远行',
  '祭祀祈福',
] as const
export type ZeriPurpose = (typeof ZERI_PURPOSES)[number]

/** 建除十二神（月建起建，日支与月支同 → 建，顺推） */
export const JIANCHU = ['建', '除', '满', '平', '定', '执', '破', '危', '成', '收', '开', '闭'] as const
export type Jianchu = (typeof JIANCHU)[number]

/** 建除宜忌简表（传统口径；「破」按合规表述为诸事慎用日） */
const JIANCHU_TABLE: Record<Jianchu, { good: string[]; bad: string[]; note: string }> = {
  建: { good: ['出行', '赴任', '祈福'], bad: ['动土', '开仓'], note: '宜出行赴任，忌动土开仓' },
  除: { good: ['除旧', '疗病', '扫舍'], bad: ['出行', '开市'], note: '宜除旧疗病扫舍，忌出行开市' },
  满: { good: ['祭祀', '祈福', '开市'], bad: ['动土', '服药'], note: '宜祭祀祈福开市，忌动土服药' },
  平: { good: ['修饰', '平治'], bad: ['开渠'], note: '宜修饰平治，余事平常' },
  定: { good: ['祭祀', '嫁娶', '安床'], bad: ['出行', '交涉'], note: '宜祭祀嫁娶安床，忌出行交涉' },
  执: { good: ['造屋', '捕捉'], bad: ['开市', '移徙'], note: '宜造屋捕捉，忌开市移徙' },
  破: { good: [], bad: ['*'], note: '传统列为诸事慎用日（宜静不宜动）' },
  危: { good: ['安床', '祭祀'], bad: ['登高', '行船'], note: '宜安床祭祀，忌登高行船' },
  成: { good: ['嫁娶', '开市', '入宅'], bad: ['诉讼'], note: '宜嫁娶开市入宅，忌诉讼' },
  收: { good: ['纳财', '入仓'], bad: ['开市', '出行'], note: '宜纳财入仓，忌开市出行' },
  开: { good: ['祭祀', '开市', '入学'], bad: ['安葬'], note: '宜祭祀开市入学，忌安葬' },
  闭: { good: ['筑堤', '修整'], bad: ['开市', '出行'], note: '宜筑堤修整，忌开市出行' },
}

/** 事项 → 宜忌关键词（与建除表用词对齐；净分 = 宜命中 − 忌命中） */
const PURPOSE_KEYS: Record<ZeriPurpose, { good: string[]; bad: string[] }> = {
  搬家入宅: { good: ['入宅', '移徙', '修整', '安床', '祭祀'], bad: ['出行', '移徙'] },
  动土装修: { good: ['造屋', '修饰', '修整', '筑堤'], bad: ['动土', '开渠'] },
  开市开业: { good: ['开市', '纳财', '入仓'], bad: ['开市'] },
  嫁娶婚庆: { good: ['嫁娶', '祭祀'], bad: ['安葬'] },
  签约合作: { good: ['赴任', '纳财', '入学'], bad: ['诉讼', '交涉'] },
  安床布置: { good: ['安床', '入宅', '修饰'], bad: [] },
  出行远行: { good: ['出行', '赴任'], bad: ['出行', '登高', '行船'] },
  祭祀祈福: { good: ['祭祀', '祈福'], bad: ['服药'] },
}

/** 三合局煞方（申子辰煞南 / 寅午戌煞北 / 亥卯未煞西 / 巳酉丑煞东） */
function shaOf(zhiIndex: number): string {
  if ([8, 0, 4].includes(zhiIndex)) return '南' // 申子辰
  if ([2, 6, 10].includes(zhiIndex)) return '北' // 寅午戌
  if ([11, 3, 7].includes(zhiIndex)) return '西' // 亥卯未
  return '东' // 巳酉丑（5, 9, 1）
}

export interface ZeriDay {
  /** YYYY-MM-DD */
  date: string
  weekday: string
  /** 日柱（如「丙申」） */
  ganzhi: string
  jianchu: Jianchu
  good: string[]
  bad: string[]
  note: string
  /** 冲生肖（如「冲虎」；日支对宫） */
  chong: string
  /** 煞方（东 / 南 / 西 / 北） */
  sha: string
  /** 1–5（传统宜忌参考） */
  score: number
}

export interface ZeriResult {
  purpose: ZeriPurpose
  from: string
  to: string
  days: ZeriDay[]
  /** 推荐日（评分降序前 3；均 ≤ 2 时为空） */
  recommended: ZeriDay[]
  notes: string[]
}

/** 单日评分：基线 3；建除吉组（成 / 开 / 满 / 定）+1；命中事项宜 +1 / 忌 −1；破日 −2（下限 1） */
export function scoreOf(jianchu: Jianchu, purpose: ZeriPurpose): number {
  const table = JIANCHU_TABLE[jianchu]
  const keys = PURPOSE_KEYS[purpose]
  let score = 3
  if (['成', '开', '满', '定'].includes(jianchu)) score += 1
  const goodHit = keys.good.some((k) => table.good.includes(k))
  const badHit = table.bad.includes('*') || keys.bad.some((k) => table.bad.includes(k))
  if (goodHit) score += 1
  if (badHit) score -= 1
  if (jianchu === '破') score -= 2
  return Math.max(1, Math.min(5, score))
}

export interface ZeriInput {
  purpose: string
  /** 起始日 YYYY-MM-DD */
  from: string
  /** 结束日 YYYY-MM-DD（含；区间 ≤ 31 天） */
  to: string
}

/** 择日排盘（唯一口径；禁止模型心算兜底） */
export function computeZeri(input: ZeriInput): ZeriResult {
  const purpose = ZERI_PURPOSES.find((p) => p === input.purpose.trim())
  if (!purpose) {
    throw new PanError(
      `事项无法识别：「${input.purpose}」`,
      `事项可选：${ZERI_PURPOSES.join(' / ')}`,
    )
  }
  const from = parseDate(input.from)
  const to = parseDate(input.to)
  if (!from || !to) {
    throw new PanError('日期格式不合法', '起止日期用 YYYY-MM-DD（如 2026-09-20）')
  }
  const fromMs = Date.UTC(from.y, from.m - 1, from.d)
  const toMs = Date.UTC(to.y, to.m - 1, to.d)
  if (toMs < fromMs) {
    throw new PanError('结束日期早于起始日期', '请调换起止日期')
  }
  const span = Math.round((toMs - fromMs) / 86_400_000) + 1
  if (span > 31) {
    throw new PanError(`区间过长（${span} 天）`, '区间上限 31 天——请缩小范围后分批排盘')
  }
  const days: ZeriDay[] = []
  let cur = from
  for (let i = 0; i < span; i++) {
    const gz = dayGanzhi(cur.y, cur.m, cur.d)
    const mz = monthZhiOf(cur.y, cur.m, cur.d)
    const jianchu = JIANCHU[(gz.zhiIndex - mz.index + 12) % 12]!
    const table = JIANCHU_TABLE[jianchu]
    days.push({
      date: fmtDate(cur.y, cur.m, cur.d),
      weekday: WEEK_LABEL[weekdayOf(cur.y, cur.m, cur.d)]!,
      ganzhi: gz.name,
      jianchu,
      good: table.good,
      bad: table.bad,
      note: table.note,
      chong: `冲${ZODIAC[(gz.zhiIndex + 6) % 12]!}`,
      sha: shaOf(gz.zhiIndex),
      score: scoreOf(jianchu, purpose),
    })
    cur = nextDay(cur.y, cur.m, cur.d)
  }
  const recommended = [...days]
    .sort((a, b) => b.score - a.score || a.date.localeCompare(b.date))
    .slice(0, 3)
    .filter((d) => d.score > 2)
  const notes = [
    '口径：建除十二神（月建随节气）+ 日支冲煞——传统简表参考；评分 1–5 不构成对吉凶的必然判断，以实际安排（天气 / 工作 / 家人时间）为先',
    '节气为近似公式（1900–2100，个别年份 ±1 天）——边界日请以专业历书复核；玄空 / 奇门择日不涉（v1）',
    '涉重要仪式细节建议以专业择日服务复核；本排盘为文化研习与参考定位',
  ]
  return { purpose, from: fmtDate(from.y, from.m, from.d), to: fmtDate(to.y, to.m, to.d), days, recommended, notes }
}

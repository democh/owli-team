/**
 * M51-E 命理排盘工具集（design §6）：四件套 —— bazi_pan / ziwei_pan / natal_pan / gua_pan。
 *
 * - 纯计算只读（无 IO / 无网络 / 无副作用）；tier=deferred，经 tool_search（「排盘 / 命盘 / 星盘」）激活；
 * - 输出含可直接整卡复制的「::: pan <type> [标题]」专业盘面卡模板（E6 容器渲染；M53 增强：
 *   八字空亡 / 地势 / 胎元命宫身宫、紫微四柱 / 来因宫 / 生年四化 / 长生杂曜、星盘元素模式、
 *   卦气旬空 / 空亡爻 / 错综卦，含大限大运当前标记）；
 * - 失败语义（§6.2）：PanError → 结构化错误 + 建议，禁止模型心算兜底冒充工具结果。
 */
import { z } from 'zod'
import { computeBazi, wuxingLabel, type BaziResult, type Pillar } from '../pan/bazi.js'
import { computeDaliuren, type DaliurenResult } from '../pan/daliuren.js'
import { computeGua, type GuaResult } from '../pan/gua.js'
import { computeNatal, signOf, type NatalResult } from '../pan/natal.js'
import { computeQimen, type QimenResult } from '../pan/qimen.js'
import { computeQizheng, type QizhengResult } from '../pan/qizheng.js'
import { computeSynastry, type SynastryResult } from '../pan/synastry.js'
import { computeTransit, type TransitResult } from '../pan/transit.js'
import { GAN_WUXING, PanError } from '../pan/types.js'
import { computeZiwei, type ZiweiResult } from '../pan/ziwei.js'
import type { AgentTool, ToolResult } from './registry.js'

/** 统一失败语义：PanError（含建议）与未预期错误分列 */
function panError(err: unknown): ToolResult {
  if (err instanceof PanError) {
    return {
      ok: false,
      summary: `排盘失败：${err.message}`,
      detail: `排盘失败：${err.message}\n建议：${err.hint}`,
    }
  }
  const msg = err instanceof Error ? err.message : String(err)
  return {
    ok: false,
    summary: `排盘失败（未预期错误）：${msg}`,
    detail: `排盘失败（未预期错误）：${msg}\n建议：请核对输入后重试；如仍失败请反馈该案例（附完整输入）`,
  }
}

const deg = (x: number): string => `${x.toFixed(2)}°`
const degInSign = (lon: number): string => {
  const s = signOf(lon)
  return `${s.sign} ${s.deg.toFixed(1)}°`
}
/** 校正量符号格式化（如 -11 / +3） */
const signed = (n: number): string => (n > 0 ? `+${n}` : `${n}`)
/** 干支阴阳（日主展示用） */
const GAN_YIN_YANG: Record<string, string> = {
  甲: '阳', 乙: '阴', 丙: '阳', 丁: '阴', 戊: '阳', 己: '阴', 庚: '阳', 辛: '阴', 壬: '阳', 癸: '阴',
}

/** 出生输入（八字 / 紫微共用） */
const birthArgs = z.object({
  birth: z.string().min(1),
  calendar: z.enum(['solar', 'lunar']).default('solar'),
  isLeapMonth: z.boolean().optional(),
  gender: z.enum(['male', 'female']),
  longitude: z.number().min(-180).max(180).optional(),
  trueSolarTime: z.boolean().optional(),
  timezone: z.string().optional(),
})

const BIRTH_PARAMETERS = {
  birth: { type: 'string', description: "出生时间 'YYYY-MM-DD HH:mm'（calendar=solar 为公历时刻；lunar 为农历日期 + 时分）" },
  calendar: { type: 'string', enum: ['solar', 'lunar'], description: '历法（默认 solar 公历；lunar 农历时用 isLeapMonth 标记闰月）' },
  isLeapMonth: { type: 'boolean', description: '农历闰月标记（该年该月为闰月时置 true）' },
  gender: { type: 'string', enum: ['male', 'female'], description: '性别（大运顺逆与部分神煞依赖）' },
  longitude: { type: 'number', description: '出生地经度（东经为正）；真太阳时校正用' },
  trueSolarTime: { type: 'boolean', description: '真太阳时校正（默认开启；缺经度 / 时区时自动跳过并告警）' },
  timezone: { type: 'string', description: 'IANA 时区名（如 Asia/Shanghai），配合 longitude 估算标准经线' },
} as const

// ---------------------------------------------------------------- bazi_pan

/** 神煞文本（M63-A）：`神煞名（起法→命中柱）` 逐项 */
function shenShaText(r: BaziResult): string {
  return r.shenSha.map((s) => `${s.name}（${s.basis}→${s.pillars.join('')}）`).join(' ｜ ')
}

/** 柱间关系文本（M63-A）：四柱两两（天干 / 地支两段）+ 运岁作用（大运 / 流年） */
function relationText(r: BaziResult): { columnar: string; yunSui: string } {
  const four = r.relations.filter((x) => x.pair !== '大运' && x.pair !== '流年')
  const gan = four.filter((x) => x.scope === '天干').map((x) => `${x.label}（${x.pair}）`)
  const zhi = four.filter((x) => x.scope === '地支').map((x) => `${x.label}（${x.pair}）`)
  const columnar = [gan.length > 0 ? `天干 ${gan.join('·')}` : '', zhi.length > 0 ? `地支 ${zhi.join('·')}` : '']
    .filter(Boolean)
    .join(' ｜ ')
  const segs: string[] = []
  const curDaYun = r.daYun.find((d) => d.isCurrent)
  const curLiuNian = r.liuNian.find((l) => l.isCurrent)
  for (const [name, gz] of [
    ['大运', curDaYun ? curDaYun.ganZhi : ''] as const,
    ['流年', curLiuNian ? curLiuNian.ganZhi : ''] as const,
  ]) {
    if (!gz) continue
    const items = r.relations.filter((x) => x.pair === name)
    if (items.length > 0) segs.push(`${name}${gz} · ${items.map((x) => x.label).join('·')}`)
  }
  return { columnar, yunSui: segs.join(' ｜ ') }
}

function baziDetail(r: BaziResult): string {
  const q = (p: Pillar): string => p.ganZhi
  const ss = (p: Pillar): string => p.shiShenGan
  const hide = (p: Pillar): string => `${p.zhi}(${p.hideGan.map((h) => h.gan).join('')})`
  const sex = r.input.gender === '男' ? '乾造' : '坤造'
  const p = r.pillars
  const dayEl = `${GAN_YIN_YANG[r.dayMaster] ?? ''}${wuxingLabel(GAN_WUXING[r.dayMaster] ?? 'earth')}`
  const { columnar, yunSui } = relationText(r)
  const xiaoYunText = r.xiaoYun.map((x) => `${x.ganZhi}（${x.age}岁）`).join(' ｜ ')
  const L: string[] = []
  L.push(`四柱八字（${sex}）：${q(p.year)} ${q(p.month)} ${q(p.day)} ${q(p.hour)}`)
  L.push(`公历：${r.solar}；农历：${r.lunar}；生肖：${r.shengXiao}；星座：${r.xingZuo}`)
  if (r.input.correction !== null) L.push(`真太阳时：校正 ${signed(r.input.correction)} 分钟 → ${r.input.corrected}`)
  else L.push(`输入：${r.input.birth}（${r.input.calendar}，未做真太阳时校正）`)
  L.push(`日主：${r.dayMaster}（${dayEl}）；五行统计：木${r.wuxing.wood} 火${r.wuxing.fire} 土${r.wuxing.earth} 金${r.wuxing.metal} 水${r.wuxing.water}`)
  L.push(`十神（年→时）：${ss(p.year)} ${ss(p.month)} ${ss(p.day)} ${ss(p.hour)}`)
  L.push(`藏干：${hide(p.year)} ${hide(p.month)} ${hide(p.day)} ${hide(p.hour)}`)
  L.push(`纳音：${p.year.naYin} / ${p.month.naYin} / ${p.day.naYin} / ${p.hour.naYin}`)
  L.push(`空亡（年/月/日/时旬空）：${p.year.xunKong} / ${p.month.xunKong} / ${p.day.xunKong} / ${p.hour.xunKong}`)
  L.push(`地势（年/月/日/时十二长生）：${p.year.diShi} / ${p.month.diShi} / ${p.day.diShi} / ${p.hour.diShi}`)
  L.push(`胎元：${r.taiYuan.ganZhi}（${r.taiYuan.naYin}）；胎息：${r.taiXi.ganZhi}（${r.taiXi.naYin}）`)
  L.push(`命宫：${r.mingGong.ganZhi}（${r.mingGong.naYin}）；身宫：${r.shenGong.ganZhi}（${r.shenGong.naYin}）`)
  if (r.shenSha.length > 0) L.push(`神煞：${shenShaText(r)}`)
  if (columnar) L.push(`柱间：${columnar}`)
  if (yunSui) L.push(`运岁：${yunSui}`)
  if (xiaoYunText) L.push(`小运（当前大运内）：${xiaoYunText}`)
  L.push(`起运：${r.startLuck.years} 年 ${r.startLuck.months} 月 ${r.startLuck.days} 日（${r.startLuck.date || '—'} 交运，大运${r.forward ? '顺行' : '逆行'}）`)
  L.push(`大运（8 步）：${r.daYun.map((d) => `${d.ganZhi}(${d.startAge}-${d.endAge}岁 ${d.startYear}-${d.endYear}${d.isCurrent ? ' 当前' : ''})`).join(' ')}`)
  if (r.liuNian.length > 0) {
    L.push(`流年（当前大运内）：${r.liuNian.map((l) => `${l.year}${l.ganZhi}${l.isCurrent ? '（当前）' : ''}`).join(' ')}`)
  }
  if (r.liuYue && r.liuYueOf) {
    L.push(`流月（${r.liuYueOf}）：${r.liuYue.map((ly) => `${ly.month}${ly.ganZhi}`).join(' ')}`)
  }
  for (const w of r.warnings) L.push(`⚠ ${w}`)
  L.push('')
  L.push('盘面卡（复制到回复渲染，整卡原样保留、勿增删字段）：')
  L.push(`::: pan bazi 四柱 ${q(p.year)} ${q(p.month)} ${q(p.day)} ${q(p.hour)}`)
  L.push(`命造：${sex} ｜ 生肖 ${r.shengXiao} ｜ 公历 ${r.input.birth} ｜ 农历 ${r.lunar}`)
  if (r.input.correction !== null && r.input.corrected !== r.input.birth) {
    L.push(`真太阳时：校正 ${signed(r.input.correction)} 分钟 → ${r.input.corrected}`)
  }
  L.push(`四柱：${q(p.year)} ${q(p.month)} ${q(p.day)} ${q(p.hour)}`)
  L.push(`十神：${ss(p.year)} ${ss(p.month)} ${ss(p.day)} ${ss(p.hour)}`)
  L.push(`藏干：${hide(p.year)} ${hide(p.month)} ${hide(p.day)} ${hide(p.hour)}`)
  L.push(`纳音：${p.year.naYin} ｜ ${p.month.naYin} ｜ ${p.day.naYin} ｜ ${p.hour.naYin}`)
  L.push(`五行：木${r.wuxing.wood} 火${r.wuxing.fire} 土${r.wuxing.earth} 金${r.wuxing.metal} 水${r.wuxing.water} ｜ 日主 ${r.dayMaster}（${dayEl}）`)
  L.push(`空亡：年${p.year.xunKong} 月${p.month.xunKong} 日${p.day.xunKong} 时${p.hour.xunKong}`)
  L.push(`地势：年${p.year.diShi} 月${p.month.diShi} 日${p.day.diShi} 时${p.hour.diShi}`)
  L.push(`胎元：${r.taiYuan.ganZhi}（${r.taiYuan.naYin}） ｜ 胎息：${r.taiXi.ganZhi}（${r.taiXi.naYin}）`)
  L.push(`命宫：${r.mingGong.ganZhi}（${r.mingGong.naYin}） ｜ 身宫：${r.shenGong.ganZhi}（${r.shenGong.naYin}）`)
  if (r.shenSha.length > 0) L.push(`神煞：${shenShaText(r)}`)
  if (columnar) L.push(`柱间：${columnar}`)
  if (yunSui) L.push(`运岁：${yunSui}`)
  if (xiaoYunText) L.push(`小运：${xiaoYunText}`)
  if (r.liuYueOf) L.push(`流月：${r.liuYueOf}`)
  L.push(`起运：${r.startLuck.years} 年 ${r.startLuck.months} 月 ${r.startLuck.days} 日 ｜ ${r.startLuck.date || '—'} 交运 ｜ 大运${r.forward ? '顺行' : '逆行'}`)
  for (const d of r.daYun) {
    L.push(`- 大运 ${d.ganZhi} | ${d.startAge}-${d.endAge} 岁 ｜ ${d.startYear}-${d.endYear}${d.isCurrent ? ' · 当前大运' : ''}`)
  }
  for (const l of r.liuNian) {
    L.push(`- 流年 ${l.year} ${l.ganZhi} | ${l.age} 岁${l.isCurrent ? ' · 当前' : ''}`)
  }
  if (r.liuYue) {
    for (const ly of r.liuYue) {
      L.push(`- 流月 ${ly.ganZhi} | ${ly.month}`)
    }
  }
  L.push(':::')
  return L.join('\n')
}

/** bazi_pan 参数（M63-A：+ liuYueOf 流月请求；F 收口：容忍 number 年份——模型常传数字） */
const baziArgs = birthArgs.extend({
  liuYueOf: z.union([z.string(), z.number()]).optional(),
})

const baziPanTool: AgentTool = {
  name: 'bazi_pan',
  tier: 'deferred',
  readOnly: true,
  description:
    '四柱八字排盘（唯一口径；四柱 / 十神 / 五行 / 神煞 / 柱间关系等盘面数据必须出自本工具，禁止心算或凭记忆推算）：输入出生时间（公历 / 农历含闰月）+ 性别 + 出生地经度 / 时区，输出四柱干支、十神、藏干、纳音、旬空、地势（十二长生）、胎元 / 胎息 / 命宫 / 身宫、五行统计、神煞（天乙贵人 / 桃花 / 驿马 / 华盖 / 羊刃等 18 种，逐柱命中）、柱间关系（天干五合相冲 + 地支六合 / 冲 / 刑 / 害 / 破 / 三合 / 三会）、运岁作用（大运 / 流年对四柱）、小运、起运顺逆与大运 / 流年（含当前标记）与真太阳时校正告警；传入 liuYueOf（年份或干支）可追加该年 12 流月；返回可直接整卡复制的专业 pan 盘面卡模板（盘面信息全量呈现）。凡是「排八字 / 看四柱 / 起大运 / 查神煞 / 看流月」的盘面准备都用本工具。',
  parameters: {
    type: 'object',
    properties: {
      ...BIRTH_PARAMETERS,
      liuYueOf: { type: 'string', description: '流月请求：指定流年（年份如 2026 或干支如 丙午）输出该年十二流月条目；缺省不输出' },
    },
    required: ['birth', 'gender'],
  },
  schema: baziArgs,
  async execute(args: z.infer<typeof baziArgs>): Promise<ToolResult> {
    try {
      const r = computeBazi(args, { ...(args.liuYueOf !== undefined ? { liuYueOf: String(args.liuYueOf) } : {}) })
      const q = `${r.pillars.year.ganZhi} ${r.pillars.month.ganZhi} ${r.pillars.day.ganZhi} ${r.pillars.hour.ganZhi}`
      return { ok: true, summary: `八字排盘完成：${q}`, detail: baziDetail(r) }
    } catch (err) {
      return panError(err)
    }
  },
}

// ---------------------------------------------------------------- ziwei_pan

function starText(stars: Array<{ name: string; brightness?: string; mutagen?: string }>): string {
  if (stars.length === 0) return '（空宫）'
  return stars.map((s) => `${s.name}${s.brightness ? `(${s.brightness})` : ''}${s.mutagen ?? ''}`).join(' ')
}

/** 杂曜列表（至多 6 个 + 省略号，防盘面行过长） */
function adjText(stars: string[]): string {
  if (stars.length === 0) return ''
  const shown = stars.slice(0, 6).join(' ')
  return stars.length > 6 ? `${shown} …` : shown
}

function ziweiDetail(r: ZiweiResult): string {
  const sex = r.input.gender === '男' ? '乾造' : '坤造'
  const horoText = r.horoscope
    ? `${r.horoscope.year} ${r.horoscope.ganZhi} ｜ 流年命宫 ${r.horoscope.soulPalaceName} ｜ 流年四化 ${r.horoscope.mutagenStars.map((m) => `${m.mutagen} ${m.star}`).join(' ｜ ')}`
    : ''
  const L: string[] = []
  L.push(`紫微斗数盘（${sex}）：${r.solar}（${r.lunar}）${r.timeLabel} ${r.timeRange}`)
  L.push(`四柱：${r.chineseDate}；生肖：${r.zodiac}；星座：${r.sign}`)
  if (r.input.correction !== null && r.input.corrected !== r.input.birth) {
    L.push(`真太阳时：校正 ${signed(r.input.correction)} 分钟 → ${r.input.corrected}`)
  }
  L.push(`五行局：${r.fiveElementsClass}；命主：${r.soul}；身主：${r.body}；命宫：${r.soulPalace.ganZhi}；身宫：${r.bodyPalace.name} ${r.bodyPalace.ganZhi}`)
  if (r.laiYinPalace) L.push(`来因宫：${r.laiYinPalace.name} ${r.laiYinPalace.ganZhi}`)
  if (r.mutagenStars.length > 0) {
    L.push(`生年四化：${r.mutagenStars.map((g) => `${g.mutagen} ${g.stars.join('、')}`).join(' ｜ ')}`)
  }
  if (horoText) L.push(`流年：${horoText}`)
  for (const p of r.palaces) {
    const marks = [p.isSoulPalace ? '命宫' : '', p.isBodyPalace ? '身宫' : ''].filter(Boolean).join('·')
    const major = starText(p.majorStars)
    const minor = p.minorStars.length > 0 ? `｜辅：${starText(p.minorStars)}` : ''
    const adj = p.adjectiveStars.length > 0 ? `｜杂：${p.adjectiveStars.join(' ')}` : ''
    L.push(
      `  ${p.name}${marks ? `（${marks}）` : ''}：${p.heavenlyStem}${p.earthlyBranch}｜${major}${minor}${adj}｜长生 ${p.changSheng}｜大限 ${p.decadalRange[0]}-${p.decadalRange[1]}${p.isCurrentDecadal ? '（当前）' : ''}`,
    )
  }
  for (const w of r.warnings) L.push(`⚠ ${w}`)
  L.push('')
  L.push('盘面卡（复制到回复渲染，整卡原样保留、勿增删字段）：')
  L.push(`::: pan ziwei 紫微 ${r.fiveElementsClass} ｜ 命宫 ${r.soulPalace.ganZhi}`)
  const corr = r.input.correction !== null && r.input.corrected !== r.input.birth ? `（真太阳时校正后 ${r.input.corrected}）` : ''
  L.push(`命造：${sex} ｜ 公历 ${r.input.birth}${corr} ｜ 农历 ${r.lunar} ｜ ${r.timeLabel}（${r.timeRange}）`)
  L.push(`四柱：${r.chineseDate} ｜ 生肖 ${r.zodiac} ｜ 星座 ${r.sign}`)
  L.push(`五行局：${r.fiveElementsClass} ｜ 命主 ${r.soul} ｜ 身主 ${r.body}`)
  L.push(`命身宫：命宫 ${r.soulPalace.ganZhi} ｜ 身宫 ${r.bodyPalace.name} ${r.bodyPalace.ganZhi}`)
  if (r.laiYinPalace) L.push(`来因宫：${r.laiYinPalace.name} ${r.laiYinPalace.ganZhi}`)
  if (r.mutagenStars.length > 0) {
    L.push(`生年四化：${r.mutagenStars.map((g) => `${g.mutagen} ${g.stars.join('、')}`).join(' ｜ ')}`)
  }
  if (horoText) L.push(`流年：${horoText}`)
  for (const p of r.palaces) {
    const bodyMark = p.isBodyPalace ? ' 身宫' : ''
    const major = starText(p.majorStars)
    const minor = p.minorStars.length > 0 ? ` ｜ ${starText(p.minorStars)}` : ''
    const adj = p.adjectiveStars.length > 0 ? ` ｜ 杂 ${adjText(p.adjectiveStars)}` : ''
    L.push(
      `- ${p.name} ${p.heavenlyStem}${p.earthlyBranch}${bodyMark} | ${major}${minor}${adj} ｜ 长生 ${p.changSheng} ｜ 大限 ${p.decadalRange[0]}-${p.decadalRange[1]}${p.isCurrentDecadal ? ' · 当前' : ''}`,
    )
  }
  L.push(':::')
  return L.join('\n')
}

/** ziwei_pan 参数（M63-A：+ horoscopeYear 流年层；F 收口：容忍 number 年份） */
const ziweiArgs = birthArgs.extend({
  horoscopeYear: z.union([z.string(), z.number()]).optional(),
})

const ziweiPanTool: AgentTool = {
  name: 'ziwei_pan',
  tier: 'deferred',
  readOnly: true,
  description:
    '紫微斗数排盘（唯一口径；十二宫 / 四化 / 大限 / 流年等盘面数据必须出自本工具，禁止心算或凭记忆安星）：输入出生时间（公历 / 农历含闰月）+ 性别 + 出生地经度 / 时区，输出四柱 / 生肖星座、五行局、命主身主、命身宫与来因宫、生年四化、十二宫（宫名 / 干支 / 主星辅星 / 亮度 / 四化 / 杂曜 / 长生十二神 / 大限，含当前大限标记）与真太阳时校正告警；传入 horoscopeYear（年份如 2026）可追加流年层（流年干支 / 流年命宫 / 流年四化）；返回可直接整卡复制的专业 pan 盘面卡模板（盘面信息全量呈现）。凡是「排紫微盘 / 看命宫主星 / 起大限 / 看流年四化」的盘面准备都用本工具。',
  parameters: {
    type: 'object',
    properties: {
      ...BIRTH_PARAMETERS,
      horoscopeYear: { type: 'string', description: '流年层请求：指定公历年份（如 2026）输出流年命宫与流年四化；缺省不输出' },
    },
    required: ['birth', 'gender'],
  },
  schema: ziweiArgs,
  async execute(args: z.infer<typeof ziweiArgs>): Promise<ToolResult> {
    try {
      const r = computeZiwei(args, { ...(args.horoscopeYear !== undefined ? { horoscopeYear: String(args.horoscopeYear) } : {}) })
      return { ok: true, summary: `紫微排盘完成：${r.fiveElementsClass} · 命主${r.soul}`, detail: ziweiDetail(r) }
    } catch (err) {
      return panError(err)
    }
  },
}

// ---------------------------------------------------------------- natal_pan

const natalArgs = z.object({
  birth: z.string().min(1),
  timezone: z.string().min(1),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  houseSystem: z.enum(['placidus', 'equal']).default('placidus'),
})

function natalDetail(r: NatalResult): string {
  const houseLabel = r.houseSystem === 'placidus' ? 'Placidus' : '等宫制'
  const L: string[] = []
  L.push(`星盘：${r.input.birth}（${r.input.timezone}）@ ${r.input.latitude}°N ${r.input.longitude}°E；UTC ${r.utc}`)
  L.push(`宫制：${houseLabel}；四轴：ASC ${degInSign(r.angles.asc)} ｜ MC ${degInSign(r.angles.mc)} ｜ DSC ${degInSign(r.angles.dsc)} ｜ IC ${degInSign(r.angles.ic)}`)
  L.push('行星（黄经 / 星座度数 / 落宫）：')
  for (const p of r.planets) {
    L.push(`  ${p.name}：${degInSign(p.lon)}（${deg(p.lon)}）｜ ${p.house} 宫${p.retrograde ? ' ｜ 逆行' : ''}`)
  }
  L.push(`宫头：${r.cusps.map((c, i) => `${i + 1}宫 ${degInSign(c)}`).join(' ｜ ')}`)
  if (r.aspects.length > 0) {
    L.push(`相位（主相位）：${r.aspects.map((a) => `${a.p1}-${a.p2} ${a.type} ${a.orb.toFixed(1)}°`).join(' ｜ ')}`)
  }
  L.push(`元素：火${r.elements.fire} 土${r.elements.earth} 风${r.elements.air} 水${r.elements.water}；模式：基本${r.modes.cardinal} 固定${r.modes.fixed} 变动${r.modes.mutable}`)
  for (const w of r.warnings) L.push(`⚠ ${w}`)
  L.push('')
  L.push('盘面卡（复制到回复渲染，整卡原样保留、勿增删字段）：')
  L.push(`::: pan natal 本命盘 ${r.input.birth}`)
  L.push(`出生：公历 ${r.input.birth} ｜ ${r.input.timezone} ｜ ${r.input.latitude}°N ${r.input.longitude}°E ｜ UTC ${r.utc}`)
  L.push(`宫制：${houseLabel} ｜ 四轴：ASC ${degInSign(r.angles.asc)} ｜ MC ${degInSign(r.angles.mc)} ｜ DSC ${degInSign(r.angles.dsc)} ｜ IC ${degInSign(r.angles.ic)}`)
  L.push(`元素：火${r.elements.fire} 土${r.elements.earth} 风${r.elements.air} 水${r.elements.water} ｜ 模式：基本${r.modes.cardinal} 固定${r.modes.fixed} 变动${r.modes.mutable}`)
  for (const p of r.planets) {
    L.push(`- ${p.name} | ${degInSign(p.lon)}（${deg(p.lon)}）｜ ${p.house} 宫${p.retrograde ? ' ｜ 逆行' : ''}`)
  }
  r.cusps.forEach((c, i) => {
    L.push(`- 宫头 ${i + 1} | ${degInSign(c)}`)
  })
  for (const a of r.aspects) {
    L.push(`- ${a.p1}-${a.p2} | ${a.type} ${a.orb.toFixed(1)}°`)
  }
  L.push(':::')
  return L.join('\n')
}

const natalPanTool: AgentTool = {
  name: 'natal_pan',
  tier: 'deferred',
  readOnly: true,
  description:
    '西方星盘排盘（astronomy-engine 星历 + 自研宫位 / 相位算法；行星黄经、宫头与相位数据必须出自本工具，禁止心算或估算）：输入公历出生时刻 + IANA 时区（必填，不做缺省猜测）+ 出生地经纬度，输出十大行星（黄经 / 星座度数 / 落宫 / 逆行）、12 宫头（默认 Placidus，高纬自动降级等宫制）、ASC / MC / DSC / IC 四轴、主相位矩阵与元素 / 模式分布；返回可直接整卡复制的专业 pan 盘面卡模板（盘面信息全量呈现）。凡是「排星盘 / 看行星座落 / 查相位」的盘面准备都用本工具。',
  parameters: {
    type: 'object',
    properties: {
      birth: { type: 'string', description: "公历出生时刻 'YYYY-MM-DD HH:mm'（当地钟表时间，公历）" },
      timezone: { type: 'string', description: 'IANA 时区名（必填，如 Asia/Shanghai；不做缺省猜测）' },
      latitude: { type: 'number', description: '出生地纬度（-90~90）' },
      longitude: { type: 'number', description: '出生地经度（东经为正，-180~180）' },
      houseSystem: { type: 'string', enum: ['placidus', 'equal'], description: '宫位制（默认 placidus；高纬或迭代不收敛时自动降级 equal 并告警）' },
    },
    required: ['birth', 'timezone', 'latitude', 'longitude'],
  },
  schema: natalArgs,
  async execute(args: z.infer<typeof natalArgs>): Promise<ToolResult> {
    try {
      const r = computeNatal(args)
      const sun = r.planets[0]
      const label = sun ? `太阳${sun.sign}${sun.degInSign.toFixed(1)}°` : ''
      return { ok: true, summary: `星盘排盘完成：${label} · ASC ${degInSign(r.angles.asc)}`, detail: natalDetail(r) }
    } catch (err) {
      return panError(err)
    }
  },
}

// ---------------------------------------------------------------- transit_pan（M63-B）

/** cross-aspects / 扫描条目上限（渲染截断；防卡体量） */
const CROSS_CAP = 40

const transitArgs = z.object({
  birth: z.string().min(1),
  timezone: z.string().min(1),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  at: z.string().min(1),
  houseSystem: z.enum(['placidus', 'equal']).default('placidus'),
  scanFrom: z.string().optional(),
  scanTo: z.string().optional(),
  windowDays: z.number().int().min(1).max(90).optional(),
})

function transitDetail(r: TransitResult): string {
  const houseLabel = r.natal.houseSystem === 'placidus' ? 'Placidus' : '等宫制'
  const L: string[] = []
  L.push(`行运盘：本命 ${r.natal.input.birth}（${r.natal.input.timezone}）；行运 ${r.at}（UTC ${r.utc}）`)
  L.push(
    `本命宫制：${houseLabel}；四轴：ASC ${degInSign(r.natal.angles.asc)} ｜ MC ${degInSign(r.natal.angles.mc)} ｜ DSC ${degInSign(r.natal.angles.dsc)} ｜ IC ${degInSign(r.natal.angles.ic)}`,
  )
  // M63 续完善（v2 双环）：本命十星（前端内环基准）
  L.push(`本命十星（内环基准）：${r.natal.planets.map((p) => `${p.name} ${degInSign(p.lon)}（${deg(p.lon)}）`).join(' ｜ ')}`)
  L.push('行运行星（黄经 / 星座度数 / 落本命宫）：')
  for (const p of r.planets) {
    L.push(`  ${p.name}：${degInSign(p.lon)}（${deg(p.lon)}）｜ ${p.house} 宫${p.retrograde ? ' ｜ 逆行' : ''}`)
  }
  if (r.aspects.length > 0) {
    L.push(`行运相位（cross，orb ≤ 6°）：${r.aspects.slice(0, CROSS_CAP).map((a) => `行运${a.transitPlanet}-本命${a.natalPoint} ${a.type} ${a.orb.toFixed(1)}°`).join(' ｜ ')}`)
  }
  if (r.scan) {
    L.push(`扫描 ${r.scan.from} ~ ${r.scan.to}（命中 ${r.scan.hits.length} 条，参考时点）：`)
    for (const h of r.scan.hits) {
      L.push(`  ${h.transitPlanet}-${h.natalPoint} ${h.type} 精确 ${h.exact}`)
    }
  }
  for (const w of r.warnings) L.push(`⚠ ${w}`)
  L.push('')
  L.push('盘面卡（复制到回复渲染，整卡原样保留、勿增删字段）：')
  L.push(`::: pan transit 行运 ${r.at.slice(0, 10)}`)
  L.push(`本命：${r.natal.input.birth} ｜ ${r.natal.input.timezone} ｜ ${r.natal.input.latitude}°N ${r.natal.input.longitude}°E ｜ ${houseLabel}`)
  L.push(`行运：${r.at}（当地钟表时间）｜ UTC ${r.utc}`)
  if (r.scan) L.push(`扫描：${r.scan.from} ~ ${r.scan.to}`)
  if (r.aspects.length > CROSS_CAP) L.push(`注：cross 共 ${r.aspects.length} 条，已按 orb 截断展示前 ${CROSS_CAP} 条`)
  // M63 续完善（v2 双环）：本命十星行（前端内环；旧卡无此段 → 单环零回归）
  for (const p of r.natal.planets) {
    L.push(`- 本命${p.name} | ${degInSign(p.lon)}（${deg(p.lon)}）`)
  }
  for (const p of r.planets) {
    L.push(`- 行运${p.name} | ${degInSign(p.lon)}（${deg(p.lon)}）｜ ${p.house} 宫${p.retrograde ? ' ｜ 逆行' : ''}`)
  }
  const crossShown = r.aspects.slice(0, CROSS_CAP)
  for (const a of crossShown) {
    L.push(`- 行运${a.transitPlanet}-本命${a.natalPoint} | ${a.type} ${a.orb.toFixed(1)}°`)
  }
  if (r.scan) {
    for (const h of r.scan.hits) {
      L.push(`- 行运${h.transitPlanet}-本命${h.natalPoint} | ${h.type} | 精确 ${h.exact} ｜ 影响窗 ±${h.windowDays} 天`)
    }
  }
  L.push('口径：cross-aspects orb ≤ 6°·主相位；扫描为参考时点非事件断言')
  L.push(':::')
  return L.join('\n')
}

const transitPanTool: AgentTool = {
  name: 'transit_pan',
  tier: 'deferred',
  readOnly: true,
  description:
    '行运盘排盘（唯一口径；行运行星黄经、行运对本命 cross-aspects 与精确时点必须出自本工具，禁止手工对照两盘估相位）：输入本命出生数据（公历 + IANA 时区必填 + 经纬度）+ 行运时刻（at），输出行运行星（黄经 / 星座度数 / 落本命宫 / 逆行）、行运→本命十星与四轴的 cross-aspects（orb ≤ 6°，按 orb 升序）；传 scanFrom / scanTo（如 2026-01 ~ 2026-12）可扫描窗口内相位精确时点（步长 1 天 + 二分至分钟；外行星×本命十星与四轴 + 内行星×四轴；输出「精确时点 + 影响窗」参考区间）；返回可直接整卡复制的专业 pan 盘面卡模板。凡是「看行运 / 行运相位 / 时间窗 / 何时触发」的盘面准备都用本工具。',
  parameters: {
    type: 'object',
    properties: {
      birth: { type: 'string', description: "本命出生时刻 'YYYY-MM-DD HH:mm'（公历，当地钟表时间）" },
      timezone: { type: 'string', description: 'IANA 时区名（必填，如 Asia/Shanghai；不做缺省猜测）' },
      latitude: { type: 'number', description: '出生地纬度（-90~90）' },
      longitude: { type: 'number', description: '出生地经度（东经为正，-180~180）' },
      at: { type: 'string', description: "行运时刻 'YYYY-MM-DD HH:mm'（当地钟表时间）" },
      houseSystem: { type: 'string', enum: ['placidus', 'equal'], description: '本命宫位制（默认 placidus）' },
      scanFrom: { type: 'string', description: "扫描窗口起（'YYYY-MM' 或 'YYYY-MM-DD'，如 2026-01；必须与 scanTo 成对）" },
      scanTo: { type: 'string', description: '扫描窗口止（同上）' },
      windowDays: { type: 'number', description: '影响窗天数（默认 14）' },
    },
    required: ['birth', 'timezone', 'latitude', 'longitude', 'at'],
  },
  schema: transitArgs,
  async execute(args: z.infer<typeof transitArgs>): Promise<ToolResult> {
    try {
      const r = computeTransit({
        birth: args.birth,
        timezone: args.timezone,
        latitude: args.latitude,
        longitude: args.longitude,
        at: args.at,
        houseSystem: args.houseSystem,
        ...(args.scanFrom ? { scanFrom: args.scanFrom } : {}),
        ...(args.scanTo ? { scanTo: args.scanTo } : {}),
        ...(args.windowDays ? { windowDays: args.windowDays } : {}),
      })
      const sun = r.planets[0]
      const label = sun ? `行运太阳${sun.sign}${sun.degInSign.toFixed(1)}°` : ''
      return { ok: true, summary: `行运盘完成：${label} · cross ${r.aspects.length} 条${r.scan ? ` · 扫描 ${r.scan.hits.length} 时点` : ''}`, detail: transitDetail(r) }
    } catch (err) {
      return panError(err)
    }
  },
}

// ---------------------------------------------------------------- synastry_pan（M63-B）

const synastryPersonSchema = z.object({
  birth: z.string().min(1),
  timezone: z.string().min(1),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  label: z.string().optional(),
})

const synastryArgs = z.object({
  a: synastryPersonSchema,
  b: synastryPersonSchema,
  mode: z.enum(['cross', 'composite']).default('cross'),
})

function synastryDetail(r: SynastryResult): string {
  const L: string[] = []
  L.push(`合盘（${r.a.label} × ${r.b.label}）：cross 相位 ${r.aspects.length} 条（orb ≤ 8°，对称去重）`)
  L.push(`${r.a.label}：${r.a.input.birth} ｜ ${r.a.input.timezone}；${r.b.label}：${r.b.input.birth} ｜ ${r.b.input.timezone}`)
  if (r.complement.length > 0) L.push(`元素互补：${r.complement.join(' / ')}`)
  for (const w of r.warnings) L.push(`⚠ ${w}`)
  L.push('')
  L.push('盘面卡（复制到回复渲染，整卡原样保留、勿增删字段）：')
  L.push(`::: pan synastry 合盘 ${r.a.label}×${r.b.label}`)
  L.push(`${r.a.label}：${r.a.input.birth} ｜ ${r.a.input.timezone} ｜ ${r.a.input.latitude}°N ${r.a.input.longitude}°E`)
  L.push(`${r.b.label}：${r.b.input.birth} ｜ ${r.b.input.timezone} ｜ ${r.b.input.latitude}°N ${r.b.input.longitude}°E`)
  L.push('知情：本盘仅基于双方出生数据的关系模式参考')
  // 行前缀固定 A / B（derive 依赖；自定义 label 时补侧映射行说明）
  if (r.a.label !== 'A' || r.b.label !== 'B') L.push(`A = ${r.a.label} ｜ B = ${r.b.label}`)
  L.push(
    `元素：${r.a.label} 火${r.a.elements.fire} 土${r.a.elements.earth} 风${r.a.elements.air} 水${r.a.elements.water} ｜ ${r.b.label} 火${r.b.elements.fire} 土${r.b.elements.earth} 风${r.b.elements.air} 水${r.b.elements.water}${r.complement.length > 0 ? ` ｜ 互补 ${r.complement.join(' / ')}` : ''}`,
  )
  L.push('口径：cross-aspects orb ≤ 8°·主相位·对称去重')
  if (r.aspects.length > CROSS_CAP) L.push(`注：cross 共 ${r.aspects.length} 条，已按 orb 截断展示前 ${CROSS_CAP} 条`)
  for (const p of r.a.planets) {
    L.push(`- A${p.name} | ${degInSign(p.lon)}（${deg(p.lon)}）`)
  }
  for (const p of r.b.planets) {
    L.push(`- B${p.name} | ${degInSign(p.lon)}（${deg(p.lon)}）`)
  }
  if (r.composite) {
    for (const p of r.composite) {
      L.push(`- 组合${p.name} | ${degInSign(p.lon)}（${deg(p.lon)}）`)
    }
  }
  const shown = r.aspects.slice(0, CROSS_CAP)
  for (const a of shown) {
    L.push(`- ${a.aPlanet}-${a.bPlanet} | ${a.type} ${a.orb.toFixed(1)}°`)
  }
  L.push(':::')
  return L.join('\n')
}

const synastryPanTool: AgentTool = {
  name: 'synastry_pan',
  tier: 'deferred',
  readOnly: true,
  description:
    '合盘排盘（唯一口径；双盘 cross-aspects 与组合盘中点必须出自本工具，禁止手工对照两张盘估相位）：输入双方出生数据（a / b 各含公历 + IANA 时区必填 + 经纬度），输出双方行星黄经（带侧前缀 A/B）、A星×B星 + A星×B四轴 + B星×A四轴的 cross-aspects（orb ≤ 8°，对称去重、按 orb 升序）与元素互补； mode=composite 时追加组合盘中点行星（只做行星中点盘，组合宫位 v1 不提供）；卡面含双方知情声明行（仅基于出生数据的关系模式参考）。凡是「合盘 / 关系盘 / 双人对照」的盘面准备都用本工具。',
  parameters: {
    type: 'object',
    properties: {
      a: {
        type: 'object',
        description: 'A 方出生数据',
        properties: {
          birth: { type: 'string', description: "出生时刻 'YYYY-MM-DD HH:mm'（公历，当地钟表时间）" },
          timezone: { type: 'string', description: 'IANA 时区名（必填）' },
          latitude: { type: 'number', description: '出生地纬度（-90~90）' },
          longitude: { type: 'number', description: '出生地经度（东经为正）' },
          label: { type: 'string', description: '展示名（缺省 A）' },
        },
        required: ['birth', 'timezone', 'latitude', 'longitude'],
      },
      b: {
        type: 'object',
        description: 'B 方出生数据（同上；合盘前双方须知悉并同意）',
        properties: {
          birth: { type: 'string', description: "出生时刻 'YYYY-MM-DD HH:mm'（公历，当地钟表时间）" },
          timezone: { type: 'string', description: 'IANA 时区名（必填）' },
          latitude: { type: 'number', description: '出生地纬度（-90~90）' },
          longitude: { type: 'number', description: '出生地经度（东经为正）' },
          label: { type: 'string', description: '展示名（缺省 B）' },
        },
        required: ['birth', 'timezone', 'latitude', 'longitude'],
      },
      mode: { type: 'string', enum: ['cross', 'composite'], description: 'cross 交角矩阵（默认）/ composite 追加组合盘中点' },
    },
    required: ['a', 'b'],
  },
  schema: synastryArgs,
  async execute(args: z.infer<typeof synastryArgs>): Promise<ToolResult> {
    try {
      const r = computeSynastry({ a: args.a, b: args.b, mode: args.mode })
      return { ok: true, summary: `合盘完成：cross ${r.aspects.length} 条${r.composite ? ' · 含组合盘' : ''}`, detail: synastryDetail(r) }
    } catch (err) {
      return panError(err)
    }
  },
}

// ---------------------------------------------------------------- daliuren_pan（M63-C）

const daliurenArgs = z.object({
  at: z.string().min(1),
  timezone: z.string().optional(),
})

function daliurenDetail(r: DaliurenResult): string {
  const L: string[] = []
  L.push(`大六壬课（${r.input.at}）：${r.pillars.day}日${r.pillars.hour}时 · ${r.jiang.name}${r.jiang.zhi}加${r.hourZhi} · ${r.dayNight}`)
  L.push(
    `四柱：${r.pillars.year}年 ${r.pillars.month}月 ${r.pillars.day}日 ${r.pillars.hour}时；月将：${r.jiang.name} ${r.jiang.zhi}（${r.zhongQi.name} ${r.zhongQi.date} 后）`,
  )
  L.push(`天地盘：${r.pan.diToTian.map((x) => `${x.di}→${x.tian}`).join(' ')}`)
  L.push(`四课：${r.ke.map((k) => `${k.label} 上${k.upper}（下${k.lower}）`).join(' | ')}`)
  L.push(
    `三传：${r.chuan.map((c) => `${c.name} ${c.zhi}（遁${c.dunGan ?? '空'}·${c.jiang}${c.kong ? '·旬空' : ''}）`).join(' · ')}`,
  )
  L.push(`课体：${r.keti.name} —— ${r.keti.note}`)
  L.push(`贵人：${r.guiRen.kind} ${r.guiRen.zhi} ${r.guiRen.direction}（临地盘 ${r.guiRen.di}）`)
  for (const w of r.warnings) L.push(`⚠ ${w}`)
  L.push('')
  L.push('盘面卡（复制到回复渲染，整卡原样保留、勿增删字段）：')
  L.push(`::: pan daliuren 大六壬 ${r.keti.name}`)
  L.push(`起课：${r.pillars.year}年 ${r.pillars.month}月 ${r.pillars.day}日 ${r.pillars.hour}时 ｜ ${r.dayNight}`)
  L.push(`月将：${r.jiang.name} ${r.jiang.zhi} ｜ 中气 ${r.zhongQi.name}（${r.zhongQi.date}）`)
  L.push(`天地盘：${r.pan.diToTian.map((x) => `${x.di}→${x.tian}`).join(' ')}`)
  for (const k of r.ke) {
    L.push(`- ${k.label} | 上 ${k.upper}（下 ${k.lower}）`)
  }
  for (const c of r.chuan) {
    L.push(`- ${c.name} | ${c.zhi} ｜ 遁干 ${c.dunGan ?? '—'} ｜ 天将 ${c.jiang}${c.kong ? ' ｜ 旬空' : ''}`)
  }
  L.push(`课体：${r.keti.name}（${r.keti.note}）`)
  L.push(`贵人：${r.guiRen.kind} ${r.guiRen.zhi}（临地盘 ${r.guiRen.di} · ${r.guiRen.direction}）`)
  L.push(`天将：${'子丑寅卯辰巳午未申酉戌亥'.split('').map((z) => `${z} ${r.pan.jiangOf[z] ?? ''}`).join(' ｜ ')}`)
  L.push('口径：时家·中气换将·贵人顺逆法·涉害归地比较')
  L.push(':::')
  return L.join('\n')
}

const daliurenPanTool: AgentTool = {
  name: 'daliuren_pan',
  tier: 'deferred',
  readOnly: true,
  description:
    '大六壬排课（自研规则代码化；天地盘 / 四课 / 三传 / 天将 / 遁干数据必须出自本工具，禁止心算起课）：输入起课时刻（at，公历 "YYYY-MM-DD HH:mm"），输出四柱、月将（中气换将）、天地盘（月将加时十二神）、四课（日干寄宫逐层取上神）、三传（九宗门完整：贼克/比用/涉害/遥克/昴星/别责/八专/伏吟/反吟，含课体与依据）、十二天将（昼贵夜贵 + 顺逆布）、旬遁天干与旬空；返回可直接整卡复制的专业 pan 盘面卡模板（盘面信息全量呈现）。凡是「起课 / 看课传 / 大六壬」的盘面准备都用本工具。',
  parameters: {
    type: 'object',
    properties: {
      at: { type: 'string', description: "起课时刻 'YYYY-MM-DD HH:mm'（公历，当地时间）" },
      timezone: { type: 'string', description: 'IANA 时区名（可选，如 Asia/Shanghai；干支历按钟表时间换算）' },
    },
    required: ['at'],
  },
  schema: daliurenArgs,
  async execute(args: z.infer<typeof daliurenArgs>): Promise<ToolResult> {
    try {
      const r = computeDaliuren({ at: args.at, ...(args.timezone ? { timezone: args.timezone } : {}) })
      return { ok: true, summary: `大六壬起课完成：${r.keti.name}（${r.pillars.day}日${r.pillars.hour}时）`, detail: daliurenDetail(r) }
    } catch (err) {
      return panError(err)
    }
  },
}

// ---------------------------------------------------------------- qizheng_pan（M63-E）

function qizhengDetail(r: QizhengResult): string {
  const L: string[] = []
  L.push(`七政四余盘：${r.input.birth}（${r.input.timezone}）@ ${r.input.latitude}°N ${r.input.longitude}°E；命宫 ${r.mingGong}`)
  L.push('七政四余（黄经 / 落宫 / 逆行 / 近似等级）：')
  for (const b of r.bodies) {
    L.push(`  ${b.name}：${b.gong}宫 ${b.degInGong.toFixed(1)}°（${b.lon.toFixed(2)}°）${b.retro ? ' ｜ 逆行' : ''}${b.note ? ` ｜ ${b.note}` : ''}`)
  }
  L.push('十二宫（命宫起）：')
  for (const p of r.palaces) {
    L.push(`  ${p.name}：${p.gong}宫（${p.sign}）｜ 宫主 ${p.lord}${p.bodies.length > 0 ? ` ｜ ${p.bodies.join(' ')}` : ''}`)
  }
  L.push(`庙旺：${r.miaoWang.map((m) => `${m.star} 庙${m.miao ?? '—'} 旺${m.wang ?? '—'}`).join(' ｜ ')}`)
  for (const w of r.warnings) L.push(`⚠ ${w}`)
  L.push('')
  L.push('盘面卡（复制到回复渲染，整卡原样保留、勿增删字段）：')
  L.push(`::: pan qizheng 七政 命宫${r.mingGong}`)
  L.push(`出生：公历 ${r.input.birth} ｜ ${r.input.timezone} ｜ ${r.input.latitude}°N ${r.input.longitude}°E`)
  for (const b of r.bodies) {
    // 七政：独立「逆行」段；四余：近似段内已含「· 逆行」（不重复输出）
    const tail = b.note ? b.note : b.retro ? '逆行' : ''
    L.push(`- ${b.name} | ${b.gong}宫 ${b.degInGong.toFixed(1)}°（${b.lon.toFixed(2)}°）${tail ? ` ｜ ${tail}` : ''}`)
  }
  for (const p of r.palaces) {
    L.push(`- ${p.name} ${p.gong} | 宫主 ${p.lord}${p.bodies.length > 0 ? ` ｜ ${p.bodies.join(' ')}` : ''}`)
  }
  L.push(`庙旺：${r.miaoWang.map((m) => `${m.star} 庙${m.miao ?? '—'} 旺${m.wang ?? '—'}`).join(' ｜ ')}`)
  L.push('口径：回归黄道十二宫·中气过宫·四余近似（罗计平交点 / 月孛平远地点 / 紫炁古法）；v1 不列二十八宿度')
  L.push(':::')
  return L.join('\n')
}

const qizhengPanTool: AgentTool = {
  name: 'qizheng_pan',
  tier: 'deferred',
  readOnly: true,
  description:
    '七政四余排盘（astronomy-engine 星历 + 四余近似；七政 / 四余 / 十二宫 / 庙旺数据必须出自本工具，禁止心算或估算）：输入公历出生时刻 + IANA 时区（必填）+ 经纬度，输出七政（太阳 / 太阴 / 水 / 金 / 火 / 木 / 土：黄经 / 落宫 / 逆行）、四余（罗睺 / 计都 = 平交点、月孛 = 平远地点、紫炁 = 古法线性——每行显式标注近似等级）、十二宫（命宫起：宫支 / 星座 / 宫主 / 落宫星曜）、七政庙旺与口径声明（v1 不列二十八宿度）；返回可直接整卡复制的专业 pan 盘面卡模板（盘面信息全量呈现）。凡是「排七政盘 / 四余 / 七政四余 / 中西星盘互参」的盘面准备都用本工具。',
  parameters: {
    type: 'object',
    properties: {
      birth: { type: 'string', description: "公历出生时刻 'YYYY-MM-DD HH:mm'（当地钟表时间）" },
      timezone: { type: 'string', description: 'IANA 时区名（必填，如 Asia/Shanghai）' },
      latitude: { type: 'number', description: '出生地纬度（-90~90）' },
      longitude: { type: 'number', description: '出生地经度（东经为正，-180~180）' },
    },
    required: ['birth', 'timezone', 'latitude', 'longitude'],
  },
  schema: natalArgs,
  async execute(args: z.infer<typeof natalArgs>): Promise<ToolResult> {
    try {
      const r = computeQizheng({
        birth: args.birth,
        timezone: args.timezone,
        latitude: args.latitude,
        longitude: args.longitude,
        ...(args.houseSystem ? { houseSystem: args.houseSystem } : {}),
      })
      return { ok: true, summary: `七政四余排盘完成：命宫 ${r.mingGong}（太阳 ${r.bodies[0]!.gong}宫）`, detail: qizhengDetail(r) }
    } catch (err) {
      return panError(err)
    }
  },
}

// ---------------------------------------------------------------- qimen_pan（M63-D）

const qimenArgs = z.object({
  at: z.string().min(1),
  timezone: z.string().optional(),
  sect: z.enum(['chaibu']).optional(),
})

/** 局数汉字（标题与定局行） */
const JU_CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九'] as const
/** 盘面行序（洛书布局：巽离坤 / 震中兑 / 艮坎乾） */
const QM_ORDER = [4, 9, 2, 3, 5, 7, 8, 1, 6] as const

function qimenGongLine(r: QimenResult, n: number): string {
  const g = r.gongs.find((x) => x.num === n)!
  if (g.num === 5) {
    return `- 中5 | —— 天禽（寄坤） ｜ 天盘 —— ｜ 地盘 ${g.diGan}`
  }
  return `- ${g.name}${g.num} | ${g.shen} ${g.star} ${g.men} ｜ 天盘 ${g.tianGan} ｜ 地盘 ${g.diGan}${g.kong ? ' ｜ 空' : ''}`
}

function qimenDetail(r: QimenResult): string {
  const juCn = JU_CN[r.ding.ju - 1]!
  const dunCn = `${r.ding.dun}${juCn}局`
  const L: string[] = []
  L.push(`奇门局盘（${r.input.at}）：${r.pillars.day}日 ${r.pillars.hour}时`)
  L.push(`定局：${dunCn} ｜ ${r.ding.qi} ${r.ding.yuan} ｜ 符头 ${r.ding.futou}（${r.ding.note}）`)
  // M63 续完善：置闰口径对照（仅两口径不同时输出；检查点窗口口径）
  const zrDiff = r.ding.zhirun.ju !== r.ding.ju
  if (zrDiff) L.push(`对照：置闰法 ${r.ding.zhirun.dun}${JU_CN[r.ding.zhirun.ju - 1]}局（${r.ding.zhirun.note}；本盘按拆补口径）`)
  L.push(`值符：${r.zhiFu.star} ｜ 值使：${r.zhiShi.men} ｜ 旬首：${r.xunShou.jia}（${r.xunShou.yi}）`)
  L.push('九宫（盘面序）：')
  for (const n of QM_ORDER) L.push(`  ${qimenGongLine(r, n)}`)
  for (const w of r.warnings) L.push(`⚠ ${w}`)
  L.push('')
  L.push('盘面卡（复制到回复渲染，整卡原样保留、勿增删字段）：')
  L.push(`::: pan qimen 奇门 ${r.ding.dun === '阳遁' ? '阳' : '阴'}${juCn}局`)
  L.push(`定局：${dunCn} ｜ 节气 ${r.ding.qi} ｜ ${r.ding.yuan} ｜ 符头 ${r.ding.futou}（${r.ding.note}）`)
  if (r.ding.zhirun.ju !== r.ding.ju) {
    L.push(`对照：置闰法 ${r.ding.zhirun.dun}${JU_CN[r.ding.zhirun.ju - 1]}局（${r.ding.zhirun.note}）`)
  }
  L.push(`值符：${r.zhiFu.star} ｜ 值使：${r.zhiShi.men} ｜ 旬首：${r.xunShou.jia}（${r.xunShou.yi}）`)
  L.push(`旬空：${r.xunShou.kong[0]} ${r.xunShou.kong[1]}（时旬）`)
  for (const n of QM_ORDER) L.push(qimenGongLine(r, n))
  L.push('口径：时家转盘·拆补法（符头候简化）·中宫寄坤')
  L.push(':::')
  return L.join('\n')
}

const qimenPanTool: AgentTool = {
  name: 'qimen_pan',
  tier: 'deferred',
  readOnly: true,
  description:
    '奇门遁甲排盘（时家转盘·拆补法自研；定局 / 地盘 / 天盘 / 八门 / 八神 / 值符值使数据必须出自本工具，禁止心算起局）：输入占时（at，公历 "YYYY-MM-DD HH:mm"），输出定局（阳 / 阴遁局数、节气、上中下元、符头与拆补说明）、地盘三奇六仪（戊己庚辛壬癸丁丙乙，阳顺阴逆）、值符星与值使门及旬首、九宫盘（八神 / 九星 / 八门 / 天盘干 / 地盘干，中宫天禽寄坤，旬空宫标注）、时旬空；返回可直接整卡复制的专业 pan 盘面卡模板（盘面信息全量呈现）。凡是「起局 / 看奇门 / 排九宫 / 择时（奇门）」的盘面准备都用本工具。',
  parameters: {
    type: 'object',
    properties: {
      at: { type: 'string', description: "占时 'YYYY-MM-DD HH:mm'（公历，当地时间）" },
      timezone: { type: 'string', description: 'IANA 时区名（可选，如 Asia/Shanghai）' },
      sect: { type: 'string', enum: ['chaibu'], description: '定局法（v1 仅拆补 chaibu）' },
    },
    required: ['at'],
  },
  schema: qimenArgs,
  async execute(args: z.infer<typeof qimenArgs>): Promise<ToolResult> {
    try {
      const r = computeQimen({
        at: args.at,
        ...(args.timezone ? { timezone: args.timezone } : {}),
        ...(args.sect ? { sect: args.sect } : {}),
      })
      return { ok: true, summary: `奇门起局完成：${r.ding.dun}${JU_CN[r.ding.ju - 1]}局（${r.ding.qi}${r.ding.yuan}）`, detail: qimenDetail(r) }
    } catch (err) {
      return panError(err)
    }
  },
}

// ---------------------------------------------------------------- gua_pan

const guaArgs = z.object({
  method: z.enum(['time', 'coin', 'number']),
  date: z.string().optional(),
  seed: z.number().int().optional(),
  numbers: z.tuple([z.number(), z.number()]).optional(),
  question: z.string().optional(),
})

const YAO_POS = ['初', '二', '三', '四', '五', '上'] as const

function guaDetail(r: GuaResult): string {
  const di = r.dayInfo
  const L: string[] = []
  const bianArrow = r.dongYao.length > 0 ? ` → ${r.bian.name}` : ''
  const label = (l: GuaResult['lines'][number]): string => {
    const marks = [l.shiYing, l.dong ? '动' : '', l.kongWang ? '空亡' : ''].filter(Boolean).join(' ')
    const bian = l.dong && l.bianGanZhi ? ` → ${l.bianGanZhi}（${l.bianWuxing} ${l.bianLiuQin}${l.bianHint ? ` · ${l.bianHint}` : ''}）` : ''
    const fu = l.fuShen ? ` ｜ 伏神 ${l.fuShen.liuQin} ${l.fuShen.ganZhi}（${l.fuShen.wuxing}）` : ''
    const rel = l.dayRelations && l.dayRelations.length > 0 ? ` ｜ 月日 ${l.dayRelations.join('·')}` : ''
    return `${l.title} ${l.liuShen} ${l.liuQin} ${l.ganZhi}（${l.wuxing}）${marks ? `【${marks}】` : ''}${bian}${fu}${rel}`
  }
  L.push(`${r.methodLabel}：${r.ben.name}${bianArrow}（起卦 ${r.input.date}）`)
  L.push(`卦气：${di.pillars.year}年 ${di.pillars.month}月 ${di.pillars.day}日 ${di.pillars.hour}时；日辰旬空：${di.xunKong}；农历：${di.lunar}`)
  L.push(`所问：${r.input.question || '（未记录）'}${r.input.seed !== undefined ? `；种子：${r.input.seed}` : ''}${r.input.numbers ? `；数字：${r.input.numbers[0]}、${r.input.numbers[1]}` : ''}`)
  L.push(`本卦：${r.ben.name}（上${r.ben.upper}下${r.ben.lower}，${r.ben.palace}宫${r.ben.palaceElement}，世${r.ben.shi}应${r.ben.ying}）`)
  L.push(`互卦：${r.hu.name}（上${r.hu.upper}下${r.hu.lower}）；变卦：${r.bian.name}（上${r.bian.upper}下${r.bian.lower}）`)
  L.push(`错卦：${r.cuo.name}（六爻全变）；综卦：${r.zong.name}（六爻颠倒）`)
  L.push(`动爻：${r.dongYao.map((d, i) => `${r.dongYaoLabel[i]}（第 ${d} 爻）`).join('、') || '无动爻'}`)
  L.push('六爻纳甲（上→下，含六神 / 六亲 / 五行 / 旬空 / 变爻 / 伏神 / 月日）：')
  for (const l of [...r.lines].reverse()) {
    L.push(`  ${label(l)}`)
  }
  if (r.tiYong) {
    L.push(`梅花体用：体${r.tiYong.ti}（${r.tiYong.tiElement}）；用${r.tiYong.yong}（${r.tiYong.yongElement}）；${r.tiYong.relation}：${r.tiYong.note}`)
  }
  for (const w of r.warnings) L.push(`⚠ ${w}`)
  L.push('')
  L.push('盘面卡（复制到回复渲染，整卡原样保留、勿增删字段）：')
  L.push(`::: pan gua ${r.ben.name}${bianArrow}`)
  L.push(`起卦：${r.methodLabel} ｜ ${r.input.date}${r.input.seed !== undefined ? ` ｜ 种子 ${r.input.seed}` : ''}${r.input.numbers ? ` ｜ 数字 ${r.input.numbers[0]}、${r.input.numbers[1]}` : ''}`)
  if (r.input.question) L.push(`所问：${r.input.question}`)
  L.push(`卦气：${di.pillars.year}年 ${di.pillars.month}月 ${di.pillars.day}日 ${di.pillars.hour}时 ｜ 日旬空 ${di.xunKong} ｜ ${di.lunar}`)
  L.push(`本卦：${r.ben.name} ｜ ${r.ben.palace}宫${r.ben.palaceElement} ｜ 世${r.ben.shi}应${r.ben.ying}`)
  L.push(`卦体：上卦 ${r.ben.upper}（${r.ben.upperNature}·${r.ben.upperElement}） ｜ 下卦 ${r.ben.lower}（${r.ben.lowerNature}·${r.ben.lowerElement}）`)
  L.push(`互卦：${r.hu.name}（上${r.hu.upper}下${r.hu.lower}） ｜ 变卦：${r.bian.name}（上${r.bian.upper}下${r.bian.lower}）`)
  L.push(`错卦：${r.cuo.name}（六爻全变） ｜ 综卦：${r.zong.name}（六爻颠倒）`)
  L.push(`动爻：${r.dongYao.map((d, i) => `${r.dongYaoLabel[i]}（第 ${d} 爻）`).join('、') || '无动爻'}`)
  if (r.yaoDigits) {
    L.push(`六爻数：${r.yaoDigits.map((d, i) => `${YAO_POS[i]}${d}`).join(' ')}`)
  }
  if (r.tiYong) {
    L.push(`体用：体${r.tiYong.ti}（${r.tiYong.tiElement}） ｜ 用${r.tiYong.yong}（${r.tiYong.yongElement}） ｜ ${r.tiYong.relation} · ${r.tiYong.note}`)
  }
  for (const l of [...r.lines].reverse()) {
    const marks = `${l.shiYing ? `（${l.shiYing}）` : ''}${l.dong ? ' 动' : ''}`
    const bian = l.dong && l.bianGanZhi
      ? ` → ${l.bianGanZhi} ${l.bianWuxing} ${l.bianLiuQin}${l.bianHint ? ` · ${l.bianHint}` : ''}`
      : ''
    const fu = l.fuShen ? ` ｜ 伏神 ${l.fuShen.liuQin} ${l.fuShen.ganZhi} ${l.fuShen.wuxing}` : ''
    const rel = l.dayRelations && l.dayRelations.length > 0 ? ` ｜ 月日 ${l.dayRelations.join('·')}` : ''
    L.push(
      `- ${l.title}${marks} | ${l.liuShen} ${l.liuQin} ${l.ganZhi} ${l.wuxing}${l.kongWang ? ' 空亡' : ''}${bian}${fu}${rel}`,
    )
  }
  L.push(':::')
  return L.join('\n')
}

const guaPanTool: AgentTool = {
  name: 'gua_pan',
  tier: 'deferred',
  readOnly: true,
  description:
    '六爻 / 梅花易数起卦装卦（自研规则代码化，种子可复现；卦象 / 六亲 / 世应 / 伏神 / 月日关系数据必须出自本工具，禁止心算起卦）：method=time 时间起卦（农历年月日时）/ coin 三枚铜钱摇卦（给 seed 可复现）/ number 数字起卦（numbers 两数）；输出卦气（起卦四柱 / 日辰旬空 / 农历）、本卦 / 互卦 / 变卦 / 错卦 / 综卦、六爻纳甲（干支五行 · 六亲六神 · 旬空爻 · 动爻变爻 · 伏神 · 月破 / 日破 / 暗动与旺衰简档 · 回头生克标注）、世应与梅花体用；返回可直接整卡复制的专业 pan 盘面卡模板（盘面信息全量呈现）。凡是「起卦 / 摇卦 / 报数占问」的盘面准备都用本工具。',
  parameters: {
    type: 'object',
    properties: {
      method: { type: 'string', enum: ['time', 'coin', 'number'], description: '起卦方式（time 时间 / coin 摇卦 / number 数字）' },
      date: { type: 'string', description: "起卦时间 'YYYY-MM-DD HH:mm'（time 方式必填按农历起卦；coin / number 用于六神日干，缺省今日）" },
      seed: { type: 'number', description: '摇卦随机种子（整数；同种子结果逐位可复现，占问存档建议显式给出）' },
      numbers: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: '数字起卦的两个数（第一个定上卦、第二个定下卦）' },
      question: { type: 'string', description: '所问之事（回显存档）' },
    },
    required: ['method'],
  },
  schema: guaArgs,
  async execute(args: z.infer<typeof guaArgs>): Promise<ToolResult> {
    try {
      const r = computeGua(args)
      return { ok: true, summary: `起卦完成：${r.ben.name} → ${r.bian.name}（动爻 ${r.dongYao.join('、') || '无'}）`, detail: guaDetail(r) }
    } catch (err) {
      return panError(err)
    }
  },
}

// ---------------------------------------------------------------- 导出

/** 命理排盘 9 工具（M51-E 四件套 + M63-B 行运/合盘 + C 大六壬 + D 奇门 + E 七政；纯计算只读，tier=deferred 经 tool_search 激活） */
export function createPanTools(): AgentTool[] {
  return [baziPanTool, ziweiPanTool, natalPanTool, guaPanTool, transitPanTool, synastryPanTool, daliurenPanTool, qimenPanTool, qizhengPanTool]
}

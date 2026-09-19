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
import { computeGua, type GuaResult } from '../pan/gua.js'
import { computeNatal, signOf, type NatalResult } from '../pan/natal.js'
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

function baziDetail(r: BaziResult): string {
  const q = (p: Pillar): string => p.ganZhi
  const ss = (p: Pillar): string => p.shiShenGan
  const hide = (p: Pillar): string => `${p.zhi}(${p.hideGan.map((h) => h.gan).join('')})`
  const sex = r.input.gender === '男' ? '乾造' : '坤造'
  const p = r.pillars
  const dayEl = `${GAN_YIN_YANG[r.dayMaster] ?? ''}${wuxingLabel(GAN_WUXING[r.dayMaster] ?? 'earth')}`
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
  L.push(`起运：${r.startLuck.years} 年 ${r.startLuck.months} 月 ${r.startLuck.days} 日（${r.startLuck.date || '—'} 交运，大运${r.forward ? '顺行' : '逆行'}）`)
  L.push(`大运（8 步）：${r.daYun.map((d) => `${d.ganZhi}(${d.startAge}-${d.endAge}岁 ${d.startYear}-${d.endYear}${d.isCurrent ? ' 当前' : ''})`).join(' ')}`)
  if (r.liuNian.length > 0) {
    L.push(`流年（当前大运内）：${r.liuNian.map((l) => `${l.year}${l.ganZhi}${l.isCurrent ? '（当前）' : ''}`).join(' ')}`)
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
  L.push(`起运：${r.startLuck.years} 年 ${r.startLuck.months} 月 ${r.startLuck.days} 日 ｜ ${r.startLuck.date || '—'} 交运 ｜ 大运${r.forward ? '顺行' : '逆行'}`)
  for (const d of r.daYun) {
    L.push(`- 大运 ${d.ganZhi} | ${d.startAge}-${d.endAge} 岁 ｜ ${d.startYear}-${d.endYear}${d.isCurrent ? ' · 当前大运' : ''}`)
  }
  for (const l of r.liuNian) {
    L.push(`- 流年 ${l.year} ${l.ganZhi} | ${l.age} 岁${l.isCurrent ? ' · 当前' : ''}`)
  }
  L.push(':::')
  return L.join('\n')
}

const baziPanTool: AgentTool = {
  name: 'bazi_pan',
  tier: 'deferred',
  readOnly: true,
  description:
    '四柱八字排盘（唯一口径；四柱 / 十神 / 五行等盘面数据必须出自本工具，禁止心算或凭记忆推算）：输入出生时间（公历 / 农历含闰月）+ 性别 + 出生地经度 / 时区，输出四柱干支、十神、藏干、纳音、旬空、地势（十二长生）、胎元 / 胎息 / 命宫 / 身宫、五行统计、起运顺逆与大运 / 流年（含当前标记）与真太阳时校正告警；返回可直接整卡复制的专业 pan 盘面卡模板（盘面信息全量呈现）。凡是「排八字 / 看四柱 / 起大运」的盘面准备都用本工具。',
  parameters: {
    type: 'object',
    properties: { ...BIRTH_PARAMETERS },
    required: ['birth', 'gender'],
  },
  schema: birthArgs,
  async execute(args: z.infer<typeof birthArgs>): Promise<ToolResult> {
    try {
      const r = computeBazi(args)
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

const ziweiPanTool: AgentTool = {
  name: 'ziwei_pan',
  tier: 'deferred',
  readOnly: true,
  description:
    '紫微斗数排盘（唯一口径；十二宫 / 四化 / 大限等盘面数据必须出自本工具，禁止心算或凭记忆安星）：输入出生时间（公历 / 农历含闰月）+ 性别 + 出生地经度 / 时区，输出四柱 / 生肖星座、五行局、命主身主、命身宫与来因宫、生年四化、十二宫（宫名 / 干支 / 主星辅星 / 亮度 / 四化 / 杂曜 / 长生十二神 / 大限，含当前大限标记）与真太阳时校正告警；返回可直接整卡复制的专业 pan 盘面卡模板（盘面信息全量呈现）。凡是「排紫微盘 / 看命宫主星 / 起大限」的盘面准备都用本工具。',
  parameters: {
    type: 'object',
    properties: { ...BIRTH_PARAMETERS },
    required: ['birth', 'gender'],
  },
  schema: birthArgs,
  async execute(args: z.infer<typeof birthArgs>): Promise<ToolResult> {
    try {
      const r = computeZiwei(args)
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
    const bian = l.dong && l.bianGanZhi ? ` → ${l.bianGanZhi}（${l.bianWuxing} ${l.bianLiuQin}）` : ''
    return `${l.title} ${l.liuShen} ${l.liuQin} ${l.ganZhi}（${l.wuxing}）${marks ? `【${marks}】` : ''}${bian}`
  }
  L.push(`${r.methodLabel}：${r.ben.name}${bianArrow}（起卦 ${r.input.date}）`)
  L.push(`卦气：${di.pillars.year}年 ${di.pillars.month}月 ${di.pillars.day}日 ${di.pillars.hour}时；日辰旬空：${di.xunKong}；农历：${di.lunar}`)
  L.push(`所问：${r.input.question || '（未记录）'}${r.input.seed !== undefined ? `；种子：${r.input.seed}` : ''}${r.input.numbers ? `；数字：${r.input.numbers[0]}、${r.input.numbers[1]}` : ''}`)
  L.push(`本卦：${r.ben.name}（上${r.ben.upper}下${r.ben.lower}，${r.ben.palace}宫${r.ben.palaceElement}，世${r.ben.shi}应${r.ben.ying}）`)
  L.push(`互卦：${r.hu.name}（上${r.hu.upper}下${r.hu.lower}）；变卦：${r.bian.name}（上${r.bian.upper}下${r.bian.lower}）`)
  L.push(`错卦：${r.cuo.name}（六爻全变）；综卦：${r.zong.name}（六爻颠倒）`)
  L.push(`动爻：${r.dongYao.map((d, i) => `${r.dongYaoLabel[i]}（第 ${d} 爻）`).join('、') || '无动爻'}`)
  L.push('六爻纳甲（上→下，含六神 / 六亲 / 五行 / 旬空 / 变爻）：')
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
    const bian = l.dong && l.bianGanZhi ? ` → ${l.bianGanZhi} ${l.bianWuxing} ${l.bianLiuQin}` : ''
    L.push(`- ${l.title}${marks} | ${l.liuShen} ${l.liuQin} ${l.ganZhi} ${l.wuxing}${l.kongWang ? ' 空亡' : ''}${bian}`)
  }
  L.push(':::')
  return L.join('\n')
}

const guaPanTool: AgentTool = {
  name: 'gua_pan',
  tier: 'deferred',
  readOnly: true,
  description:
    '六爻 / 梅花易数起卦装卦（自研规则代码化，种子可复现；卦象 / 六亲 / 世应数据必须出自本工具，禁止心算起卦）：method=time 时间起卦（农历年月日时）/ coin 三枚铜钱摇卦（给 seed 可复现）/ number 数字起卦（numbers 两数）；输出卦气（起卦四柱 / 日辰旬空 / 农历）、本卦 / 互卦 / 变卦 / 错卦 / 综卦、六爻纳甲（干支五行 · 六亲六神 · 旬空爻 · 动爻变爻）、世应与梅花体用；返回可直接整卡复制的专业 pan 盘面卡模板（盘面信息全量呈现）。凡是「起卦 / 摇卦 / 报数占问」的盘面准备都用本工具。',
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

/** 命理排盘 4 工具（M51-E；纯计算只读，tier=deferred 经 tool_search 激活） */
export function createPanTools(): AgentTool[] {
  return [baziPanTool, ziweiPanTool, natalPanTool, guaPanTool]
}

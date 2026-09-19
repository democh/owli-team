/**
 * M63-D：奇门遁甲计算（时家·转盘·拆补法；自研规则代码化）。
 *
 * 口径（设计 docs/metaphysics-deepening-design.md 附录 A.3，卡面固定声明）：
 * - 定局：拆补法整理——符头（甲 / 己日）定元（子午卯酉上元 / 寅申巳亥中元 / 辰戌丑未下元），
 *   符头与节气的先后关系定属（符头 ≥ 节气 → 用该节气；符头 < 节气 → 归上一节气），
 *   局数查七十二局表（冬至起阳遁 / 夏至起阴遁）；
 *   考据注记（2026-09-19）：拆补/置闰差异规则已考据（上元符头 = 子午卯酉之甲己日；
 *   超神 = 符头先于节气且差距累积；超九日于芒种/大雪置闰 = 重复该节三元十五日）——
 *   本 v1 采用「符头候整体归属符头所在节气」的简化整理（跨界候逐日归属为简化处理）；
 *   M63 续完善已落地双口径：`ding.zhirun` 置闰对照（检查点窗口：芒种/大雪后 15~30 天重复三元，
 *   仅两口径不同局时随卡输出「对照」行）——跨年累积顺延为文档级口径（v1 窗口口径）；
 * - 地盘：三奇六仪序（戊己庚辛壬癸丁丙乙）——阳遁从局数宫起戊顺飞（宫数 1→9 循环）、阴遁逆飞；
 * - 值符值使：时柱旬首仪落宫 → 该宫原生九星为值符、原生八门为值使；
 * - 天盘（转盘）：值符随时干——值符星加临时干（甲则用旬首仪）宫，余星按圆盘同序随转；天盘干随星；
 * - 八门飞宫：值使随时支——自旬首宫起按旬内序数（甲 0）阳顺阴逆逐宫飞（含中宫；落中寄坤）；
 * - 八神：值符神起（随值符星落宫）、阳顺阴逆沿圆盘排布。
 * 只输出局盘结构（含定局依据），不做吉凶断语（合规红线）。
 */
import { Lunar, Solar } from 'lunar-typescript'
import { PanError, parseDateTime } from './types.js'

/** 洛书九宫（宫数 1-9 → 宫名缩写） */
const GONG_NAME: Record<number, string> = { 1: '坎', 2: '坤', 3: '震', 4: '巽', 5: '中', 6: '乾', 7: '兑', 8: '艮', 9: '离' }
/** 圆盘顺时针 8 宫（坎→艮→震→巽→离→坤→兑→乾；中宫不参与旋转） */
const RING = [1, 8, 3, 4, 9, 2, 7, 6] as const
/** 原生九星（宫数） */
const STAR_OF: Record<number, string> = {
  1: '天蓬', 2: '天芮', 3: '天冲', 4: '天辅', 5: '天禽', 6: '天心', 7: '天柱', 8: '天任', 9: '天英',
}
/** 原生八门（宫数；中 5 无门） */
const MEN_OF: Record<number, string> = {
  1: '休门', 2: '死门', 3: '伤门', 4: '杜门', 6: '开门', 7: '惊门', 8: '生门', 9: '景门',
}
/** 八门圆盘序（顺时针方位） */
const MEN_RING = [1, 8, 3, 4, 9, 2, 7, 6] as const
/** 八神序 */
const SHEN = ['值符', '螣蛇', '太阴', '六合', '白虎', '玄武', '九地', '九天'] as const
/** 六仪三奇序（布干用） */
const YIQI = ['戊', '己', '庚', '辛', '壬', '癸', '丁', '丙', '乙'] as const
/** 七十二局表（节气 → [上元, 中元, 下元] 局数） */
const JU_TABLE: Record<string, [number, number, number]> = {
  冬至: [1, 7, 4], 小寒: [2, 8, 5], 大寒: [3, 9, 6],
  立春: [8, 5, 2], 雨水: [9, 6, 3], 惊蛰: [1, 7, 4],
  春分: [3, 9, 6], 清明: [4, 1, 7], 谷雨: [5, 2, 8],
  立夏: [4, 1, 7], 小满: [5, 2, 8], 芒种: [6, 3, 9],
  夏至: [9, 3, 6], 小暑: [8, 2, 5], 大暑: [7, 1, 4],
  立秋: [2, 5, 8], 处暑: [1, 4, 7], 白露: [9, 3, 6],
  秋分: [7, 1, 4], 寒露: [6, 9, 3], 霜降: [5, 8, 2],
  立冬: [6, 9, 3], 小雪: [5, 8, 2], 大雪: [4, 7, 1],
}
/** 阳遁节气（冬至→芒种） */
const YANG_QI = new Set(['冬至', '小寒', '大寒', '立春', '雨水', '惊蛰', '春分', '清明', '谷雨', '立夏', '小满', '芒种'])
/** 节气序（用于找「上一节气」） */
const QI_ORDER = [
  '冬至', '小寒', '大寒', '立春', '雨水', '惊蛰', '春分', '清明', '谷雨', '立夏', '小满', '芒种',
  '夏至', '小暑', '大暑', '立秋', '处暑', '白露', '秋分', '寒露', '霜降', '立冬', '小雪', '大雪',
] as const
/** 旬首仪（甲子戊 / 甲戌己 / 甲申庚 / 甲午辛 / 甲辰壬 / 甲寅癸） */
const XUN_YI: Record<string, string> = { 子: '戊', 戌: '己', 申: '庚', 午: '辛', 辰: '壬', 寅: '癸' }
/** 九宫所含地支（后天八卦方位；旬空宫标注用） */
const GONG_ZHI: Record<number, string[]> = {
  1: ['子'], 2: ['未', '申'], 3: ['卯'], 4: ['辰', '巳'], 6: ['戌', '亥'], 7: ['酉'], 8: ['丑', '寅'], 9: ['午'],
}
const ZHI = '子丑寅卯辰巳午未申酉戌亥'
const GAN = '甲乙丙丁戊己庚辛壬癸'
const DAY = 86_400_000

export interface QimenInput {
  /** 占时 'YYYY-MM-DD HH:mm' */
  at: string
  /** IANA 时区（缺省按本地时钟） */
  timezone?: string
  /** 定局法（v1 仅拆补） */
  sect?: 'chaibu'
}

export interface QimenGong {
  /** 宫数 1-9 */
  num: number
  /** 宫名（坎 / 坤 / …） */
  name: string
  /** 八神（中宫 → ''） */
  shen: string
  /** 九星（中宫 → 天禽寄坤） */
  star: string
  /** 八门（中宫 → ''） */
  men: string
  /** 天盘干（中宫 → ''） */
  tianGan: string
  /** 地盘干 */
  diGan: string
  /** 旬空标记（时旬空之支寄宫——仅在乾坤？不：空亡标注在地盘干所辖支） */
  kong: boolean
}

export interface QimenResult {
  input: { at: string; timezone: string | null }
  pillars: { year: string; month: string; day: string; hour: string }
  ding: {
    /** 阳遁 / 阴遁 */
    dun: '阳遁' | '阴遁'
    ju: number
    qi: string
    yuan: '上元' | '中元' | '下元'
    futou: string
    /** 符头与节气关系说明（超神 / 接气 / 相符） */
    note: string
    /** M63 续完善：置闰口径对照（检查点窗口口径；leap 时与拆补不同局；dun 沿用被重复节的遁性） */
    zhirun: { dun: '阳遁' | '阴遁'; ju: number; qi: string; yuan: '上元' | '中元' | '下元'; leap: boolean; note: string }
  }
  zhiFu: { star: string; gong: number }
  zhiShi: { men: string; gong: number }
  xunShou: { jia: string; yi: string; kong: [string, string] }
  gongs: QimenGong[]
  warnings: string[]
}

/** 某公历日的日干支 */
function dayGanZhi(y: number, m: number, d: number): string {
  return Solar.fromYmd(y, m, d).getLunar().getDayInGanZhi()
}

/**
 * M63 续完善：置闰判定（拆补/置闰差异·锁定口径）——
 * 检查点 C（芒种 / 大雪）的上元符头（子午卯酉之甲己日）超前量 d ≥ 9（「超神九日」）→ 置闰。
 * 考据：《易学象数论·超神接气直指》「超至九日及十余日，则当置闰」+ 分类文「只有芒种和大雪才能置闰」。
 */
function zhirunOf(ymd: [number, number, number]): boolean {
  const cMs = Date.UTC(ymd[0], ymd[1] - 1, ymd[2])
  for (let i = 0; i < 16; i++) {
    const d0 = new Date(cMs - i * DAY)
    const gz = dayGanZhi(d0.getUTCFullYear(), d0.getUTCMonth() + 1, d0.getUTCDate())
    if ((gz.charAt(0) === '甲' || gz.charAt(0) === '己') && ['子', '午', '卯', '酉'].includes(gz.charAt(1))) {
      return i >= 9 // i = 检查点 - 上元符头（天）
    }
  }
  return false
}

/** 日期比较（YYYY-M-D）*/
const cmpYmd = (a: [number, number, number], b: [number, number, number]): number =>
  a[0] !== b[0] ? a[0] - b[0] : a[1] !== b[1] ? a[1] - b[1] : a[2] - b[2]

/** [y, m(1-based), d] → UTC 毫秒（日期粒度） */
const ymdMs = (ymd: [number, number, number]): number => Date.UTC(ymd[0], ymd[1] - 1, ymd[2])

/** 收集 [T-45, T+15] 范围的 24 节气（双表合并中文键） */
function jieQiList(t: { y: number; m: number; d: number }): Array<{ name: string; ymd: [number, number, number] }> {
  const targets = new Set<string>(QI_ORDER)
  const tMs = Date.UTC(t.y, t.m - 1, t.d, 12, 0)
  const out = new Map<string, [number, number, number]>()
  for (const off of [45, 15, -15]) {
    const base = new Date(tMs - off * DAY)
    const lunar: Lunar = Solar.fromYmdHms(
      base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), 12, 0, 0,
    ).getLunar()
    const table = lunar.getJieQiTable() as Record<string, { getYear: () => number; getMonth: () => number; getDay: () => number }>
    for (const [key, solar] of Object.entries(table)) {
      if (!targets.has(key)) continue
      const ymd: [number, number, number] = [solar.getYear(), solar.getMonth(), solar.getDay()]
      const prev = out.get(key)
      // 同名节气取与当前时间最近的一次（合并多表时可能有两个年份的同名项）
      if (!prev || Math.abs(ymdMs(ymd) - tMs) < Math.abs(ymdMs(prev) - tMs)) out.set(key, ymd)
    }
  }
  return Array.from(out.entries()).map(([name, ymd]) => ({ name, ymd }))
}

/** 计算奇门局盘（golden 测试入口） */
export function computeQimen(input: QimenInput): QimenResult {
  const t = parseDateTime(input.at, '占时')
  const lunar = Solar.fromYmdHms(t.y, t.m, t.d, t.hh, t.mm, 0).getLunar()
  const yearGz = lunar.getYearInGanZhi()
  const monthGz = lunar.getMonthInGanZhi()
  const dayGz = lunar.getDayInGanZhi()
  const hourGz = lunar.getTimeInGanZhi()
  const dayGan = dayGz.charAt(0)
  const dayZhi = dayGz.charAt(1)
  const hourGan = hourGz.charAt(0)
  const hourZhi = hourGz.charAt(1)

  // ---- 定局（拆补法） ----
  // 符头：从当日（含）往前找最近的甲 / 己日
  let fY = t.y
  let fM = t.m
  let fD = t.d
  let fGz = dayGz
  for (let i = 0; i < 6; i++) {
    if (fGz.charAt(0) === '甲' || fGz.charAt(0) === '己') break
    const d0 = new Date(Date.UTC(fY, fM - 1, fD) - DAY)
    fY = d0.getUTCFullYear()
    fM = d0.getUTCMonth() + 1
    fD = d0.getUTCDate()
    fGz = dayGanZhi(fY, fM, fD)
  }
  const fZhi = fGz.charAt(1)
  const yuan: '上元' | '中元' | '下元' = ['子', '午', '卯', '酉'].includes(fZhi) ? '上元' : ['寅', '申', '巳', '亥'].includes(fZhi) ? '中元' : '下元'

  // 节气定位：当日（含）之前最近节气 S；符头 ≥ S → 用 S；否则用 S 的前一节气
  const qis = jieQiList(t)
  const today: [number, number, number] = [t.y, t.m, t.d]
  const before = qis
    .filter((q) => cmpYmd(q.ymd, today) <= 0)
    .sort((a, b) => cmpYmd(b.ymd, a.ymd))
  const s = before[0]
  if (!s) throw new PanError('节气定位失败（节气表异常）', '请反馈该案例（日期与时刻）')
  const fDay: [number, number, number] = [fY, fM, fD]
  let qi = s.name
  let note: string
  if (cmpYmd(fDay, s.ymd) >= 0) {
    const diff = Math.round((ymdMs(fDay) - ymdMs(s.ymd)) / DAY)
    note = diff === 0 ? '符头与节气同日' : `符头后于节气 ${diff} 日（拆补）`
  } else {
    const idx = QI_ORDER.indexOf(s.name as (typeof QI_ORDER)[number])
    qi = QI_ORDER[(idx - 1 + 24) % 24]!
    const diff = Math.round((ymdMs(s.ymd) - ymdMs(fDay)) / DAY)
    note = `符头先于节气 ${diff} 日（归上一节气 ${qi}）`
  }
  const yang = YANG_QI.has(qi)
  const yuanIdx = yuan === '上元' ? 0 : yuan === '中元' ? 1 : 2
  const ju = JU_TABLE[qi]![yuanIdx]!

  // ---- M63 续完善：置闰口径对照（检查点芒种/大雪窗口 [15,30) 天；超神九日置闰=重复三元十五天）----
  const todayMs = Date.UTC(today[0], today[1] - 1, today[2])
  let zhirun: QimenResult['ding']['zhirun'] = { dun: yang ? '阳遁' : '阴遁', ju, qi, yuan, leap: false, note: '与拆补整理一致' }
  const checks = qis
    .filter((q) => (q.name === '芒种' || q.name === '大雪') && 0 <= Math.round((todayMs - ymdMs(q.ymd)) / DAY) && Math.round((todayMs - ymdMs(q.ymd)) / DAY) < 30)
    .sort((a, b) => ymdMs(b.ymd) - ymdMs(a.ymd))
  const ck = checks[0]
  if (ck) {
    const dd = Math.round((todayMs - ymdMs(ck.ymd)) / DAY)
    if (dd >= 15 && zhirunOf(ck.ymd)) {
      const off = dd - 15
      const yz = off < 5 ? 0 : off < 10 ? 1 : 2
      const yuanL = (['上元', '中元', '下元'] as const)[yz]!
      zhirun = {
        dun: YANG_QI.has(ck.name) ? '阳遁' : '阴遁',
        ju: JU_TABLE[ck.name]![yz]!,
        qi: ck.name,
        yuan: yuanL,
        leap: true,
        note: `置闰窗口第 ${off + 1} 天（重复${ck.name}${yuanL}）`,
      }
    }
  }

  // ---- 地盘三奇六仪（阳顺阴逆，宫数 1→9 循环） ----
  const diGanOf = new Map<number, string>()
  const ganGongOf = new Map<string, number>()
  for (let i = 0; i < 9; i++) {
    const gong = ((ju - 1 + (yang ? i : -i) + 9 * 2) % 9) + 1
    diGanOf.set(gong, YIQI[i]!)
    ganGongOf.set(YIQI[i]!, gong)
  }

  // ---- 旬首与值符值使 ----
  const hGanIdx = GAN.indexOf(hourGan)
  const hZhiIdx = ZHI.indexOf(hourZhi)
  const shouZhiIdx = (hZhiIdx - hGanIdx + 12 * 2) % 12
  const shouZhi = ZHI[shouZhiIdx]!
  const xunYi = XUN_YI[shouZhi]!
  const kong: [string, string] = [ZHI[(shouZhiIdx + 10) % 12]!, ZHI[(shouZhiIdx + 11) % 12]!]
  const fuGong = ganGongOf.get(xunYi)! // 旬首仪落宫 → 值符宫
  const zhiFuStar = STAR_OF[fuGong]!
  const zhiShiMen = fuGong === 5 ? MEN_OF[2]! : MEN_OF[fuGong]! // 中宫寄坤

  // ---- 天盘九星（转盘：值符随时干） ----
  // 时干对应干：甲 → 旬首仪
  const targetGan = hourGan === '甲' ? xunYi : hourGan
  const targetGong = ganGongOf.get(targetGan)!
  // 圆盘旋转：值符星原在位置 p1（fuGong 在 RING 的序号；fuGong=5 时按寄坤 2），目标宫 D（=5 时按 2）
  const ringIdx = (gong: number): number => {
    const g = gong === 5 ? 2 : gong
    return RING.indexOf(g as (typeof RING)[number])
  }
  const k = (ringIdx(targetGong) - ringIdx(fuGong) + 8) % 8
  const tianStarOf = new Map<number, string>() // 宫 → 天盘星
  const tianGanOf = new Map<number, string>() // 宫 → 天盘干
  for (let i = 0; i < 8; i++) {
    const srcGong = RING[i]!
    const dstGong = RING[(i + k) % 8]!
    const star = STAR_OF[srcGong]!
    tianStarOf.set(dstGong, srcGong === 2 ? `${star}（禽随）` : star)
    tianGanOf.set(dstGong, diGanOf.get(srcGong)!)
  }

  // ---- 八门飞宫（值使随时支） ----
  const n = (hZhiIdx - shouZhiIdx + 12 * 2) % 12 // 旬内序数（甲 0）
  const step = yang ? n : -n
  let shiGong = ((fuGong - 1 + step) % 9 + 9) % 9 + 1
  if (shiGong === 5) shiGong = 2 // 逢中寄坤
  const k2 = (ringIdx(shiGong) - ringIdx(fuGong) + 8) % 8
  const tianMenOf = new Map<number, string>() // 宫 → 八门
  for (let i = 0; i < 8; i++) {
    const srcGong = MEN_RING[i]!
    const dstGong = RING[(i + k2) % 8]!
    tianMenOf.set(dstGong, MEN_OF[srcGong]!)
  }

  // ---- 八神（值符神随值符星落宫；阳顺阴逆沿圆盘） ----
  const base = ringIdx(targetGong)
  const shenOf = new Map<number, string>() // 宫 → 八神
  for (let i = 0; i < 8; i++) {
    const dst = RING[(base + (yang ? i : -i) + 8 * 2) % 8]!
    shenOf.set(dst, SHEN[i]!)
  }

  // ---- 九宫组装 ----
  const gongs: QimenGong[] = []
  for (let gong = 1; gong <= 9; gong++) {
    if (gong === 5) {
      gongs.push({
        num: 5,
        name: '中',
        shen: '',
        star: '天禽（寄坤）',
        men: '',
        tianGan: '',
        diGan: diGanOf.get(5)!,
        kong: false, // 中宫无地支方位，不标旬空
      })
      continue
    }
    gongs.push({
      num: gong,
      name: GONG_NAME[gong]!,
      shen: shenOf.get(gong) ?? '',
      star: tianStarOf.get(gong) ?? STAR_OF[gong]!,
      men: tianMenOf.get(gong) ?? MEN_OF[gong]!,
      tianGan: tianGanOf.get(gong) ?? diGanOf.get(gong)!,
      diGan: diGanOf.get(gong)!,
      kong: (GONG_ZHI[gong] ?? []).some((z) => kong.includes(z)),
    })
  }

  return {
    input: { at: input.at, timezone: input.timezone ?? null },
    pillars: { year: yearGz, month: monthGz, day: dayGz, hour: hourGz },
    ding: { dun: yang ? '阳遁' : '阴遁', ju, qi, yuan, futou: fGz, note, zhirun },
    zhiFu: { star: zhiFuStar, gong: fuGong },
    zhiShi: { men: zhiShiMen, gong: shiGong },
    xunShou: { jia: `甲${shouZhi}`, yi: xunYi, kong },
    gongs,
    warnings: [
      `旬首 甲${shouZhi}（${xunYi}）；时旬空 ${kong[0]}${kong[1]}`,
      '口径：时家转盘·拆补法（符头候简化）·中宫寄坤',
    ],
  }
}

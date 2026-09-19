/**
 * M54-A：四盘派生（设计 §3.8 精确解析规格）——纯函数，无 DOM / 无 React / 无副作用。
 *
 * - 输入 = PanCard.parsePanRows 的 fields / items（remark 侧已 trim 边界空白）；
 * - 统一前置：值按全角 `｜` 切段并逐段 trim，按关键词 / 正则定位、不按下标（段数不定）；
 * - 必需门失败 → null（宁回表）：调用方 PanView 回退静态表格（零回归路径）。
 */
import type {
  BaziLuck,
  BaziModel,
  BaziPillar,
  BaziYear,
  GuaModel,
  GuaYao,
  NatalAspect,
  NatalModel,
  NatalPlanet,
  PanKind,
  PanModel,
  PanRowData,
  ZiweiModel,
  ZiweiPalace,
  ZiweiStar,
} from './model'

// ---------------------------------------------------------------------------
// 通用
// ---------------------------------------------------------------------------

const GAN = '甲乙丙丁戊己庚辛壬癸'
const ZHI = '子丑寅卯辰巳午未申酉戌亥'
const GAN_ZHI_RE = /^[甲乙丙丁戊己庚辛壬癸][子丑寅卯辰巳午未申酉戌亥]$/u

/** 黄道十二星座（白羊 → 双鱼；黄经 = signIndex × 30 + deg） */
export const SIGNS = ['白羊', '金牛', '双子', '巨蟹', '狮子', '处女', '天秤', '天蝎', '射手', '摩羯', '水瓶', '双鱼'] as const
export type SignName = (typeof SIGNS)[number]

export function zhiIndexOf(zhi: string): number {
  return ZHI.indexOf(zhi)
}

export function signIndexOf(sign: string): number {
  return (SIGNS as readonly string[]).indexOf(sign)
}

/** 值按全角 `｜` 切段并逐段 trim（空段剔除） */
function splitSegs(value: string): string[] {
  return value
    .split('｜')
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

/** 字段查值（label 精确匹配） */
function fieldOf(fields: PanRowData[], label: string): string | undefined {
  return fields.find((f) => f.label === label)?.value
}

// ---------------------------------------------------------------------------
// 八字（§3.8 bazi）
// ---------------------------------------------------------------------------

const PILLAR_NAMES = ['年', '月', '日', '时'] as const

function parseWuXing(value: string): BaziModel['wuxing'] | null {
  const counts: Partial<BaziModel['wuxing']> = {}
  const re = /(木|火|土|金|水)(\d+)/gu
  let m: RegExpExecArray | null
  while ((m = re.exec(value)) !== null) counts[m[1] as keyof BaziModel['wuxing']] = Number(m[2])
  const keys = ['木', '火', '土', '金', '水'] as const
  if (keys.some((k) => counts[k] === undefined)) return null
  return { 木: counts.木!, 火: counts.火!, 土: counts.土!, 金: counts.金!, 水: counts.水! }
}

function deriveBazi(fields: PanRowData[], items: PanRowData[]): BaziModel | null {
  // 四柱：先剥离 `（…）` 括注（`丁未（男）` 等尾注），过滤干支词，有效词恒 4
  const siZhu = fieldOf(fields, '四柱')?.replace(/（[^（）]*）/gu, ' ')
  const pillarTokens = siZhu ? siZhu.split(/\s+/).filter((t) => GAN_ZHI_RE.test(t)) : []
  if (pillarTokens.length !== 4) return null
  const shiShenTokens = (fieldOf(fields, '十神') ?? '').split(/\s+/).filter(Boolean)
  const pillars = pillarTokens.map((gz, i) => ({
    name: PILLAR_NAMES[i]!,
    gan: gz.charAt(0),
    zhi: gz.charAt(1),
    ...(shiShenTokens.length === 4 ? { shiShen: shiShenTokens[i]! } : {}),
  })) as [BaziPillar, BaziPillar, BaziPillar, BaziPillar]

  // 五行：五键计数（任一顺序可容；缺键 → null）
  const wuXingVal = fieldOf(fields, '五行')
  const wuxing = wuXingVal ? parseWuXing(wuXingVal) : null
  if (!wuxing) return null

  const dm = wuXingVal ? /日主 (\S)（(.+?)）/.exec(wuXingVal) : null
  const jy = fieldOf(fields, '起运')
    ? /(\d{4}-\d{2}-\d{2}) 交运 ｜ 大运(顺行|逆行)/.exec(fieldOf(fields, '起运')!)
    : null

  // 大运 / 流年（label 命中而 value 不命中 → 整个派生 null）
  const daYun: BaziLuck[] = []
  const liuNian: BaziYear[] = []
  for (const it of items) {
    const dl = /^大运 (\S{2})$/.exec(it.label)
    if (dl) {
      const dv = /^(\d{1,3})-(\d{1,3}) 岁 ｜ (\d{4})-(\d{4})( · 当前大运)?$/.exec(it.value)
      if (!GAN_ZHI_RE.test(dl[1]!) || !dv) return null
      daYun.push({
        ganZhi: dl[1]!,
        ages: [Number(dv[1]), Number(dv[2])],
        years: [Number(dv[3]), Number(dv[4])],
        current: dv[5] !== undefined,
      })
      continue
    }
    const ll = /^流年 (\d{4}) (\S{2})$/.exec(it.label)
    if (ll) {
      const lv = /^(\d{1,3}) 岁( · 当前)?$/.exec(it.value)
      if (!GAN_ZHI_RE.test(ll[2]!) || !lv) return null
      liuNian.push({ year: Number(ll[1]), ganZhi: ll[2]!, age: Number(lv[1]), current: lv[2] !== undefined })
    }
  }
  if (daYun.length === 0) return null

  return {
    kind: 'bazi',
    pillars,
    wuxing,
    ...(dm ? { dayMaster: { gan: dm[1]!, yinYang: dm[2]! } } : {}),
    ...(jy ? { jiaoYun: { date: jy[1]!, direction: jy[2] as '顺行' | '逆行' } } : {}),
    daYun,
    liuNian,
    detail: fields,
  }
}

// ---------------------------------------------------------------------------
// 紫微（§3.8 ziwei）
// ---------------------------------------------------------------------------

const ZIWEI_PALACE_RE = /^(\S+) (\S{2})( 身宫)?$/
const ZIWEI_DAXIAN_RE = /^大限 (\d{1,3})-(\d{1,3})( · 当前)?$/
const ZIWEI_STAR_RE = /^([^()]+?)(?:\(([^()]+?)\))?([禄权科忌])?$/

function parseZiweiStars(seg: string): ZiweiStar[] | null {
  if (seg === '（空宫）') return []
  const stars: ZiweiStar[] = []
  for (const tok of seg.split(/\s+/).filter(Boolean)) {
    const m = ZIWEI_STAR_RE.exec(tok)
    if (!m || !m[1]) return null
    stars.push({
      name: m[1],
      ...(m[2] ? { brightness: m[2] } : {}),
      ...(m[3] ? { mutagen: m[3] as NonNullable<ZiweiStar['mutagen']> } : {}),
    })
  }
  return stars.length > 0 ? stars : null
}

function deriveZiwei(fields: PanRowData[], items: PanRowData[]): ZiweiModel | null {
  const palaces: ZiweiPalace[] = []
  const seen = new Set<string>()
  for (const it of items) {
    const pm = ZIWEI_PALACE_RE.exec(it.label)
    if (!pm || !GAN.includes(pm[2]!.charAt(0))) return null
    const zhi = pm[2]!.charAt(1)
    const zhiIndex = zhiIndexOf(zhi)
    if (zhiIndex < 0 || seen.has(zhi)) return null
    seen.add(zhi)

    // 值段锚定：长生 / 大限 / 杂曜 → 具名段；其余依序：主星段、辅星段
    const rest: string[] = []
    let changSheng: string | undefined
    let misc = ''
    let daXian: ZiweiPalace['daXian']
    for (const seg of splitSegs(it.value)) {
      const dx = ZIWEI_DAXIAN_RE.exec(seg)
      if (dx) {
        daXian = { range: [Number(dx[1]), Number(dx[2])], current: dx[3] !== undefined }
        continue
      }
      const cs = /^长生 (\S+)$/.exec(seg)
      if (cs) {
        changSheng = cs[1]!
        continue
      }
      if (seg.startsWith('杂 ')) {
        misc = seg
        continue
      }
      rest.push(seg)
    }
    if (!daXian) return null // 必需：每条含 `大限 ` 段
    const stars = parseZiweiStars(rest[0] ?? '')
    if (stars === null) return null

    palaces.push({
      name: pm[1]!,
      gan: pm[2]!.charAt(0),
      zhi,
      zhiIndex,
      stars,
      assist: rest[1] ?? '',
      misc,
      ...(changSheng ? { changSheng } : {}),
      daXian,
      shenGong: pm[3] !== undefined,
      raw: it.value,
    })
  }
  if (palaces.length !== 12) return null
  palaces.sort((a, b) => a.zhiIndex - b.zhiIndex)

  // 中宫：五行局（命主 / 身主）+ 来因宫 + 生年四化
  let wuXingJu: string | undefined
  let mingZhu: string | undefined
  let shenZhu: string | undefined
  const juVal = fieldOf(fields, '五行局')
  if (juVal) {
    for (const seg of splitSegs(juVal)) {
      const mz = /^命主 (\S+)$/.exec(seg)
      if (mz) {
        mingZhu = mz[1]!
        continue
      }
      const sz = /^身主 (\S+)$/.exec(seg)
      if (sz) {
        shenZhu = sz[1]!
        continue
      }
      if (!wuXingJu && seg.endsWith('局')) wuXingJu = seg
    }
  }
  const laiYin = fieldOf(fields, '来因宫')?.trim()
  const siHua: ZiweiModel['center']['siHua'] = []
  const siHuaVal = fieldOf(fields, '生年四化')
  if (siHuaVal) {
    for (const seg of splitSegs(siHuaVal)) {
      const sm = /^(禄|权|科|忌) (\S+)$/.exec(seg)
      if (sm) siHua.push({ mutagen: sm[1] as '禄', star: sm[2]! })
    }
  }

  return {
    kind: 'ziwei',
    palaces,
    center: {
      ...(wuXingJu ? { wuXingJu } : {}),
      ...(mingZhu ? { mingZhu } : {}),
      ...(shenZhu ? { shenZhu } : {}),
      ...(laiYin ? { laiYin } : {}),
      siHua,
    },
    detail: fields,
  }
}

// ---------------------------------------------------------------------------
// 星盘（§3.8 natal）
// ---------------------------------------------------------------------------

const NATAL_CUSP_LABEL_RE = /^宫头 (\d{1,2})$/
const NATAL_CUSP_VALUE_RE = /^(\S+) (\d+(?:\.\d+)?)°$/
const NATAL_PLANET_SEG_RE = /^(\S+) (\d+(?:\.\d+)?)°（(\d+(?:\.\d+)?)°）$/
const NATAL_ASPECT_RE = /^(合相|六合|刑相|拱相|对分) (\d+(?:\.\d+)?)°$/

function deriveNatal(fields: PanRowData[], items: PanRowData[]): NatalModel | null {
  const planets: NatalPlanet[] = []
  const cuspMap = new Map<number, number>()
  const aspects: NatalAspect[] = []
  for (const it of items) {
    const cm = NATAL_CUSP_LABEL_RE.exec(it.label)
    if (cm) {
      // 宫头不可解析 → 忽略该条（宫环降级为精简轮；不影响行星层）
      const cv = NATAL_CUSP_VALUE_RE.exec(it.value)
      const si = cv ? signIndexOf(cv[1]!) : -1
      const house = Number(cm[1])
      if (cv && si >= 0 && house >= 1 && house <= 12) cuspMap.set(house, si * 30 + Number(cv[2]))
      continue
    }
    if (it.label.includes('-')) {
      // 相位行不可解析 → 忽略（相位为装饰层）
      const [a, b] = it.label.split('-')
      const av = NATAL_ASPECT_RE.exec(it.value)
      if (av && a && b) aspects.push({ a, b, type: av[1] as NatalAspect['type'], orb: Number(av[2]) })
      continue
    }
    // 行星行：label 非宫头 / 不含 `-`，必须可解析（否则整套 null）
    const segs = splitSegs(it.value)
    const p0 = NATAL_PLANET_SEG_RE.exec(segs[0] ?? '')
    const si = p0 ? signIndexOf(p0[1]!) : -1
    if (!p0 || si < 0) return null
    const houseSeg = segs[1]
    const house = houseSeg ? /^(\d{1,2}) 宫$/.exec(houseSeg)?.[1] : undefined
    if (houseSeg && house === undefined) return null
    const retroSeg = segs[2]
    if (retroSeg !== undefined && retroSeg !== '逆行') return null
    planets.push({
      name: it.label,
      sign: p0[1]!,
      deg: Number(p0[2]),
      lon: Number(p0[3]),
      ...(house !== undefined ? { house: Number(house) } : {}),
      retro: retroSeg === '逆行',
    })
  }
  if (planets.length === 0) return null

  // 宫头恰 12 且全可解析 → 全轮盘，否则精简轮
  const cusps = cuspMap.size === 12 ? Array.from({ length: 12 }, (_, i) => cuspMap.get(i + 1)!) : null

  // 四轴：ASC（缺 → 未提供，渲染按 0° 白羊置左）
  const ascMatch = /ASC (\S+) (\d+(?:\.\d+)?)°/.exec(fieldOf(fields, '宫制') ?? '')
  const ascSi = ascMatch ? signIndexOf(ascMatch[1]!) : -1
  const asc = ascMatch && ascSi >= 0 ? ascSi * 30 + Number(ascMatch[2]) : undefined

  return {
    kind: 'natal',
    planets,
    cusps,
    ...(asc !== undefined ? { asc } : {}),
    aspects,
    detail: fields,
  }
}

// ---------------------------------------------------------------------------
// 卦（§3.8 gua）
// ---------------------------------------------------------------------------

/** 爻题（通行书法：初九 / 六二 / 九三 / 九四 / 六五 / 上六）→ pos + 阴阳 */
const YAO_TITLES: Record<string, { pos: 1 | 2 | 3 | 4 | 5 | 6; yin: boolean }> = {
  初九: { pos: 1, yin: false }, 初六: { pos: 1, yin: true },
  九二: { pos: 2, yin: false }, 六二: { pos: 2, yin: true },
  九三: { pos: 3, yin: false }, 六三: { pos: 3, yin: true },
  九四: { pos: 4, yin: false }, 六四: { pos: 4, yin: true },
  九五: { pos: 5, yin: false }, 六五: { pos: 5, yin: true },
  上九: { pos: 6, yin: false }, 上六: { pos: 6, yin: true },
}
const YAO_LABEL_RE = /^(初九|初六|九二|六二|九三|六三|九四|六四|九五|六五|上九|上六)(（(世|应)）)?( 动)?$/
const GUA_YAO_VALUE_RE =
  /^(青龙|朱雀|勾陈|腾蛇|白虎|玄武) (父母|兄弟|子孙|妻财|官鬼) (\S{2}) (\S+?)( 空亡)?( → (\S{2}) (\S+?) (父母|兄弟|子孙|妻财|官鬼))?$/
const GUA_DIGIT_RE = /^(初|二|三|四|五|上)([6789])$/
const GUA_POS: Record<string, number> = { 初: 1, 二: 2, 三: 3, 四: 4, 五: 5, 上: 6 }

function deriveGua(title: string, fields: PanRowData[], items: PanRowData[]): GuaModel | null {
  const yao: GuaYao[] = []
  for (const it of items) {
    const lm = YAO_LABEL_RE.exec(it.label)
    const vm = lm ? GUA_YAO_VALUE_RE.exec(it.value) : null
    if (!lm || !vm) return null
    const t = YAO_TITLES[lm[1]!]!
    yao.push({
      pos: t.pos,
      yin: t.yin,
      ...(lm[3] ? { shiYing: lm[3] as '世' | '应' } : {}),
      dong: lm[4] !== undefined,
      kong: vm[5] !== undefined,
      liuShen: vm[1]!,
      liuQin: vm[2]!,
      ganZhi: vm[3]!,
      wuXing: vm[4]!,
      ...(vm[6] !== undefined ? { bian: { ganZhi: vm[7]!, wuXing: vm[8]!, liuQin: vm[9]! } } : {}),
    })
  }
  if (yao.length !== 6) return null
  yao.sort((a, b) => a.pos - b.pos)
  for (let i = 0; i < 6; i++) if (yao[i]!.pos !== i + 1) return null

  // 六爻数（coin 卡专有；缺省 / 损坏 → 不提供，不影响其余）
  let digits: number[] | undefined
  const digitVal = fieldOf(fields, '六爻数')
  if (digitVal) {
    const slots: Array<number | undefined> = [undefined, undefined, undefined, undefined, undefined, undefined]
    for (const tok of digitVal.split(/\s+/).filter(Boolean)) {
      const dm = GUA_DIGIT_RE.exec(tok)
      if (dm) slots[GUA_POS[dm[1]!]! - 1] = Number(dm[2])
    }
    if (slots.every((d) => typeof d === 'number')) digits = slots as number[]
  }

  // 卦名：本卦取「本卦」字段第 1 段（回退标题 `→` 左侧）；变卦取标题 `→` 右侧（回退「互卦」字段）
  const benSeg = splitSegs(fieldOf(fields, '本卦') ?? '')[0]
  const ben = benSeg && /^[\u4e00-\u9fa5]{2,4}$/u.test(benSeg) ? benSeg : (title.split('→')[0] ?? '').trim()
  let bianName: string | undefined = (title.split('→')[1] ?? '').trim() || undefined
  if (bianName && !/^[\u4e00-\u9fa5]{2,4}$/u.test(bianName)) bianName = undefined
  if (!bianName) {
    const bm = /变卦：(\S+?)(?:（|$)/.exec(fieldOf(fields, '互卦') ?? '')
    if (bm) bianName = bm[1]
  }

  return {
    kind: 'gua',
    ben,
    ...(bianName ? { bianName } : {}),
    yao,
    ...(digits ? { digits } : {}),
    detail: fields,
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/** 唯一入口：必需门失败 → null（调用方回退静态表格） */
export function derivePan(kind: PanKind, title: string, fields: PanRowData[], items: PanRowData[]): PanModel | null {
  const f = fields
    .map((r) => ({ label: r.label.trim(), value: r.value.trim() }))
    .filter((r) => r.label !== '')
  const it = items
    .map((r) => ({ label: r.label.trim(), value: r.value.trim() }))
    .filter((r) => r.label !== '')
  switch (kind) {
    case 'bazi':
      return deriveBazi(f, it)
    case 'ziwei':
      return deriveZiwei(f, it)
    case 'natal':
      return deriveNatal(f, it)
    case 'gua':
      return deriveGua(title, f, it)
    default:
      return null
  }
}

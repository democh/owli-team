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
  DaliurenModel,
  GuaModel,
  GuaYao,
  NatalAspect,
  NatalModel,
  NatalPlanet,
  PanKind,
  PanModel,
  PanRowData,
  QimenModel,
  QizhengModel,
  SynastryModel,
  SynastryPlanet,
  TransitModel,
  TransitPlanet,
  ZiweiModel,
  ZiweiPalace,
  ZiweiStar,
} from './model'
import { deriveLuopan } from './luopan-model'
import { deriveZeri } from './zeri-model'

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
  const liuYue: BaziModel['liuYue'] = []
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
      continue
    }
    // M63-A：流月条目（可选追加；不合形状 → 忽略）
    const ym = /^流月 (\S{2})$/.exec(it.label)
    if (ym && GAN_ZHI_RE.test(ym[1]!)) liuYue.push({ ganZhi: ym[1]!, month: it.value })
  }
  if (daYun.length === 0) return null

  // M63-A：神煞 / 柱间 / 运岁 / 小运（可选追加字段；缺失或损坏 → 该区块不渲染）
  const shenSha: NonNullable<BaziModel['shenSha']> = []
  const shenShaVal = fieldOf(fields, '神煞')
  if (shenShaVal) {
    for (const seg of splitSegs(shenShaVal)) {
      const m = /^([^（）]+)（([^（）]+)）$/.exec(seg)
      if (!m) continue
      const [basis, pillarStr] = m[2]!.split('→')
      if (!basis) continue
      const pillars = (pillarStr ?? '').split('').filter((c) => PILLAR_NAMES.includes(c as '年'))
      shenSha.push({ name: m[1]!, basis, pillars })
    }
  }
  const columnar: NonNullable<BaziModel['columnar']> = []
  const columnarVal = fieldOf(fields, '柱间')
  if (columnarVal) {
    for (const seg of splitSegs(columnarVal)) {
      const m = /^(天干|地支) (.+)$/.exec(seg)
      if (!m) continue
      const scope = m[1] as '天干' | '地支'
      for (const item of m[2]!.split('·').map((s) => s.trim()).filter(Boolean)) {
        const im = /^(.+?)（(\S+)）$/.exec(item)
        if (im) columnar.push({ scope, label: im[1]!, pair: im[2]! })
      }
    }
  }
  const yunSui = fieldOf(fields, '运岁')?.trim() || undefined
  const xiaoYun: NonNullable<BaziModel['xiaoYun']> = []
  const xiaoYunVal = fieldOf(fields, '小运')
  if (xiaoYunVal) {
    for (const seg of splitSegs(xiaoYunVal)) {
      const m = /^(\S{2})（(\d+)岁）$/.exec(seg)
      if (m && GAN_ZHI_RE.test(m[1]!)) xiaoYun.push({ ganZhi: m[1]!, age: Number(m[2]) })
    }
  }
  // 流月对应流年回显（`流月：2026 丙午`）
  let liuYueOf: BaziModel['liuYueOf']
  const liuYueOfVal = fieldOf(fields, '流月')
  if (liuYueOfVal) {
    const m = /^(\d{4}) (\S{2})$/.exec(liuYueOfVal.trim())
    if (m && GAN_ZHI_RE.test(m[2]!)) liuYueOf = { year: Number(m[1]), ganZhi: m[2]! }
  }

  return {
    kind: 'bazi',
    pillars,
    wuxing,
    ...(dm ? { dayMaster: { gan: dm[1]!, yinYang: dm[2]! } } : {}),
    ...(jy ? { jiaoYun: { date: jy[1]!, direction: jy[2] as '顺行' | '逆行' } } : {}),
    daYun,
    liuNian,
    ...(shenSha.length > 0 ? { shenSha } : {}),
    ...(columnar.length > 0 ? { columnar } : {}),
    ...(yunSui ? { yunSui } : {}),
    ...(xiaoYun.length > 0 ? { xiaoYun } : {}),
    ...(liuYue.length > 0 ? { liuYue } : {}),
    ...(liuYueOf ? { liuYueOf } : {}),
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

  // M63-A：流年层（可选追加字段；`2026 丙午 ｜ 流年命宫 财帛 ｜ 流年四化 禄 天同 ｜ 权 天机 …`）
  let horoscope: NonNullable<ZiweiModel['center']['horoscope']> | undefined
  const horoVal = fieldOf(fields, '流年')
  if (horoVal) {
    let year: number | undefined
    let ganZhi: string | undefined
    let soulPalace: string | undefined
    const hs: NonNullable<ZiweiModel['center']['horoscope']>['siHua'] = []
    for (const seg of splitSegs(horoVal)) {
      const ym = /^(\d{4}) (\S{2})$/.exec(seg)
      if (ym && GAN_ZHI_RE.test(ym[2]!)) {
        year = Number(ym[1])
        ganZhi = ym[2]!
        continue
      }
      const sm = /^流年命宫 (\S+)$/.exec(seg)
      if (sm) {
        soulPalace = sm[1]!
        continue
      }
      const raw = seg.replace(/^流年四化\s*/u, '')
      const hm = /^(禄|权|科|忌) (\S+)$/.exec(raw)
      if (hm) hs.push({ mutagen: hm[1] as '禄', star: hm[2]! })
    }
    if (year && ganZhi && soulPalace) {
      // 流年十二宫：自流年命宫起按固定宫序逆布（本命宫地支减序；实证与 iztro palaceNames 逐字吻合）
      const SUI_ORDER = ['命宫', '兄弟', '夫妻', '子女', '财帛', '疾厄', '迁移', '仆役', '官禄', '田宅', '福德', '父母']
      const palaceOf: Record<string, string> = {}
      const base = palaces.find((p) => p.name === soulPalace)
      if (base) {
        SUI_ORDER.forEach((name, i) => {
          const zi = (base.zhiIndex - i + 24) % 12
          palaceOf[ZHI[zi]!] = name
        })
      }
      horoscope = { year, ganZhi, soulPalace, siHua: hs, palaceOf }
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
      ...(horoscope ? { horoscope } : {}),
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
/** 爻值核心段（M63-A 扩展：变爻段可选 ` · 回头生/克/泄` 尾注；伏神 / 月日为追加段） */
const GUA_YAO_VALUE_RE =
  /^(青龙|朱雀|勾陈|腾蛇|白虎|玄武) (父母|兄弟|子孙|妻财|官鬼) (\S{2}) (\S+?)( 空亡)?( → (\S{2}) (\S+?) (父母|兄弟|子孙|妻财|官鬼)( · (回头生|回头克|回头泄))?)?$/
const GUA_FUSHEN_SEG_RE = /^伏神 (\S+) (\S{2}) (\S+)$/
const GUA_DAYREL_SEG_RE = /^月日 (.+)$/
const GUA_DIGIT_RE = /^(初|二|三|四|五|上)([6789])$/
const GUA_POS: Record<string, number> = { 初: 1, 二: 2, 三: 3, 四: 4, 五: 5, 上: 6 }

function deriveGua(title: string, fields: PanRowData[], items: PanRowData[]): GuaModel | null {
  const yao: GuaYao[] = []
  for (const it of items) {
    const lm = YAO_LABEL_RE.exec(it.label)
    const segs = splitSegs(it.value)
    const vm = lm ? GUA_YAO_VALUE_RE.exec(segs[0] ?? '') : null
    if (!lm || !vm) return null
    // M63-A：伏神 / 月日关系（追加段；不合形状 → 忽略）
    let fuShen: GuaYao['fuShen']
    let dayRel: string[] | undefined
    for (const seg of segs.slice(1)) {
      const fm = GUA_FUSHEN_SEG_RE.exec(seg)
      if (fm) {
        fuShen = { liuQin: fm[1]!, ganZhi: fm[2]!, wuXing: fm[3]! }
        continue
      }
      const dm = GUA_DAYREL_SEG_RE.exec(seg)
      if (dm) {
        dayRel = dm[1]!.split('·').map((s) => s.trim()).filter(Boolean)
        continue
      }
    }
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
      ...(fuShen ? { fuShen } : {}),
      ...(dayRel && dayRel.length > 0 ? { dayRel } : {}),
      ...(vm[11] ? { bianHint: vm[11] } : {}),
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
// 行运（M63-B；§附录 B.1）——行运行星 / cross-aspects / 扫描时点
// ---------------------------------------------------------------------------

const TRANSIT_PLANET_LABEL_RE = /^行运([^-\s]+)$/
const TRANSIT_SCAN_VALUE_RE = /^(\S+) \| 精确 (\d{4}-\d{2}-\d{2} \d{2}:\d{2})(?: ｜ 影响窗 ±(\d+) 天)?$/
const TRANSIT_CROSS_VALUE_RE = /^(\S+) (\d+(?:\.\d+)?)°$/
const TRANSIT_SCAN_FIELD_RE = /^(\d{4}-\d{2}-\d{2}) ~ (\d{4}-\d{2}-\d{2})$/

function deriveTransit(fields: PanRowData[], items: PanRowData[]): TransitModel | null {
  const planets: TransitPlanet[] = []
  const natalPlanets: NonNullable<TransitModel['natalPlanets']> = []
  const aspects: TransitModel['aspects'] = []
  const hits: NonNullable<TransitModel['scan']>['hits'] = []
  for (const it of items) {
    // cross / 扫描先判（label 含 `-`；避免被「行运X」行星正则抢匹配）：按 value 区分
    const cm = /^行运(\S+?)-本命(\S+)$/.exec(it.label)
    if (cm) {
      if (it.value.includes('精确')) {
        // 扫描时点（追加条目；不合形状 → 忽略，不阻断派生）
        const sm = TRANSIT_SCAN_VALUE_RE.exec(it.value)
        if (sm) {
          hits.push({
            transitPlanet: cm[1]!,
            natalPoint: cm[2]!,
            type: sm[1]!,
            exact: sm[2]!,
            windowDays: sm[3] !== undefined ? Number(sm[3]) : 14,
          })
        }
        continue
      }
      const av = TRANSIT_CROSS_VALUE_RE.exec(it.value)
      if (av) aspects.push({ transitPlanet: cm[1]!, natalPoint: cm[2]!, type: av[1]!, orb: Number(av[2]) })
      continue
    }
    // M63 续完善（v2 双环）：本命十星行（`本命X | 星座 度（黄经）`；旧卡无 → 单环）
    const nm = /^本命([^-\s]+)$/.exec(it.label)
    if (nm) {
      const np = NATAL_PLANET_SEG_RE.exec(splitSegs(it.value)[0] ?? '')
      if (np) natalPlanets.push({ name: nm[1]!, lon: Number(np[3]) })
      continue
    }
    const pm = TRANSIT_PLANET_LABEL_RE.exec(it.label)
    if (!pm) continue
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
      name: pm[1]!,
      sign: p0[1]!,
      deg: Number(p0[2]),
      lon: Number(p0[3]),
      ...(house !== undefined ? { house: Number(house) } : {}),
      retro: retroSeg === '逆行',
    })
  }
  if (planets.length === 0) return null // 必需门：≥1 行运行星

  let scan: TransitModel['scan'] = null
  const scanVal = fieldOf(fields, '扫描')
  if (scanVal) {
    const sm = TRANSIT_SCAN_FIELD_RE.exec(scanVal.trim())
    if (sm) scan = { from: sm[1]!, to: sm[2]!, hits }
  }
  // 无扫描字段但有条目 → 不呈现（扫描块以字段行为准）
  return {
    kind: 'transit',
    planets,
    ...(natalPlanets.length > 0 ? { natalPlanets } : {}),
    aspects,
    scan,
    detail: fields,
  }
}

// ---------------------------------------------------------------------------
// 合盘（M63-B；§附录 B.2）——双人行星 / cross-aspects / 组合盘
// ---------------------------------------------------------------------------

const SYNASTRY_PLANET_LABEL_RE = /^([AB组合])(\S+)$/
const SYNASTRY_CROSS_LABEL_RE = /^((?:A|B)\S+?)-((?:A|B)\S+)$/
const SYNASTRY_CROSS_VALUE_RE = /^(\S+) (\d+(?:\.\d+)?)°$/

function deriveSynastry(fields: PanRowData[], items: PanRowData[]): SynastryModel | null {
  const a: SynastryPlanet[] = []
  const b: SynastryPlanet[] = []
  const composite: SynastryPlanet[] = []
  const aspects: SynastryModel['aspects'] = []
  for (const it of items) {
    if (it.label.includes('-')) {
      const cm = SYNASTRY_CROSS_LABEL_RE.exec(it.label)
      if (!cm) continue
      const av = SYNASTRY_CROSS_VALUE_RE.exec(it.value)
      if (av) aspects.push({ a: cm[1]!, b: cm[2]!, type: av[1]!, orb: Number(av[2]) })
      continue
    }
    const pm = SYNASTRY_PLANET_LABEL_RE.exec(it.label)
    if (!pm) continue
    const segs = splitSegs(it.value)
    const p0 = NATAL_PLANET_SEG_RE.exec(segs[0] ?? '')
    const si = p0 ? signIndexOf(p0[1]!) : -1
    if (!p0 || si < 0) return null
    const side = pm[1] === '组合' ? 'C' : (pm[1] as 'A' | 'B')
    const entry: SynastryPlanet = { side, name: pm[2]!, sign: p0[1]!, deg: Number(p0[2]), lon: Number(p0[3]) }
    if (side === 'A') a.push(entry)
    else if (side === 'B') b.push(entry)
    else composite.push(entry)
  }
  if (a.length === 0 || b.length === 0) return null // 必需门：双方各 ≥1 行星
  const elementText = fieldOf(fields, '元素')?.trim() || undefined
  return {
    kind: 'synastry',
    a,
    b,
    composite,
    aspects,
    ...(elementText ? { elementText } : {}),
    detail: fields,
  }
}

// ---------------------------------------------------------------------------
// 大六壬（M63-C；§附录 B.3）——天地盘 / 四课 / 三传
// ---------------------------------------------------------------------------

const DALIUREN_KE_LABEL_RE = /^([一二三四])课$/
const DALIUREN_KE_VALUE_RE = /^上 (\S+)（下 (\S+)）$/
const DALIUREN_CHUAN_LABEL_RE = /^(初|中|末)传$/
const DALIUREN_CHUAN_DUN_RE = /^遁干 (\S+)$/
const DALIUREN_CHUAN_JIANG_RE = /^天将 (\S+)$/
const DALIUREN_PAN_PAIR_RE = /^(\S+)→(\S+)$/
const DALIUREN_JIANG_PAIR_RE = /^(\S+) (\S+)$/
const KE_IDX: Record<string, 1 | 2 | 3 | 4> = { 一: 1, 二: 2, 三: 3, 四: 4 }

function deriveDaliuren(fields: PanRowData[], items: PanRowData[]): DaliurenModel | null {
  const ke: DaliurenModel['ke'] = []
  const chuan: DaliurenModel['chuan'] = []
  for (const it of items) {
    const km = DALIUREN_KE_LABEL_RE.exec(it.label)
    if (km) {
      const kv = DALIUREN_KE_VALUE_RE.exec(it.value)
      if (!kv) return null
      const idx = KE_IDX[km[1]!]!
      ke.push({ idx, label: `${km[1]}课`, upper: kv[1]!, lower: kv[2]! })
      continue
    }
    const cm = DALIUREN_CHUAN_LABEL_RE.exec(it.label)
    if (cm) {
      const segs = splitSegs(it.value)
      const zhi = (segs[0] ?? '').trim()
      if (!zhi || zhi.length !== 1) return null
      let dunGan: string | undefined
      let jiang = ''
      let kong = false
      for (const seg of segs.slice(1)) {
        const dm = DALIUREN_CHUAN_DUN_RE.exec(seg)
        if (dm) {
          if (dm[1] !== '—') dunGan = dm[1]
          continue
        }
        const jm = DALIUREN_CHUAN_JIANG_RE.exec(seg)
        if (jm) jiang = jm[1]!
        else if (seg === '旬空') kong = true
      }
      chuan.push({ name: `${cm[1]}传`, zhi, ...(dunGan ? { dunGan } : {}), jiang, kong })
    }
  }
  if (ke.length !== 4 || chuan.length !== 3) return null // 必需门：四课 4 + 三传 3
  ke.sort((a, b) => a.idx - b.idx)

  // 天地盘（12 组）
  const pan: DaliurenModel['pan'] = []
  const panVal = fieldOf(fields, '天地盘')
  if (panVal) {
    for (const token of panVal.split(/\s+/u).filter(Boolean)) {
      const pm = DALIUREN_PAN_PAIR_RE.exec(token)
      if (pm) pan.push({ di: pm[1]!, tian: pm[2]! })
    }
  }
  if (pan.length !== 12) return null // 必需门：天地盘 12 位

  // 天将（12 组；可选——缺失不阻断）
  const jiangOf: Record<string, string> = {}
  const jiangVal = fieldOf(fields, '天将')
  if (jiangVal) {
    for (const seg of splitSegs(jiangVal)) {
      const jm = DALIUREN_JIANG_PAIR_RE.exec(seg)
      if (jm) jiangOf[jm[1]!] = jm[2]!
    }
  }

  // 课体（名 + 括注）
  const ketiVal = fieldOf(fields, '课体')
  let keti: string | undefined
  let ketiNote: string | undefined
  if (ketiVal) {
    const km = /^([^（]+)(?:（(.+)）)?$/u.exec(ketiVal.trim())
    if (km) {
      keti = km[1]!.trim()
      if (km[2]) ketiNote = km[2]
    }
  }

  return {
    kind: 'daliuren',
    ke,
    chuan,
    pan,
    jiangOf,
    ...(keti ? { keti } : {}),
    ...(ketiNote ? { ketiNote } : {}),
    ...(fieldOf(fields, '月将') ? { jiangText: fieldOf(fields, '月将')!.trim() } : {}),
    detail: fields,
  }
}

// ---------------------------------------------------------------------------
// 七政四余（M63-E；§附录 B.5）——七政四余 / 十二宫 / 庙旺
// ---------------------------------------------------------------------------

const QZ_BODY_NAMES = ['太阳', '太阴', '水星', '金星', '火星', '木星', '土星', '罗睺', '计都', '月孛', '紫炁'] as const
const QZ_VALUE_RE = /^(\S+)宫 (\d+(?:\.\d+)?)°（(\d+(?:\.\d+)?)°）$/
const QZ_PALACE_LABEL_RE = /^(命宫|财帛|兄弟|田宅|男女|奴仆|夫妻|疾厄|迁移|官禄|福德|相貌) (\S)$/
const QZ_PALACE_VALUE_RE = /^宫主 (\S+)(?: ｜ (.+))?$/
const QZ_SIGN_BY_GONG: Record<string, string> = {
  戌: '白羊', 酉: '金牛', 申: '双子', 未: '巨蟹', 午: '狮子', 巳: '处女',
  辰: '天秤', 卯: '天蝎', 寅: '射手', 丑: '摩羯', 子: '水瓶', 亥: '双鱼',
}

function deriveQizheng(fields: PanRowData[], items: PanRowData[]): QizhengModel | null {
  const bodies: QizhengModel['bodies'] = []
  const palaces: QizhengModel['palaces'] = []
  for (const it of items) {
    const pm = QZ_PALACE_LABEL_RE.exec(it.label)
    if (pm) {
      const pv = QZ_PALACE_VALUE_RE.exec(it.value)
      if (!pv) return null
      const gong = pm[2]!
      palaces.push({
        name: pm[1]!,
        gong,
        sign: QZ_SIGN_BY_GONG[gong] ?? '',
        lord: pv[1]!,
        bodies: pv[2] ? pv[2].split(/\s+/u).filter(Boolean) : [],
      })
      continue
    }
    if ((QZ_BODY_NAMES as readonly string[]).includes(it.label)) {
      const segs = splitSegs(it.value)
      const bv = QZ_VALUE_RE.exec(segs[0] ?? '')
      if (!bv) return null
      let retro = false
      let note: string | undefined
      for (const seg of segs.slice(1)) {
        if (seg === '逆行') retro = true
        else if (seg.startsWith('近似')) {
          note = seg
          // 四余：近似段内含「· 逆行」（不重复独立段）
          if (seg.includes('· 逆行')) retro = true
        }
      }
      bodies.push({
        name: it.label,
        gong: bv[1]!,
        deg: Number(bv[2]),
        lon: Number(bv[3]),
        retro,
        ...(note ? { note } : {}),
      })
    }
  }
  if (bodies.length < 7 || palaces.length !== 12) return null // 必需门：七政齐 + 十二宫
  const miaoWangText = fieldOf(fields, '庙旺')?.trim() || undefined
  return {
    kind: 'qizheng',
    bodies,
    palaces,
    ...(miaoWangText ? { miaoWangText } : {}),
    detail: fields,
  }
}

// ---------------------------------------------------------------------------
// 奇门遁甲（M63-D；§附录 B.4）——九宫局盘
// ---------------------------------------------------------------------------

const QM_GONG_LABEL_RE = /^(坎|坤|震|巽|中|乾|兑|艮|离)(\d)$/
const QM_TIAN_RE = /^天盘 (.+)$/
const QM_DI_RE = /^地盘 (.+)$/

function deriveQimen(fields: PanRowData[], items: PanRowData[]): QimenModel | null {
  const gongs: QimenModel['gongs'] = []
  for (const it of items) {
    const lm = QM_GONG_LABEL_RE.exec(it.label)
    if (!lm) continue
    const num = Number(lm[2])
    const segs = splitSegs(it.value)
    const head = (segs[0] ?? '').split(/\s+/).filter(Boolean)
    let shen = ''
    let star = ''
    let men = ''
    if (head.length === 3) {
      shen = head[0]!
      star = head[1]!
      men = head[2]!
    } else if (head.length === 2) {
      // 中宫（—— 天禽（寄坤））
      star = head[1]!
    } else if (head.length === 1) {
      star = head[0]!
    } else {
      return null
    }
    let tianGan = ''
    let diGan = ''
    let kong = false
    for (const seg of segs.slice(1)) {
      const tm = QM_TIAN_RE.exec(seg)
      if (tm) {
        tianGan = tm[1] === '——' ? '' : tm[1]!
        continue
      }
      const dm = QM_DI_RE.exec(seg)
      if (dm) {
        diGan = dm[1]! === '——' ? '' : dm[1]!
        continue
      }
      if (seg === '空') kong = true
    }
    gongs.push({ num, name: lm[1]!, shen: shen === '——' ? '' : shen, star, men: men === '——' ? '' : men, tianGan, diGan, kong })
  }
  if (gongs.length !== 9) return null // 必需门：九宫恰 9 条
  gongs.sort((a, b) => a.num - b.num)
  for (let i = 0; i < 9; i++) if (gongs[i]!.num !== i + 1) return null
  return {
    kind: 'qimen',
    gongs,
    ...(fieldOf(fields, '定局') ? { dingText: fieldOf(fields, '定局')!.trim() } : {}),
    ...(fieldOf(fields, '值符') ? { zhiFuText: fieldOf(fields, '值符')!.trim() } : {}),
    ...(fieldOf(fields, '旬空') ? { kongText: fieldOf(fields, '旬空')!.trim() } : {}),
    ...(fieldOf(fields, '对照') ? { duiZhaoText: fieldOf(fields, '对照')!.trim() } : {}),
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
    case 'transit':
      return deriveTransit(f, it)
    case 'synastry':
      return deriveSynastry(f, it)
    case 'daliuren':
      return deriveDaliuren(f, it)
    case 'qizheng':
      return deriveQizheng(f, it)
    case 'qimen':
      return deriveQimen(f, it)
    case 'luopan':
      return deriveLuopan(f, it)
    case 'zeri':
      return deriveZeri(f, it)
    default:
      return null
  }
}

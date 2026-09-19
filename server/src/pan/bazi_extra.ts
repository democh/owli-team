/**
 * M63-A：八字深化计算层——神煞（18 种）/ 柱间关系 / 运岁作用（附录 A.1 口径）。
 *
 * 纯函数零 IO；神煞逐柱命中制（输出「神煞名（起法→命中柱）」），
 * 柱间关系四柱两两（6 对）+ 三合 / 三会 / 半合 / 自刑 + 大运 / 流年对四柱（运岁作用）。
 * 只描述结构事实，不做吉凶断语（合规红线）。
 */

/** 柱位槽（年 / 月 / 日 / 时；供与 bazi.ts 解耦的轻量输入） */
export interface PillarSlot {
  position: '年' | '月' | '日' | '时'
  gan: string
  zhi: string
}

/** 神煞命中（basis = 起法，如「日干」；pillars = 命中的柱位） */
export interface BaziShenShaItem {
  name: string
  basis: string
  pillars: string[]
}

/** 柱间关系（scope 天干 / 地支；pair 柱对如「年时」或「大运」） */
export interface BaziRelationItem {
  scope: '天干' | '地支'
  type: string
  pair: string
  label: string
}

// ---------------------------------------------------------------------------
// 常量表（附录 A.1）
// ---------------------------------------------------------------------------

/** 日干起的神煞（目标为地支） */
const GAN_BASED: Record<string, Record<string, string[]>> = {
  天乙贵人: {
    甲: ['丑', '未'], 戊: ['丑', '未'], 庚: ['丑', '未'],
    乙: ['子', '申'], 己: ['子', '申'],
    丙: ['亥', '酉'], 丁: ['亥', '酉'],
    壬: ['卯', '巳'], 癸: ['卯', '巳'],
    辛: ['午', '寅'],
  },
  太极贵人: {
    甲: ['子', '午'], 乙: ['子', '午'],
    丙: ['卯', '酉'], 丁: ['卯', '酉'],
    戊: ['辰', '戌', '丑', '未'], 己: ['辰', '戌', '丑', '未'],
    庚: ['寅', '亥'], 辛: ['寅', '亥'],
    壬: ['巳', '申'], 癸: ['巳', '申'],
  },
  文昌贵人: { 甲: ['巳'], 乙: ['午'], 丙: ['申'], 丁: ['酉'], 戊: ['申'], 己: ['酉'], 庚: ['亥'], 辛: ['子'], 壬: ['寅'], 癸: ['卯'] },
  国印贵人: { 甲: ['戌'], 乙: ['亥'], 丙: ['丑'], 丁: ['寅'], 戊: ['丑'], 己: ['寅'], 庚: ['辰'], 辛: ['巳'], 壬: ['未'], 癸: ['申'] },
  禄神: { 甲: ['寅'], 乙: ['卯'], 丙: ['巳'], 丁: ['午'], 戊: ['巳'], 己: ['午'], 庚: ['申'], 辛: ['酉'], 壬: ['亥'], 癸: ['子'] },
  羊刃: { 甲: ['卯'], 乙: ['辰'], 丙: ['午'], 丁: ['未'], 戊: ['午'], 己: ['未'], 庚: ['酉'], 辛: ['戌'], 壬: ['子'], 癸: ['丑'] },
  红艳: { 甲: ['午'], 乙: ['午'], 丙: ['寅'], 丁: ['未'], 戊: ['辰'], 己: ['辰'], 庚: ['戌'], 辛: ['酉'], 壬: ['子'], 癸: ['申'] },
  金舆: { 甲: ['辰'], 乙: ['巳'], 丙: ['未'], 丁: ['申'], 戊: ['未'], 己: ['申'], 庚: ['戌'], 辛: ['亥'], 壬: ['丑'], 癸: ['寅'] },
}

/** 天德贵人（月支 → 天干或地支；命中检查干 / 支两路） */
const TIAN_DE: Record<string, string> = {
  寅: '丁', 卯: '申', 辰: '壬', 巳: '辛', 午: '亥', 未: '甲',
  申: '癸', 酉: '寅', 戌: '丙', 亥: '乙', 子: '巳', 丑: '庚',
}

const GAN_SET = new Set(['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'])

/** 月德贵人（月支三合局 → 天干） */
const YUE_DE: Record<string, string> = {
  寅: '丙', 午: '丙', 戌: '丙',
  申: '壬', 子: '壬', 辰: '壬',
  亥: '甲', 卯: '甲', 未: '甲',
  巳: '庚', 酉: '庚', 丑: '庚',
}

/** 三合局分组（地支 → 局三支串） */
const SAN_HE_GROUP: Record<string, string> = {
  寅: '寅午戌', 午: '寅午戌', 戌: '寅午戌',
  申: '申子辰', 子: '申子辰', 辰: '申子辰',
  巳: '巳酉丑', 酉: '巳酉丑', 丑: '巳酉丑',
  亥: '亥卯未', 卯: '亥卯未', 未: '亥卯未',
}

/** 三合局起的神煞表（神煞名 → 局 → 目标地支） */
const SANHE_BASED: Record<string, Record<string, string>> = {
  桃花: { 寅午戌: '卯', 申子辰: '酉', 巳酉丑: '午', 亥卯未: '子' },
  驿马: { 寅午戌: '申', 申子辰: '寅', 巳酉丑: '亥', 亥卯未: '巳' },
  华盖: { 寅午戌: '戌', 申子辰: '辰', 巳酉丑: '丑', 亥卯未: '未' },
  将星: { 寅午戌: '午', 申子辰: '子', 巳酉丑: '酉', 亥卯未: '卯' },
  劫煞: { 寅午戌: '亥', 申子辰: '巳', 巳酉丑: '寅', 亥卯未: '申' },
  亡神: { 寅午戌: '巳', 申子辰: '亥', 巳酉丑: '申', 亥卯未: '寅' },
}

/** 年支三会方起：孤辰 / 寡宿 */
const GU_GUA: Record<string, { gu: string; gua: string }> = {
  亥子丑: { gu: '寅', gua: '戌' },
  寅卯辰: { gu: '巳', gua: '丑' },
  巳午未: { gu: '申', gua: '辰' },
  申酉戌: { gu: '亥', gua: '未' },
}

/** 年支三会方（地支 → 方串） */
const SAN_HUI_FANG: Record<string, string> = {
  亥: '亥子丑', 子: '亥子丑', 丑: '亥子丑',
  寅: '寅卯辰', 卯: '寅卯辰', 辰: '寅卯辰',
  巳: '巳午未', 午: '巳午未', 未: '巳午未',
  申: '申酉戌', 酉: '申酉戌', 戌: '申酉戌',
}

// ---------------------------------------------------------------------------
// 神煞
// ---------------------------------------------------------------------------

/**
 * 神煞命中（18 种，附录 A.1）：
 * - 日干起（地支）：天乙 / 太极 / 文昌 / 国印 / 禄神 / 羊刃 / 红艳 / 金舆；
 * - 月支起：天德（干支两路） / 月德；
 * - 年支 / 日支三合局起：桃花 / 驿马 / 华盖 / 将星 / 劫煞 / 亡神（年支、日支双起，去重）；
 * - 年支三会方起：孤辰 / 寡宿。
 */
export function computeShenSha(slots: PillarSlot[]): BaziShenShaItem[] {
  const [y, m, d] = slots
  if (!y || !m || !d) return []
  const dayGan = d.gan
  const monthZhi = m.zhi
  const yearZhi = y.zhi
  const dayZhi = d.zhi
  const out: BaziShenShaItem[] = []

  const pushZhiHits = (name: string, basis: string, targets: string[]): void => {
    const pillars = slots.filter((s) => targets.includes(s.zhi)).map((s) => s.position)
    if (pillars.length > 0) out.push({ name, basis, pillars })
  }

  // 日干起（地支目标）
  for (const [name, table] of Object.entries(GAN_BASED)) {
    const targets = table[dayGan]
    if (targets) pushZhiHits(name, '日干', targets)
  }

  // 天德贵人（月支起；目标为干或支）
  const td = TIAN_DE[monthZhi]
  if (td) {
    const pillars = slots
      .filter((s) => (GAN_SET.has(td) ? s.gan === td : s.zhi === td))
      .map((s) => s.position)
    if (pillars.length > 0) out.push({ name: '天德贵人', basis: '月支', pillars })
  }

  // 月德贵人（月支起；天干目标）
  const yd = YUE_DE[monthZhi]
  if (yd) {
    const pillars = slots.filter((s) => s.gan === yd).map((s) => s.position)
    if (pillars.length > 0) out.push({ name: '月德贵人', basis: '月支', pillars })
  }

  // 三合局起（年支 / 日支双起）
  for (const [name, table] of Object.entries(SANHE_BASED)) {
    const bases: Array<{ basis: string; zhi: string }> = [
      { basis: '年支', zhi: yearZhi },
      { basis: '日支', zhi: dayZhi },
    ]
    const seen = new Set<string>()
    for (const b of bases) {
      const group = SAN_HE_GROUP[b.zhi]
      const target = group ? table[group] : undefined
      if (target && !seen.has(target)) {
        seen.add(target)
        pushZhiHits(name, b.basis, [target])
      }
    }
  }

  // 孤辰 / 寡宿（年支三会方起）
  const fang = SAN_HUI_FANG[yearZhi]
  const gg = fang ? GU_GUA[fang] : undefined
  if (gg) {
    pushZhiHits('孤辰', '年支', [gg.gu])
    pushZhiHits('寡宿', '年支', [gg.gua])
  }

  return out
}

// ---------------------------------------------------------------------------
// 柱间关系
// ---------------------------------------------------------------------------

const PAIRS_GAN_HE: Array<[string, string]> = [['甲', '己'], ['乙', '庚'], ['丙', '辛'], ['丁', '壬'], ['戊', '癸']]
const PAIRS_GAN_CHONG: Array<[string, string]> = [['甲', '庚'], ['乙', '辛'], ['丙', '壬'], ['丁', '癸']]
const PAIRS_ZHI_HE: Array<[string, string]> = [['子', '丑'], ['寅', '亥'], ['卯', '戌'], ['辰', '酉'], ['巳', '申'], ['午', '未']]
const PAIRS_ZHI_CHONG: Array<[string, string]> = [['子', '午'], ['丑', '未'], ['寅', '申'], ['卯', '酉'], ['辰', '戌'], ['巳', '亥']]
const PAIRS_ZHI_HAI: Array<[string, string]> = [['子', '未'], ['丑', '午'], ['寅', '巳'], ['卯', '辰'], ['申', '亥'], ['酉', '戌']]
const PAIRS_ZHI_XING: Array<[string, string]> = [['寅', '巳'], ['巳', '申'], ['寅', '申'], ['丑', '戌'], ['戌', '未'], ['丑', '未'], ['子', '卯']]
const PAIRS_ZHI_PO: Array<[string, string]> = [['子', '酉'], ['丑', '辰'], ['寅', '亥'], ['卯', '午'], ['巳', '申'], ['未', '戌']]
const SELF_XING = ['辰', '午', '酉', '亥']
const PAIRS_BAN_HE: Array<[string, string]> = [['申', '子'], ['子', '辰'], ['亥', '卯'], ['卯', '未'], ['寅', '午'], ['午', '戌'], ['巳', '酉'], ['酉', '丑']]
const SAN_HE_JU: Array<{ zhi: [string, string, string]; element: string }> = [
  { zhi: ['申', '子', '辰'], element: '水' },
  { zhi: ['亥', '卯', '未'], element: '木' },
  { zhi: ['寅', '午', '戌'], element: '火' },
  { zhi: ['巳', '酉', '丑'], element: '金' },
]
const SAN_HUI_JU: Array<{ zhi: [string, string, string]; element: string }> = [
  { zhi: ['寅', '卯', '辰'], element: '木' },
  { zhi: ['巳', '午', '未'], element: '火' },
  { zhi: ['申', '酉', '戌'], element: '金' },
  { zhi: ['亥', '子', '丑'], element: '水' },
]

const inPair = (a: string, b: string, pairs: Array<[string, string]>): boolean =>
  pairs.some(([x, y]) => (x === a && y === b) || (x === b && y === a))

/**
 * 柱间关系（四柱两两 6 对；天干：五合 / 相冲；地支：六合 / 六冲 / 相害 / 相刑 / 相破 / 半合）
 * + 三合局 / 三会（三支齐） + 自刑（同支 ≥2） + 运岁作用（大运 / 流年对四柱）。
 * 运岁传入 fortune 时，pair 记为「大运」「流年」，label 标注命中柱位。
 */
export function computeRelations(
  slots: PillarSlot[],
  fortune?: { daYun?: string; liuNian?: string },
): BaziRelationItem[] {
  const out: BaziRelationItem[] = []

  // 四柱两两
  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length; j++) {
      const a = slots[i]!
      const b = slots[j]!
      const pair = `${a.position}${b.position}`
      if (inPair(a.gan, b.gan, PAIRS_GAN_HE)) out.push({ scope: '天干', type: '五合', pair, label: `${a.gan}${b.gan}合` })
      if (inPair(a.gan, b.gan, PAIRS_GAN_CHONG)) out.push({ scope: '天干', type: '相冲', pair, label: `${a.gan}${b.gan}冲` })
      if (inPair(a.zhi, b.zhi, PAIRS_ZHI_HE)) out.push({ scope: '地支', type: '六合', pair, label: `${a.zhi}${b.zhi}合` })
      if (inPair(a.zhi, b.zhi, PAIRS_ZHI_CHONG)) out.push({ scope: '地支', type: '六冲', pair, label: `${a.zhi}${b.zhi}冲` })
      if (inPair(a.zhi, b.zhi, PAIRS_ZHI_HAI)) out.push({ scope: '地支', type: '相害', pair, label: `${a.zhi}${b.zhi}害` })
      if (inPair(a.zhi, b.zhi, PAIRS_ZHI_XING)) out.push({ scope: '地支', type: '相刑', pair, label: `${a.zhi}${b.zhi}刑` })
      if (inPair(a.zhi, b.zhi, PAIRS_ZHI_PO)) out.push({ scope: '地支', type: '相破', pair, label: `${a.zhi}${b.zhi}破` })
      if (inPair(a.zhi, b.zhi, PAIRS_BAN_HE)) out.push({ scope: '地支', type: '半合', pair, label: `${a.zhi}${b.zhi}半合` })
    }
  }

  // 自刑（同支 ≥2；辰午酉亥）
  for (const z of SELF_XING) {
    const hits = slots.filter((s) => s.zhi === z)
    if (hits.length >= 2) {
      out.push({ scope: '地支', type: '自刑', pair: hits.map((s) => s.position).join(''), label: `${z}${z}自刑` })
    }
  }

  // 三合局 / 三会（三支齐）
  for (const ju of SAN_HE_JU) {
    const hits = ju.zhi.map((z) => slots.find((s) => s.zhi === z))
    if (hits.every(Boolean)) {
      out.push({ scope: '地支', type: '三合', pair: hits.map((s) => s!.position).join(''), label: `${ju.zhi.join('')}三合${ju.element}局` })
    }
  }
  for (const ju of SAN_HUI_JU) {
    const hits = ju.zhi.map((z) => slots.find((s) => s.zhi === z))
    if (hits.every(Boolean)) {
      out.push({ scope: '地支', type: '三会', pair: hits.map((s) => s!.position).join(''), label: `${ju.zhi.join('')}三会${ju.element}方` })
    }
  }

  // 运岁作用（大运 / 流年对四柱；只列命中项）
  const fortunes: Array<{ name: string; gz: string }> = []
  if (fortune?.daYun) fortunes.push({ name: '大运', gz: fortune.daYun })
  if (fortune?.liuNian) fortunes.push({ name: '流年', gz: fortune.liuNian })
  for (const f of fortunes) {
    const fGan = f.gz.charAt(0)
    const fZhi = f.gz.charAt(1)
    if (!fGan || !fZhi) continue
    for (const s of slots) {
      if (inPair(fGan, s.gan, PAIRS_GAN_HE)) out.push({ scope: '天干', type: '五合', pair: f.name, label: `${fGan}${s.gan}合（${s.position}）` })
      if (inPair(fGan, s.gan, PAIRS_GAN_CHONG)) out.push({ scope: '天干', type: '相冲', pair: f.name, label: `${fGan}${s.gan}冲（${s.position}）` })
      if (inPair(fZhi, s.zhi, PAIRS_ZHI_HE)) out.push({ scope: '地支', type: '六合', pair: f.name, label: `${fZhi}${s.zhi}合（${s.position}）` })
      if (inPair(fZhi, s.zhi, PAIRS_ZHI_CHONG)) out.push({ scope: '地支', type: '六冲', pair: f.name, label: `${fZhi}${s.zhi}冲（${s.position}）` })
      if (inPair(fZhi, s.zhi, PAIRS_ZHI_HAI)) out.push({ scope: '地支', type: '相害', pair: f.name, label: `${fZhi}${s.zhi}害（${s.position}）` })
    }
  }

  return out
}

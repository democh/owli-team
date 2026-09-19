/**
 * M54-C t3：盘面对照差异分析（§5.3）——纯函数，无 DOM / 无 React / 无存储。
 *
 * - 同 kind 逐项比较：八字逐柱（+日主/五行/起运）、紫微主星集合（+中宫/生年四化）、
 *   星盘行星度数（+上升）、卦爻模式（+本卦变卦）；
 * - 返回全部行（含相同行），`diff` 标注差异供高亮；异 kind → null（调用方仅并排）。
 * - 只比较卡内已呈现的数据，不重算、不推测（口径纪律与 derive 一致）。
 */
import { SIGNS } from './derive'
import type { BaziModel, GuaModel, NatalModel, NatalPlanet, PanModel, ZiweiModel, ZiweiPalace } from './model'

export interface PanDiffRow {
  label: string
  a: string
  b: string
  /** 两侧不同（对照高亮；相同行淡显） */
  diff: boolean
}

const DASH = '—'
const YAO_POS = ['初', '二', '三', '四', '五', '上'] as const

function row(label: string, a: string, b: string): PanDiffRow {
  return { label, a, b, diff: a !== b }
}

// ---------------------------------------------------------------------------
// 八字：日主 / 逐柱 / 五行 / 起运
// ---------------------------------------------------------------------------

function diffBazi(a: BaziModel, b: BaziModel): PanDiffRow[] {
  const dm = (m: BaziModel): string => (m.dayMaster ? `${m.dayMaster.gan}（${m.dayMaster.yinYang}）` : DASH)
  const rows: PanDiffRow[] = [row('日主', dm(a), dm(b))]
  for (let i = 0; i < 4; i++) {
    const p = (m: BaziModel): string => {
      const x = m.pillars[i]!
      return `${x.gan}${x.zhi}${x.shiShen ? ` ${x.shiShen}` : ''}`
    }
    rows.push(row(`${a.pillars[i]!.name}柱`, p(a), p(b)))
  }
  const wx = (m: BaziModel): string =>
    (['木', '火', '土', '金', '水'] as const).map((k) => `${k}${m.wuxing[k]}`).join(' ')
  rows.push(row('五行', wx(a), wx(b)))
  const jy = (m: BaziModel): string => (m.jiaoYun ? `${m.jiaoYun.date} ${m.jiaoYun.direction}` : DASH)
  rows.push(row('起运', jy(a), jy(b)))
  return rows
}

// ---------------------------------------------------------------------------
// 紫微：逐宫主星集合 / 中宫 / 生年四化
// ---------------------------------------------------------------------------

function starText(p?: ZiweiPalace): string {
  if (!p) return DASH
  if (p.stars.length === 0) return '空宫'
  return p.stars.map((s) => (s.mutagen ? `${s.name}(${s.mutagen})` : s.name)).join('、')
}

function diffZiwei(a: ZiweiModel, b: ZiweiModel): PanDiffRow[] {
  const ma = new Map(a.palaces.map((p) => [p.name, p]))
  const mb = new Map(b.palaces.map((p) => [p.name, p]))
  const names: string[] = []
  const seen = new Set<string>()
  for (const p of [...a.palaces, ...b.palaces]) {
    if (!seen.has(p.name)) {
      seen.add(p.name)
      names.push(p.name)
    }
  }
  const rows = names.map((n) => row(n, starText(ma.get(n)), starText(mb.get(n))))
  const center = (m: ZiweiModel): string =>
    [m.center.wuXingJu, m.center.mingZhu, m.center.shenZhu].filter(Boolean).join(' ') || DASH
  rows.push(row('中宫', center(a), center(b)))
  const hua = (m: ZiweiModel): string =>
    m.center.siHua.length > 0 ? m.center.siHua.map((h) => `${h.mutagen}${h.star}`).join(' ') : DASH
  rows.push(row('生年四化', hua(a), hua(b)))
  return rows
}

// ---------------------------------------------------------------------------
// 星盘：逐行星落点 / 上升
// ---------------------------------------------------------------------------

function planetText(p?: NatalPlanet): string {
  if (!p) return DASH
  return `${p.sign}${p.deg}°${p.retro ? ' 逆' : ''}`
}

function diffNatal(a: NatalModel, b: NatalModel): PanDiffRow[] {
  const ma = new Map(a.planets.map((p) => [p.name, p]))
  const mb = new Map(b.planets.map((p) => [p.name, p]))
  const names: string[] = []
  const seen = new Set<string>()
  for (const p of [...a.planets, ...b.planets]) {
    if (!seen.has(p.name)) {
      seen.add(p.name)
      names.push(p.name)
    }
  }
  const rows = names.map((n) => row(n, planetText(ma.get(n)), planetText(mb.get(n))))
  const asc = (m: NatalModel): string =>
    m.asc === undefined ? DASH : `${SIGNS[Math.floor(m.asc / 30) % 12]}${(m.asc % 30).toFixed(1)}°`
  rows.push(row('上升', asc(a), asc(b)))
  return rows
}

// ---------------------------------------------------------------------------
// 卦：本卦变卦 / 逐爻模式（阴阳 · 动 · 世应）
// ---------------------------------------------------------------------------

function yaoText(m: GuaModel, i: number): string {
  const y = m.yao[i]!
  return `${y.yin ? '▬ ▬' : '▬▬▬'}${y.dong ? ' 动' : ''}${y.shiYing ? ` ${y.shiYing}` : ''}`
}

function diffGua(a: GuaModel, b: GuaModel): PanDiffRow[] {
  const guaName = (m: GuaModel): string => (m.bianName ? `${m.ben} → ${m.bianName}` : m.ben)
  const rows: PanDiffRow[] = [row('本卦', guaName(a), guaName(b))]
  for (let i = 0; i < 6; i++) rows.push(row(`${YAO_POS[i]}爻`, yaoText(a, i), yaoText(b, i)))
  return rows
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/** 同 kind → 差异行（含相同行，diff 标注）；异 kind → null（调用方仅并排，不做差异） */
export function diffPan(a: PanModel, b: PanModel): PanDiffRow[] | null {
  if (a.kind === 'bazi' && b.kind === 'bazi') return diffBazi(a, b)
  if (a.kind === 'ziwei' && b.kind === 'ziwei') return diffZiwei(a, b)
  if (a.kind === 'natal' && b.kind === 'natal') return diffNatal(a, b)
  if (a.kind === 'gua' && b.kind === 'gua') return diffGua(a, b)
  return null
}

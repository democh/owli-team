/**
 * M31：便签 / 脑图节点强调色（accent 以字符串键持久化；右键「换个颜色」循环切换）。
 */
export const ACCENT_KEYS = ['amber', 'rose', 'sky', 'emerald', 'violet'] as const

export type AccentKey = (typeof ACCENT_KEYS)[number]

export interface AccentStyle {
  /** 顶部色带 / 圆点 */
  bar: string
  /** 卡片淡淡的一层底色 */
  tint: string
  /** 文字点缀 */
  text: string
}

export const ACCENTS: Record<AccentKey, AccentStyle> = {
  amber: { bar: 'bg-amber-400', tint: 'bg-amber-400/10', text: 'text-amber-600' },
  rose: { bar: 'bg-rose-400', tint: 'bg-rose-400/10', text: 'text-rose-600' },
  sky: { bar: 'bg-sky-400', tint: 'bg-sky-400/10', text: 'text-sky-600' },
  emerald: { bar: 'bg-emerald-400', tint: 'bg-emerald-400/10', text: 'text-emerald-600' },
  violet: { bar: 'bg-violet-400', tint: 'bg-violet-400/10', text: 'text-violet-600' },
}

export function accentOf(key?: string): AccentStyle {
  return ACCENTS[key as AccentKey] ?? ACCENTS.amber
}

export function nextAccent(key?: string): AccentKey {
  const i = ACCENT_KEYS.indexOf((key as AccentKey) ?? 'amber')
  return ACCENT_KEYS[(i + 1) % ACCENT_KEYS.length]!
}

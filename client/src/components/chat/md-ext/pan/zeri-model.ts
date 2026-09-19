/**
 * M66 续完善：择日卡派生（`::: pan zeri`）——卡内文本 → ZeriModel（纯函数）。
 *
 * 口径：日期 / 建除 / 评分 / 冲煞一律取自卡内文本（工具输出），不重算、不预测；
 * 必需门（日期条目 ≥ 1）失败 → null（调用方回退静态表格，零回归路径——与四件套同纪律）。
 */
import type { PanRowData, ZeriCardDay, ZeriModel } from './model'

/** 日期条目 label 形如「2026-09-22（己亥 · 满 · 周二）」 */
const DAY_LABEL_RE = /^(\d{4}-\d{2}-\d{2})（([^）]+)）$/
/** 日期条目 value 形如「5 | 冲蛇 煞西 | 宜祭祀祈福开市」 */
const DAY_VALUE_RE = /^(\d)\s*\|\s*(.+?)\s*\|\s*(.+)$/

export function deriveZeri(fields: PanRowData[], items: PanRowData[]): ZeriModel | null {
  const get = (prefix: string): string => fields.find((r) => r.label.startsWith(prefix))?.value ?? ''

  const days: ZeriCardDay[] = []
  for (const it of items) {
    const lm = DAY_LABEL_RE.exec(it.label)
    if (!lm) continue
    const vm = DAY_VALUE_RE.exec(it.value)
    if (!vm) continue
    const parts = lm[2]!.split('·').map((s) => s.trim())
    days.push({
      date: lm[1]!,
      ganzhi: parts[0] ?? '',
      jianchu: parts[1] ?? '',
      weekday: parts[2] ?? '',
      score: Number(vm[1]),
      chongSha: vm[2]!,
      note: vm[3]!,
    })
  }
  if (days.length === 0) return null

  const purposeLine = get('事项')
  const segments = purposeLine.split(/[｜|]/).map((s) => s.trim())
  const purpose = (segments[0] ?? '').replace(/^事项：/, '').trim()
  const rangeRaw = (segments[1] ?? '').replace(/^区间：/, '').trim()
  const rangeParts = rangeRaw.split(/\s*至\s*/)
  const recommended = [...get('推荐').matchAll(/(\d{4}-\d{2}-\d{2})/g)].map((m) => m[1]!)

  return {
    kind: 'zeri',
    purpose,
    from: (rangeParts[0] ?? '').trim(),
    to: (rangeParts[1] ?? '').trim(),
    caliber: get('口径'),
    days,
    recommended,
    notes: items.filter((r) => r.label.startsWith('声明')),
  }
}

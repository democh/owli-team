/**
 * M54-A：盘面共享件（§7.9）——图例 / 四化 chip / 五行能量条 / 请教版。
 * 统一约束：不读写会话存储；回调缺省 noop（独立渲染 / 单测无上下文不崩）。
 */
import * as React from 'react'

export type MuTone = '禄' | '权' | '科' | '忌'

const MU_CLASS: Record<MuTone, string> = { 禄: 'lu', 权: 'quan', 科: 'ke', 忌: 'ji' }

/** 四化 chip（颜色 + 文字双编码，§7.10） */
export function MuChip({ tone }: { tone: MuTone }): React.JSX.Element {
  return <span className={`pn-mu pn-mu-${MU_CLASS[tone]}`}>{tone}</span>
}

/** 值按全角 `｜` 切段（与 derive 侧同口径；用于纳音等展示拆分） */
export function segments(value: string): string[] {
  return value
    .split('｜')
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

/** 图例行（只读小字） */
export function Legend({ items, ariaLabel = '盘面图例' }: { items: React.ReactNode[]; ariaLabel?: string }): React.JSX.Element {
  return (
    <div className="pn-legend" role="list" aria-label={ariaLabel}>
      {items.map((it, i) => (
        <span className="pn-legend-item" role="listitem" key={i}>
          {it}
        </span>
      ))}
    </div>
  )
}

/** 请教版（点击即草稿；无条目时不渲染） */
export function AskBar({ items }: { items: Array<{ text: string; onPick?: () => void }> }): React.JSX.Element | null {
  if (items.length === 0) return null
  return (
    <div className="pn-ask">
      {items.map((it, i) => (
        <button key={i} type="button" className="pn-ask-btn" onClick={() => it.onPick?.()}>
          {it.text}
        </button>
      ))}
    </div>
  )
}

/** 爻位名（初 → 上；GuaBoard / TsToss 共用） */
export const PN_POS_LABEL = ['初', '二', '三', '四', '五', '上'] as const

/** 爻题（通行书法：初 / 上 位名在前，二~五 九六在前） */
export function yaoTitle(y: { pos: number; yin: boolean }): string {
  const yinYang = y.yin ? '六' : '九'
  if (y.pos === 1) return `初${yinYang}`
  if (y.pos === 6) return `上${yinYang}`
  return `${yinYang}${PN_POS_LABEL[y.pos - 1]}`
}

/** 小六爻图（自上而下渲染；yao 为自下而上序）——GuaBoard 错·综预览 / TsToss 揭晓与对照共用 */
export function MiniGua({ yao }: { yao: Array<{ yin: boolean }> }): React.JSX.Element {
  const top = [...yao].reverse()
  return (
    <div className="pn-mini" aria-hidden="true">
      {top.map((y, i) => (
        <span key={i} data-pos={top.length - i} className={`pn-mini-yao ${y.yin ? 'is-yin' : 'is-yang'}`} />
      ))}
    </div>
  )
}

/** 五行能量条（直接显示卡内计数；§4.2 口径纪律：不重算、不加藏干加权） */
export function HeatBar({ label, value, max }: { label: string; value: number; max: number }): React.JSX.Element {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0
  return (
    <span className="pn-heat">
      <span className="pn-heat-label">{label}</span>
      <span className="pn-heat-track">
        <span className="pn-heat-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="pn-heat-n">{value}</span>
    </span>
  )
}

/**
 * M63（批一 A4）：轮次判定卡（`::: ruling <正方|反方|多方|空方|僵持> [第 N 轮小结]`）。
 * 过程件（体量轻于终局裁决卡）：单行判定徽标（原始胜方词，状态色：长红 / 短绿 / 灰）+
 * 标题 + 条目 chips；未命中状态词 → 中性「小结」徽标。
 * - 条目由 remark 侧转 data-items JSON（复用 VerdictCard.parseVerdictItems 单一解析）；
 * - 解析失败 / 空条目 → raw 兜底静态渲染（不空白、不丢内容）；
 * - 终局语义归 `::: verdict`（裁决流不含 ruling；计分 / 回合轴由场景层 derive 消费）。
 */
import * as React from 'react'
import { cn } from '../../../lib/utils'
import { parseVerdictItems } from './VerdictCard'

export function RulingCard({
  status,
  head,
  title,
  items: itemsRaw,
  raw,
  children,
}: {
  status?: string
  /** 原始胜方词（正方 / 多方 / …；缺省回退状态词兜底标签） */
  head?: string
  title?: string
  items?: string
  raw?: string
  children?: React.ReactNode
}): React.JSX.Element {
  const parsed = React.useMemo(() => parseVerdictItems(itemsRaw), [itemsRaw])
  const active = status && status !== 'none' ? status : ''
  const cls = cn('md-ruling', active && `md-ruling-${active}`)

  // 无条目（解析失败 / 空容器）：raw 兜底静态渲染，其余内容照常
  if (parsed.length === 0) {
    return (
      <div className={cls}>
        {raw ? <pre className="md-ruling-static">{raw}</pre> : null}
        {children}
      </div>
    )
  }

  return (
    <div className={cls} data-ruling-card="">
      <div className="md-ruling-head">
        <span className={cn('md-ruling-badge', !head && !active && 'is-neutral')}>
          {head || (active === 'long' ? '胜方' : active === 'short' ? '负方' : active === 'draw' ? '僵持' : '小结')}
        </span>
        {title ? <span className="md-ruling-title">{title}</span> : null}
      </div>
      <div className="md-ruling-items">
        {parsed.map((it, i) => (
          <span className="md-ruling-item" key={i}>
            {it.label ? <b>{it.label}</b> : null}
            {it.value}
          </span>
        ))}
      </div>
      {children}
    </div>
  )
}

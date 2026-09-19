/**
 * KPI 指标卡组（::: kpi [标题]，条目 `- 名称 | 值 | 变化 | 目标`）：
 * - 条目由 remark-ext finalize 拆为 data-* 结构化节点，本组件按属性渲染，不解析文本；
 * - 涨跌色（+绿 / −红，↑↓▲▼ 等价符号）；值/目标均可取数时显示进度条（上限 100%）；
 * - 点击数值复制（复用 copyText，1.6s 状态复位）；hover 通过 title 显示原始行；
 * - 非条目子节点（普通段落等）原样渲染在网格之后。
 */
import * as React from 'react'
import { Check } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { copyText } from './CopyButton'

/** 变化方向：仅识别显式涨跌符号，其余保持中性色 */
function deltaDirection(delta: string): number {
  const t = delta.trim()
  if (!t) return 0
  if (/^[+\uFF0B\u2191\u25B2]/.test(t)) return 1
  if (/^[-\u2212\uFF0D\u2193\u25BC]/.test(t)) return -1
  return 0
}

/** 从「¥1,200万 / +8%」类文本中取首个数值（无则 undefined） */
function toNumber(text: string): number | undefined {
  const m = /-?\d+(?:\.\d+)?/.exec(text.replace(/,/g, ''))
  return m ? Number(m[0]) : undefined
}

/** 值/目标均取数且目标非零 → 进度百分比（0-100 取整） */
function progressPct(value: string, target: string): number | undefined {
  if (!value || !target) return undefined
  const v = toNumber(value)
  const t = toNumber(target)
  if (v === undefined || t === undefined || t === 0) return undefined
  return Math.max(0, Math.min(100, Math.round((v / t) * 100)))
}

export function KpiGroup({ title, children }: { title?: string; children?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="md-kpi">
      {title ? <div className="md-kpi-title">{title}</div> : null}
      {children}
    </div>
  )
}

export function KpiItem({
  name,
  value,
  delta,
  target,
  raw,
}: {
  name: string
  value: string
  delta: string
  target: string
  raw: string
}): React.JSX.Element {
  const [copied, setCopied] = React.useState(false)
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  React.useEffect(() => () => clearTimeout(timer.current), [])
  const dir = deltaDirection(delta)
  const pct = progressPct(value, target)
  const copyValue = (): void => {
    void copyText(value).then((ok) => {
      if (!ok) return
      setCopied(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1600)
    })
  }
  return (
    <div className="md-kpi-item" title={raw || undefined}>
      {name ? <div className="md-kpi-name">{name}</div> : null}
      <div className="md-kpi-figure">
        {value ? (
          <button type="button" className="md-kpi-value" title="点击复制" onClick={copyValue}>
            <span>{value}</span>
            {copied ? <Check className="size-3 shrink-0 text-emerald-600" /> : null}
          </button>
        ) : null}
        {delta ? <span className={cn('md-kpi-delta', dir > 0 && 'is-up', dir < 0 && 'is-down')}>{delta}</span> : null}
      </div>
      {pct !== undefined ? (
        <div className="md-kpi-progress" title={`${pct}% / 目标 ${target}`}>
          <div className="md-kpi-progress-bar" style={{ width: `${pct}%` }} />
          <span className="md-kpi-target">目标 {target}</span>
        </div>
      ) : null}
    </div>
  )
}

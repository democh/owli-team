/**
 * Callout 提示块（::: tip|info|note|success|warning|danger [标题]）：
 * 左侧图标 + 标题 + 正文；配色由 .md-callout-<kind> 上的 --cal 变量驱动（index.css）。
 */
import * as React from 'react'
import {
  CheckCircle2,
  Info,
  Lightbulb,
  ShieldAlert,
  StickyNote,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react'
import { CALLOUT_KINDS, type CalloutKind } from './remark-ext'

const META: Record<CalloutKind, { label: string; icon: LucideIcon }> = {
  tip: { label: '提示', icon: Lightbulb },
  info: { label: '信息', icon: Info },
  note: { label: '笔记', icon: StickyNote },
  success: { label: '成功', icon: CheckCircle2 },
  warning: { label: '注意', icon: TriangleAlert },
  danger: { label: '危险', icon: ShieldAlert },
}

export function CalloutCard({
  kind,
  title,
  children,
}: {
  kind: string
  title?: string
  children?: React.ReactNode
}): React.JSX.Element {
  const k: CalloutKind = (CALLOUT_KINDS as readonly string[]).includes(kind) ? (kind as CalloutKind) : 'note'
  const meta = META[k]
  const Icon = meta.icon
  return (
    <div className={`md-callout md-callout-${k}`}>
      <div className="md-callout-head">
        <Icon className="size-3.5 shrink-0" />
        <span>{title || meta.label}</span>
      </div>
      <div className="md-callout-body">{children}</div>
    </div>
  )
}

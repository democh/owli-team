/**
 * 方案卡（::: option [推荐|备选|否决|待定] 标题）：
 * - 状态徽标配色由 .md-option-<status> 上的 --opt 变量驱动（index.css）；
 * - 状态词未命中白名单 → 不显示徽标，降级为中性标题卡（标题为整段参数）；
 * - 正文（列表/段落等）原样渲染；
 * - M37-5：「选它」把「拍板：标题」写入 Composer 草稿（ADR 0064：用户确认后发送）。
 */
import * as React from 'react'
import { PenLine } from 'lucide-react'
import { useUiStore } from '../../../stores/ui-store'
import { OPTION_STATUS_LABEL, type OptionStatus } from './remark-ext'

const STATUS_KEYS = new Set<string>(Object.keys(OPTION_STATUS_LABEL))

export function OptionCard({
  status,
  title,
  children,
}: {
  status?: string
  title?: string
  children?: React.ReactNode
}): React.JSX.Element {
  const insertToComposer = useUiStore((s) => s.insertToComposer)
  const key = status && STATUS_KEYS.has(status) ? (status as OptionStatus) : undefined
  return (
    <div className={key ? `md-option md-option-${key}` : 'md-option'}>
      <div className="md-option-head">
        {key ? <span className="md-option-badge">{OPTION_STATUS_LABEL[key]}</span> : null}
        {title ? <span className="md-option-title">{title}</span> : null}
        {title ? (
          <button
            type="button"
            className="md-option-pick"
            title="把「拍板：标题」写入输入框（可编辑后发送）"
            onClick={() => insertToComposer(`拍板：${title}`)}
          >
            <PenLine className="size-3" />
            选它
          </button>
        ) : null}
      </div>
      <div className="md-option-body">{children}</div>
    </div>
  )
}

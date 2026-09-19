/**
 * M43（§72.2）：对决声明卡（`::: debate [题面]`）——对决议题的显式声明（协议侧入口；
 * ADR 0117：PK 只做显式结构化触发，本容器即三个显式入口之一）。
 * - 题面 = 容器首参；条目行（`- 键 | 值`）为双方立场 / 规则（可选）；
 * - 纯声明卡（无交互）；解析失败 → raw 兜底静态渲染，其余内容照常。
 */
import * as React from 'react'
import { Swords } from 'lucide-react'
import { offerRowsOf, parseOfferRows, type OfferRow } from '../../../lib/pk'
import { useMessageInfo } from './message-context'

export function DebateCard({
  title,
  items: itemsRaw,
  raw,
  children,
}: {
  title?: string
  items?: string
  raw?: string
  children?: React.ReactNode
}): React.JSX.Element {
  useMessageInfo()
  const parsed = React.useMemo<OfferRow[]>(() => {
    const fromJson = parseOfferRows(itemsRaw)
    if (fromJson.length > 0) return fromJson
    return raw ? offerRowsOf(raw.split('\n')).items : []
  }, [itemsRaw, raw])

  return (
    <div className="md-debate">
      <div className="md-debate-head">
        <span className="md-debate-kind">
          <Swords className="size-3.5" />
          对决
        </span>
        <span className="md-debate-title">{title || '对决议题'}</span>
      </div>
      {parsed.length > 0 ? (
        <div className="md-debate-sides" role="list">
          {parsed.map((r, i) => (
            <div key={`${r.label}-${i}`} className="md-debate-side" role="listitem">
              {r.label ? <span className="md-debate-label">{r.label}</span> : null}
              <span className="md-debate-value">{r.value}</span>
            </div>
          ))}
        </div>
      ) : null}
      {parsed.length === 0 && raw ? <pre className="md-debate-static">{raw}</pre> : null}
      {children}
    </div>
  )
}

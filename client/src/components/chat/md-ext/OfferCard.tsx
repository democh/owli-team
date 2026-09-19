/**
 * M43（§72.7）：报价卡（`::: offer [标题]`）——字段行（`键：值`）与条目行（`- 键 | 值`）由
 * remark 侧转 data-fields / data-items JSON。
 * - 报价 / 价格 / 金额类字段高亮（negotiation 报价流的核心读数）；
 * - 解析失败 → raw 兜底静态渲染，其余内容照常。
 */
import * as React from 'react'
import { cn } from '../../../lib/utils'
import { offerRowsOf, parseOfferRows, type OfferRow } from '../../../lib/pk'
import { useMessageInfo } from './message-context'

const PRICE_RE = /报价|价格|金额|总价|单价|价位/

export function OfferCard({
  title,
  fields: fieldsRaw,
  items: itemsRaw,
  raw,
  children,
}: {
  title?: string
  fields?: string
  items?: string
  raw?: string
  children?: React.ReactNode
}): React.JSX.Element {
  useMessageInfo()
  const parsed = React.useMemo(() => {
    const fields = parseOfferRows(fieldsRaw)
    const items = parseOfferRows(itemsRaw)
    if (fields.length > 0 || items.length > 0) return { fields, items }
    return raw ? offerRowsOf(raw.split('\n')) : { fields: [], items: [] }
  }, [fieldsRaw, itemsRaw, raw])

  if (parsed.fields.length === 0 && parsed.items.length === 0) {
    return (
      <div className="md-offer">
        {raw ? <pre className="md-offer-static">{raw}</pre> : null}
        {children}
      </div>
    )
  }

  const row = (r: OfferRow, i: number, isItem: boolean): React.JSX.Element => (
    <div
      key={`${r.label}-${i}`}
      className={cn('md-offer-row', !isItem && PRICE_RE.test(r.label) && 'is-price')}
    >
      {r.label ? <span className="md-offer-label">{r.label}</span> : null}
      <span className="md-offer-value">{r.value}</span>
    </div>
  )

  return (
    <div className="md-offer">
      <div className="md-offer-head">
        <span className="md-offer-kind">报价</span>
        <span className="md-offer-title">{title || '报价条件'}</span>
      </div>
      <div className="md-offer-rows" role="list">
        {parsed.fields.map((r, i) => row(r, i, false))}
        {parsed.items.map((r, i) => row(r, i, true))}
      </div>
      {children}
    </div>
  )
}

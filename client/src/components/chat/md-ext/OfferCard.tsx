/**
 * M43（§72.7）：报价卡（`::: offer [标题]`）——字段行（`键：值`）与条目行（`- 键 | 值`）由
 * remark 侧转 data-fields / data-items JSON。
 * - 报价 / 价格 / 金额类字段高亮（negotiation 报价流的核心读数）；
 * - 值可点复制（与 KpiItem 同模式：1.6s 反馈）——谈判比价 / 传阅的高频动作；
 * - 解析失败 → raw 兜底静态渲染，其余内容照常。
 */
import * as React from 'react'
import { Check } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { offerRowsOf, parseOfferRows, type OfferRow } from '../../../lib/pk'
import { copyText } from './CopyButton'
import { useMessageInfo } from './message-context'

const PRICE_RE = /报价|价格|金额|总价|单价|价位/

/** 值为可点复制的读数（与 KpiItem 一致的轻交互；失败静默不反馈） */
function OfferValue({ value }: { value: string }): React.JSX.Element {
  const [copied, setCopied] = React.useState(false)
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  React.useEffect(() => () => clearTimeout(timer.current), [])
  const onCopy = (): void => {
    void copyText(value).then((ok) => {
      if (!ok) return
      setCopied(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1600)
    })
  }
  return (
    <button type="button" className="md-offer-value" title="点击复制" onClick={onCopy}>
      <span>{value}</span>
      {copied ? <Check className="size-3 shrink-0 text-emerald-600" /> : null}
    </button>
  )
}

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
      <OfferValue value={r.value} />
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

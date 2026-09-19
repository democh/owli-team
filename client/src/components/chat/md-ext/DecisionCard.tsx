/**
 * M38（§92）：决议卡（`::: decision`）——决策留痕三要素（背景 / 决策 / 后果）。
 * - 结构由 remark 侧转 data-fields JSON（字段行 `背景：… / 决策：… / 后果：…`，缺省字段按出现顺序排后）；
 * - 「确认拍板」→ composerInsert 草稿（统一回填语义，ADR 0064；只写草稿不直发）；
 * - 解析失败 → raw 兜底静态渲染。
 */
import * as React from 'react'
import { Gavel, Stamp } from 'lucide-react'
import { useUiStore } from '../../../stores/ui-store'
import { useMessageInfo } from './message-context'
import { useStreaming } from './streaming'
import type { PanRow } from './remark-ext'

/** 决议首选字段顺序（未出现的跳过；其余字段按出现顺序排后） */
const DECISION_KEYS = ['背景', '决策', '后果']

/** data-fields JSON → 字段行（非法 JSON / 形状不符 → 空数组，走 raw 回退） */
export function parseDecisionFields(json: string | undefined): PanRow[] {
  if (!json) return []
  try {
    const arr: unknown = JSON.parse(json)
    if (!Array.isArray(arr)) return []
    const out: PanRow[] = []
    for (const v of arr) {
      if (!v || typeof v !== 'object') continue
      const o = v as { label?: unknown; value?: unknown }
      if (typeof o.label !== 'string' || typeof o.value !== 'string' || o.label === '') continue
      out.push({ label: o.label, value: o.value })
    }
    return out
  } catch {
    return []
  }
}

export function DecisionCard({
  title,
  fields: fieldsRaw,
  raw,
  children,
  /** 覆盖回填回调（消息流缺省走 ui-store 草稿回填） */
  onInsert,
}: {
  title?: string
  fields?: string
  raw?: string
  children?: React.ReactNode
  onInsert?: (text: string) => void
}): React.JSX.Element {
  // 消息 id 仅用于潜在回源（渲染不依赖）；与 ClaimCard 同构读取保持容器上下文一致
  useMessageInfo()
  const streaming = useStreaming()
  const insertToComposer = useUiStore((s) => s.insertToComposer)
  const parsed = React.useMemo(() => parseDecisionFields(fieldsRaw), [fieldsRaw])
  const insert = onInsert ?? ((text: string): void => insertToComposer(text))

  const ordered = React.useMemo(() => {
    const rest = [...parsed]
    const head: PanRow[] = []
    for (const key of DECISION_KEYS) {
      const idx = rest.findIndex((f) => f.label === key)
      if (idx >= 0) head.push(rest.splice(idx, 1)[0]!)
    }
    return [...head, ...rest]
  }, [parsed])

  if (ordered.length === 0) {
    return (
      <div className="md-decision">
        {raw ? <pre className="md-decision-static">{raw}</pre> : null}
        {children}
      </div>
    )
  }

  return (
    <div className="md-decision" data-decision-card="">
      <div className="md-decision-head">
        <Gavel className="size-3.5" aria-hidden />
        <span className="md-decision-title">{title || '决议'}</span>
      </div>
      <div className="md-decision-body">
        {ordered.map((f, i) => (
          <div className="md-decision-sec" key={i}>
            <span className="md-decision-k">{f.label}</span>
            <span className="md-decision-v">{f.value}</span>
          </div>
        ))}
      </div>
      {children}
      <div className="md-decision-foot">
        <button
          type="button"
          className="md-decision-confirm"
          disabled={streaming}
          title="写入输入框（可编辑后发送）"
          onClick={() => insert(`确认拍板：《${title || '本决议'}》。请按决议推进，并列出后续行动项与负责人。`)}
        >
          <Stamp className="size-3" />
          确认拍板
        </button>
      </div>
    </div>
  )
}

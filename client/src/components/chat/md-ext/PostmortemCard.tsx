/**
 * M39（§97，SR-3，ADR 0151）：复盘卡（`::: postmortem [标题]`）——SRE 无责复盘的结构化呈现。
 * - 结构由 remark 侧转 data-fields（`分级：… / 时间线：… / 归因：…` 字段行）与 data-items
 *   （`- 改进项 | 内容 | owner 期限` 条目）；三要素按「分级 → 时间线 → 归因」排序（其余字段排后）；
 * - 改进项条目按值内 `|` 再拆「内容 / 归属」——归属渲染为 chip（owner + 期限）；
 * - 解析失败 / 无内容 → raw 兜底静态渲染。
 */
import * as React from 'react'
import { ClipboardCheck } from 'lucide-react'
import type { PanRow } from './remark-ext'

/** 复盘首选字段顺序（未出现的跳过；其余字段按出现顺序排后） */
const PM_KEYS = ['分级', '时间线', '归因']

export interface PostmortemAction {
  /** 改进项内容 */
  text: string
  /** 归属（owner + 期限；缺省为空串） */
  owner: string
}

/** data-fields JSON → 字段行（非法 JSON / 形状不符 → 空数组，走 raw 回退） */
export function parsePostmortemFields(json: string | undefined): PanRow[] {
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

/** data-items JSON → 改进项（值内 `|` 再拆「内容 / 归属」） */
export function parsePostmortemItems(json: string | undefined): PostmortemAction[] {
  if (!json) return []
  try {
    const arr: unknown = JSON.parse(json)
    if (!Array.isArray(arr)) return []
    const out: PostmortemAction[] = []
    for (const v of arr) {
      if (!v || typeof v !== 'object') continue
      const o = v as { label?: unknown; value?: unknown }
      if (typeof o.label !== 'string' || typeof o.value !== 'string') continue
      const parts = o.value.split(/[|｜]/).map((s) => s.trim())
      const text = parts[0] ?? ''
      if (text === '') continue
      out.push({ text, owner: parts.slice(1).join(' · ') })
    }
    return out
  } catch {
    return []
  }
}

export function PostmortemCard({
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
  const parsed = React.useMemo(() => parsePostmortemFields(fieldsRaw), [fieldsRaw])
  const actions = React.useMemo(() => parsePostmortemItems(itemsRaw), [itemsRaw])

  const ordered = React.useMemo(() => {
    const rest = [...parsed]
    const head: PanRow[] = []
    for (const key of PM_KEYS) {
      const idx = rest.findIndex((f) => f.label === key)
      if (idx >= 0) head.push(rest.splice(idx, 1)[0]!)
    }
    return [...head, ...rest]
  }, [parsed])

  if (ordered.length === 0 && actions.length === 0) {
    return (
      <div className="md-postmortem">
        {raw ? <pre className="md-postmortem-static">{raw}</pre> : null}
        {children}
      </div>
    )
  }

  return (
    <div className="md-postmortem" data-postmortem-card="">
      <div className="md-postmortem-head">
        <ClipboardCheck className="size-3.5" aria-hidden />
        <span className="md-postmortem-title">{title || '复盘'}</span>
      </div>
      {ordered.length > 0 ? (
        <div className="md-postmortem-body">
          {ordered.map((f, i) => (
            <div className="md-postmortem-sec" key={i}>
              <span className="md-postmortem-k">{f.label}</span>
              <span className="md-postmortem-v">{f.value}</span>
            </div>
          ))}
        </div>
      ) : null}
      {actions.length > 0 ? (
        <div className="md-postmortem-actions" data-postmortem-actions="">
          <div className="md-postmortem-cap">改进项 · {actions.length}</div>
          <ul>
            {actions.map((a, i) => (
              <li key={i}>
                <span className="md-postmortem-dot" aria-hidden />
                <span className="md-postmortem-text">{a.text}</span>
                {a.owner !== '' ? <span className="md-postmortem-owner">{a.owner}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {children}
    </div>
  )
}

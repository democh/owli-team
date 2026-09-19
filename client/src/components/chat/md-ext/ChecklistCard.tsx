/**
 * M37-4（§52）：任务清单卡（::: checklist [标题]）——任务项由 remark 侧转 data-items JSON。
 * - 行内点选为本地互动态（覆盖表 Map<index, boolean>）：用户未触碰过的条目跟随消息内容初始 checked；
 * - 勾选态存 sessionStorage（ma:check:<sessionId>:<messageId>），刷新 / 翻页保留；
 *   无消息上下文（独立 Markdown 渲染）时仅即时态、不落存储；
 * - 流式期间整卡静态（行不可点、按钮禁用）；完成态渲染缓存复用时按挂载位置的 context 求值（安全）；
 * - 「回填完成情况」把当前勾选序列化为任务清单 markdown 写入 Composer 草稿（ADR 0064：用户确认后发送）。
 */
import * as React from 'react'
import { Check, PenLine } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { useUiStore } from '../../../stores/ui-store'
import { useMessageInfo } from './message-context'
import { useStreaming } from './streaming'

export interface ChecklistItemData {
  label: string
  checked: boolean
}

/** data-items JSON → 条目数组（非法 JSON / 形状不符 → 空数组，走 raw / children 回退） */
export function parseChecklistItems(json: string | undefined): ChecklistItemData[] {
  if (!json) return []
  try {
    const arr: unknown = JSON.parse(json)
    if (!Array.isArray(arr)) return []
    const out: ChecklistItemData[] = []
    for (const v of arr) {
      if (!v || typeof v !== 'object') continue
      const o = v as { label?: unknown; checked?: unknown }
      if (typeof o.label !== 'string' || o.label === '') continue
      out.push({ label: o.label, checked: o.checked === true })
    }
    return out
  } catch {
    return []
  }
}

/** 当前勾选（真值数组）→ 回填文本：任务清单 markdown，可编辑后发送 */
export function buildChecklistBackfill(title: string | undefined, items: ChecklistItemData[], done: readonly boolean[]): string {
  const count = items.reduce((n, _, i) => n + (done[i] ? 1 : 0), 0)
  const lines = items.map((it, i) => `- [${done[i] ? 'x' : ' '}] ${it.label}`).join('\n')
  const head = title ? `《${title}》` : '任务清单'
  return `完成情况回填 · ${head}（${count}/${items.length}）\n${lines}`
}

type Overrides = ReadonlyMap<number, boolean>

function readOverrides(key: string): Overrides {
  if (!key) return new Map()
  try {
    const raw = sessionStorage.getItem(key)
    if (raw === null) return new Map()
    const arr: unknown = JSON.parse(raw)
    if (!Array.isArray(arr)) return new Map()
    const out = new Map<number, boolean>()
    for (const pair of arr) {
      if (!Array.isArray(pair)) continue
      const [i, v] = pair as [unknown, unknown]
      if (Number.isInteger(i) && (i as number) >= 0 && typeof v === 'boolean') out.set(i as number, v)
    }
    return out
  } catch {
    return new Map() // 存储损坏 / 隐私模式：回到内容初始态
  }
}

function writeOverrides(key: string, ov: Overrides): void {
  if (!key) return
  try {
    sessionStorage.setItem(key, JSON.stringify([...ov.entries()]))
  } catch {
    // 配额 / 隐私模式：忽略，仅本次会话内生效
  }
}

export function ChecklistCard({
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
  const info = useMessageInfo()
  const streaming = useStreaming()
  const insertToComposer = useUiStore((s) => s.insertToComposer)
  const parsed = React.useMemo(() => parseChecklistItems(itemsRaw), [itemsRaw])
  const key = info && info.sessionId && info.messageId ? `ma:check:${info.sessionId}:${info.messageId}` : ''
  const [snap, setSnap] = React.useState<{ key: string; ov: Overrides }>(() => ({ key, ov: readOverrides(key) }))
  const ov = snap.key === key ? snap.ov : readOverrides(key)

  // 无条目（解析失败 / 空容器）：raw 兜底静态渲染，其余内容照常
  if (parsed.length === 0) {
    return (
      <div className="md-checklist">
        {raw ? <pre className="md-checklist-static">{raw}</pre> : null}
        {children}
      </div>
    )
  }

  const isDone = (i: number): boolean => ov.get(i) ?? parsed[i]!.checked
  const done = parsed.map((_, i) => isDone(i))
  const doneCount = done.reduce((n, v) => n + (v ? 1 : 0), 0)

  const toggle = (i: number): void => {
    const next = new Map(ov)
    next.set(i, !isDone(i))
    setSnap({ key, ov: next })
    writeOverrides(key, next)
  }

  return (
    <div className="md-checklist">
      <div className="md-checklist-head">
        {title ? <span>{title}</span> : null}
        <span className="md-checklist-count">
          {doneCount}/{parsed.length}
        </span>
      </div>
      <div className="md-checklist-list">
        {parsed.map((it, i) => {
          const checked = isDone(i)
          return (
            <button
              key={i}
              type="button"
              className={cn('md-checkline', checked && 'is-done')}
              disabled={streaming}
              aria-pressed={checked}
              onClick={() => toggle(i)}
            >
              <span className="md-checkbox" aria-hidden>
                {checked ? <Check className="size-2.5" strokeWidth={3} /> : null}
              </span>
              <span className="md-check-label">{it.label}</span>
            </button>
          )
        })}
      </div>
      {children}
      <div className="md-checklist-foot">
        <span className="md-checklist-progress" aria-hidden>
          <span style={{ width: `${Math.round((doneCount / parsed.length) * 100)}%` }} />
        </span>
        <span>
          {doneCount}/{parsed.length} 已完成
        </span>
        <button
          type="button"
          className="md-checklist-backfill"
          disabled={streaming}
          title="把当前完成情况写入输入框（可编辑后发送）"
          onClick={() => insertToComposer(buildChecklistBackfill(title, parsed, done))}
        >
          <PenLine className="size-3" />
          回填完成情况
        </button>
      </div>
    </div>
  )
}

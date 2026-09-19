/**
 * M69：牌阵卡（`::: cards`）——tarot 抽牌结果的结构化呈现。
 * - 数据由 remark 侧转 data-items JSON（条目 `- 牌位 | 牌名 | 正逆位 | 关键词`）；
 * - 「深入解读这组牌」→ composerInsert 草稿（统一回填语义，ADR 0064；只写草稿不直发）；
 * - M78：「亲手抽一组」→ 打开抽牌台（全局宿主，ui-store.openTarotDraw）；
 * - 解析失败 → raw 兜底静态渲染。
 */
import * as React from 'react'
import { Moon } from 'lucide-react'
import { useUiStore } from '../../../stores/ui-store'
import { useMessageInfo } from './message-context'
import { useStreaming } from './streaming'
import type { PanRow } from './remark-ext'

export interface TarotCardRow {
  position: string
  name: string
  orientation: string
  keywords: string[]
}

function parseItems(json: string | undefined): PanRow[] {
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

/** data-items JSON → 牌行（宽松解析：value 按 | 拆「牌名 / 正逆位 / 关键词」） */
export function parseCards(itemsRaw: string | undefined): TarotCardRow[] {
  const items = parseItems(itemsRaw)
  const out: TarotCardRow[] = []
  for (const it of items) {
    const parts = it.value.split('|').map((s) => s.trim())
    const name = parts[0] ?? ''
    const orientation = parts[1] ?? ''
    const keywords = (parts[2] ?? '')
      .split(/[·、,，/]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (!name) continue
    out.push({ position: it.label, name, orientation, keywords })
  }
  return out
}

export function CardsCard({
  title,
  items: itemsRaw,
  raw,
  children,
  onInsert,
}: {
  title?: string
  items?: string
  raw?: string
  children?: React.ReactNode
  onInsert?: (text: string) => void
}): React.JSX.Element {
  useMessageInfo()
  const streaming = useStreaming()
  const insertToComposer = useUiStore((s) => s.insertToComposer)
  const openTarotDraw = useUiStore((s) => s.openTarotDraw)
  const cards = React.useMemo(() => parseCards(itemsRaw), [itemsRaw])
  const insert = onInsert ?? ((text: string): void => insertToComposer(text))

  if (cards.length === 0) {
    return (
      <div className="md-cards">
        {raw ? <pre className="md-cards-static">{raw}</pre> : null}
        {children}
      </div>
    )
  }

  const deckText = `@观照 深入解读这组牌（${title || '本牌阵'}）：逐牌展开 + 关系编织 + 参考区间，并注明复现种子。`
  const redrawText = `@观照 换一组牌重抽（同问题，新种子）：${title || '本牌阵'}。`
  return (
    <div className="md-cards" data-cards-card="">
      <div className="md-cards-head">
        <Moon className="size-3.5" aria-hidden />
        <span className="md-cards-title">{title || '牌阵'}</span>
        <span className="md-cards-count">{cards.length} 张</span>
      </div>
      <div className="md-cards-body">
        {cards.map((c, i) => (
          <div className={`md-card-row${c.orientation.includes('逆') ? ' md-card-row-rev' : ''}`} key={i}>
            <span className="md-card-pos">{c.position}</span>
            <span className="md-card-name">{c.name}</span>
            {c.orientation ? <span className="md-card-orient">{c.orientation}</span> : null}
            {c.keywords.length > 0 ? <span className="md-card-keys">{c.keywords.join(' · ')}</span> : null}
          </div>
        ))}
      </div>
      {children}
      <div className="md-cards-foot">
        <button
          type="button"
          className="md-cards-redraw"
          disabled={streaming}
          title="换一组牌重抽（新种子）"
          onClick={() => insert(redrawText)}
        >
          <Moon className="size-3" />
          重抽一组
        </button>
        <button
          type="button"
          className="md-cards-pick"
          disabled={streaming}
          title="打开抽牌台，亲手洗牌选牌"
          onClick={() => openTarotDraw({})}
        >
          <Moon className="size-3" />
          亲手抽一组
        </button>
        <button
          type="button"
          className="md-cards-enter"
          disabled={streaming}
          title="写入输入框（可编辑后发送）"
          onClick={() => insert(deckText)}
        >
          <Moon className="size-3" />
          深入解读这组牌
        </button>
      </div>
    </div>
  )
}

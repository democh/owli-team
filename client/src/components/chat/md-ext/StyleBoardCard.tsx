/**
 * M65-C：风格板卡（`::: styleboard 主题名`）——色卡（名称 | #hex | 用途）+ 质感关键词。
 *
 * 交互（v57 五模式）：色值点击复制（copyText 1.6s 复位）；「按此板调整方案」回填草稿；
 * 复制结构化文本；流式禁用。非法色值降级文本行（不渲染色块）。
 */
import * as React from 'react'
import { Check, Palette } from 'lucide-react'
import { useUiStore } from '../../../stores/ui-store'
import { tplApplyStyleboard } from '../../../lib/ds-templates'
import { CopyButton, copyText } from './CopyButton'
import { useStreaming } from './streaming'
import { isHexColor, type SwatchData } from './remark-ext'

/** data-items JSON → 色卡条目（非法形状 → 空数组，走 children 回退） */
export function parseSwatches(json?: string): SwatchData[] {
  if (!json) return []
  try {
    const arr: unknown = JSON.parse(json)
    if (!Array.isArray(arr)) return []
    const out: SwatchData[] = []
    for (const v of arr) {
      if (!v || typeof v !== 'object') continue
      const o = v as { name?: unknown; hex?: unknown; usage?: unknown }
      const name = typeof o.name === 'string' ? o.name : ''
      if (name === '') continue
      out.push({
        name,
        hex: typeof o.hex === 'string' ? o.hex : '',
        usage: typeof o.usage === 'string' ? o.usage : '',
      })
    }
    return out
  } catch {
    return []
  }
}

/** 风格板 → 可复制结构化文本 */
export function buildStyleboardText(title: string | undefined, swatches: SwatchData[], texture?: string): string {
  const head = `《${title || '风格板'}》`
  const rows = swatches.map((s) => `- ${s.name} | ${s.hex}${s.usage ? ` | ${s.usage}` : ''}`)
  return [head, ...rows, ...(texture ? [`质感：${texture}`] : [])].join('\n')
}

function SwatchRow({ swatch, disabled }: { swatch: SwatchData; disabled: boolean }): React.JSX.Element {
  const [copied, setCopied] = React.useState(false)
  const valid = isHexColor(swatch.hex)
  const onCopy = (): void => {
    if (!valid) return
    void copyText(swatch.hex).then((ok) => {
      if (!ok) return
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    })
  }
  return (
    <div className="md-sb-row">
      {valid ? (
        <span className="md-sb-chip" style={{ background: swatch.hex }} aria-hidden />
      ) : (
        <span className="md-sb-chip md-sb-chip-invalid" aria-hidden />
      )}
      <span className="md-sb-name">{swatch.name}</span>
      <button
        type="button"
        className="md-sb-hex"
        disabled={disabled || !valid}
        title={valid ? '点击复制色值' : '色值格式非法（应为 #rrggbb）'}
        onClick={onCopy}
      >
        {copied ? <Check size={11} /> : null}
        {swatch.hex || '—'}
      </button>
      <span className="md-sb-usage">{swatch.usage}</span>
    </div>
  )
}

export function StyleBoardCard({
  title,
  items: itemsRaw,
  texture,
  children,
}: {
  title?: string
  items?: string
  /** 质感行（`质感：哑光木纹 · 低饱和`） */
  texture?: string
  children?: React.ReactNode
}): React.JSX.Element {
  const streaming = useStreaming()
  const insertToComposer = useUiStore((s) => s.insertToComposer)
  const swatches = React.useMemo(() => parseSwatches(itemsRaw), [itemsRaw])

  if (swatches.length === 0 && !texture) {
    return (
      <div className="md-styleboard" data-styleboard="">
        {children}
      </div>
    )
  }

  const primary = swatches[0]?.hex
  const accent = swatches[1]?.hex

  return (
    <div className="md-styleboard" data-styleboard="">
      <div className="md-sb-head">
        <Palette size={13} className="md-sb-icon" />
        <span className="md-sb-title">{title || '风格板'}</span>
        <span className="md-card-grow" />
        <CopyButton text={buildStyleboardText(title, swatches, texture)} />
      </div>
      {swatches.length > 0 ? (
        <div className="md-sb-list">
          {swatches.map((s, i) => (
            <SwatchRow key={i} swatch={s} disabled={streaming} />
          ))}
        </div>
      ) : null}
      {texture ? <div className="md-sb-texture">质感：{texture}</div> : null}
      <div className="md-sb-foot">
        <button
          type="button"
          className="md-sb-apply"
          disabled={streaming}
          title="回填「按此风格板调整方案」草稿"
          onClick={() => insertToComposer(tplApplyStyleboard({ theme: title || '风格板', ...(primary ? { primary } : {}), ...(accent ? { accent } : {}) }))}
        >
          按此板调整方案
        </button>
      </div>
      {children}
    </div>
  )
}

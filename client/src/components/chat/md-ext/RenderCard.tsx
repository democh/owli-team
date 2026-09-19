/**
 * M65-C：效果图卡（`::: render 标题`）——产物图（来源行解析）+ 元信息（视角 / 风格 / 参数）。
 *
 * - 「来源 | 输入 → 产物」：取箭头后最后一段作为产物路径渲染图片（artifactContentUrl，
 *   session 上下文缺失 / 产物未就位 → 仅元信息 + 提示行，不空图）；
 * - 图片复用 ZoomableImage（点击放大）；「再生成一版」回填草稿（seed 从参数行提取）；
 * - 解析失败 / 无字段 → children 兜底；流式禁用（v57 五模式）。
 */
import * as React from 'react'
import { Image as ImageIcon } from 'lucide-react'
import { artifactContentUrl } from '../../../lib/artifacts'
import { useSessionStore } from '../../../stores/session-store'
import { useUiStore } from '../../../stores/ui-store'
import { seedOfParams, tplRegenRender } from '../../../lib/ds-templates'
import { CopyButton } from './CopyButton'
import { useStreaming } from './streaming'
import { parseVerdictItems, type VerdictItemData } from './VerdictCard'
import { ZoomableImage } from './ZoomableImage'

export type RenderField = VerdictItemData

/** 字段列表 → 命名查询（后续重名字段取首个） */
export function fieldOf(fields: RenderField[], label: string): string | undefined {
  return fields.find((f) => f.label === label)?.value
}

/**
 * 「来源」值 → 产物路径：`输入 → 产物` 取最后一个 `→` 段；
 * 无箭头时整串视为路径；非图片扩展名 → undefined（不渲染图片区）。
 */
export function renderProductPath(source: string | undefined): string | undefined {
  if (!source) return undefined
  const parts = source
    .split('→')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  const last = parts[parts.length - 1]
  if (!last) return undefined
  return /\.(png|jpe?g|webp|gif)$/i.test(last) ? last : undefined
}

export function RenderCard({
  title,
  items: itemsRaw,
  children,
}: {
  title?: string
  items?: string
  children?: React.ReactNode
}): React.JSX.Element {
  const streaming = useStreaming()
  const insertToComposer = useUiStore((s) => s.insertToComposer)
  const sessionId = useSessionStore((s) => s.currentId)
  const fields = React.useMemo(() => parseVerdictItems(itemsRaw), [itemsRaw])

  if (fields.length === 0) {
    return (
      <div className="md-render" data-render="">
        {children}
      </div>
    )
  }

  const sourceVal = fieldOf(fields, '来源')
  const params = fieldOf(fields, '参数') ?? ''
  const seed = seedOfParams(params)
  const product = renderProductPath(sourceVal)
  const imgUrl = sessionId && product ? artifactContentUrl(sessionId, product) : undefined
  const meta = fields.filter((f) => f.label !== '来源')

  return (
    <div className="md-render" data-render="">
      <div className="md-render-head">
        <ImageIcon size={13} className="md-render-icon" />
        <span className="md-render-title">{title || '效果图'}</span>
        <span className="md-card-grow" />
        <CopyButton text={[`《${title || '效果图'}》`, ...fields.map((f) => `- ${f.label}：${f.value}`)].join('\n')} />
      </div>
      {imgUrl ? (
        <div className="md-render-img-wrap" data-render-img>
          <ZoomableImage src={imgUrl} alt={title || '效果图'} className="md-render-img" />
        </div>
      ) : (
        <div className="md-render-note">
          {sourceVal ? '产物未就位（生成中或路径不可用）' : '未声明来源（生成完成后补「来源」行）'}
        </div>
      )}
      {meta.length > 0 ? (
        <div className="md-render-meta">
          {meta.map((f, i) => (
            <div key={i} className="md-render-meta-row">
              <span className="md-render-meta-label">{f.label}</span>
              <span className="md-render-meta-value">{f.value}</span>
            </div>
          ))}
        </div>
      ) : null}
      <div className="md-render-foot">
        <button
          type="button"
          className="md-render-regen"
          disabled={streaming}
          title="回填「再生成一版」草稿"
          onClick={() => insertToComposer(tplRegenRender({ title: title || '效果图', ...(seed ? { seed } : {}) }))}
        >
          再生成一版
        </button>
        {sourceVal ? <span className="md-render-src" title={sourceVal}>{sourceVal}</span> : null}
      </div>
      {children}
    </div>
  )
}

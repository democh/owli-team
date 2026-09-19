/**
 * M65-C：布局方案卡（`::: layout 方案名`）——房间清单表（房间 | 面积 | 要点）+ 方案源。
 *
 * 交互（v57 卡片五模式）：
 * - 「在 3D 工作台打开」→ requestStudioOpen（跨组件打开通道；工作台负责加载）；
 * - 房间行点击 → 回填调整草稿（insertToComposer，ADR 0064 只写草稿不直发）；
 * - 「复制清单」结构化导出（CopyButton + buildLayoutText）；流式期间交互禁用。
 * 解析失败 / 空条目 → children（原始 markdown）兜底渲染。
 */
import * as React from 'react'
import { Box } from 'lucide-react'
import { useUiStore } from '../../../stores/ui-store'
import { tplAdjustRoom } from '../../../lib/ds-templates'
import { requestStudioOpen } from '../../studio/studio-open'
import { CopyButton } from './CopyButton'
import { useStreaming } from './streaming'
import type { LayoutRowData } from './remark-ext'

/** data-items JSON → 房间条目（非法 JSON / 形状不符 → 空数组，走 children 回退） */
export function parseLayoutItems(json?: string): LayoutRowData[] {
  if (!json) return []
  try {
    const arr: unknown = JSON.parse(json)
    if (!Array.isArray(arr)) return []
    const out: LayoutRowData[] = []
    for (const v of arr) {
      if (!v || typeof v !== 'object') continue
      const o = v as { room?: unknown; area?: unknown; note?: unknown }
      const room = typeof o.room === 'string' ? o.room : ''
      if (room === '') continue
      out.push({
        room,
        area: typeof o.area === 'string' ? o.area : '',
        note: typeof o.note === 'string' ? o.note : '',
      })
    }
    return out
  } catch {
    return []
  }
}

/** 清单 → 可复制结构化文本（markdown 表，可直接粘贴回聊天 / 文档） */
export function buildLayoutText(title: string | undefined, items: LayoutRowData[], source?: string): string {
  const head = `《${title || '布局方案'}》`
  const rows = items.map((it) => `- ${it.room} | ${it.area}${it.note ? ` | ${it.note}` : ''}`)
  return [head, ...rows, ...(source ? [`方案源：${source}`] : [])].join('\n')
}

export function LayoutCard({
  title,
  items: itemsRaw,
  source,
  children,
}: {
  title?: string
  items?: string
  /** 方案源（design/*.scene.json；缺省时「打开」按钮置灰） */
  source?: string
  children?: React.ReactNode
}): React.JSX.Element {
  const streaming = useStreaming()
  const insertToComposer = useUiStore((s) => s.insertToComposer)
  const items = React.useMemo(() => parseLayoutItems(itemsRaw), [itemsRaw])

  if (items.length === 0 && !source) {
    // 解析失败 / 空容器：保持原始 markdown 内容（fail-safe，不空卡）
    return (
      <div className="md-layout" data-layout="">
        {children}
      </div>
    )
  }

  return (
    <div className="md-layout" data-layout="">
      <div className="md-layout-head">
        <Box size={13} className="md-layout-icon" />
        <span className="md-layout-title">{title || '布局方案'}</span>
        <span className="md-card-grow" />
        <CopyButton text={buildLayoutText(title, items, source)} />
      </div>
      {items.length > 0 ? (
        <table className="md-layout-table">
          <thead>
            <tr>
              <th>房间</th>
              <th>面积</th>
              <th>要点</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => (
              <tr key={i}>
                <td>
                  <button
                    type="button"
                    className="md-layout-room"
                    disabled={streaming}
                    title={streaming ? '生成中，稍后可调整' : '点击回填调整草稿'}
                    onClick={() => insertToComposer(tplAdjustRoom({ room: it.room, area: it.area, note: it.note }))}
                  >
                    {it.room}
                  </button>
                </td>
                <td className="md-layout-area">{it.area}</td>
                <td className="md-layout-note">{it.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <div className="md-layout-foot">
        <button
          type="button"
          className="md-layout-open"
          disabled={streaming || !source}
          title={source ? `在 3D 工作台打开 ${source}` : '方案源未声明（等成员产出 scene 文件）'}
          onClick={() => {
            if (source) requestStudioOpen(source)
          }}
        >
          <Box size={12} />
          在 3D 工作台打开
        </button>
        {source ? <span className="md-layout-src">{source}</span> : null}
      </div>
      {children}
    </div>
  )
}

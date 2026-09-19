/**
 * M52-A 元件 10/12：交付件面板（DeliveryPanel）——board / console 共件（§7.6）。
 * 数据源：消息 artifacts 聚合（derive.artifactsOf）；点条目 onOpen 打开交付件。
 */
import * as React from 'react'
import { FileText } from 'lucide-react'

export interface DeliveryItem {
  path: string
  title?: string
}

function baseName(p: string): string {
  const i = p.lastIndexOf('/')
  return i >= 0 ? p.slice(i + 1) : p
}

export function DeliveryPanel({
  items,
  onOpen,
}: {
  items: DeliveryItem[]
  onOpen?: (path: string) => void
}): React.JSX.Element {
  return (
    <div className="scene-delivery" role="list" aria-label="交付件">
      {items.map((it) => (
        <button type="button" role="listitem" className="scene-delivery-item" key={it.path} title={it.path} onClick={() => onOpen?.(it.path)}>
          <FileText size={13} className="scene-delivery-icon" />
          <span className="scene-delivery-name">{it.title ?? baseName(it.path)}</span>
          <span className="scene-delivery-path">{it.path}</span>
        </button>
      ))}
    </div>
  )
}

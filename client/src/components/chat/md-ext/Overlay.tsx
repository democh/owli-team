/**
 * 全屏浮层（md 扩展通用）：portal 到 body（脱离消息卡的层叠/裁剪上下文）；
 * Esc 或点击遮罩关闭；打开期间锁定 body 滚动。
 */
import * as React from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

export function Overlay({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean
  title: string
  onClose: () => void
  children: React.ReactNode
}): React.JSX.Element | null {
  React.useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, onClose])

  if (!open) return null
  return createPortal(
    <div className="md-overlay" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className="md-overlay-panel" onClick={(e) => e.stopPropagation()}>
        <div className="md-overlay-bar">
          <span className="md-overlay-title">{title}</span>
          <button type="button" className="md-block-btn" title="关闭（Esc）" aria-label="关闭" onClick={onClose}>
            <X className="size-3.5" />
          </button>
        </div>
        <div className="md-overlay-body">{children}</div>
      </div>
    </div>,
    document.body,
  )
}

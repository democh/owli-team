/**
 * 全屏浮层（md 扩展通用）：portal 到 body（脱离消息卡的层叠/裁剪上下文）；
 * Esc 或点击遮罩关闭；打开期间锁定 body 滚动。
 */
import * as React from 'react'
import * as Dialog from '@radix-ui/react-dialog'
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
  const returnFocusRef = React.useRef<HTMLElement | null>(null)

  if (!open) return null
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="md-overlay">
          <Dialog.Content
            className="md-overlay-panel"
            aria-describedby={undefined}
            onOpenAutoFocus={() => {
              returnFocusRef.current = document.activeElement as HTMLElement | null
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus()
            }}
          >
            <div className="md-overlay-bar">
              <Dialog.Title asChild>
                <span className="md-overlay-title">{title}</span>
              </Dialog.Title>
              <Dialog.Close className="md-block-btn" title="关闭（Esc）" aria-label="关闭">
                <X className="size-3.5" />
              </Dialog.Close>
            </div>
            <div className="md-overlay-body">{children}</div>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

import * as React from 'react'
import { CheckCircle2, Info, Loader2, TriangleAlert, XCircle } from 'lucide-react'
import { Toaster as SonnerToaster } from 'sonner'

/**
 * 全局 toast 出口（sonner 包装；M85+ 视觉优化）：
 * - 主题锁定浅色（项目仅浅色 tokens，防止系统暗色下 sonner 自动切暗色）；
 * - 类型图标（lucide）：success / error / warning / info / loading（旋转）；
 * - 视觉分层全部在 index.css（`ma-toast*` 类 + [data-type] 类型色：左侧色条 / 图标圆底 / 细描边）——
 *   裸 toast（无类型）自动获得主色锚点；调用点升级为 typed（toast.success 等）即得彩色图标。
 */

/** 类型图标（导出供测试断言） */
export const TOAST_ICONS: Record<'success' | 'error' | 'warning' | 'info' | 'loading', React.ReactNode> = {
  success: <CheckCircle2 className="size-[18px]" />,
  error: <XCircle className="size-[18px]" />,
  warning: <TriangleAlert className="size-[18px]" />,
  info: <Info className="size-[18px]" />,
  loading: <Loader2 className="size-[18px] animate-spin" />,
}

/** 自定义类名（index.css 承接样式；导出供测试断言） */
export const TOAST_CLASSNAMES = {
  toast: 'ma-toast',
  title: 'ma-toast-title',
  description: 'ma-toast-desc',
  icon: 'ma-toast-icon',
  closeButton: 'ma-toast-close',
  actionButton: 'ma-toast-action',
  cancelButton: 'ma-toast-cancel',
} as const

export function Toaster(): React.JSX.Element {
  return (
    <SonnerToaster
      theme="light"
      position="top-center"
      closeButton
      gap={10}
      offset={14}
      mobileOffset={12}
      visibleToasts={3}
      icons={TOAST_ICONS}
      toastOptions={{ classNames: TOAST_CLASSNAMES }}
    />
  )
}

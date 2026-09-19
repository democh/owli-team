/**
 * HTML 交付件预览（M24）：沙箱 iframe 直出（raw=1 原文流，浏览器原生解析）。
 *
 * 安全策略：sandbox 不含 allow-same-origin → iframe 为 opaque origin，
 * 页面内脚本无法访问宿主应用（localStorage / API / DOM）；允许 scripts 以便
 * 交互式页面（含 mermaid / echarts CDN 页面）正常渲染；popups 便于 target=_blank 链接。
 */
import * as React from 'react'

export function HtmlPreview({ src, title }: { src: string; title: string }): React.JSX.Element {
  return (
    <iframe
      src={src}
      title={title}
      sandbox="allow-scripts allow-popups allow-forms allow-modals"
      referrerPolicy="no-referrer"
      className="h-full w-full border-0 bg-white"
    />
  )
}

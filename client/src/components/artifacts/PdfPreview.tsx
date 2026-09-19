/**
 * PDF 交付件预览（M24）：浏览器内置 PDF 阅读器（iframe 直出 content 流，inline Content-Type）。
 * 不支持内置阅读器的环境由浏览器给出下载兜底；工具条另提供下载按钮。
 */
import * as React from 'react'

export function PdfPreview({ src, title }: { src: string; title: string }): React.JSX.Element {
  return <iframe src={src} title={title} className="h-full w-full border-0 bg-white" />
}

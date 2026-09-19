/**
 * 图片灯箱：正文图片包一层放大入口（role=button，非 button 以兼容链接内嵌图），
 * 点击 → portal 浮层展示原图；无 src 图片原样直出。
 */
import * as React from 'react'
import { cn } from '../../../lib/utils'
import { Overlay } from './Overlay'

type ImgProps = React.ImgHTMLAttributes<HTMLImageElement> & { node?: unknown }

export function ZoomableImage({ node: _node, className, alt, src, ...rest }: ImgProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false)

  if (!src) {
    return <img {...rest} className={cn('md-img', className)} alt={alt} />
  }

  return (
    <>
      <span
        role="button"
        tabIndex={0}
        className="md-img-btn"
        title="点击放大查看"
        onClick={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setOpen(true)
          }
        }}
      >
        <img {...rest} src={src} alt={alt} loading="lazy" className={cn('md-img', className)} />
      </span>
      <Overlay open={open} title={alt || '图片'} onClose={() => setOpen(false)}>
        <img src={src} alt={alt} className="md-img-zoom" />
      </Overlay>
    </>
  )
}

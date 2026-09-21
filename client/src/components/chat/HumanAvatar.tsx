/**
 * M79-B：人类成员头像（设计 §14.6）；M79-Q：实装图片头像。
 *
 * 渲染口径：图片（img 圆形 cover；加载失败回退首字）> 色块（#rrggbb 底 + 白色首字）> emoji（中性底 + 单字符）> 缺省（主色浅底 + 首字）。
 * 与 AgentAvatar（3D 卡通）同尺寸纪律；他人人类消息 / 共享弹窗 / 联系人 / 候选 / 图片头像等处共用。
 */
import * as React from 'react'
import type { UserAvatar } from '@multi-agent/shared'
import { cn } from '../../lib/utils'

export function HumanAvatar({
  avatar,
  name,
  size = 34,
  className,
}: {
  avatar?: UserAvatar
  name: string
  size?: number
  className?: string
}): React.JSX.Element {
  // M79-Q：图片加载失败（文件缺失 / 网络）→ 就地回退首字（不抛错）；换图（value 变化）时重置
  const [imageFailed, setImageFailed] = React.useState(false)
  React.useEffect(() => setImageFailed(false), [avatar?.value])
  const image = avatar?.kind === 'image' && !imageFailed ? avatar.value : undefined
  const emoji = !image && avatar?.kind === 'emoji' ? avatar.value : undefined
  const color = !image && avatar?.kind === 'color' ? avatar.value : undefined
  const initial = (name.trim().slice(0, 1) || '?').toUpperCase()
  return (
    <span
      aria-hidden
      title={name}
      className={cn(
        'flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full font-semibold',
        !image && !emoji && (color ? 'text-white' : 'bg-primary/10 text-primary'),
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * (emoji ? 0.5 : 0.42)),
        ...(image ? {} : emoji ? { background: 'var(--muted)' } : color ? { background: color } : {}),
      }}
    >
      {image ? (
        <img
          src={image}
          alt=""
          className="h-full w-full object-cover"
          draggable={false}
          onError={() => setImageFailed(true)}
        />
      ) : (
        (emoji ?? initial)
      )}
    </span>
  )
}

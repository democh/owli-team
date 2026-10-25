/**
 * Agent 头像（§19）：生图形象（agents/ 包内 avatar.png，经 /api/agents/:id/avatar 提供）优先，
 * 未配置或加载失败时回退「渐变 + lucide 图标」方案；
 * 状态角标：thinking 省略号 / done 星星 / error 闪电（animated=false 时全关，供列表小尺寸场景）。
 * 用户（人类主角）不设头像：界面中不渲染用户形象。
 * 圆角：组件内置 25% 等比圆角（所有头像展示统一，任意尺寸圆润度一致；调用方 className 可覆盖）。
 */
import * as React from 'react'
import { Sparkles, Zap } from 'lucide-react'
import type { AgentDefinition, AgentRunState } from '@multi-agent/shared'
import { resolveIcon } from '../../lib/avatar-icons'
import { cn } from '../../lib/utils'

export interface AgentAvatarProps {
  /** 未传 agent 时回退「中性底 + 图标」 */
  agent?: AgentDefinition
  /** 渲染尺寸（px） */
  size?: number
  state?: AgentRunState
  /** false 时不渲染状态角标（列表 / 小尺寸场景） */
  animated?: boolean
  className?: string
  title?: string
}

export const AgentAvatar = React.memo(function AgentAvatar({
  agent,
  size = 32,
  state = 'idle',
  animated = true,
  className,
  title,
}: AgentAvatarProps): React.JSX.Element {
  const src = agent?.avatar.image
  const [failedSrc, setFailedSrc] = React.useState<string>()
  const gradient = agent?.avatar.gradient
  const Icon = resolveIcon(agent?.avatar.icon)
  const showImage = Boolean(src) && src !== failedSrc

  return (
    <div
      className={cn('relative shrink-0 select-none rounded-[25%]', className)}
      style={{ width: size, height: size }}
      title={title ?? agent?.name}
    >
      {showImage ? (
        <img
          src={src}
          loading={animated ? 'eager' : 'lazy'}
          alt={agent?.name ?? ''}
          width={size}
          height={size}
          onError={() => setFailedSrc(src)}
          className="block size-full rounded-[inherit] bg-white object-cover ring-1 ring-black/5"
        />
      ) : gradient ? (
        <div
          className="flex size-full items-center justify-center rounded-[inherit] text-white"
          style={{ background: `linear-gradient(135deg, ${gradient[0]}, ${gradient[1]})` }}
        >
          <Icon style={{ width: size * 0.5, height: size * 0.5 }} />
        </div>
      ) : (
        <div className="flex size-full items-center justify-center rounded-[inherit] bg-muted text-muted-foreground">
          <Icon style={{ width: size * 0.5, height: size * 0.5 }} />
        </div>
      )}

      {animated && state === 'thinking' && (
        <span className="absolute -right-1 -top-1 flex items-end gap-[1px]" aria-hidden>
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="pa-dot size-[3px] rounded-full bg-primary"
              style={{ animationDelay: `${i * 0.18}s` }}
            />
          ))}
        </span>
      )}
      {animated && state === 'done' && (
        <Sparkles className="pa-star absolute -right-1 -top-1 size-3 text-amber-400" aria-hidden />
      )}
      {animated && state === 'error' && (
        <Zap className="pa-bolt absolute -right-1 -top-1 size-3 text-destructive" aria-hidden />
      )}
    </div>
  )
})

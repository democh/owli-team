/**
 * M26：最左侧常驻图标导航栏（44px，icon-only + tooltip）。
 * 工作台 / Agent 管理 / Skill 管理 / MCP 管理 / 连接管理 / 设置（M36：设置升级为主区视图，pin 底部）。
 * 控件台视图不卸载 AppLayout（WS 生命周期与运行状态保持），仅切换主区内容。
 */
import * as React from 'react'
import { Bot, Cable, MessagesSquare, Plug, Settings, Sparkles } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useUiStore, type AppView } from '../../stores/ui-store'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

interface RailItem {
  view: AppView
  label: string
  icon: React.ComponentType<{ className?: string }>
}

const ITEMS: RailItem[] = [
  { view: 'workspace', label: '工作台', icon: MessagesSquare },
  { view: 'agents', label: 'Agent 管理', icon: Bot },
  { view: 'skills', label: 'Skill 管理', icon: Sparkles },
  { view: 'mcp', label: 'MCP 管理', icon: Plug },
  { view: 'connections', label: '连接管理', icon: Cable },
]

function RailButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string
  active?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-current={active ? 'page' : undefined}
          onClick={onClick}
          className={cn(
            'flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors',
            active ? 'bg-primary/12 text-primary' : 'hover:bg-accent hover:text-accent-foreground',
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  )
}

export function ActivityRail(): React.JSX.Element {
  const appView = useUiStore((s) => s.appView)
  const setAppView = useUiStore((s) => s.setAppView)

  return (
    <nav aria-label="主导航" className="flex h-full w-11 shrink-0 flex-col items-center gap-1 border-r bg-card/60 py-2">
      {ITEMS.map(({ view, label, icon: Icon }) => (
        <RailButton key={view} label={label} active={appView === view} onClick={() => setAppView(view)}>
          <Icon className="size-4" />
        </RailButton>
      ))}
      <div className="mt-auto">
        <RailButton label="设置" active={appView === 'settings'} onClick={() => setAppView('settings')}>
          <Settings className="size-4" />
        </RailButton>
      </div>
    </nav>
  )
}

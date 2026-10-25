/**
 * M26：最左侧常驻图标导航栏（44px，icon-only + tooltip）。
 * 工作台 / 素材库（M68：全员可见的个人资源） / Agent 管理 / Skill 管理 / MCP 管理 / 连接管理 / 设置（M36：设置升级为主区视图，pin 底部）。
 * M57：管理面（Agent / Skill / MCP / 连接 / 用户）仅 admin 可见；成员 = 工作台 + 素材库 + 设置（个人偏好）。
 * 控件台视图不卸载 AppLayout（WS 生命周期与运行状态保持），仅切换主区内容。
 */
import * as React from 'react'
import { Bot, Cable, MessagesSquare, Plug, Settings, Sparkles, UserCog } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useAuthStore } from '../../stores/auth-store'
import { useUiStore, type AppView } from '../../stores/ui-store'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

interface RailItem {
  view: AppView
  label: string
  icon: React.ComponentType<{ className?: string }>
}

/** 管理面入口（M57：仅 admin 可见） */
const ADMIN_ITEMS: RailItem[] = [
  { view: 'agents', label: 'Agent 管理', icon: Bot },
  { view: 'skills', label: 'Skill 管理', icon: Sparkles },
  { view: 'mcp', label: 'MCP 管理', icon: Plug },
  { view: 'connections', label: '连接管理', icon: Cable },
  { view: 'users', label: '用户管理', icon: UserCog },
]

const ADMIN_VIEWS = new Set<AppView>(ADMIN_ITEMS.map((i) => i.view))

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
  const isAdmin = useAuthStore((s) => s.isAdmin)

  // M57：成员访问了管理面视图（历史 localStorage 等）→ 回退工作台
  React.useEffect(() => {
    if (!isAdmin && ADMIN_VIEWS.has(appView)) setAppView('workspace')
  }, [isAdmin, appView, setAppView])

  // M68：素材库为全员可见的个人资源（非管理面）；M57：成员仅工作台 + 素材库 + 设置
  // 临时隐藏：素材库入口已注释（后端 / 视图代码保留，恢复时取消注释即可）
  const items: RailItem[] = [
    { view: 'workspace', label: '工作台', icon: MessagesSquare },
    // { view: 'materials', label: '素材库', icon: Images },
    ...(isAdmin ? ADMIN_ITEMS : []),
  ]

  return (
    <nav aria-label="主导航" className="flex h-full w-11 shrink-0 flex-col items-center gap-1 border-r bg-card/60 py-2">
      {items.map(({ view, label, icon: Icon }) => (
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

/**
 * M57 P2：会话共享弹窗（共享面板）。
 *
 * 权限（服务端为准，此处仅做展示层 gating）：
 * - 属主：邀请成员（用户名 + 可协作 / 只读）、改角色、移出；
 * - 成员（editor / viewer）：查看成员列表 + 自助退出；
 * - 兼容模式（未启用多用户）：提示需先完成管理员设置。
 */
import * as React from 'react'
import { Crown, Loader2, LogOut, UserMinus, UserPlus, UserRound, Users } from 'lucide-react'
import type { SessionShareRole } from '@multi-agent/shared'
import { toast } from 'sonner'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { Input } from '../ui/input'
import { useAuthStore } from '../../stores/auth-store'
import { useSessionStore } from '../../stores/session-store'
import { useShareStore } from '../../stores/share-store'
import { cn } from '../../lib/utils'

const ROLE_LABEL: Record<SessionShareRole, string> = {
  editor: '可协作（读写）',
  viewer: '只读',
}

/** 邀请表单的角色说明（随分段控件联动，弱化文案） */
const ROLE_HINT: Record<SessionShareRole, string> = {
  editor: '可发送消息、停止与审批',
  viewer: '仅可查看消息与交付件',
}

/** 首字母头像（无头像体系）：昵称首字符 + 角色色底（属主琥珀 / 成员主色） */
function InitialAvatar({ name, owner }: { name: string; owner?: boolean }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-8 shrink-0 select-none items-center justify-center rounded-full text-[12.5px] font-semibold',
        owner ? 'bg-amber-500/12 text-amber-700' : 'bg-primary/10 text-primary',
      )}
    >
      {(name.trim().slice(0, 1) || '?').toUpperCase()}
    </span>
  )
}

export interface ShareDialogProps {
  sessionId?: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ShareDialog({ sessionId, open, onOpenChange }: ShareDialogProps): React.JSX.Element {
  const multiUser = useAuthStore((s) => s.status.multiUser)
  const me = useAuthStore((s) => s.user)
  const view = useShareStore((s) => s.view)
  const loading = useShareStore((s) => s.loading)
  const busy = useShareStore((s) => s.busy)
  const [username, setUsername] = React.useState('')
  const [role, setRole] = React.useState<SessionShareRole>('editor')

  // 打开时懒加载；关闭时释放绑定（下次打开重新拉取）
  React.useEffect(() => {
    if (open && sessionId && multiUser) void useShareStore.getState().load(sessionId)
    if (!open) useShareStore.getState().close()
  }, [open, sessionId, multiUser])

  const isOwner = !!me && !!view?.owner && view.owner.userId === me.id
  const isMember = !!me && !!view?.members.some((m) => m.userId === me.id)
  const myRole = view?.members.find((m) => m.userId === me?.id)?.role

  const invite = async (): Promise<void> => {
    const name = username.trim()
    if (!name || !sessionId) return
    try {
      await useShareStore.getState().invite(sessionId, name, role)
      setUsername('')
      toast.success(`已邀请「${name}」（${ROLE_LABEL[role]}）`)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const changeRole = async (userId: string, next: SessionShareRole): Promise<void> => {
    if (!sessionId) return
    try {
      await useShareStore.getState().setRole(sessionId, userId, next)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const removeMember = async (userId: string, name: string): Promise<void> => {
    if (!sessionId) return
    try {
      await useShareStore.getState().remove(sessionId, userId)
      toast.success(`已移出「${name}」`)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const leave = async (): Promise<void> => {
    if (!sessionId) return
    try {
      await useShareStore.getState().leave(sessionId)
      onOpenChange(false)
      toast.success('已退出该共享会话')
      const sessions = useSessionStore.getState()
      await sessions.loadSessions()
      // 退出后失去访问：当前会话仍停留则清空（列表已不含该会话）
      const after = useSessionStore.getState()
      if (after.currentId === sessionId && !after.sessions.some((s) => s.id === sessionId)) {
        void after.selectSession(undefined)
      }
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-[14px]">会话共享</DialogTitle>
          {multiUser && (
            <DialogDescription className="text-[12px]">
              把本会话共享给团队成员：可协作（读写）或只读（仅查看）。
            </DialogDescription>
          )}
        </DialogHeader>
        {!multiUser ? (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-dashed bg-muted/20 px-3 py-2.5 text-[12.5px] leading-5 text-muted-foreground">
            <UserRound className="mt-0.5 size-4 shrink-0" />
            <span>
              当前为单用户模式（未启用账号体系）：共享需先在「账号 → 创建管理员并启用多用户」完成初始化。
            </span>
          </div>
        ) : (
          <div className="mt-3 space-y-3">
            {loading && !view ? (
              <div className="flex flex-col items-center gap-2 py-8 text-[12.5px] text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                加载共享信息…
              </div>
            ) : view ? (
              <>
                <div className="flex items-center gap-2.5 rounded-xl border px-3 py-2.5">
                  <InitialAvatar name={view.owner?.displayName ?? '?'} owner />
                  <div className="flex min-w-0 flex-1 items-center gap-1.5">
                    <span className="truncate text-[13px] font-medium">
                      {view.owner?.displayName ?? '（未知）'}
                    </span>
                    <span className="shrink-0 text-[11.5px] text-muted-foreground">
                      @{view.owner?.username ?? '-'}
                    </span>
                    {view.owner?.userId === me?.id && (
                      <Badge className="h-4 shrink-0 px-1 text-[10px]">我</Badge>
                    )}
                  </div>
                  <span className="flex shrink-0 items-center gap-1 rounded-full bg-amber-500/12 px-2 py-0.5 text-[10.5px] font-medium text-amber-700">
                    <Crown className="size-3" />
                    属主
                  </span>
                </div>

                <div>
                  <div className="mb-1.5 flex items-center gap-1.5 px-0.5">
                    <span className="text-[12px] font-medium text-muted-foreground">共享成员</span>
                    <span className="rounded-full bg-muted px-1.5 text-[10.5px] leading-4 text-muted-foreground">
                      {view.members.length}
                    </span>
                  </div>
                  {view.members.length === 0 ? (
                    <div className="flex flex-col items-center gap-1.5 rounded-xl border border-dashed px-3 py-5 text-center">
                      <Users className="size-5 text-muted-foreground/50" />
                      <p className="text-[12px] text-muted-foreground">
                        还没有共享成员{isOwner ? '：在下方按用户名邀请' : ''}
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {view.members.map((m) => (
                        <div key={m.userId} className="flex items-center gap-2.5 rounded-xl border px-3 py-2">
                          <InitialAvatar name={m.displayName} />
                          <div className="flex min-w-0 flex-1 items-center gap-1.5">
                            <span className="truncate text-[13px] font-medium">{m.displayName}</span>
                            <span className="shrink-0 text-[11.5px] text-muted-foreground">
                              @{m.username}
                            </span>
                            {m.userId === me?.id && (
                              <Badge className="h-4 shrink-0 px-1 text-[10px]">我</Badge>
                            )}
                          </div>
                          <Badge
                            variant={m.role === 'editor' ? 'default' : 'secondary'}
                            className="h-5 shrink-0 px-1.5 text-[10.5px]"
                          >
                            {m.role === 'editor' ? '可协作' : '只读'}
                          </Badge>
                          {isOwner && (
                            <>
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-6 shrink-0 px-2 text-[11px]"
                                disabled={busy}
                                onClick={() =>
                                  void changeRole(m.userId, m.role === 'editor' ? 'viewer' : 'editor')
                                }
                              >
                                {m.role === 'editor' ? '改为只读' : '改为可协作'}
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                className="shrink-0"
                                title="移出共享"
                                disabled={busy}
                                onClick={() => void removeMember(m.userId, m.displayName)}
                              >
                                <UserMinus className="size-3.5 text-destructive" />
                              </Button>
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {isOwner ? (
                  <div className="rounded-xl border bg-muted/20 p-3">
                    <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground">
                      <UserPlus className="size-3.5" />
                      邀请成员（按用户名）
                    </div>
                    <div className="flex items-center gap-2">
                      <Input
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        placeholder="用户名（由管理员在「用户管理」创建）"
                        className="h-8 flex-1 text-[12.5px]"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void invite()
                        }}
                      />
                      <Button
                        size="sm"
                        className="h-8 shrink-0"
                        disabled={busy || !username.trim()}
                        onClick={() => void invite()}
                      >
                        邀请
                      </Button>
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <span className="shrink-0 text-[11px] text-muted-foreground">权限</span>
                      <span className="flex shrink-0 overflow-hidden rounded-full border bg-card p-0.5">
                        {(['editor', 'viewer'] as const).map((r) => (
                          <button
                            key={r}
                            type="button"
                            onClick={() => setRole(r)}
                            className={cn(
                              'rounded-full px-2.5 py-0.5 text-[10.5px] font-medium transition-colors',
                              role === r
                                ? 'bg-primary text-primary-foreground shadow-sm'
                                : 'text-muted-foreground hover:text-foreground',
                            )}
                          >
                            {r === 'editor' ? '可协作' : '只读'}
                          </button>
                        ))}
                      </span>
                      <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                        {ROLE_HINT[role]}
                      </span>
                    </div>
                    <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
                      成员可自助退出；属主不能退出（如需收回会话请删除会话）。
                    </p>
                  </div>
                ) : isMember ? (
                  <div className="flex items-center justify-between gap-2 rounded-xl border bg-muted/20 px-3 py-2.5">
                    <span className="min-w-0 truncate text-[12px] text-muted-foreground">
                      你以「{ROLE_LABEL[myRole ?? 'viewer']}」参与本会话
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 shrink-0 text-[12px]"
                      disabled={busy}
                      onClick={() => void leave()}
                    >
                      <LogOut className="size-3.5" />
                      退出共享
                    </Button>
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

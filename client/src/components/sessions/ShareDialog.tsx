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
import type { Session, SessionShareRole, UserAvatar } from '@multi-agent/shared'
import { toast } from 'sonner'
import { apiPatch } from '../../lib/api'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { Input } from '../ui/input'
import { useAuthStore } from '../../stores/auth-store'
import { useSessionStore } from '../../stores/session-store'
import { useShareStore } from '../../stores/share-store'
import { useFriendsStore } from '../../stores/friends-store'
import { cn } from '../../lib/utils'
import { HumanAvatar } from '../chat/HumanAvatar'

const ROLE_LABEL: Record<SessionShareRole, string> = {
  editor: '可协作（读写）',
  viewer: '只读',
}

/** 邀请表单的角色说明（随分段控件联动，弱化文案） */
const ROLE_HINT: Record<SessionShareRole, string> = {
  editor: '可发送消息、停止与审批',
  viewer: '仅可查看消息与交付件',
}

/** 首字母头像（无画像时回退）：昵称首字符 + 角色色底（属主琥珀 / 成员主色）；M79-B：有画像时优先色块 / emoji */
function InitialAvatar({ name, owner, avatar }: { name: string; owner?: boolean; avatar?: UserAvatar }): React.JSX.Element {
  if (avatar) return <HumanAvatar avatar={avatar} name={name} size={32} />
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
  const friends = useFriendsStore((s) => s.friends)
  // M79-R：好友多选批量邀请（与聊天成员弹窗一致）+ 移出二次确认
  const [selectedFriends, setSelectedFriends] = React.useState<string[]>([])
  const [batchBusy, setBatchBusy] = React.useState(false)
  const [confirmingRemove, setConfirmingRemove] = React.useState<string | null>(null)

  // 打开时懒加载；关闭时释放绑定（下次打开重新拉取）；M79-N：同时拉好友（快捷邀请）
  React.useEffect(() => {
    if (open && sessionId && multiUser) {
      void useShareStore.getState().load(sessionId)
      void useFriendsStore.getState().load()
    }
    if (!open) {
      useShareStore.getState().close()
      setSelectedFriends([])
      setConfirmingRemove(null)
    }
  }, [open, sessionId, multiUser])

  // M79-N：好友快捷邀请（好友 − 属主 − 已在场成员；点选即邀 editor）——「只输用户名」之外的第二条路径
  const invitableFriends = React.useMemo(() => {
    if (!view) return []
    const inRoom = new Set<string>([...view.members.map((m) => m.userId), ...(view.owner ? [view.owner.userId] : [])])
    return friends.filter((f) => f.userId !== me?.id && !inRoom.has(f.userId))
  }, [friends, view, me?.id])

  const isOwner = !!me && !!view?.owner && view.owner.userId === me.id
  const isMember = !!me && !!view?.members.some((m) => m.userId === me.id)
  const myRole = view?.members.find((m) => m.userId === me?.id)?.role

  /** 邀请核心（用户名输入与好友点选共用）；name 空 = 读当前输入 */
  const inviteBy = async (explicit?: string): Promise<void> => {
    const name = (explicit ?? username).trim()
    if (!name || !sessionId || busy) return
    try {
      await useShareStore.getState().invite(sessionId, name, role)
      if (!explicit) setUsername('')
      toast.success(`已邀请「${name}」（${ROLE_LABEL[role]}）`)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }
  const invite = (): Promise<void> => inviteBy()

  const toggleFriend = (userId: string): void =>
    setSelectedFriends((prev) => (prev.includes(userId) ? prev.filter((x) => x !== userId) : [...prev, userId]))

  /** M79-R：好友多选批量邀请（与聊天成员弹窗同交互；失败汇总提示） */
  const inviteSelectedFriends = async (): Promise<void> => {
    if (!sessionId || selectedFriends.length === 0 || busy || batchBusy) return
    const picked = friends.filter((f) => selectedFriends.includes(f.userId))
    setBatchBusy(true)
    try {
      const results = await Promise.allSettled(
        picked.map((f) => useShareStore.getState().invite(sessionId, f.username, role)),
      )
      const okCount = results.filter((r) => r.status === 'fulfilled').length
      const failed = picked.filter((_, i) => results[i]!.status === 'rejected').map((f) => f.displayName)
      if (okCount > 0) toast.success(`已邀请 ${okCount} 位（${ROLE_LABEL[role]}）`)
      if (failed.length > 0) toast.error(`邀请失败：${failed.join('、')}`)
      setSelectedFriends([])
    } finally {
      setBatchBusy(false)
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
      setConfirmingRemove(null)
      toast.success(`已移出「${name}」`)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  // M79-F：多人协作静默引导——team 会话已有共享成员且仍为「自动应答」时，一键切「仅点名唤起」
  const session = useSessionStore((s) => s.sessions.find((x) => x.id === sessionId))
  const enableMentionOnly = async (): Promise<void> => {
    if (!sessionId) return
    try {
      const res = await apiPatch<{ session: Session }>(`/api/sessions/${sessionId}`, { routeMode: 'mention' })
      useSessionStore.getState().applySession(res.session)
      toast.success('已切换为仅点名唤起（未 @ 成员的消息不再交给 AI）')
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
                  <InitialAvatar name={view.owner?.displayName ?? '?'} owner avatar={view.owner?.avatar} />
                  <div className="flex min-w-0 flex-1 items-center gap-1.5">
                    <span className="truncate text-[13px] font-medium">
                      {view.owner?.displayName ?? '（未知）'}
                    </span>
                    {view.owner?.headline && (
                      <span className="shrink-0 rounded-full bg-muted px-1.5 text-[10.5px] leading-4 text-muted-foreground">
                        {view.owner.headline}
                      </span>
                    )}
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
                          <InitialAvatar name={m.displayName} avatar={m.avatar} />
                          <div className="flex min-w-0 flex-1 items-center gap-1.5">
                            <span className="truncate text-[13px] font-medium">{m.displayName}</span>
                            {m.headline && (
                              <span className="shrink-0 rounded-full bg-muted px-1.5 text-[10.5px] leading-4 text-muted-foreground">
                                {m.headline}
                              </span>
                            )}
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
                          {isOwner &&
                            (confirmingRemove === m.userId ? (
                              <span className="flex shrink-0 items-center gap-1">
                                <Button
                                  variant="destructive"
                                  size="sm"
                                  className="h-6 px-2 text-[11px]"
                                  disabled={busy}
                                  onClick={() => void removeMember(m.userId, m.displayName)}
                                >
                                  确认移出
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-6 px-1.5 text-[11px]"
                                  onClick={() => setConfirmingRemove(null)}
                                >
                                  取消
                                </Button>
                              </span>
                            ) : (
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
                                  onClick={() => setConfirmingRemove(m.userId)}
                                >
                                  <UserMinus className="size-3.5 text-destructive" />
                                </Button>
                              </>
                            ))}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {isOwner ? (
                  <div className="rounded-xl border bg-muted/20 p-3">
                    {/* M79-F：多人协作引导——已有共享成员且 team 会话仍为「自动应答」时，建议切换静默模式 */}
                    {view.members.length >= 1 &&
                      session &&
                      session.kind !== 'direct' &&
                      session.kind !== 'group' &&
                      (session.routeMode ?? 'auto') !== 'mention' && (
                        <div className="mb-2 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2 py-1.5">
                          <p className="min-w-0 flex-1 text-[11.5px] leading-4 text-amber-800">
                            多人协作建议开启「仅点名唤起」：未 @ 成员的消息不再交给 AI 回应。
                          </p>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 shrink-0 border-amber-500/40 px-2 text-[11px] text-amber-800"
                            disabled={busy}
                            onClick={() => void enableMentionOnly()}
                          >
                            开启
                          </Button>
                        </div>
                      )}
                    {/* M79-N：从好友选择（一键邀请，免输用户名） */}
                    {invitableFriends.length > 0 && (
                      <div className="mb-2">
                        <div className="mb-1 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                          <Users className="size-3.5" />
                          从好友选择
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {invitableFriends.map((f) => {
                            const active = selectedFriends.includes(f.userId)
                            return (
                              <button
                                key={f.userId}
                                type="button"
                                disabled={busy || batchBusy}
                                aria-pressed={active}
                                title={active ? `取消选择 ${f.displayName}` : `选择 ${f.displayName}（${ROLE_LABEL[role]}）`}
                                className={cn(
                                  'flex items-center gap-1 rounded-full border py-0.5 pl-0.5 pr-2 text-[11.5px] transition-all disabled:opacity-50',
                                  active
                                    ? 'border-primary/40 bg-primary/[0.08] text-primary'
                                    : 'border-transparent bg-muted/70 text-muted-foreground hover:border-primary/25 hover:bg-primary/5 hover:text-primary',
                                )}
                                onClick={() => toggleFriend(f.userId)}
                              >
                                <HumanAvatar avatar={f.avatar} name={f.displayName} size={16} />
                                <span className="max-w-28 truncate">{f.displayName}</span>
                              </button>
                            )
                          })}
                        </div>
                        {selectedFriends.length > 0 && (
                          <div className="mt-1.5 flex justify-end">
                            <Button
                              size="sm"
                              className="h-7 text-[12px]"
                              disabled={busy || batchBusy}
                              onClick={() => void inviteSelectedFriends()}
                            >
                              {batchBusy && <Loader2 className="mr-1 size-3.5 animate-spin" />}
                              邀请（{selectedFriends.length} 人）
                            </Button>
                          </div>
                        )}
                      </div>
                    )}
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

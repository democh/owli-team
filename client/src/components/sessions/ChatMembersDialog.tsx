/**
 * M79-F：群 / 私聊成员弹窗（设计 §14.4）。
 *
 * - direct：只读成员名单（双方 + 属主徽章）；
 * - group：成员名单 + 群主移出（二次确认）+ 「邀请好友」选择器（任何成员可邀自己的好友；role 恒 editor）；
 * - group 生命周期（M79-AA 群管理补全）：成员「退出群聊」（自助 /leave）/ 群主「解散群聊」（删除会话）；
 * - 数据：share-store（GET /shares 懒加载）；候选：friends-store（排除已在场成员与本人）。
 */
import * as React from 'react'
import { Check, Crown, Loader2, LogOut, Trash2, UserMinus, UserPlus } from 'lucide-react'
import { toast } from 'sonner'
import type { Session } from '@multi-agent/shared'
import { useAuthStore } from '../../stores/auth-store'
import { useFriendsStore } from '../../stores/friends-store'
import { useSessionStore } from '../../stores/session-store'
import { useShareStore } from '../../stores/share-store'
import { useWsStore } from '../../stores/ws-store'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { HumanAvatar } from '../chat/HumanAvatar'
import { OnlineDot } from '../chat/OnlineDot'
import { cn } from '../../lib/utils'

export interface ChatMembersDialogProps {
  /** 当前聊天会话（direct / group；undefined = 未选中不渲染内容） */
  session?: Session
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ChatMembersDialog({ session, open, onOpenChange }: ChatMembersDialogProps): React.JSX.Element {
  const view = useShareStore((s) => s.view)
  const loading = useShareStore((s) => s.loading)
  const busy = useShareStore((s) => s.busy)
  const friends = useFriendsStore((s) => s.friends)
  const me = useAuthStore((s) => s.user)
  // M79-G：同会话成员在线点（可见域 = 好友 ∪ 同会话成员）
  const presenceMap = useWsStore((s) => s.presenceMap)
  const isGroup = session?.kind === 'group'
  const isOwner = !!me && !!view?.owner && view.owner.userId === me.id
  const amMember = !!me && !!view?.members.some((m) => m.userId === me.id)
  const [selected, setSelected] = React.useState<string[]>([])
  const [confirming, setConfirming] = React.useState<string | null>(null)
  /** M79-AA 群管理补全：退出（成员）/ 解散（群主）行内二次确认 + 解散请求 busy */
  const [confirmingLeave, setConfirmingLeave] = React.useState(false)
  const [confirmingDisband, setConfirmingDisband] = React.useState(false)
  const [disbandBusy, setDisbandBusy] = React.useState(false)

  // 打开懒加载；关闭清理绑定与本地选择态
  // 依赖会话 id（而非 session 对象）：成员面板不因会话对象引用变化而重复拉取
  const sessionId = session?.id
  React.useEffect(() => {
    if (open && sessionId) {
      void useShareStore.getState().load(sessionId)
      void useFriendsStore.getState().load()
    }
    if (!open) {
      useShareStore.getState().close()
      setSelected([])
      setConfirming(null)
      setConfirmingLeave(false)
      setConfirmingDisband(false)
      setDisbandBusy(false)
    }
  }, [open, sessionId])

  // 好友候选（排除已成组成员与本人）
  const memberIds = new Set<string>([
    ...(view ? view.members.map((m) => m.userId) : []),
    ...(view?.owner ? [view.owner.userId] : []),
  ])
  const candidates = friends.filter((f) => !memberIds.has(f.userId) && f.userId !== me?.id)

  const toggle = (userId: string): void =>
    setSelected((prev) => (prev.includes(userId) ? prev.filter((x) => x !== userId) : [...prev, userId]))

  const inviteSelected = async (): Promise<void> => {
    if (!session || selected.length === 0 || busy) return
    try {
      for (const userId of selected) {
        const username = candidates.find((c) => c.userId === userId)?.username
        if (!username) continue
        await useShareStore.getState().invite(session.id, username, 'editor')
      }
      toast.success(`已邀请 ${selected.length} 位好友`)
      setSelected([])
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const removeMember = async (userId: string, name: string): Promise<void> => {
    if (!session || busy) return
    try {
      await useShareStore.getState().remove(session.id, userId)
      setConfirming(null)
      toast.success(`已移出「${name}」`)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  /** M79-AA 群管理补全：成员自助退出群聊（复用 /leave；退出后失去访问 → 列表对账 + 当前会话清空） */
  const leaveGroup = async (): Promise<void> => {
    if (!session || busy) return
    try {
      await useShareStore.getState().leave(session.id)
      onOpenChange(false)
      toast.success('已退出群聊', { id: `session-left-${session.id}` })
      await useSessionStore.getState().loadSessions()
      const after = useSessionStore.getState()
      if (after.currentId === session.id && !after.sessions.some((s) => s.id === session.id)) {
        void after.selectSession(undefined)
      }
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  /** M79-AA 群管理补全：群主解散群聊（删除会话——所有成员失去访问；toast 与 session-deleted 帧去重同 id） */
  const disbandGroup = async (): Promise<void> => {
    if (!session || disbandBusy) return
    setDisbandBusy(true)
    try {
      await useSessionStore.getState().removeSession(session.id)
      setConfirmingDisband(false)
      onOpenChange(false)
      toast.success('群聊已解散', { id: `session-deleted-${session.id}` })
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setDisbandBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-[14px]">{isGroup ? '群成员' : '会话成员'}</DialogTitle>
          <DialogDescription className="text-[12px]">
            {isGroup ? '成员可邀请自己的好友加入；群主可移出成员。' : '私聊会话的两位成员。'}
          </DialogDescription>
        </DialogHeader>
        <div className="mt-1 space-y-3">
          {loading && !view ? (
            <div className="flex items-center justify-center gap-2 py-6 text-[12px] text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              加载中…
            </div>
          ) : view ? (
            <>
              {/* 成员名单（行式布局：头像 + 昵称与账号 + 角色徽章） */}
              <div className="space-y-1.5">
                {view.owner && (
                  <div className="flex items-center gap-2.5 rounded-xl border px-3 py-2.5">
                    <HumanAvatar avatar={view.owner.avatar} name={view.owner.displayName} size={32} />
                    <div className="flex min-w-0 flex-1 items-center gap-1.5">
                      <OnlineDot online={presenceMap[view.owner.userId]} />
                      <span className="truncate text-[13px] font-medium">{view.owner.displayName}</span>
                      {view.owner.headline && (
                        <span className="shrink-0 rounded-full bg-muted px-1.5 text-[10.5px] leading-4 text-muted-foreground">
                          {view.owner.headline}
                        </span>
                      )}
                      <span className="shrink-0 text-[11.5px] text-muted-foreground">@{view.owner.username}</span>
                      {view.owner.userId === me?.id && <Badge className="h-4 shrink-0 px-1 text-[10px]">我</Badge>}
                    </div>
                    <span className="flex shrink-0 items-center gap-1 rounded-full bg-amber-500/12 px-2 py-0.5 text-[10.5px] font-medium text-amber-700">
                      <Crown className="size-3" />
                      {isGroup ? '群主' : '发起人'}
                    </span>
                  </div>
                )}
                {view.members.map((m) => (
                  <div key={m.userId} className="flex items-center gap-2.5 rounded-xl border px-3 py-2.5">
                    <HumanAvatar avatar={m.avatar} name={m.displayName} size={32} />
                    <div className="flex min-w-0 flex-1 items-center gap-1.5">
                      <OnlineDot online={presenceMap[m.userId]} />
                      <span className="truncate text-[13px] font-medium">{m.displayName}</span>
                      {m.headline && (
                        <span className="shrink-0 rounded-full bg-muted px-1.5 text-[10.5px] leading-4 text-muted-foreground">
                          {m.headline}
                        </span>
                      )}
                      <span className="shrink-0 text-[11.5px] text-muted-foreground">@{m.username}</span>
                      {m.userId === me?.id && <Badge className="h-4 shrink-0 px-1 text-[10px]">我</Badge>}
                    </div>
                    {isGroup && isOwner && m.userId !== me?.id ? (
                      confirming === m.userId ? (
                        <span className="flex shrink-0 items-center gap-1">
                          <Button
                            size="sm"
                            variant="destructive"
                            className="h-6 px-2 text-[11.5px]"
                            disabled={busy}
                            onClick={() => void removeMember(m.userId, m.displayName)}
                          >
                            确认移出
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 px-1.5 text-[11.5px]"
                            onClick={() => setConfirming(null)}
                          >
                            取消
                          </Button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-background hover:text-destructive"
                          title="移出成员"
                          onClick={() => setConfirming(m.userId)}
                        >
                          <UserMinus className="size-3.5" />
                        </button>
                      )
                    ) : null}
                  </div>
                ))}
                {view.members.length === 0 && !isGroup && (
                  <p className="px-1 text-[11.5px] text-muted-foreground">对方账号已删除（历史保留）。</p>
                )}
              </div>

              {/* 邀请好友（仅群聊；任何成员可邀请自己的好友） */}
              {isGroup && (
                <div className="rounded-xl border border-dashed p-2">
                  <div className="mb-1.5 flex items-center gap-1.5 px-0.5">
                    <UserPlus className="size-3.5 text-muted-foreground" />
                    <span className="text-[12px] font-medium text-muted-foreground">邀请好友</span>
                  </div>
                  {candidates.length === 0 ? (
                    <p className="px-1 py-1.5 text-[11.5px] text-muted-foreground">好友都已在群里（或还没有好友）</p>
                  ) : (
                    <div className="max-h-40 space-y-1 overflow-y-auto">
                      {candidates.map((friend) => {
                        const active = selected.includes(friend.userId)
                        return (
                          <button
                            key={friend.userId}
                            type="button"
                            className={cn(
                              'flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition-colors',
                              active ? 'border-primary/40 bg-primary/[0.06]' : 'border-transparent hover:bg-accent/60',
                            )}
                            onClick={() => toggle(friend.userId)}
                          >
                            <HumanAvatar avatar={friend.avatar} name={friend.displayName} size={24} />
                            <span className="min-w-0 flex-1 truncate text-[12.5px]">{friend.displayName}</span>
                            {friend.headline && (
                              <span className="shrink-0 rounded-full bg-muted px-1.5 text-[10.5px] leading-4 text-muted-foreground">
                                {friend.headline}
                              </span>
                            )}
                            {active && <Check className="size-3.5 shrink-0 text-primary" />}
                          </button>
                        )
                      })}
                    </div>
                  )}
                  {candidates.length > 0 && (
                    <div className="mt-2 flex justify-end">
                      <Button size="sm" disabled={selected.length === 0 || busy} onClick={() => void inviteSelected()}>
                        {busy && <Loader2 className="mr-1 size-3.5 animate-spin" />}
                        邀请（{selected.length} 人）
                      </Button>
                    </div>
                  )}
                </div>
              )}

              {/* M79-AA 群管理补全：群生命周期——群主「解散群聊」（删除会话）/ 成员「退出群聊」（自助 leave） */}
              {isGroup && (isOwner || amMember) && (
                <div className="flex items-center justify-between gap-2 rounded-xl border bg-muted/20 px-3 py-2">
                  {isOwner ? (
                    confirmingDisband ? (
                      <>
                        <span className="min-w-0 flex-1 text-[11.5px] leading-4 text-muted-foreground">
                          解散后所有成员将失去访问，不可恢复
                        </span>
                        <span className="flex shrink-0 items-center gap-1">
                          <Button
                            variant="destructive"
                            size="sm"
                            className="h-6 px-2 text-[11.5px]"
                            disabled={disbandBusy}
                            onClick={() => void disbandGroup()}
                          >
                            {disbandBusy && <Loader2 className="mr-1 size-3 animate-spin" />}
                            确认解散
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-1.5 text-[11.5px]"
                            onClick={() => setConfirmingDisband(false)}
                          >
                            取消
                          </Button>
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="min-w-0 flex-1 text-[11.5px] leading-4 text-muted-foreground">
                          解散后所有成员将失去访问，不可恢复
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 shrink-0 border-destructive/40 text-[12px] text-destructive hover:bg-destructive/[0.04] hover:text-destructive"
                          disabled={busy}
                          onClick={() => setConfirmingDisband(true)}
                        >
                          <Trash2 className="size-3.5" />
                          解散群聊
                        </Button>
                      </>
                    )
                  ) : confirmingLeave ? (
                    <>
                      <span className="min-w-0 flex-1 text-[11.5px] leading-4 text-muted-foreground">
                        退出后不再接收该群消息（可被重新邀请）
                      </span>
                      <span className="flex shrink-0 items-center gap-1">
                        <Button
                          variant="destructive"
                          size="sm"
                          className="h-6 px-2 text-[11.5px]"
                          disabled={busy}
                          onClick={() => void leaveGroup()}
                        >
                          确认退出
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-1.5 text-[11.5px]"
                          onClick={() => setConfirmingLeave(false)}
                        >
                          取消
                        </Button>
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="min-w-0 flex-1 text-[11.5px] leading-4 text-muted-foreground">
                        退出后不再接收该群消息（可被重新邀请）
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 shrink-0 text-[12px]"
                        disabled={busy}
                        onClick={() => setConfirmingLeave(true)}
                      >
                        <LogOut className="size-3.5" />
                        退出群聊
                      </Button>
                    </>
                  )}
                </div>
              )}
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

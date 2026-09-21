/**
 * M79-D：新建群聊对话框（群名 + 好友多选；设计 §14.3）。
 *
 * 提交 POST /chats/group { title?, memberIds }（成员须为创建人好友——服务端复核）；
 * 成功后关闭并由调用方切换会话。
 */
import * as React from 'react'
import { Check, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { apiPost } from '../../lib/api'
import { useFriendsStore } from '../../stores/friends-store'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { Input } from '../ui/input'
import { HumanAvatar } from '../chat/HumanAvatar'
import { cn } from '../../lib/utils'

export interface CreateGroupDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (sessionId: string) => void
}

export function CreateGroupDialog({ open, onOpenChange, onCreated }: CreateGroupDialogProps): React.JSX.Element {
  const friends = useFriendsStore((s) => s.friends)
  const [title, setTitle] = React.useState('')
  const [selected, setSelected] = React.useState<string[]>([])
  const [busy, setBusy] = React.useState(false)

  // 关闭即重置（下次打开为干净状态）
  React.useEffect(() => {
    if (!open) {
      setTitle('')
      setSelected([])
      setBusy(false)
    }
  }, [open])

  const toggle = (userId: string): void =>
    setSelected((prev) => (prev.includes(userId) ? prev.filter((x) => x !== userId) : [...prev, userId]))

  const submit = async (): Promise<void> => {
    if (selected.length === 0 || busy) return
    setBusy(true)
    try {
      const res = await apiPost<{ session: { id: string } }>('/api/chats/group', {
        ...(title.trim() ? { title: title.trim() } : {}),
        memberIds: selected,
      })
      toast.success('群聊已创建')
      onOpenChange(false)
      onCreated(res.session.id)
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-[14px]">新建群聊</DialogTitle>
          <DialogDescription className="text-[12px]">
            选择好友创建群聊；创建后可继续邀请成员，或拉 Agent 进群组成混编协作。
          </DialogDescription>
        </DialogHeader>
        <div className="mt-1 space-y-3">
          <Input
            value={title}
            maxLength={60}
            placeholder="群聊名称（留空 = 自动命名）"
            onChange={(e) => setTitle(e.target.value)}
          />
          <div className="max-h-64 space-y-1 overflow-y-auto">
            {friends.length === 0 ? (
              <p className="px-1 py-4 text-center text-[12px] text-muted-foreground">还没有好友：先在联系人面板添加</p>
            ) : (
              friends.map((friend) => {
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
                    <HumanAvatar avatar={friend.avatar} name={friend.displayName} size={26} />
                    <span className="min-w-0 flex-1 truncate text-[12.5px]">{friend.displayName}</span>
                    {friend.headline && (
                      <span className="shrink-0 rounded-full bg-muted px-1.5 text-[10.5px] leading-4 text-muted-foreground">
                        {friend.headline}
                      </span>
                    )}
                    {active && <Check className="size-3.5 shrink-0 text-primary" />}
                  </button>
                )
              })
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button disabled={selected.length === 0 || busy} onClick={() => void submit()}>
              {busy && <Loader2 className="mr-1 size-3.5 animate-spin" />}
              创建（{selected.length} 人）
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

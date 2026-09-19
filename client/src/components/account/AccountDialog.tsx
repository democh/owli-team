/**
 * M57：账号弹窗（HeaderBar 用户入口）——当前身份 / 修改密码 / 用户管理（admin）/ 退出登录。
 * 兼容模式（合成管理员）仅展示身份说明与无操作提示；改密成功后整页 reload（auth-store）。
 */
import * as React from 'react'
import { Loader2, LogOut, ShieldCheck, UserCog, UserRound } from 'lucide-react'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog'
import { Input } from '../ui/input'
import { Separator } from '../ui/separator'
import { useAuthStore } from '../../stores/auth-store'
import { useUiStore } from '../../stores/ui-store'
export function AccountDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const user = useAuthStore((s) => s.user)
  const isAdmin = useAuthStore((s) => s.isAdmin)
  const changePassword = useAuthStore((s) => s.changePassword)
  const logout = useAuthStore((s) => s.logout)
  const [current, setCurrent] = React.useState('')
  const [next, setNext] = React.useState('')
  const [confirm, setConfirm] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // 打开时重置表单
  React.useEffect(() => {
    if (open) {
      setCurrent('')
      setNext('')
      setConfirm('')
      setError(null)
      setBusy(false)
    }
  }, [open])

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setError(null)
    if (next !== confirm) {
      setError('两次输入的新密码不一致')
      return
    }
    setBusy(true)
    try {
      await changePassword(current, next)
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  const legacy = Boolean(user?.legacy)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogTitle className="flex items-center gap-2 text-[14px]">
          <UserRound className="size-4 text-primary" />
          账号
        </DialogTitle>

        <div className="mt-1 space-y-1 rounded-md border bg-muted/30 px-3 py-2 text-[12px]">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">{user?.displayName ?? '—'}</span>
            <span className="rounded-full border border-border px-2 py-0.5 text-[10.5px] text-muted-foreground">
              {legacy ? '单用户兼容模式' : isAdmin ? '管理员' : '成员'}
            </span>
          </div>
          <div className="text-[11px] text-muted-foreground">
            {legacy ? '尚未启用账号体系：完成首启初始化后（POST /api/auth/setup）进入多用户模式' : `用户名：${user?.username ?? ''}`}
          </div>
        </div>

        {!legacy && (
          <>
            <Separator className="my-2" />
            <form className="space-y-2.5" onSubmit={(e) => void submit(e)}>
              <div className="flex items-center gap-1.5 text-[12px] font-medium">
                <ShieldCheck className="size-3.5 text-muted-foreground" />
                修改密码
              </div>
              <Input
                type="password"
                placeholder="当前密码"
                autoComplete="current-password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
              />
              <Input
                type="password"
                placeholder="新密码（至少 10 位，含两类字符）"
                autoComplete="new-password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
              />
              <Input
                type="password"
                placeholder="确认新密码"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
              {error && (
                <p role="alert" className="text-[11.5px] text-destructive">
                  {error}
                </p>
              )}
              <Button type="submit" size="sm" className="w-full" disabled={busy || !current || !next}>
                {busy && <Loader2 className="mr-1 size-3.5 animate-spin" />}
                更新密码（其它设备将退出登录）
              </Button>
            </form>
          </>
        )}

        <Separator className="my-2" />
        <div className="flex items-center justify-between gap-2">
          {legacy ? (
            <Button
              size="sm"
              variant="default"
              title="创建首个管理员并启用多用户（存量数据将归其名下）"
              onClick={() => {
                useAuthStore.getState().openSetup()
                onOpenChange(false)
              }}
            >
              <ShieldCheck className="mr-1 size-3.5" />
              创建管理员并启用多用户
            </Button>
          ) : isAdmin ? (
            <Button
              size="sm"
              variant="outline"
              title="打开用户管理（邀请 / 禁用 / 重置密码）"
              onClick={() => {
                useUiStore.getState().setAppView('users')
                onOpenChange(false)
              }}
            >
              <UserCog className="mr-1 size-3.5" />
              用户管理
            </Button>
          ) : (
            <span />
          )}
          <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => void logout()}>
            <LogOut className="mr-1 size-3.5" />
            退出登录
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

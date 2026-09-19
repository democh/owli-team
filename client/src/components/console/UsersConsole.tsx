/**
 * M57：用户管理（admin）——邀请制建号 / 角色与状态调整 / 重置密码 / 删除。
 * - 列表：显示名（用户名）/ 角色 / 状态 / 首登改密标记 / 最近登录 / 操作；
 * - 初始密码仅创建 / 重置时返回一次（弹窗展示，可复制；用户首登强制改密）；
 * - 自我保护：本人不可禁用 / 改角色 / 删除（服务端同样护栏）；最后一个管理员由服务端护栏兜底。
 */
import * as React from 'react'
import { Check, Copy, Gauge, KeyRound, Loader2, Plus, ShieldCheck, Trash2, UserCheck, UserX, Users } from 'lucide-react'
import { toast } from 'sonner'
import { ApiError, apiDelete, apiGet, apiPatch, apiPost } from '../../lib/api'
import type { UserInfo } from '@multi-agent/shared'
import { useAuthStore } from '../../stores/auth-store'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { Input } from '../ui/input'
import { FieldRow, TextInput } from './fields'
import { QuotaDialog } from './QuotaDialog'

interface UsersResponse {
  users: UserInfo[]
}

/** 初始密码展示弹窗（仅一次） */
function InitialPasswordDialog({
  open,
  onOpenChange,
  username,
  initialPassword,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  username: string
  initialPassword: string
}): React.JSX.Element {
  const [copied, setCopied] = React.useState(false)
  React.useEffect(() => {
    if (open) setCopied(false)
  }, [open])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-[14px]">初始密码（仅显示一次）</DialogTitle>
          <DialogDescription className="text-[12px]">
            用户「{username}」的初始密码如下；首次登录时将被要求修改密码。
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
          <code className="min-w-0 flex-1 select-all break-all font-mono text-[13px]">{initialPassword}</code>
          <Button
            size="icon-sm"
            variant="ghost"
            title="复制"
            onClick={() => {
              void navigator.clipboard?.writeText(initialPassword).then(() => {
                setCopied(true)
                toast.success('已复制初始密码')
              })
            }}
          >
            {copied ? <Check className="size-3.5 text-emerald-600" /> : <Copy className="size-3.5" />}
          </Button>
        </div>
        <Button size="sm" onClick={() => onOpenChange(false)}>
          我已保存
        </Button>
      </DialogContent>
    </Dialog>
  )
}

export function UsersConsole(): React.JSX.Element {
  const me = useAuthStore((s) => s.user)
  const [users, setUsers] = React.useState<UserInfo[]>([])
  const [loading, setLoading] = React.useState(true)
  const [busyId, setBusyId] = React.useState<string>()
  // 创建弹窗
  const [createOpen, setCreateOpen] = React.useState(false)
  const [username, setUsername] = React.useState('')
  const [displayName, setDisplayName] = React.useState('')
  const [role, setRole] = React.useState<'member' | 'admin'>('member')
  const [password, setPassword] = React.useState('')
  const [creating, setCreating] = React.useState(false)
  // 初始密码弹窗
  const [reveal, setReveal] = React.useState<{ username: string; initialPassword: string }>()
  // M57 P3：配额弹窗目标
  const [quotaTarget, setQuotaTarget] = React.useState<UserInfo | null>(null)

  const refresh = React.useCallback(async (): Promise<void> => {
    try {
      const res = await apiGet<UsersResponse>('/api/users')
      setUsers(res.users)
    } catch (err) {
      toast.error(`用户列表加载失败：${(err as Error).message}`)
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  const openCreate = (): void => {
    setUsername('')
    setDisplayName('')
    setRole('member')
    setPassword('')
    setCreateOpen(true)
  }

  const submitCreate = async (): Promise<void> => {
    setCreating(true)
    try {
      const res = await apiPost<{ user: UserInfo; initialPassword?: string }>('/api/users', {
        username: username.trim(),
        displayName: displayName.trim() || undefined,
        role,
        password: password.trim() || undefined,
      })
      setCreateOpen(false)
      if (res.initialPassword) setReveal({ username: res.user.username, initialPassword: res.initialPassword })
      else toast.success(`已创建账号「${res.user.username}」`)
      await refresh()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setCreating(false)
    }
  }

  const patchUser = async (user: UserInfo, patch: { role?: 'admin' | 'member'; status?: 'active' | 'disabled' }): Promise<void> => {
    setBusyId(user.id)
    try {
      await apiPatch(`/api/users/${user.id}`, patch)
      await refresh()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusyId(undefined)
    }
  }

  const resetPassword = async (user: UserInfo): Promise<void> => {
    if (!window.confirm(`重置「${user.displayName}」的密码？其全部登录会话将立即失效。`)) return
    setBusyId(user.id)
    try {
      const res = await apiPost<{ user: UserInfo; initialPassword: string }>(`/api/users/${user.id}/password`)
      setReveal({ username: res.user.username, initialPassword: res.initialPassword })
      await refresh()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusyId(undefined)
    }
  }

  const removeUser = async (user: UserInfo): Promise<void> => {
    if (!window.confirm(`删除账号「${user.displayName}」？其会话 / 记忆等归属数据将级联清理，且不可恢复。`)) return
    setBusyId(user.id)
    try {
      await apiDelete(`/api/users/${user.id}`)
      toast.success(`已删除账号「${user.username}」`)
      await refresh()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusyId(undefined)
    }
  }

  /** 自我保护的 UI 侧预判（服务端同样强制） */
  const isSelf = (user: UserInfo): boolean => Boolean(me?.id) && me?.id === user.id

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
        <Users className="size-4 text-primary" />
        <h1 className="text-[13px] font-semibold">用户管理</h1>
        <span className="text-[11.5px] text-muted-foreground">邀请制：账号由管理员创建，首次登录需修改初始密码</span>
        <Button size="xs" className="ml-auto" onClick={openCreate}>
          <Plus className="mr-1 size-3.5" />
          邀请用户
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {loading ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
          </div>
        ) : users.length === 0 ? (
          <p className="py-10 text-center text-[12.5px] text-muted-foreground">暂无账号</p>
        ) : (
          <div className="overflow-hidden rounded-lg border">
            <table className="w-full text-[12.5px]">
              <thead className="bg-muted/40 text-left text-[11.5px] text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">账号</th>
                  <th className="px-3 py-2 font-medium">角色</th>
                  <th className="px-3 py-2 font-medium">状态</th>
                  <th className="px-3 py-2 font-medium">最近登录</th>
                  <th className="px-3 py-2 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => {
                  const self = isSelf(user)
                  const busy = busyId === user.id
                  return (
                    <tr key={user.id} className="border-t">
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium">{user.displayName}</span>
                          {self && <span className="rounded-full border px-1.5 py-px text-[10px] text-muted-foreground">我</span>}
                          {user.mustChangePassword && (
                            <span className="rounded-full border border-amber-500/30 bg-amber-50 px-1.5 py-px text-[10px] text-amber-700">
                              待改密
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-muted-foreground">{user.username}</div>
                      </td>
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          disabled={self || busy}
                          title={self ? '不能修改自己的角色' : '切换角色（admin / member）'}
                          className="rounded-full border px-2 py-0.5 text-[11px] transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                          onClick={() => void patchUser(user, { role: user.role === 'admin' ? 'member' : 'admin' })}
                        >
                          {user.role === 'admin' ? '管理员' : '成员'}
                        </button>
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={
                            user.status === 'active' ? 'text-emerald-700' : 'rounded-full bg-muted px-1.5 py-px text-muted-foreground'
                          }
                        >
                          {user.status === 'active' ? '启用' : '已禁用'}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-[11.5px] text-muted-foreground">
                        {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : '—'}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            title={user.status === 'active' ? '禁用（即时吊销全部会话）' : '启用'}
                            disabled={self || busy}
                            onClick={() => void patchUser(user, { status: user.status === 'active' ? 'disabled' : 'active' })}
                          >
                            {busy ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : user.status === 'active' ? (
                              <UserX className="size-3.5" />
                            ) : (
                              <UserCheck className="size-3.5" />
                            )}
                          </Button>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            title="重置密码（生成新的初始密码）"
                            disabled={busy}
                            onClick={() => void resetPassword(user)}
                          >
                            <KeyRound className="size-3.5" />
                          </Button>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            title="配额与用量（并发 / token / 成本 / 会话 / 存储）"
                            disabled={busy}
                            onClick={() => setQuotaTarget(user)}
                          >
                            <Gauge className="size-3.5" />
                          </Button>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            className="text-destructive hover:text-destructive"
                            title="删除账号（级联清理其数据）"
                            disabled={self || busy}
                            onClick={() => void removeUser(user)}
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <ShieldCheck className="size-3.5" />
          护栏：系统至少保留一名启用中的管理员；本人账号不可禁用 / 改角色 / 删除；禁用与重置密码即刻吊销全部登录会话。
        </p>
      </div>

      {/* 邀请（创建账号） */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-[14px]">邀请用户</DialogTitle>
            <DialogDescription className="text-[12px]">
              初始密码可留空由系统生成（仅创建时展示一次）；用户首次登录需修改密码。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <FieldRow label="用户名（登录名）" hint="3–32 位字母 / 数字 / _. -">
              <TextInput value={username} onChange={setUsername} placeholder="如：zhangsan" />
            </FieldRow>
            <FieldRow label="显示名">
              <TextInput value={displayName} onChange={setDisplayName} placeholder="如：张三" />
            </FieldRow>
            <FieldRow label="角色">
              <div className="flex gap-2">
                <Button size="sm" variant={role === 'member' ? 'default' : 'outline'} onClick={() => setRole('member')}>
                  成员
                </Button>
                <Button size="sm" variant={role === 'admin' ? 'default' : 'outline'} onClick={() => setRole('admin')}>
                  管理员
                </Button>
              </div>
            </FieldRow>
            <FieldRow label="初始密码（可选）" hint="留空自动生成；至少 10 位且含两类字符">
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            </FieldRow>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setCreateOpen(false)}>
                取消
              </Button>
              <Button size="sm" disabled={creating || !username.trim()} onClick={() => void submitCreate()}>
                {creating && <Loader2 className="mr-1 size-3.5 animate-spin" />}
                创建账号
              </Button>
            </div>
            {password.trim() && password.trim().length < 10 && (
              <p className="text-[11.5px] text-amber-700">初始密码至少 10 位（服务端会校验）</p>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <InitialPasswordDialog
        open={Boolean(reveal)}
        onOpenChange={(v) => {
          if (!v) setReveal(undefined)
        }}
        username={reveal?.username ?? ''}
        initialPassword={reveal?.initialPassword ?? ''}
      />

      {/* M57 P3：配额与用量（admin） */}
      <QuotaDialog
        userId={quotaTarget?.id ?? ''}
        displayName={quotaTarget?.displayName ?? ''}
        open={quotaTarget !== null}
        onOpenChange={(open) => {
          if (!open) setQuotaTarget(null)
        }}
      />
    </div>
  )
}

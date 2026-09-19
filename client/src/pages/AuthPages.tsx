/**
 * M57：认证页面（AuthGate 各阶段视图）——
 * SetupPage 首启向导 / LoginPage 登录 / TokenEntryPage 令牌入口（AUTH_TOKEN 部署）/
 * ForcePasswordPage 首登强制改密；共用 AuthShell 外壳。
 */
import * as React from 'react'
import { KeyRound, Loader2, LockKeyhole, LogOut, ShieldCheck, UserPlus } from 'lucide-react'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Input } from '../components/ui/input'
import { useAuthStore } from '../stores/auth-store'

function AuthShell({
  icon,
  title,
  subtitle,
  children,
}: {
  icon: React.ReactNode
  title: string
  subtitle?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-gradient-to-b from-slate-50 via-slate-50 to-slate-100 px-4">
      <div className="flex items-center gap-2">
        <img src="/favicon.svg" alt="" className="size-6" />
        <span className="text-[17px] font-bold tracking-tight">Owli Team</span>
      </div>
      <Card className="w-full max-w-sm shadow-lg">
        <CardHeader className="space-y-2 pb-2">
          <div className="flex items-center gap-2 text-primary">
            {icon}
            <CardTitle className="text-[15px]">{title}</CardTitle>
          </div>
          {subtitle && <p className="text-[12px] leading-relaxed text-muted-foreground">{subtitle}</p>}
        </CardHeader>
        <CardContent className="pt-1">{children}</CardContent>
      </Card>
      <p className="max-w-sm text-center text-[11px] leading-relaxed text-muted-foreground">
        账号由管理员创建（邀请制）；首次登录后需修改初始密码。
      </p>
    </div>
  )
}

function ErrorLine({ message }: { message: string | null }): React.JSX.Element | null {
  if (!message) return null
  return (
    <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-1.5 text-[12px] text-destructive">
      {message}
    </p>
  )
}

/** 首启向导：创建首个管理员（仅无账号时可用） */
export function SetupPage(): React.JSX.Element {
  const setup = useAuthStore((s) => s.setup)
  const error = useAuthStore((s) => s.error)
  const setError = useAuthStore((s) => s.setError)
  const [username, setUsername] = React.useState('')
  const [displayName, setDisplayName] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [confirm, setConfirm] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setError(null)
    if (password !== confirm) {
      setError('两次输入的密码不一致')
      return
    }
    setBusy(true)
    try {
      await setup(username, password, displayName)
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <AuthShell
      icon={<ShieldCheck className="size-4" />}
      title="初始化管理员账号"
      subtitle="当前系统尚无任何账号。创建首个管理员后进入多用户模式，既有数据将自动归属其名下。"
    >
      <form className="space-y-3" onSubmit={(e) => void submit(e)}>
        <div className="space-y-1">
          <label className="text-[11.5px] text-muted-foreground" htmlFor="setup-username">
            用户名（登录名）
          </label>
          <Input
            id="setup-username"
            value={username}
            autoComplete="username"
            placeholder="3–32 位字母 / 数字 / _. -"
            onChange={(e) => setUsername(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <label className="text-[11.5px] text-muted-foreground" htmlFor="setup-display">
            显示名（可选）
          </label>
          <Input id="setup-display" value={displayName} placeholder="如：张三" onChange={(e) => setDisplayName(e.target.value)} />
        </div>
        <div className="space-y-1">
          <label className="text-[11.5px] text-muted-foreground" htmlFor="setup-password">
            密码（至少 10 位，含两类字符）
          </label>
          <Input
            id="setup-password"
            type="password"
            value={password}
            autoComplete="new-password"
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <label className="text-[11.5px] text-muted-foreground" htmlFor="setup-confirm">
            确认密码
          </label>
          <Input
            id="setup-confirm"
            type="password"
            value={confirm}
            autoComplete="new-password"
            onChange={(e) => setConfirm(e.target.value)}
          />
        </div>
        <ErrorLine message={error} />
        <Button type="submit" className="w-full" disabled={busy || !username || !password}>
          {busy ? <Loader2 className="mr-1 size-4 animate-spin" /> : <UserPlus className="mr-1 size-4" />}
          创建并进入
        </Button>
      </form>
    </AuthShell>
  )
}

/** 登录页（用户名 + 密码；失败统一文案由服务端给出） */
export function LoginPage({ notice }: { notice?: string | null }): React.JSX.Element {
  const login = useAuthStore((s) => s.login)
  const error = useAuthStore((s) => s.error)
  const setError = useAuthStore((s) => s.setError)
  const [username, setUsername] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await login(username, password)
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <AuthShell icon={<LockKeyhole className="size-4" />} title="登录" subtitle="使用管理员创建的用户名与密码登录。">
      <form className="space-y-3" onSubmit={(e) => void submit(e)}>
        <div className="space-y-1">
          <label className="text-[11.5px] text-muted-foreground" htmlFor="login-username">
            用户名
          </label>
          <Input
            id="login-username"
            value={username}
            autoComplete="username"
            autoFocus
            onChange={(e) => setUsername(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <label className="text-[11.5px] text-muted-foreground" htmlFor="login-password">
            密码
          </label>
          <Input
            id="login-password"
            type="password"
            value={password}
            autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <ErrorLine message={error ?? notice ?? null} />
        <Button type="submit" className="w-full" disabled={busy || !username || !password}>
          {busy && <Loader2 className="mr-1 size-4 animate-spin" />}
          登录
        </Button>
      </form>
    </AuthShell>
  )
}

/** 令牌入口（未初始化账号 + AUTH_TOKEN 部署：引导浏览器经 /?token= 种 cookie，与旧版流程一致） */
export function TokenEntryPage(): React.JSX.Element {
  const [token, setToken] = React.useState('')
  const status = useAuthStore((s) => s.status)
  const submit = (e: React.FormEvent): void => {
    e.preventDefault()
    if (!token.trim()) return
    window.location.href = `/?token=${encodeURIComponent(token.trim())}`
  }
  return (
    <AuthShell
      icon={<KeyRound className="size-4" />}
      title="访问令牌"
      subtitle={
        status.authRequired
          ? '当前部署使用 AUTH_TOKEN 鉴权（尚未初始化账号体系）。粘贴令牌完成授权后，也可在「设置」中创建管理员启用多用户。'
          : '请输入访问令牌。'
      }
    >
      <form className="space-y-3" onSubmit={submit}>
        <Input
          value={token}
          placeholder="AUTH_TOKEN"
          autoFocus
          onChange={(e) => setToken(e.target.value)}
        />
        <Button type="submit" className="w-full" disabled={!token.trim()}>
          授权进入
        </Button>
      </form>
    </AuthShell>
  )
}

/** 首登强制改密（管理员下发初始密码后） */
export function ForcePasswordPage(): React.JSX.Element {
  const user = useAuthStore((s) => s.user)
  const changePassword = useAuthStore((s) => s.changePassword)
  const logout = useAuthStore((s) => s.logout)
  const error = useAuthStore((s) => s.error)
  const setError = useAuthStore((s) => s.setError)
  const [current, setCurrent] = React.useState('')
  const [next, setNext] = React.useState('')
  const [confirm, setConfirm] = React.useState('')
  const [busy, setBusy] = React.useState(false)

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

  return (
    <AuthShell
      icon={<ShieldCheck className="size-4" />}
      title="请先修改初始密码"
      subtitle={`${user?.displayName ?? user?.username ?? ''}，你正在使用管理员下发的初始密码；为安全起见，修改后才能继续使用。`}
    >
      <form className="space-y-3" onSubmit={(e) => void submit(e)}>
        <div className="space-y-1">
          <label className="text-[11.5px] text-muted-foreground" htmlFor="force-current">
            当前密码（初始密码）
          </label>
          <Input
            id="force-current"
            type="password"
            value={current}
            autoComplete="current-password"
            autoFocus
            onChange={(e) => setCurrent(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <label className="text-[11.5px] text-muted-foreground" htmlFor="force-next">
            新密码（至少 10 位，含两类字符）
          </label>
          <Input
            id="force-next"
            type="password"
            value={next}
            autoComplete="new-password"
            onChange={(e) => setNext(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <label className="text-[11.5px] text-muted-foreground" htmlFor="force-confirm">
            确认新密码
          </label>
          <Input
            id="force-confirm"
            type="password"
            value={confirm}
            autoComplete="new-password"
            onChange={(e) => setConfirm(e.target.value)}
          />
        </div>
        <ErrorLine message={error} />
        <Button type="submit" className="w-full" disabled={busy || !current || !next}>
          {busy && <Loader2 className="mr-1 size-4 animate-spin" />}
          修改密码并进入
        </Button>
        <Button type="button" variant="ghost" size="sm" className="w-full" onClick={() => void logout()}>
          <LogOut className="mr-1 size-3.5" />
          退出登录
        </Button>
      </form>
    </AuthShell>
  )
}

/** 启动加载占位（bootstrap 进行中） */
export function AuthLoading(): React.JSX.Element {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 text-muted-foreground">
      <Loader2 className="size-5 animate-spin" />
    </div>
  )
}

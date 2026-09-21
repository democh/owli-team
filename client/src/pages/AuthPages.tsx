/**
 * M57：认证页面（AuthGate 各阶段视图）——
 * SetupPage 首启向导 / LoginPage 登录 / TokenEntryPage 令牌入口（AUTH_TOKEN 部署）/
 * ForcePasswordPage 首登强制改密；共用 AuthShell 外壳。
 *
 * M79-T（视觉微批）：品牌氛围背景（渐晕 + 网格遮罩）+ 头像徽标品牌区 + 卡片紧凑重排 +
 * 密码可见切换（tabIndex=-1 不打断键盘流）；文案锚点 / label / id / role 全保留（测试与 E2E 依赖）。
 */
import * as React from 'react'
import { Eye, EyeOff, KeyRound, Loader2, LockKeyhole, LogOut, UserPlus, UserRound } from 'lucide-react'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Input } from '../components/ui/input'
import { useAuthStore } from '../stores/auth-store'

function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center gap-7 overflow-hidden bg-[#f7f8fc] px-4">
      {/* 品牌氛围背景（纯 CSS：主/副光晕 + 细网格径向遮罩；无图片依赖） */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute -top-40 left-1/2 h-[26rem] w-[46rem] -translate-x-1/2 rounded-full bg-primary/[0.13] blur-[96px]" />
        <div className="absolute -bottom-32 -right-24 h-80 w-80 rounded-full bg-violet-400/[0.14] blur-[90px]" />
        <div className="absolute -left-24 top-1/3 h-64 w-64 rounded-full bg-sky-300/[0.12] blur-[90px]" />
        <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(15,23,42,0.028)_1px,transparent_1px),linear-gradient(to_bottom,rgba(15,23,42,0.028)_1px,transparent_1px)] bg-[size:40px_40px] [mask-image:radial-gradient(ellipse_70%_60%_at_50%_36%,black,transparent)]" />
      </div>

      {/* 品牌区（徽标 + 名称） */}
      <div className="relative flex items-center gap-2.5">
        <span className="flex size-10 items-center justify-center rounded-xl border border-slate-900/[0.06] bg-white shadow-sm shadow-slate-900/10">
          <img src="/favicon.svg" alt="" style={{ width: 22, height: 22 }} />
        </span>
        <span className="text-[20px] font-bold tracking-tight text-slate-900">Owli Team</span>
      </div>

      {/* 卡片（顶部品牌渐变条 + 简洁头部 + 底部说明条） */}
      <Card className="animate-fade-in-up relative w-full max-w-[23rem] gap-0 overflow-hidden rounded-2xl border border-slate-900/[0.06] bg-white/95 py-0 shadow-[0_24px_64px_-24px_rgba(15,23,42,0.28)] backdrop-blur">
        <div aria-hidden className="h-1 w-full bg-gradient-to-r from-primary/70 via-violet-500/70 to-primary/40" />
        <CardHeader className="space-y-0 px-6 pb-0 pt-6">
          <CardTitle className="text-[16px] tracking-tight">{title}</CardTitle>
          {subtitle && (
            <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">{subtitle}</p>
          )}
        </CardHeader>
        <CardContent className="px-6 pb-6 pt-4">{children}</CardContent>
        <p className="border-t border-slate-100 bg-slate-50/70 px-6 py-2.5 text-center text-[11px] leading-relaxed text-muted-foreground/90">
          账号由管理员创建（邀请制）；首次登录后需修改初始密码。
        </p>
      </Card>
    </div>
  )
}

function ErrorLine({ message }: { message: string | null }): React.JSX.Element | null {
  if (!message) return null
  return (
    <p
      role="alert"
      className="animate-fade-in-up rounded-lg border border-destructive/30 bg-destructive/5 px-2.5 py-1.5 text-[12px] leading-5 text-destructive"
    >
      {message}
    </p>
  )
}

/** M79-T：密码输入（可见性切换；tabIndex=-1 保证 Enter 提交等键盘流不受打断） */
function PasswordInput({
  id,
  value,
  autoComplete,
  autoFocus,
  onChange,
}: {
  id: string
  value: string
  autoComplete: string
  autoFocus?: boolean
  onChange: (value: string) => void
}): React.JSX.Element {
  const [visible, setVisible] = React.useState(false)
  return (
    <div className="relative">
      <LockKeyhole className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/60" />
      <Input
        id={id}
        type={visible ? 'text' : 'password'}
        value={value}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        className="h-10 rounded-lg pl-9 pr-9"
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label="切换可见性"
        title={visible ? '隐藏密码' : '显示密码'}
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
        onClick={() => setVisible((v) => !v)}
      >
        {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
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
      title="初始化管理员账号"
      subtitle="当前系统尚无任何账号。创建首个管理员后进入多用户模式，既有数据将自动归属其名下。"
    >
      <form className="space-y-3" onSubmit={(e) => void submit(e)}>
        <div className="space-y-1.5">
          <label className="text-[11.5px] text-muted-foreground" htmlFor="setup-username">
            用户名（登录名）
          </label>
          <div className="relative">
            <UserRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/60" />
            <Input
              id="setup-username"
              value={username}
              autoComplete="username"
              className="h-10 rounded-lg pl-9"
              placeholder="3–32 位字母 / 数字 / _. -"
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <label className="text-[11.5px] text-muted-foreground" htmlFor="setup-display">
            显示名（可选）
          </label>
          <div className="relative">
            <UserRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/60" />
            <Input
              id="setup-display"
              value={displayName}
              className="h-10 rounded-lg pl-9"
              placeholder="如：张三"
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <label className="text-[11.5px] text-muted-foreground" htmlFor="setup-password">
            密码（至少 10 位，含两类字符）
          </label>
          <PasswordInput
            id="setup-password"
            value={password}
            autoComplete="new-password"
            onChange={setPassword}
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-[11.5px] text-muted-foreground" htmlFor="setup-confirm">
            确认密码
          </label>
          <PasswordInput id="setup-confirm" value={confirm} autoComplete="new-password" onChange={setConfirm} />
        </div>
        <ErrorLine message={error} />
        <Button type="submit" className="h-10 w-full rounded-lg bg-gradient-to-r from-primary to-violet-500 text-[13.5px] shadow-lg shadow-primary/25 transition-all hover:shadow-xl hover:shadow-primary/30 hover:brightness-[1.03]" disabled={busy || !username || !password}>
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
    <AuthShell title="登录">
      <form className="space-y-3" onSubmit={(e) => void submit(e)}>
        <div className="space-y-1.5">
          <label className="text-[11.5px] text-muted-foreground" htmlFor="login-username">
            用户名
          </label>
          <div className="relative">
            <UserRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/60" />
            <Input
              id="login-username"
              value={username}
              autoComplete="username"
              autoFocus
              className="h-10 rounded-lg pl-9"
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <label className="text-[11.5px] text-muted-foreground" htmlFor="login-password">
            密码
          </label>
          <PasswordInput id="login-password" value={password} autoComplete="current-password" onChange={setPassword} />
        </div>
        <ErrorLine message={error ?? notice ?? null} />
        <Button type="submit" className="h-10 w-full rounded-lg bg-gradient-to-r from-primary to-violet-500 text-[13.5px] shadow-lg shadow-primary/25 transition-all hover:shadow-xl hover:shadow-primary/30 hover:brightness-[1.03]" disabled={busy || !username || !password}>
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
      title="访问令牌"
      subtitle={
        status.authRequired
          ? '当前部署使用 AUTH_TOKEN 鉴权（尚未初始化账号体系）。粘贴令牌完成授权后，也可在「设置」中创建管理员启用多用户。'
          : undefined
      }
    >
      <form className="space-y-3" onSubmit={submit}>
        <div className="relative">
          <KeyRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/60" />
          <Input
            value={token}
            placeholder="AUTH_TOKEN"
            autoFocus
            className="h-10 rounded-lg pl-9"
            onChange={(e) => setToken(e.target.value)}
          />
        </div>
        <Button type="submit" className="h-10 w-full rounded-lg bg-gradient-to-r from-primary to-violet-500 text-[13.5px] shadow-lg shadow-primary/25 transition-all hover:shadow-xl hover:shadow-primary/30 hover:brightness-[1.03]" disabled={!token.trim()}>
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
      title="请先修改初始密码"
      subtitle={`${user?.displayName ?? user?.username ?? ''}，你正在使用管理员下发的初始密码；为安全起见，修改后才能继续使用。`}
    >
      <form className="space-y-3" onSubmit={(e) => void submit(e)}>
        <div className="space-y-1.5">
          <label className="text-[11.5px] text-muted-foreground" htmlFor="force-current">
            当前密码（初始密码）
          </label>
          <PasswordInput
            id="force-current"
            value={current}
            autoComplete="current-password"
            autoFocus
            onChange={setCurrent}
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-[11.5px] text-muted-foreground" htmlFor="force-next">
            新密码（至少 10 位，含两类字符）
          </label>
          <PasswordInput id="force-next" value={next} autoComplete="new-password" onChange={setNext} />
        </div>
        <div className="space-y-1.5">
          <label className="text-[11.5px] text-muted-foreground" htmlFor="force-confirm">
            确认新密码
          </label>
          <PasswordInput id="force-confirm" value={confirm} autoComplete="new-password" onChange={setConfirm} />
        </div>
        <ErrorLine message={error} />
        <Button type="submit" className="h-10 w-full rounded-lg bg-gradient-to-r from-primary to-violet-500 text-[13.5px] shadow-lg shadow-primary/25 transition-all hover:shadow-xl hover:shadow-primary/30 hover:brightness-[1.03]" disabled={busy || !current || !next}>
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

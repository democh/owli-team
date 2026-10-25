/**
 * 应用入口：hash 路由（#/avatars 头像预览页、#/agents 名录页）+ 主布局。
 * M57：AuthGate 门控——启动先解析登录态（首启 / 令牌入口 / 登录 / 强制改密 / 就绪），
 * 兼容模式（无账号，行为同旧版）下直接进入。
 */
import * as React from 'react'
import { TooltipProvider } from './components/ui/tooltip'
import { Toaster } from './components/ui/sonner'
import { AppLayout } from './components/layout/AppLayout'
import { AvatarPreview } from './pages/AvatarPreview'
import { AuthLoading, ForcePasswordPage, LoginPage, SetupPage, TokenEntryPage } from './pages/AuthPages'
import { useAuthStore } from './stores/auth-store'

const AgentsDirectory = React.lazy(() => import('./pages/AgentsDirectory').then((m) => ({ default: m.AgentsDirectory })))

/** M57：登录态门控（各阶段见 auth-store.bootstrap） */
function AuthGate({ children }: { children: React.ReactNode }): React.JSX.Element {
  const phase = useAuthStore((s) => s.phase)
  const bootstrap = useAuthStore((s) => s.bootstrap)

  React.useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  switch (phase) {
    case 'loading':
      return <AuthLoading />
    case 'setup':
      return <SetupPage />
    case 'token':
      return <TokenEntryPage />
    case 'login':
      return <LoginPage />
    case 'force-password':
      return <ForcePasswordPage />
    default:
      return <>{children}</>
  }
}

export default function App(): React.JSX.Element {
  const [hash, setHash] = React.useState(() => window.location.hash)

  React.useEffect(() => {
    const onChange = (): void => setHash(window.location.hash)
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  return (
    <TooltipProvider delayDuration={300}>
      <AuthGate>
        {hash.startsWith('#/avatars') ? (
          <AvatarPreview />
        ) : hash.startsWith('#/agents') ? (
          <React.Suspense fallback={<AuthLoading />}><AgentsDirectory /></React.Suspense>
        ) : (
          <AppLayout />
        )}
      </AuthGate>
      <Toaster />
    </TooltipProvider>
  )
}

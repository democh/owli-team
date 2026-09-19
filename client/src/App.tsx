/**
 * 应用入口：hash 路由（#/avatars 头像预览页、#/agents 名录页）+ 主布局。
 */
import * as React from 'react'
import { TooltipProvider } from './components/ui/tooltip'
import { Toaster } from './components/ui/sonner'
import { AppLayout } from './components/layout/AppLayout'
import { AvatarPreview } from './pages/AvatarPreview'
import { AgentsDirectory } from './pages/AgentsDirectory'

export default function App(): React.JSX.Element {
  const [hash, setHash] = React.useState(() => window.location.hash)

  React.useEffect(() => {
    const onChange = (): void => setHash(window.location.hash)
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  return (
    <TooltipProvider delayDuration={300}>
      {hash.startsWith('#/avatars') ? (
        <AvatarPreview />
      ) : hash.startsWith('#/agents') ? (
        <AgentsDirectory />
      ) : (
        <AppLayout />
      )}
      <Toaster />
    </TooltipProvider>
  )
}

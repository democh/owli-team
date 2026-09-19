import { Toaster as SonnerToaster } from 'sonner'

/** 全局 toast 出口（仅浅色，跟随 tokens） */
export function Toaster(): React.JSX.Element {
  return (
    <SonnerToaster
      position="top-center"
      toastOptions={{
        classNames: {
          toast: 'rounded-lg border bg-card text-card-foreground shadow-md',
          description: 'text-muted-foreground',
        },
      }}
    />
  )
}

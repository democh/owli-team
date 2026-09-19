/**
 * M26：资产校验徽章（Agent / Skill 控制台页头共用）。
 * - 绿 = 全部通过；琥珀 = 存在问题（错误数 · 警告数）；
 * - 点击展开 issue 列表（level 图标 + 定位路径 + 描述），支持「重新校验」；
 * - 数据源：console-store.issues（refreshAll / 写盘后自动重拉）。
 */
import * as React from 'react'
import { AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useConsoleStore } from '../../stores/console-store'
import { Button } from '../ui/button'

export function ValidateBanner(): React.JSX.Element {
  const issues = useConsoleStore((s) => s.issues)
  const [open, setOpen] = React.useState(false)
  const [checking, setChecking] = React.useState(false)
  const errors = issues.filter((i) => i.level === 'error').length
  const warnings = issues.length - errors
  const ok = issues.length === 0

  const recheck = async (): Promise<void> => {
    setChecking(true)
    try {
      await useConsoleStore.getState().loadValidate()
    } catch {
      // 校验失败静默（徽章维持旧结果，问题会在服务端日志体现）
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={open}
        title="资产校验（front-matter / 引用 / 目录结构）"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[11.5px] font-medium transition-colors',
          ok
            ? 'border-emerald-600/20 bg-emerald-500/10 text-emerald-700'
            : 'border-amber-500/25 bg-amber-500/12 text-amber-700',
        )}
      >
        {ok ? <CheckCircle2 className="size-3.5" /> : <AlertTriangle className="size-3.5" />}
        {ok ? '资产校验通过' : `${errors} 个错误 · ${warnings} 个警告`}
      </button>
      {open && (
        <div className="absolute right-0 top-9 z-30 w-[460px] max-w-[82vw] overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-xl">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="text-[12px] font-medium">校验结果</span>
            <Button variant="ghost" size="xs" disabled={checking} onClick={() => void recheck()}>
              <RefreshCw className={cn('size-3', checking && 'animate-spin')} />
              重新校验
            </Button>
          </div>
          <div className="max-h-72 overflow-y-auto p-1.5">
            {issues.length === 0 ? (
              <div className="px-3 py-6 text-center text-[11.5px] text-muted-foreground">
                全部资产通过校验（front-matter / 引用 / 目录结构）
              </div>
            ) : (
              issues.map((issue, i) => (
                <div key={`${issue.path}-${i}`} className="flex gap-2 rounded px-2 py-1.5 hover:bg-accent/60">
                  <AlertTriangle
                    className={cn(
                      'mt-0.5 size-3.5 shrink-0',
                      issue.level === 'error' ? 'text-destructive' : 'text-amber-500',
                    )}
                  />
                  <div className="min-w-0">
                    <div className="break-words text-[12px]">{issue.message}</div>
                    <div className="truncate font-mono text-[10.5px] text-muted-foreground">{issue.path}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}

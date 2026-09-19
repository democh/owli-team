/**
 * worktree 面板（M6）：repo / worktree 项目的会话头部状态条。
 * - 显示工作区模式（worktree 分支 / 直连仓库）与主仓库当前分支；
 * - 三个动作：查看改动（diff）、合并到主分支（二次确认）、丢弃 worktree（二次确认）；
 * - sandbox 会话不渲染（返回 null）。
 */
import * as React from 'react'
import { GitBranch, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { apiGet, apiPost } from '../../lib/api'
import { Button } from '../ui/button'

export interface WorktreeState {
  mode: 'sandbox' | 'repo' | 'worktree'
  root: string
  branch?: string
  repoRoot?: string
  mainBranch?: string
  diff: { branch: string; files: string[]; diff: string; truncated: boolean } | null
}

export function WorktreeBar({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const [info, setInfo] = React.useState<WorktreeState | null>(null)
  const [busy, setBusy] = React.useState<'merge' | 'discard' | null>(null)
  const [showDiff, setShowDiff] = React.useState(false)

  const refresh = React.useCallback(async (): Promise<void> => {
    try {
      const data = await apiGet<WorktreeState>(`/api/sessions/${sessionId}/worktree`)
      setInfo(data)
    } catch {
      // 非项目会话 / 后端不可用时静默隐藏面板
      setInfo(null)
    }
  }, [sessionId])

  React.useEffect(() => {
    setShowDiff(false)
    void refresh()
  }, [refresh])

  if (!info || info.mode === 'sandbox') return null

  const onMerge = async (): Promise<void> => {
    if (!window.confirm('合并会把 agent 分支写入主仓库当前分支，确认继续？')) return
    setBusy('merge')
    try {
      const res = await apiPost<{ detail: string }>(`/api/sessions/${sessionId}/worktree/merge`, { confirm: true })
      toast.success(res.detail || '合并完成')
      await refresh()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const onDiscard = async (): Promise<void> => {
    if (!window.confirm('丢弃将删除 worktree 目录与 agent 分支，未合并的改动会丢失，确认继续？')) return
    setBusy('discard')
    try {
      await apiPost(`/api/sessions/${sessionId}/worktree/discard`, {})
      toast.success('已丢弃 worktree')
      await refresh()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="shrink-0 border-b bg-muted/30">
      <div className="flex h-8 items-center gap-2 px-4 text-[11.5px] text-muted-foreground">
        <GitBranch className="size-3.5 shrink-0" />
        {info.mode === 'worktree' ? (
          <span className="truncate">
            工作树{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-[10.5px]">{info.branch}</code>
            {info.mainBranch ? (
              <>
                {' '}
                · 主仓库 <code className="rounded bg-muted px-1 py-0.5 text-[10.5px]">{info.mainBranch}</code>
              </>
            ) : null}
          </span>
        ) : (
          <span className="truncate">
            直连仓库
            {info.mainBranch ? (
              <>
                {' '}
                <code className="rounded bg-muted px-1 py-0.5 text-[10.5px]">{info.mainBranch}</code>
              </>
            ) : null}
            （改动即真实改动）
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11.5px]"
            onClick={() => setShowDiff((v) => !v)}
          >
            {showDiff ? '收起改动' : '查看改动'}
          </Button>
          {info.mode === 'worktree' && (
            <>
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-[11.5px]"
                disabled={busy !== null}
                onClick={() => void onMerge()}
              >
                {busy === 'merge' && <Loader2 className="size-3 animate-spin" />}
                合并到主分支
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-[11.5px] text-destructive"
                disabled={busy !== null}
                onClick={() => void onDiscard()}
              >
                {busy === 'discard' && <Loader2 className="size-3 animate-spin" />}
                丢弃 worktree
              </Button>
            </>
          )}
        </div>
      </div>
      {showDiff && (
        <div className="max-h-64 overflow-auto border-t bg-background px-4 py-2">
          {info.diff && info.diff.diff ? (
            <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed">{info.diff.diff}</pre>
          ) : (
            <p className="py-1 text-[11.5px] text-muted-foreground">当前没有改动。</p>
          )}
        </div>
      )}
    </div>
  )
}

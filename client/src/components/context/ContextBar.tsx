/**
 * 上下文档（M8/M9 → M25）：
 * - 顶部用量条：当前 token / 预算（超 70% 变色）+ 本 Run 费用 + 运行轨迹入口；
 * - 点击打开「上下文抽屉」：L0–L5 分层 token、语义召回明细（L1.5）、滚动摘要、记忆摘要、降级提示。
 * 数据源：GET /api/sessions/:id/context（M25 含 recalled 召回明细）、GET /api/runs/:id/usage；
 * 刷新时机：会话切换 / 运行结束 / 压缩事件（run-store.compressionCount）/ 手动刷新。
 */
import * as React from 'react'
import { Activity, Layers, Loader2, RefreshCw } from 'lucide-react'
import type { ContextSnapshot } from '@multi-agent/shared'
import { apiGet } from '../../lib/api'
import { cn } from '../../lib/utils'
import { useRunStore } from '../../stores/run-store'
import { useSessionStore } from '../../stores/session-store'
import { useUiStore } from '../../stores/ui-store'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'

interface UsageSum {
  promptTokens: number
  completionTokens: number
  costUsd: number
}

/** M25：召回条目 scope 展示名 */
const SCOPE_LABEL: Record<'session' | 'agent' | 'project' | 'global', string> = {
  session: '会话',
  agent: '成员',
  project: '项目',
  global: '全局',
}

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function ratioClass(ratio: number): string {
  if (ratio >= 0.9) return 'bg-rose-500'
  if (ratio >= 0.7) return 'bg-amber-500'
  return 'bg-emerald-500'
}

export function ContextBar(): React.JSX.Element | null {
  const currentId = useSessionStore((s) => s.currentId)
  const runId = useRunStore((s) => s.runId)
  const active = useRunStore((s) => s.active)
  const compressionCount = useRunStore((s) => s.compressionCount)
  const contextOpen = useUiStore((s) => s.contextOpen)
  const setContextOpen = useUiStore((s) => s.setContextOpen)
  const openTrace = useUiStore((s) => s.openTrace)

  const [snapshot, setSnapshot] = React.useState<ContextSnapshot | null>(null)
  const [usage, setUsage] = React.useState<UsageSum | null>(null)
  const [refreshing, setRefreshing] = React.useState(false)

  const loadContext = React.useCallback(async (): Promise<void> => {
    const id = useSessionStore.getState().currentId
    if (!id) return
    setRefreshing(true)
    try {
      const res = await apiGet<{ context: ContextSnapshot }>(`/api/sessions/${id}/context`)
      if (useSessionStore.getState().currentId === id) setSnapshot(res.context)
    } catch {
      // 会话不存在等：保持旧快照
    } finally {
      setRefreshing(false)
    }
  }, [])

  // 会话切换 / 压缩 / 运行结束 → 重拉快照
  React.useEffect(() => {
    if (!currentId) {
      setSnapshot(null)
      return
    }
    void loadContext()
  }, [currentId, compressionCount, active, loadContext])

  // 本 Run 费用：runId 变化 / 运行结束时刷新
  React.useEffect(() => {
    if (!runId) {
      setUsage(null)
      return
    }
    void apiGet<{ usage: UsageSum }>(`/api/runs/${runId}/usage`)
      .then((res) => setUsage(res.usage))
      .catch(() => undefined)
  }, [runId, active])

  if (!currentId) return null
  const ratio = Math.min(1, Math.max(0, snapshot?.usageRatio ?? 0))
  const pct = Math.round(ratio * 100)

  return (
    <>
      <button
        type="button"
        title="查看上下文分层与摘要"
        onClick={() => {
          setContextOpen(true)
          void loadContext()
        }}
        className="flex h-7 w-full shrink-0 items-center gap-2 border-b bg-muted/40 px-3 text-left text-[10.5px] text-muted-foreground transition-colors hover:bg-muted/70"
      >
        <Layers className="size-3 shrink-0" />
        <span className="shrink-0">上下文</span>
        <span className="relative h-1.5 w-28 shrink-0 overflow-hidden rounded-full bg-border">
          <span
            className={cn('absolute inset-y-0 left-0 rounded-full transition-all', ratioClass(ratio))}
            style={{ width: `${pct}%` }}
          />
        </span>
        <span className={cn('shrink-0 font-medium', ratio >= 0.7 ? 'text-amber-600' : 'text-foreground/80')}>
          {snapshot ? `${pct}%` : '—'}
        </span>
        {snapshot && (
          <span className="hidden shrink-0 sm:inline">
            {fmtTokens(snapshot.estimatedTokens)} / {fmtTokens(snapshot.budgetTokens)} tokens
          </span>
        )}
        {snapshot?.degraded && <Badge variant="warning">已降级</Badge>}
        {usage && usage.costUsd > 0 && (
          <span className="ml-auto shrink-0">本 Run ${usage.costUsd.toFixed(4)}</span>
        )}
        {runId && (
          <span
            role="button"
            tabIndex={0}
            title="查看本次运行轨迹（回合/工具/压缩/调度）"
            className={cn(
              'shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 transition-colors hover:bg-accent hover:text-foreground',
              usage && usage.costUsd > 0 ? 'inline-flex' : 'ml-auto inline-flex',
            )}
            onClick={(e) => {
              e.stopPropagation()
              openTrace(runId)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation()
                openTrace(runId)
              }
            }}
          >
            <Activity className="size-3" />
            轨迹
          </span>
        )}
      </button>

      <Dialog open={contextOpen} onOpenChange={setContextOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              上下文与摘要
              <Badge variant={ratio >= 0.7 ? 'warning' : 'success'}>{pct}%</Badge>
              <Button
                variant="ghost"
                size="icon-sm"
                className="ml-auto mr-6"
                title="刷新"
                disabled={refreshing}
                onClick={() => void loadContext()}
              >
                {refreshing ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
              </Button>
            </DialogTitle>
            <DialogDescription>
              {snapshot
                ? `预算 ${snapshot.budgetTokens.toLocaleString()} tokens · 估算 ${snapshot.estimatedTokens.toLocaleString()} tokens · 摘要水位 seq ${snapshot.untilSeq}`
                : '暂无快照（发起一次对话后生成）'}
            </DialogDescription>
          </DialogHeader>

          {snapshot && (
            <div className="mt-2 max-h-[60vh] space-y-3 overflow-y-auto pr-1">
              <div className="space-y-1.5">
                {snapshot.layers.map((layer) => {
                  const max = Math.max(1, ...snapshot.layers.map((l) => l.tokens))
                  return (
                    <div key={layer.key} className="flex items-center gap-2 text-[11.5px]">
                      <span className="w-24 shrink-0 text-muted-foreground">
                        <span className="font-mono">{layer.key}</span> {layer.label}
                      </span>
                      <span className="relative h-2 flex-1 overflow-hidden rounded-full bg-border">
                        <span
                          className="absolute inset-y-0 left-0 rounded-full bg-primary/70"
                          style={{ width: `${Math.round((layer.tokens / max) * 100)}%` }}
                        />
                      </span>
                      <span className="w-14 shrink-0 text-right tabular-nums">{fmtTokens(layer.tokens)}</span>
                    </div>
                  )
                })}
                {snapshot.layers.length === 0 && (
                  <p className="text-[12px] text-muted-foreground">分层数据待生成</p>
                )}
              </div>

              {/* M25：语义召回（L1.5）明细 */}
              {(() => {
                const layer = snapshot.layers.find((l) => l.key === 'L1.5')
                if (!layer) return null
                return (
                  <div>
                    <div className="mb-1 flex items-center gap-2 text-[11px] font-medium text-muted-foreground">
                      语义召回（L1.5）
                      {layer.detail && <span className="font-normal">{layer.detail}</span>}
                    </div>
                    {snapshot.recalled && snapshot.recalled.length > 0 ? (
                      <div className="space-y-1">
                        {snapshot.recalled.map((item) => (
                          <div key={item.id} className="rounded-lg border bg-muted/30 px-2.5 py-1.5 text-[11.5px]">
                            <div className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
                              <Badge variant="outline">{SCOPE_LABEL[item.scope]}</Badge>
                              <span className="font-mono">{item.score.toFixed(3)}</span>
                            </div>
                            <p className="mt-0.5 whitespace-pre-wrap leading-5 text-foreground/90">{item.content}</p>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-[11.5px] text-muted-foreground">本回合无召回注入</p>
                    )}
                  </div>
                )
              })()}

              {snapshot.summary && (
                <div>
                  <div className="mb-1 text-[11px] font-medium text-muted-foreground">滚动摘要</div>
                  <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg border bg-muted/40 p-2.5 text-[11.5px] leading-5">
                    {snapshot.summary}
                  </pre>
                </div>
              )}

              <div className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
                <span>记忆 {snapshot.memory.length} 条</span>
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => {
                    setContextOpen(false)
                    useUiStore.getState().setRightView('memory')
                  }}
                >
                  打开记忆面板
                </Button>
                {snapshot.compressedAt && <span>· 最近压缩 {snapshot.compressedAt.slice(11, 16)}</span>}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

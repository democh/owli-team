/**
 * 指标面板（M9）：右栏「指标」分段 —— 让系统健康度与成本一眼可见。
 * 数据源：GET /api/metrics/summary（run_events + usage + tool_metrics + feedback 聚合）。
 * - 运行/回合/平均回合耗时/token/费用/压缩次数；
 * - 工具调用与失败率排行；
 * - 反馈好评率（👍/👎）；
 * - 按用途（agent 回合 / summary 压缩 / judge 评审）的用量拆分。
 */
import * as React from 'react'
import { Activity, Loader2, RefreshCw } from 'lucide-react'
import type { MetricsSummary } from '@multi-agent/shared'
import { apiGet } from '../../lib/api'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'

interface UsageSlice {
  calls: number
  promptTokens: number
  completionTokens: number
  costUsd: number
}

interface ToolRow {
  toolName: string
  calls: number
  failures: number
  avgMs: number
}

interface MetricsResponse {
  summary: MetricsSummary
  byKind: Record<string, UsageSlice>
  tools: ToolRow[]
  feedback: { total: number; up: number; down: number }
}

const WINDOWS: Array<{ label: string; sinceMs?: number }> = [
  { label: '24 小时', sinceMs: 24 * 3600 * 1000 },
  { label: '7 天', sinceMs: 7 * 24 * 3600 * 1000 },
  { label: '全部' },
]

const KIND_LABEL: Record<string, string> = {
  agent: 'Agent 回合',
  summary: '压缩摘要',
  judge: '评审打分',
  embed: '向量嵌入',
  digest: '记忆沉淀',
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms)}ms`
}

export function MetricsPanel(): React.JSX.Element {
  const [windowIndex, setWindowIndex] = React.useState(0)
  const [data, setData] = React.useState<MetricsResponse | null>(null)
  const [loading, setLoading] = React.useState(false)

  const load = React.useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const sinceMs = WINDOWS[windowIndex].sinceMs
      const res = await apiGet<MetricsResponse>(
        `/api/metrics/summary${sinceMs ? `?sinceMs=${sinceMs}` : ''}`,
      )
      setData(res)
    } catch {
      // 服务端异常时保留旧数据
    } finally {
      setLoading(false)
    }
  }, [windowIndex])

  React.useEffect(() => {
    void load()
  }, [load])

  const s = data?.summary
  const failureRate = s && s.toolCalls > 0 ? s.toolFailures / s.toolCalls : 0
  const feedback = data?.feedback
  const upRate = feedback && feedback.total > 0 ? feedback.up / feedback.total : undefined
  const kinds = Object.entries(data?.byKind ?? {})

  return (
    <div className="h-full overflow-y-auto p-2">
      <div className="mb-2 flex items-center gap-1">
        {WINDOWS.map((w, i) => (
          <button
            key={w.label}
            type="button"
            className={cn(
              'rounded-full border px-2 py-0.5 text-[11px] transition-colors',
              i === windowIndex
                ? 'border-primary/40 bg-primary/10 text-primary'
                : 'border-transparent text-muted-foreground hover:bg-accent/70',
            )}
            onClick={() => setWindowIndex(i)}
          >
            {w.label}
          </button>
        ))}
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto"
          title="刷新"
          disabled={loading}
          onClick={() => void load()}
        >
          {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
        </Button>
      </div>

      {!s && !loading && (
        <div className="px-2 py-8 text-center text-[12.5px] text-muted-foreground">
          <Activity className="float-soft mx-auto mb-2 size-6 text-primary/40" />
          暂无指标（发起一次协作后生成）
        </div>
      )}

      {s && (
        <div className="space-y-2">
          <div className="grid grid-cols-3 gap-1.5">
            {[
              { label: '运行', value: String(s.runs) },
              { label: '回合', value: String(s.turns) },
              { label: '平均回合', value: s.turns > 0 ? fmtMs(s.avgTurnMs) : '—' },
              { label: '输入 token', value: fmtTokens(s.promptTokens) },
              { label: '输出 token', value: fmtTokens(s.completionTokens) },
              { label: '费用', value: `$${s.costUsd.toFixed(4)}` },
            ].map((x) => (
              <div
                key={x.label}
                className="rounded-xl border bg-gradient-to-b from-card to-muted/50 px-2 py-1.5 text-center shadow-soft"
              >
                <div className="text-[13.5px] font-semibold leading-5 text-primary">{x.value}</div>
                <div className="text-[10px] text-muted-foreground">{x.label}</div>
              </div>
            ))}
          </div>

          <div className="rounded-xl border bg-card px-2.5 py-2 text-[11.5px]">
            <div className="mb-1 flex items-center justify-between text-muted-foreground">
              <span>工具调用</span>
              <span className="tabular-nums">
                {s.toolCalls} 次 · 失败率 {(failureRate * 100).toFixed(1)}% · 压缩 {s.compressions} 次
              </span>
            </div>
            <span className="relative block h-1.5 overflow-hidden rounded-full bg-border">
              <span
                className={cn(
                  'absolute inset-y-0 left-0 rounded-full',
                  failureRate >= 0.2 ? 'bg-rose-500' : failureRate >= 0.05 ? 'bg-amber-500' : 'bg-emerald-500',
                )}
                style={{ width: `${Math.max(2, Math.round((1 - failureRate) * 100))}%` }}
              />
            </span>
          </div>

          {(data?.tools?.length ?? 0) > 0 && (
            <div className="rounded-xl border bg-card p-2">
              <div className="mb-1 text-[11px] font-medium text-muted-foreground">工具排行</div>
              <div className="space-y-1">
                {data!.tools.slice(0, 8).map((t) => (
                  <div key={t.toolName} className="flex items-center gap-2 text-[11.5px]">
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{t.toolName}</span>
                    <span className="shrink-0 text-muted-foreground tabular-nums">{t.calls} 次</span>
                    <span
                      className={cn(
                        'w-14 shrink-0 text-right tabular-nums',
                        t.failures > 0 ? 'text-rose-600' : 'text-muted-foreground',
                      )}
                    >
                      {t.failures > 0 ? `失败 ${t.failures}` : '全成功'}
                    </span>
                    <span className="w-12 shrink-0 text-right tabular-nums text-muted-foreground">
                      {fmtMs(t.avgMs)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {feedback && feedback.total > 0 && (
            <div className="rounded-xl border bg-card px-2.5 py-2 text-[11.5px] text-muted-foreground">
              反馈 {feedback.total} 条 · 👍 {feedback.up} · 👎 {feedback.down}
              {upRate !== undefined && <span className="ml-1 text-foreground">好评率 {(upRate * 100).toFixed(0)}%</span>}
            </div>
          )}

          {kinds.length > 0 && (
            <div className="rounded-xl border bg-card p-2">
              <div className="mb-1 text-[11px] font-medium text-muted-foreground">用量拆分</div>
              <div className="space-y-1">
                {kinds.map(([kind, slice]) => (
                  <div key={kind} className="flex items-center gap-2 text-[11.5px]">
                    <span className="min-w-0 flex-1 truncate">{KIND_LABEL[kind] ?? kind}</span>
                    <span className="shrink-0 text-muted-foreground tabular-nums">
                      {fmtTokens(slice.promptTokens + slice.completionTokens)} tokens
                    </span>
                    <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground">
                      ${slice.costUsd.toFixed(4)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

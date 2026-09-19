/**
 * K 线画布节点（M34 增强）：
 * - 有 bars → 直渲染（KlineCanvas 内核与 K 线块共用；bars 过 kline-spec 收窄 + 升序归一）；
 * - 周期 / 复权切换直连 GET /api/finance/kline（只读网关，不重问 Agent），切换结果写回节点（画布自动保存）；
 * - 空态（无 bars）：输入标的 + 周期 / 复权 → 「拉取行情」直连网关，成功写回节点；
 * - 数据来源三通道：K 线块「送上画布」/ agent canvas_write / 节点内直连拉取。
 */
import * as React from 'react'
import { LineChart, Loader2, RefreshCw, TriangleAlert } from 'lucide-react'
import type { CanvasKlineData, CanvasNodeDataMap } from '@multi-agent/shared'
import {
  klineDefaultTitle,
  KLINE_ADJUSTS,
  KLINE_ADJUST_LABELS,
  KLINE_PERIODS,
  KLINE_PERIOD_LABELS,
  parseKlineSpec,
  type KlineAdjust,
  type KlineAnnotation,
  type KlineDataset,
  type KlineIndicator,
  type KlinePeriod,
} from '../../../lib/kline-spec'
import { cn } from '../../../lib/utils'
import { useCanvasStore } from '../../../stores/canvas-store'
import { KlineCanvas } from '../../finance/KlineCanvas'
import { NodeShell } from './NodeShell'
import type { CanvasNodeProps } from './types'

/** 切换条保留日 / 周 / 月三档（与 K 线块一致）；空态选择器用全量周期 */
const SWITCH_PERIODS: readonly KlinePeriod[] = ['day', 'week', 'month']

function asPeriod(value: string | undefined): KlinePeriod {
  return value !== undefined && (KLINE_PERIODS as readonly string[]).includes(value) ? (value as KlinePeriod) : 'day'
}

function asAdjust(value: string | undefined): KlineAdjust {
  return value !== undefined && (KLINE_ADJUSTS as readonly string[]).includes(value) ? (value as KlineAdjust) : 'qfq'
}

type NodeState =
  | { state: 'empty' }
  | { state: 'invalid'; error: string }
  | { state: 'ready'; dataset: KlineDataset; indicators: KlineIndicator[]; annotations: KlineAnnotation[] }

/** 节点数据 → 渲染配置（过解析器收窄；bars 缺失 = 空态，损坏 = 错误提示） */
function narrow(d: CanvasNodeDataMap['kline']): NodeState {
  const hasBars = Array.isArray(d.bars) && d.bars.length > 0
  if (!hasBars) return { state: 'empty' }
  const wrapped: Record<string, unknown> = {
    data: {
      kind: 'kline',
      ...(d.symbol ? { symbol: d.symbol } : {}),
      ...(d.name ? { name: d.name } : {}),
      ...(d.period ? { period: d.period } : {}),
      ...(d.adjust ? { adjust: d.adjust } : {}),
      bars: d.bars,
    },
    ...(d.indicators ? { indicators: d.indicators } : {}),
    ...(d.annotations ? { annotations: d.annotations } : {}),
  }
  const result = parseKlineSpec(JSON.stringify(wrapped))
  if (!result.ok || !result.spec.data) {
    return { state: 'invalid', error: result.ok ? '缺少 bars' : result.error }
  }
  return { state: 'ready', dataset: result.spec.data, indicators: result.spec.indicators, annotations: result.spec.annotations }
}

export function KlineNode({ id, data, selected }: CanvasNodeProps): React.JSX.Element {
  const d = data as unknown as CanvasNodeDataMap['kline']
  const updateNodeData = useCanvasStore((s) => s.updateNodeData)
  const parsed = React.useMemo(() => narrow(d), [d])
  const [symbol, setSymbol] = React.useState(d.symbol ?? '')
  const [period, setPeriod] = React.useState<KlinePeriod>(() => asPeriod(d.period))
  const [adjust, setAdjust] = React.useState<KlineAdjust>(() => asAdjust(d.adjust))
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | undefined>(undefined)

  /** 直连行情网关拉取（只读）→ 成功写回节点（结果写回节点：工作台实体与消息块的「仅本地」不同） */
  const fetchKline = async (target: { symbol: string; period: KlinePeriod; adjust: KlineAdjust }): Promise<void> => {
    if (loading || !target.symbol) return
    setLoading(true)
    setError(undefined)
    try {
      const res = await fetch(
        `/api/finance/kline?symbol=${encodeURIComponent(target.symbol)}&period=${target.period}&adjust=${target.adjust}&indicators=VOL&limit=250`,
      )
      const body = (await res.json().catch(() => undefined)) as { error?: string; kline?: unknown } | undefined
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`)
      const parsedBody = parseKlineSpec(JSON.stringify({ data: body?.kline }))
      if (!parsedBody.ok || !parsedBody.spec.data) throw new Error(parsedBody.ok ? '缺少 bars' : parsedBody.error)
      const ds = parsedBody.spec.data
      updateNodeData(id, {
        symbol: ds.symbol ?? target.symbol,
        period: ds.period ?? target.period,
        adjust: ds.adjust ?? target.adjust,
        ...(ds.name ? { name: ds.name } : {}),
        bars: ds.bars,
      } as Partial<CanvasKlineData>)
    } catch (err) {
      setError(`拉取失败：${(err as Error).message}`)
    } finally {
      setLoading(false)
    }
  }

  if (parsed.state === 'empty') {
    return (
      <NodeShell nodeId={id} selected={selected} resizable={{ minWidth: 320, minHeight: 220 }}>
        <div className="flex h-full flex-col gap-2 overflow-auto p-2.5">
          <div className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
            <LineChart className="size-3" />
            K 线行情
          </div>
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] text-muted-foreground">标的</span>
            <input
              className="nodrag h-6 rounded-md border border-input bg-card px-1.5 text-[11.5px] focus-visible:border-primary/40 focus-visible:outline-none"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void fetchKline({ symbol: symbol.trim(), period, adjust })
              }}
              placeholder="如 sh600519 / 600519.SH"
            />
          </label>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1 text-[10.5px] text-muted-foreground">
              周期
              <select
                className="nodrag h-6 rounded-md border border-input bg-card px-1 text-[10.5px] focus-visible:border-primary/40 focus-visible:outline-none"
                value={period}
                onChange={(e) => setPeriod(e.target.value as KlinePeriod)}
                aria-label="周期"
              >
                {KLINE_PERIODS.map((p) => (
                  <option key={p} value={p}>
                    {KLINE_PERIOD_LABELS[p]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1 text-[10.5px] text-muted-foreground">
              复权
              <select
                className="nodrag h-6 rounded-md border border-input bg-card px-1 text-[10.5px] focus-visible:border-primary/40 focus-visible:outline-none"
                value={adjust}
                onChange={(e) => setAdjust(e.target.value as KlineAdjust)}
                aria-label="复权"
              >
                {KLINE_ADJUSTS.map((a) => (
                  <option key={a} value={a}>
                    {KLINE_ADJUST_LABELS[a]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button
            type="button"
            className="nodrag flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-md bg-primary text-[11.5px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            disabled={loading || !symbol.trim()}
            onClick={() => void fetchKline({ symbol: symbol.trim(), period, adjust })}
          >
            {loading ? <Loader2 className="size-3 animate-spin" /> : <LineChart className="size-3" />}
            {loading ? '拉取中…' : '拉取行情'}
          </button>
          {error && <div className="shrink-0 text-[10.5px] leading-snug text-rose-600">{error}</div>}
          <div className="mt-auto text-[10px] leading-relaxed text-muted-foreground">
            直连行情网关（只读）；也可让 Agent 用 fin_kline 拉取后经 canvas_write 写入，或从 K 线块「送上画布」。
          </div>
        </div>
      </NodeShell>
    )
  }

  if (parsed.state === 'invalid') {
    return (
      <NodeShell nodeId={id} selected={selected} resizable={{ minWidth: 320, minHeight: 220 }}>
        <div className="flex h-full flex-col items-center justify-center gap-1.5 p-3 text-center">
          <TriangleAlert className="size-4 text-amber-600" />
          <div className="text-[11px] leading-snug text-muted-foreground">K 线数据损坏：{parsed.error}</div>
        </div>
      </NodeShell>
    )
  }

  const { dataset, indicators, annotations } = parsed
  const label = klineDefaultTitle(dataset)
  const periodLabel = dataset.period ? KLINE_PERIOD_LABELS[dataset.period] ?? dataset.period : undefined

  return (
    <NodeShell nodeId={id} selected={selected} resizable={{ minWidth: 380, minHeight: 260 }}>
      <div className="flex h-full flex-col overflow-hidden rounded-[inherit]">
        <div className="flex shrink-0 items-center gap-1.5 border-b px-2.5 py-1.5 text-[10px] text-muted-foreground">
          <span className="truncate text-[11px] font-medium text-foreground">{label}</span>
          {periodLabel && <span className="shrink-0">{periodLabel}</span>}
          {dataset.symbol && <span className="shrink-0 rounded bg-muted px-1 leading-4">{dataset.symbol}</span>}
          <button
            type="button"
            className="nodrag ml-auto flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 hover:bg-accent hover:text-foreground disabled:opacity-50"
            title="重新拉取当前周期行情"
            disabled={loading || !dataset.symbol}
            onClick={() => {
              if (dataset.symbol) {
                void fetchKline({ symbol: dataset.symbol, period: asPeriod(dataset.period), adjust: asAdjust(dataset.adjust) })
              }
            }}
          >
            <RefreshCw className={cn('size-3', loading && 'animate-spin')} />
            刷新
          </button>
        </div>

        {dataset.symbol && (
          <div className="flex shrink-0 flex-wrap items-center gap-1 border-b px-2.5 py-1">
            {SWITCH_PERIODS.map((p) => (
              <button
                key={p}
                type="button"
                className={cn(
                  'nodrag rounded px-1.5 py-0.5 text-[10px] transition-colors',
                  (dataset.period ?? 'day') === p ? 'bg-primary/10 font-medium text-foreground' : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
                )}
                disabled={loading}
                onClick={() => void fetchKline({ symbol: dataset.symbol!, period: p, adjust: asAdjust(dataset.adjust) })}
              >
                {KLINE_PERIOD_LABELS[p]}
              </button>
            ))}
            <span className="mx-0.5 h-3 w-px bg-border" />
            {KLINE_ADJUSTS.map((a) => (
              <button
                key={a}
                type="button"
                className={cn(
                  'nodrag rounded px-1.5 py-0.5 text-[10px] transition-colors',
                  (dataset.adjust ?? 'qfq') === a ? 'bg-primary/10 font-medium text-foreground' : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
                )}
                disabled={loading}
                onClick={() => void fetchKline({ symbol: dataset.symbol!, period: asPeriod(dataset.period), adjust: a })}
              >
                {KLINE_ADJUST_LABELS[a]}
              </button>
            ))}
            {error && <span className="truncate text-[10px] text-rose-600">{error}</span>}
          </div>
        )}

        {/* 图表区内滚动 / 拖动归图表自身（滚轮缩放 + 拖动平移行情），不触发画布缩放与节点拖动；
            节点拖动与缩放走标题栏 / 边框 / 缩放手柄 */}
        <div className="canvas-kline-frame nodrag nowheel min-h-0 flex-1 overflow-hidden p-1.5">
          <KlineCanvas dataset={dataset} indicators={indicators} annotations={annotations} label={label} />
        </div>
      </div>
    </NodeShell>
  )
}

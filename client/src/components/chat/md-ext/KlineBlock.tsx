/**
 * K 线块（```kline，M34 §6.1）：
 * - 解析走 lib/kline-spec（零依赖纯函数）；渲染走 lib/kline（klinecharts v10 懒加载独立 chunk）；
 * - 数据：内联 data 直接用；否则按 src 取会话交付件内容（由 src-dataset 统一通道，M6 零新增）；
 * - 周期 / 复权切换：块内小工具条直连 GET /api/finance/kline（只读网关，不重问 Agent；切换结果仅本地展示不改快照）；
 * - 流式期间显示源码；解析 / 取数失败 → 错误卡 + 源码回退；渲染失败 → 帧内提示（源码仍可查看）；
 * - 工具条：源码开关 / 全屏 / 复制 / 送上画布（bars 内联落为 kline 节点，节点内可继续切周期）。
 */
import * as React from 'react'
import { toast } from 'sonner'
import { FileCode2, Frame, Maximize2, TriangleAlert } from 'lucide-react'
import {
  klineDefaultTitle,
  KLINE_ADJUST_LABELS,
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
import { CopyButton } from './CopyButton'
import { Overlay } from './Overlay'
import { useSrcDataset } from './src-dataset'
import { useStreaming } from './streaming'

const SWITCH_PERIODS: readonly KlinePeriod[] = ['day', 'week', 'month']
const SWITCH_ADJUSTS: readonly KlineAdjust[] = ['qfq', 'hfq', 'none']

interface KlinePayload {
  dataset: KlineDataset
  /** 快照文件自带的渲染配置（块内缺省时兜底） */
  indicators: KlineIndicator[]
  annotations: KlineAnnotation[]
}

/** 快照 JSON → payload（bars + 自带 indicators/annotations 一并过解析器校验归一） */
function parseSnapshotPayload(json: Record<string, unknown>): { ok: true; payload: KlinePayload } | { ok: false; error: string } {
  const wrapped = {
    data: json,
    ...(json.indicators !== undefined ? { indicators: json.indicators } : {}),
    ...(json.annotations !== undefined ? { annotations: json.annotations } : {}),
  }
  const parsed = parseKlineSpec(JSON.stringify(wrapped))
  if (!parsed.ok || !parsed.spec.data) {
    return { ok: false, error: parsed.ok ? '缺少 bars' : parsed.error }
  }
  return { ok: true, payload: { dataset: parsed.spec.data, indicators: parsed.spec.indicators, annotations: parsed.spec.annotations } }
}

function SourceFallback({ code }: { code: string }): React.JSX.Element {
  return (
    <pre className="md-code-plain">
      <code>{code}</code>
    </pre>
  )
}

export function KlineBlock({ code, title }: { code: string; title?: string }): React.JSX.Element {
  const streaming = useStreaming()
  const parsed = React.useMemo(() => parseKlineSpec(code), [code])
  const spec = parsed.ok ? parsed.spec : undefined
  const [showSource, setShowSource] = React.useState(false)
  const [zoom, setZoom] = React.useState(false)
  const [override, setOverride] = React.useState<KlineDataset | undefined>(undefined)
  const [switching, setSwitching] = React.useState<{ period: KlinePeriod; adjust: KlineAdjust } | undefined>(undefined)
  const [switchError, setSwitchError] = React.useState<string | undefined>(undefined)
  const inlinePayload = spec?.data
    ? { dataset: spec.data, indicators: spec.indicators, annotations: spec.annotations }
    : undefined
  const fetched = useSrcDataset<KlinePayload>(spec?.src, inlinePayload, parseSnapshotPayload, 'K 线快照')

  /** 块内是否显式给出字段（缺省时退回快照自带配置） */
  const explicit = React.useMemo(() => {
    try {
      const obj = JSON.parse(code) as Record<string, unknown>
      return { indicators: obj.indicators !== undefined, annotations: obj.annotations !== undefined }
    } catch {
      return { indicators: false, annotations: false }
    }
  }, [code])

  if (streaming) return <SourceFallback code={code} />

  if (!parsed.ok) {
    return (
      <div className="md-chart-error">
        <div className="md-chart-error-head">
          <TriangleAlert className="size-3.5 shrink-0" />
          <span>K 线配置无效：{parsed.error}</span>
        </div>
        <SourceFallback code={code} />
      </div>
    )
  }

  if (fetched.error) {
    return (
      <div className="md-chart-error">
        <div className="md-chart-error-head">
          <TriangleAlert className="size-3.5 shrink-0" />
          <span>{fetched.error}</span>
        </div>
        <SourceFallback code={code} />
      </div>
    )
  }

  const dataset = override ?? fetched.payload?.dataset
  const indicators = explicit.indicators ? spec!.indicators : fetched.payload?.indicators ?? spec!.indicators
  const annotations = explicit.annotations ? spec!.annotations : fetched.payload?.annotations ?? spec!.annotations
  const label = title || spec!.title || klineDefaultTitle(dataset)
  const periodLabel = dataset?.period ? KLINE_PERIOD_LABELS[dataset.period] ?? dataset.period : undefined

  /** 送上画布：bars 内联落为 kline 节点（节点内可切周期 / 复权，互不联动） */
  const toCanvas = async (): Promise<void> => {
    if (!dataset?.bars?.length) return
    const id = await useCanvasStore.getState().sendKline({
      ...(dataset.symbol ? { symbol: dataset.symbol } : {}),
      ...(dataset.name ? { name: dataset.name } : {}),
      ...(dataset.period ? { period: dataset.period } : {}),
      ...(dataset.adjust ? { adjust: dataset.adjust } : {}),
      bars: dataset.bars,
      ...(indicators.length > 0 ? { indicators } : {}),
      ...(annotations.length > 0 ? { annotations } : {}),
    })
    if (id) toast('已送上画布 · 顶部「画布」Tab 查看')
  }

  const switchTo = async (period: KlinePeriod, adjust: KlineAdjust): Promise<void> => {
    const symbol = dataset?.symbol
    if (!symbol) return
    if (switching) return
    setSwitching({ period, adjust })
    setSwitchError(undefined)
    try {
      // 仅取 bars（指标由前端内核本地计算，避免重复计算）；数据源不动快照
      const res = await fetch(
        `/api/finance/kline?symbol=${encodeURIComponent(symbol)}&period=${period}&adjust=${adjust}&indicators=VOL&limit=250`,
      )
      const body = (await res.json().catch(() => undefined)) as { error?: string; kline?: unknown } | undefined
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`)
      const parsedBody = parseKlineSpec(JSON.stringify({ data: body?.kline }))
      if (!parsedBody.ok || !parsedBody.spec.data) throw new Error(parsedBody.ok ? '缺少 bars' : parsedBody.error)
      setOverride(parsedBody.spec.data)
    } catch (err) {
      setSwitchError(`切换失败：${(err as Error).message}`)
    } finally {
      setSwitching(undefined)
    }
  }

  return (
    <figure className="md-klineblock">
      <div className="md-block-bar">
        <span className="md-block-title">{label}</span>
        <span className="md-block-lang">kline</span>
        {periodLabel && <span className="md-block-meta">{periodLabel}</span>}
        <span className="md-block-meta">{indicators.join('·')}</span>
        {override && <span className="md-block-meta">实拉视图</span>}
        <span className="md-block-actions">
          {dataset && (
            <button type="button" className="md-block-btn" title="送上画布（落为 K 线节点，可切换周期 / 复权）" onClick={() => void toCanvas()}>
              <Frame className="size-3.5" />
              <span>送上画布</span>
            </button>
          )}
          <button
            type="button"
            className={cn('md-block-btn', showSource && 'is-active')}
            title={showSource ? '收起源码' : '查看源码'}
            onClick={() => setShowSource((v) => !v)}
          >
            <FileCode2 className="size-3.5" />
            <span>源码</span>
          </button>
          <button type="button" className="md-block-btn" title="全屏查看" onClick={() => setZoom(true)}>
            <Maximize2 className="size-3.5" />
            <span>全屏</span>
          </button>
          <CopyButton text={code} />
        </span>
      </div>

      {showSource && <SourceFallback code={code} />}

      {dataset?.symbol && (
        <div className="md-kline-switch">
          {SWITCH_PERIODS.map((p) => (
            <button
              key={p}
              type="button"
              className={cn('md-block-btn', (dataset.period ?? 'day') === p && !override && 'is-active')}
              disabled={switching !== undefined}
              onClick={() => void switchTo(p, (dataset.adjust as KlineAdjust) ?? 'qfq')}
            >
              {KLINE_PERIOD_LABELS[p]}
            </button>
          ))}
          <span className="md-kline-switch-divider" />
          {SWITCH_ADJUSTS.map((a) => (
            <button
              key={a}
              type="button"
              className={cn('md-block-btn', (dataset.adjust ?? 'qfq') === a && 'is-active')}
              disabled={switching !== undefined}
              onClick={() => void switchTo((dataset.period as KlinePeriod) ?? 'day', a)}
            >
              {KLINE_ADJUST_LABELS[a]}
            </button>
          ))}
          {switching && <span className="md-block-meta">加载中…</span>}
          {switchError && <span className="md-kline-switch-error">{switchError}</span>}
        </div>
      )}

      {dataset ? (
        <KlineCanvas dataset={dataset} indicators={indicators} annotations={annotations} label={label} />
      ) : (
        <div className="md-kline-frame">
          <div className="md-kline-canvas" />
          <div className="md-chart-note">{fetched.loading ? '快照加载中…' : '暂无数据'}</div>
        </div>
      )}

      {dataset && (
        <Overlay open={zoom} title={label} onClose={() => setZoom(false)}>
          <KlineCanvas
            dataset={dataset}
            indicators={indicators}
            annotations={annotations}
            label={label}
            className="md-kline-canvas-zoom"
          />
        </Overlay>
      )}
    </figure>
  )
}

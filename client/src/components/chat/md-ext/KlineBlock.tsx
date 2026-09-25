/**
 * K 线块（```kline，M34 §6.1；M83 升级：工具条 / 阶段色带 / 落图 / 分析面板）：
 * - 解析走 lib/kline-spec（纯函数）；渲染走 chart/entry（klinecharts v10 懒加载独立 chunk）；
 * - 数据：内联 data 直接用；否则按 src 取会话交付件内容（由 src-dataset 统一通道，M6 零新增）；
 * - 周期 / 复权切换：块内小工具条直连 GET /api/finance/kline（只读网关，不重问 Agent；切换结果仅本地展示不改快照）；
 *   切换 = 叠加层强制失效（旧分析 / 落图 / 信号隐藏，防 ts 坐标错位——M83 §5.3）；
 * - 「智能分析」：直连 GET /api/finance/analysis → 面板 + 落图本地展示（不改快照，与周期切换同语义）；
 * - 流式期间显示源码；解析 / 取数失败 → 错误卡 + 源码回退；渲染失败 → 帧内提示（源码仍可查看）；
 * - 工具条：源码开关 / 全屏 / 复制 / 送上画布（bars 内联落为 kline 节点，节点内可继续切周期）。
 */
import * as React from 'react'
import { toast } from 'sonner'
import { FileCode2, Frame, Loader2, Maximize2, Sparkles, TriangleAlert } from 'lucide-react'
import type { Drawing, KlineAnalysis, MainIndicator, SignalSpec, SubIndicator } from '@multi-agent/shared'
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
import { parseKlineAnalysis } from '../../../lib/kline-analysis'
import { cn } from '../../../lib/utils'
import { useCanvasStore } from '../../../stores/canvas-store'
import { KlineCanvas } from '../../finance/KlineCanvas'
import { KlineAnalysisPanel } from '../../finance/chart/KlineAnalysisPanel'
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
  /** M83：快照携带的落图 / 信号 / 分析（快照分析产物回放） */
  drawings: Drawing[]
  signal: SignalSpec | null
  analysis?: KlineAnalysis
  mainIndicator?: MainIndicator | 'none'
  subIndicator?: SubIndicator | 'none'
  showPhases?: boolean
}

/** 快照 JSON → payload（bars + 自带渲染 / 落图 / 分析一并过解析器校验归一；导出供跨端契约 fixture 测试） */
export function parseSnapshotPayload(json: Record<string, unknown>): { ok: true; payload: KlinePayload } | { ok: false; error: string } {
  const render = (typeof json.render === 'object' && json.render !== null ? json.render : {}) as Record<string, unknown>
  const wrapped = {
    data: json,
    ...(json.indicators !== undefined ? { indicators: json.indicators } : {}),
    ...(json.annotations !== undefined ? { annotations: json.annotations } : {}),
    ...(json.drawings !== undefined ? { drawings: json.drawings } : {}),
    ...(json.signal !== undefined ? { signal: json.signal } : {}),
    ...(json.analysis !== undefined ? { analysis: json.analysis } : {}),
    ...(render.mainIndicator !== undefined ? { mainIndicator: render.mainIndicator } : {}),
    ...(render.subIndicator !== undefined ? { subIndicator: render.subIndicator } : {}),
    ...(render.showPhases !== undefined ? { showPhases: render.showPhases } : {}),
  }
  const parsed = parseKlineSpec(JSON.stringify(wrapped))
  const spec = parsed.ok ? parsed.spec : undefined
  if (!spec || !spec.data) {
    return { ok: false, error: parsed.ok ? '缺少 bars' : parsed.error }
  }
  return {
    ok: true,
    payload: {
      dataset: spec.data,
      indicators: spec.indicators,
      annotations: spec.annotations,
      drawings: spec.drawings,
      signal: spec.signal,
      ...(spec.analysis ? { analysis: spec.analysis } : {}),
      ...(spec.mainIndicator !== undefined ? { mainIndicator: spec.mainIndicator } : {}),
      ...(spec.subIndicator !== undefined ? { subIndicator: spec.subIndicator } : {}),
      ...(spec.showPhases !== undefined ? { showPhases: spec.showPhases } : {}),
    },
  }
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
  /** M83：「智能分析」本地结果（不改快照，与周期切换同语义） */
  const [localAnalysis, setLocalAnalysis] = React.useState<KlineAnalysis | undefined>(undefined)
  const [analyzing, setAnalyzing] = React.useState(false)
  const [analyzeError, setAnalyzeError] = React.useState<string | undefined>(undefined)
  /** M83：阶段色带显隐（用户覆盖；缺省按数据推导） */
  const [phasesOn, setPhasesOn] = React.useState<boolean | undefined>(undefined)
  const inlinePayload = spec?.data
    ? {
        dataset: spec.data,
        indicators: spec.indicators,
        annotations: spec.annotations,
        drawings: spec.drawings,
        signal: spec.signal,
        ...(spec.analysis ? { analysis: spec.analysis } : {}),
        ...(spec.mainIndicator !== undefined ? { mainIndicator: spec.mainIndicator } : {}),
        ...(spec.subIndicator !== undefined ? { subIndicator: spec.subIndicator } : {}),
        ...(spec.showPhases !== undefined ? { showPhases: spec.showPhases } : {}),
      }
    : undefined
  const fetched = useSrcDataset<KlinePayload>(spec?.src, inlinePayload, parseSnapshotPayload, 'K 线快照')

  /** 块内是否显式给出字段（缺省时退回快照自带配置；render 对象形态同视为显式） */
  const explicit = React.useMemo(() => {
    try {
      const obj = JSON.parse(code) as Record<string, unknown>
      const render = typeof obj.render === 'object' && obj.render !== null ? (obj.render as Record<string, unknown>) : {}
      return {
        indicators: obj.indicators !== undefined,
        annotations: obj.annotations !== undefined,
        mainIndicator: obj.mainIndicator !== undefined || render.mainIndicator !== undefined,
        subIndicator: obj.subIndicator !== undefined || render.subIndicator !== undefined,
        showPhases: obj.showPhases !== undefined || render.showPhases !== undefined,
        drawings: obj.drawings !== undefined,
        signal: obj.signal !== undefined,
        analysis: obj.analysis !== undefined,
      }
    } catch {
      return {
        indicators: false,
        annotations: false,
        mainIndicator: false,
        subIndicator: false,
        showPhases: false,
        drawings: false,
        signal: false,
        analysis: false,
      }
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
  // M83：叠加层（分析 / 落图 / 信号）——周期切换（override 激活）时整体失效，防 ts 坐标错位
  const overrideActive = override !== undefined
  const analysis = overrideActive
    ? undefined
    : localAnalysis ?? (explicit.analysis ? spec!.analysis : fetched.payload?.analysis ?? spec!.analysis)
  const drawings = overrideActive ? [] : explicit.drawings ? spec!.drawings : fetched.payload?.drawings ?? spec!.drawings
  const signal = overrideActive ? null : explicit.signal ? spec!.signal : fetched.payload?.signal ?? spec!.signal
  const phases = analysis?.phases.bands ?? []
  const mainIndicator = explicit.mainIndicator ? spec!.mainIndicator : fetched.payload?.mainIndicator ?? spec!.mainIndicator
  const subIndicator = explicit.subIndicator ? spec!.subIndicator : fetched.payload?.subIndicator ?? spec!.subIndicator
  const showPhases = phasesOn ?? (explicit.showPhases ? spec!.showPhases : fetched.payload?.showPhases ?? spec!.showPhases) ?? phases.length > 0
  const label = title || spec!.title || klineDefaultTitle(dataset)

  /** 智能分析（M83）：直连网关 → 面板 + 落图本地展示（不改快照） */
  const runAnalysis = async (): Promise<void> => {
    const symbol = dataset?.symbol
    if (!symbol || analyzing) return
    setAnalyzing(true)
    setAnalyzeError(undefined)
    try {
      const res = await fetch(
        `/api/finance/analysis?symbol=${encodeURIComponent(symbol)}&period=${dataset?.period ?? 'day'}&adjust=${dataset?.adjust ?? 'qfq'}&limit=250`,
      )
      const body = (await res.json().catch(() => undefined)) as { error?: string; analysis?: unknown } | undefined
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`)
      const result = parseKlineAnalysis(body?.analysis)
      if (!result.value) throw new Error(result.warnings[0] ?? '分析结果无效')
      setLocalAnalysis(result.value)
    } catch (err) {
      setAnalyzeError(`分析失败：${(err as Error).message}`)
    } finally {
      setAnalyzing(false)
    }
  }

  /** 送上画布：bars 内联落为 kline 节点（叠加层随带：drawings / analysis 一并入节点，可继续切周期） */
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
      ...(drawings.length > 0 ? { drawings } : {}),
      ...(analysis ? { analysis } : {}),
    })
    if (id) toast.success('已送上画布 · 顶部「画布」Tab 查看')
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
      // M83：bars 更换 → 叠加层强制失效（分析 / 落图 / 信号隐藏，重取分析后恢复）
      setLocalAnalysis(undefined)
      setAnalyzeError(undefined)
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
        {override && <span className="md-block-meta">实拉视图</span>}
        {analysis && <span className="md-block-meta">已分析</span>}
        <span className="md-block-actions">
          {dataset?.symbol && !analysis && (
            <button
              type="button"
              className="md-block-btn"
              title="智能分析（阶段 / 情绪 / 关键位 → 面板 + 落图；不改快照）"
              disabled={analyzing}
              onClick={() => void runAnalysis()}
            >
              {analyzing ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
            </button>
          )}
          {dataset && (
            <button type="button" className="md-block-btn" title="送上画布（落为 K 线节点，可切换周期 / 复权）" onClick={() => void toCanvas()}>
              <Frame className="size-3.5" />
            </button>
          )}
          <button
            type="button"
            className={cn('md-block-btn', showSource && 'is-active')}
            title={showSource ? '收起源码' : '查看源码'}
            onClick={() => setShowSource((v) => !v)}
          >
            <FileCode2 className="size-3.5" />
          </button>
          <button type="button" className="md-block-btn" title="全屏查看" onClick={() => setZoom(true)}>
            <Maximize2 className="size-3.5" />
          </button>
          <CopyButton text={code} compact />
        </span>
      </div>

      {showSource && <SourceFallback code={code} />}

      {dataset?.symbol && (
        <div className="md-kline-switch">
          {SWITCH_PERIODS.map((p) => (
            <button
              key={p}
              type="button"
              className={cn('md-block-btn', (dataset.period ?? 'day') === p && 'is-active')}
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
          {overrideActive && <span className="md-block-meta">已切换：分析 / 落图已失效</span>}
        </div>
      )}

      {dataset ? (
        <KlineCanvas
          dataset={dataset}
          indicators={indicators}
          annotations={annotations}
          drawings={drawings}
          signal={signal}
          phases={phases}
          mainIndicator={mainIndicator}
          subIndicator={subIndicator}
          showPhases={showPhases}
          onShowPhasesChange={setPhasesOn}
          label={label}
        />
      ) : (
        <div className="md-kline-frame">
          <div className="md-kline-canvas" />
          <div className="md-chart-note">{fetched.loading ? '快照加载中…' : '暂无数据'}</div>
        </div>
      )}

      {analyzeError && <div className="md-chart-note is-error">{analyzeError}</div>}
      {analysis && <KlineAnalysisPanel analysis={analysis} onTogglePhases={() => setPhasesOn(!showPhases)} />}

      {dataset && (
        <Overlay open={zoom} title={label} onClose={() => setZoom(false)}>
          <KlineCanvas
            dataset={dataset}
            indicators={indicators}
            annotations={annotations}
            drawings={drawings}
            signal={signal}
            phases={phases}
            mainIndicator={mainIndicator}
            subIndicator={subIndicator}
            showPhases={showPhases}
            onShowPhasesChange={setPhasesOn}
            label={label}
            className="md-kline-canvas-zoom"
          />
        </Overlay>
      )}
    </figure>
  )
}

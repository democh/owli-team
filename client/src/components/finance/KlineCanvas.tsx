/**
 * K 线画布宿主（M83 §5.1 升级版：块 / 节点 / 全屏共用）：
 * - 动态 import 唯一入口 chart/entry（klinecharts 独立 chunk，不进主包）；
 * - 指标工具条：主图（无/布林/肯特纳/SAR/一目均衡/超级趋势/唐奇安/均线束）+ 副图（成交量/MACD/KDJ/RSI）
 *   + 阶段色带开关；窄容器（<560px，如画布节点）主图指标自动收为下拉（compact）；
 * - 受控重建：指标 / 色带 / 落图（drawings / signal）变化一律经 handle.update（不重建图表）；
 * - 数据变更（dataset 引用变化）整图重建；0 宽恢复由内核层处理（entry.ts）。
 */
import * as React from 'react'
import { Download } from 'lucide-react'
import type { Drawing, KlinePhaseBand, MainIndicator, SignalSpec, SubIndicator } from '@multi-agent/shared'
import { cn } from '../../lib/utils'
import {
  deriveMainIndicator,
  deriveSubIndicator,
  type KlineAnnotation,
  type KlineDataset,
  type KlineIndicator,
} from '../../lib/kline-spec'

/** 与 chart/entry 的 KlineHandle 结构一致（不静态引入 klinecharts，保持 chunk 懒加载） */
interface KlineHandle {
  update(
    patch: Partial<{
      mainIndicator: MainIndicator | 'none'
      subIndicator: SubIndicator | 'none'
      showPhases: boolean
      phases: KlinePhaseBand[]
      drawings: Drawing[]
      signal: SignalSpec | null
    }>,
  ): void
  exportPng(filename: string): void
  resize(): void
  dispose(): void
}

const NO_ANNOTATIONS: KlineAnnotation[] = []

/** 主图指标选项（顺序与产品口径一致：无 → 通道 → 云图 → 趋势） */
const MAIN_OPTIONS: ReadonlyArray<{ key: MainIndicator | 'none'; label: string }> = [
  { key: 'none', label: '无' },
  { key: 'BOLL', label: '布林' },
  { key: 'KCB', label: '肯特纳' },
  { key: 'SAR', label: 'SAR' },
  { key: 'ICHIMOKU', label: '一目均衡' },
  { key: 'ST', label: '超级趋势' },
  { key: 'DONCHIAN', label: '唐奇安' },
  { key: 'MA', label: '均线束' },
]

/** 副图指标选项 */
const SUB_OPTIONS: ReadonlyArray<{ key: SubIndicator | 'none'; label: string }> = [
  { key: 'VOL', label: '成交量' },
  { key: 'MACD', label: 'MACD' },
  { key: 'KDJ', label: 'KDJ' },
  { key: 'RSI', label: 'RSI' },
  { key: 'none', label: '无' },
]

export function KlineCanvas({
  dataset,
  indicators,
  annotations = NO_ANNOTATIONS,
  drawings,
  signal,
  phases,
  mainIndicator,
  subIndicator,
  showPhases,
  onShowPhasesChange,
  label,
  className,
  toolbar = true,
}: {
  dataset: KlineDataset
  /** 旧字段（块 / 快照的渲染面板列表）：用于推导主 / 副图缺省 */
  indicators?: KlineIndicator[]
  annotations?: KlineAnnotation[]
  /** M83：落图（分析与策略产出） */
  drawings?: Drawing[]
  /** M83：策略信号（交易计划落图） */
  signal?: SignalSpec | null
  /** M83：逐根阶段（色带数据源；analysis.bands） */
  phases?: KlinePhaseBand[]
  /** M83：主图 / 副图（显式优先；缺省按 indicators 推导） */
  mainIndicator?: MainIndicator | 'none'
  subIndicator?: SubIndicator | 'none'
  /** M83：阶段色带显隐（缺省：有 phases 时 true）；传 onShowPhasesChange 则为受控 */
  showPhases?: boolean
  /** 阶段开关变更回调（受控模式；缺省内部自持） */
  onShowPhasesChange?: (next: boolean) => void
  label?: string
  className?: string
  /** 指标工具条（默认显示；画布节点自动 compact） */
  toolbar?: boolean
}): React.JSX.Element {
  const ref = React.useRef<HTMLDivElement>(null)
  const handleRef = React.useRef<KlineHandle | undefined>(undefined)
  const [state, setState] = React.useState<'loading' | 'ready' | 'failed'>('loading')
  const [compact, setCompact] = React.useState(false)
  // 工具条用户覆盖（undefined = 跟随 props 推导；dataset 变化时重置）
  const [mainOverride, setMainOverride] = React.useState<MainIndicator | 'none' | undefined>(undefined)
  const [subOverride, setSubOverride] = React.useState<SubIndicator | 'none' | undefined>(undefined)
  const [phasesOverride, setPhasesOverride] = React.useState<boolean | undefined>(undefined)

  const effectiveMain = mainOverride ?? mainIndicator ?? deriveMainIndicator(indicators ?? [])
  const effectiveSub = subOverride ?? subIndicator ?? deriveSubIndicator(indicators ?? [])
  const effectivePhases = phasesOverride ?? showPhases ?? (phases?.length ?? 0) > 0

  // 最新值经 ref 传递（创建 effect 只在 dataset 变化时重建，避免闭包过期）
  const latest = React.useRef({ main: effectiveMain, sub: effectiveSub, phasesOn: effectivePhases, drawings, signal, phases, annotations, label })
  latest.current = { main: effectiveMain, sub: effectiveSub, phasesOn: effectivePhases, drawings, signal, phases, annotations, label }

  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    let disposed = false
    setState('loading')
    setMainOverride(undefined)
    setSubOverride(undefined)
    setPhasesOverride(undefined)
    void import('./chart/entry')
      .then(async (mod) => {
        if (disposed) return
        // M85 修复：等待容器尺寸稳定两帧再 init——React Flow 首帧可能给出过渡尺寸，
        // 而 klinecharts 会把 init 尺寸固化为内层 style 像素高（此后 resize 也拉不回）
        {
          let prev = { w: el.clientWidth, h: el.clientHeight }
          for (let i = 0; i < 12; i++) {
            await new Promise((r) => requestAnimationFrame(r))
            if (disposed) return
            const cur = { w: el.clientWidth, h: el.clientHeight }
            if (cur.w === prev.w && cur.h === prev.h && cur.h > 0 && cur.w > 0) break
            prev = cur
          }
        }
        try {
          const cur = latest.current
          handleRef.current = mod.createKlineChart(el, {
            dataset,
            mainIndicator: cur.main,
            subIndicator: cur.sub,
            showPhases: cur.phasesOn,
            phases: cur.phases ?? [],
            annotations: cur.annotations,
            drawings: cur.drawings ?? [],
            signal: cur.signal ?? null,
            ...(cur.label ? { label: cur.label } : {}),
          })
          setState('ready')
        } catch {
          if (!disposed) setState('failed')
        }
      })
      .catch(() => {
        if (!disposed) setState('failed')
      })
    return () => {
      disposed = true
      handleRef.current?.dispose()
      handleRef.current = undefined
    }
  }, [dataset])

  // 受控更新：指标 / 色带 / 落图变化（不重建图表）
  React.useEffect(() => {
    handleRef.current?.update({
      mainIndicator: effectiveMain,
      subIndicator: effectiveSub,
      showPhases: effectivePhases,
      phases: phases ?? [],
      drawings: drawings ?? [],
      signal: signal ?? null,
    })
  }, [effectiveMain, effectiveSub, effectivePhases, phases, drawings, signal])

  // 窄容器（画布节点等）：主图指标收为下拉（compact）
  React.useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      setCompact(el.clientWidth > 0 && el.clientWidth < 560)
    })
    ro.observe(el)
    setCompact(el.clientWidth > 0 && el.clientWidth < 560)
    return () => ro.disconnect()
  }, [])

  const onExport = (): void => {
    handleRef.current?.exportPng(`${label || 'kline'}.png`)
  }

  /** 阶段开关：受控（宿主回传）优先；否则内部自持 */
  const onToolbarPhases = (): void => {
    const next = !effectivePhases
    if (onShowPhasesChange) onShowPhasesChange(next)
    else setPhasesOverride(next)
  }

  return (
    <div className="md-kline-frame">
      {/* 工具条容器（M85 布局修复）：所有工具条占 grid 首行，画布独占 1fr 行——
          否则 1fr 行会被第二个工具条吃掉（拉成空白），画布落隐式行被推出可视 */}
      <div className="md-kline-bars">
      {toolbar && state === 'ready' && (
        <div className="md-kline-toolbar">
          <span className="md-kline-group">
            <span className="md-kline-toolbar-label">主图</span>
            {compact ? (
              <select
                className="md-kline-select"
                value={effectiveMain}
                onChange={(e) => setMainOverride(e.target.value as MainIndicator | 'none')}
              >
                {MAIN_OPTIONS.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              MAIN_OPTIONS.map((o) => (
                <button
                  key={o.key}
                  type="button"
                  className={cn('md-kline-chip', effectiveMain === o.key && 'is-active')}
                  onClick={() => setMainOverride(o.key)}
                >
                  {o.label}
                </button>
              ))
            )}
          </span>
          <span className="md-kline-group">
            <span className="md-kline-toolbar-label">副图</span>
            {compact ? (
              <select
                className="md-kline-select"
                value={effectiveSub}
                onChange={(e) => setSubOverride(e.target.value as SubIndicator | 'none')}
              >
                {SUB_OPTIONS.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              SUB_OPTIONS.map((o) => (
                <button
                  key={o.key}
                  type="button"
                  className={cn('md-kline-chip', effectiveSub === o.key && 'is-active')}
                  onClick={() => setSubOverride(o.key)}
                >
                  {o.label}
                </button>
              ))
            )}
          </span>
          <span className="md-kline-group md-kline-group-end">
            <button
              type="button"
              className={cn('md-kline-chip', effectivePhases && 'is-active')}
              title="阶段色带（吸筹 / 拉升 / 派发等背景着色）"
              onClick={onToolbarPhases}
            >
              阶段
            </button>
            <button type="button" className="md-kline-chip" title="导出白底 PNG（含全部落图）" onClick={onExport}>
              <Download className="size-3" />
              <span>截图</span>
            </button>
          </span>
        </div>
      )}
      </div>
      <div ref={ref} className={cn('md-kline-canvas', className)} data-state={state} />
      {state === 'loading' && <div className="md-chart-note">K 线加载中…</div>}
      {state === 'failed' && <div className="md-chart-note is-error">K 线渲染失败（渲染内核不可用）</div>}
    </div>
  )
}

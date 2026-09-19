/**
 * Chart 图表块（```chart / ```echarts）：JSON → echarts。
 * - 解析走 lib/chart-spec（零依赖纯函数）；echarts 运行时由 lib/chart 动态 import（独立 chunk）；
 * - 流式期间显示源码；配置错误 → 错误卡 + 源码回退；
 * - 工具条：源码开关 / 全屏 / 复制；ChartCanvas 封装 init/ResizeObserver/dispose 生命周期。
 */
import * as React from 'react'
import { FileCode2, Maximize2, TriangleAlert } from 'lucide-react'
import { parseChartSpec, type ChartSpec } from '../../../lib/chart-spec'
import { cn } from '../../../lib/utils'
import { CopyButton } from './CopyButton'
import { Overlay } from './Overlay'
import { useStreaming } from './streaming'

/** 与 lib/chart 的 ChartHandle 结构一致（不静态引入 echarts，保持 chunk 懒加载） */
interface ChartHandle {
  dispose(): void
}

function ChartCanvas({ spec, className }: { spec: ChartSpec; className?: string }): React.JSX.Element {
  const ref = React.useRef<HTMLDivElement>(null)
  const [state, setState] = React.useState<'loading' | 'ready' | 'failed'>('loading')

  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    let disposed = false
    let handle: ChartHandle | undefined
    setState('loading')
    void import('../../../lib/chart')
      .then((mod) => {
        if (disposed) return
        try {
          handle = mod.createChart(el, spec)
          setState('ready')
        } catch {
          setState('failed')
        }
      })
      .catch(() => {
        if (!disposed) setState('failed')
      })
    return () => {
      disposed = true
      handle?.dispose()
    }
  }, [spec])

  return (
    <div className="md-chart-frame">
      <div ref={ref} className={cn(className, 'md-chart-canvas')} data-state={state} />
      {state === 'loading' && <div className="md-chart-note">图表加载中…</div>}
      {state === 'failed' && <div className="md-chart-note is-error">图表渲染失败（当前环境不支持 Canvas）</div>}
    </div>
  )
}

export function ChartBlock({ code, title }: { code: string; title?: string }): React.JSX.Element {
  const streaming = useStreaming()
  const parsed = React.useMemo(() => parseChartSpec(code), [code])
  const [showSource, setShowSource] = React.useState(false)
  const [zoom, setZoom] = React.useState(false)

  if (streaming) {
    return (
      <pre className="md-code-plain">
        <code>{code}</code>
      </pre>
    )
  }

  if (!parsed.ok) {
    return (
      <div className="md-chart-error">
        <div className="md-chart-error-head">
          <TriangleAlert className="size-3.5 shrink-0" />
          <span>图表配置无效：{parsed.error}</span>
        </div>
        <pre className="md-code-plain">
          <code>{code}</code>
        </pre>
      </div>
    )
  }

  const spec = parsed.spec
  const label = title || spec.title || '图表'

  return (
    <figure className="md-chartblock">
      <div className="md-block-bar">
        <span className="md-block-title">{label}</span>
        <span className="md-block-lang">{spec.kind}</span>
        <span className="md-block-actions">
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

      {showSource && (
        <pre className="md-code-plain">
          <code>{code}</code>
        </pre>
      )}

      <ChartCanvas spec={spec} className="md-chart-canvas" />

      <Overlay open={zoom} title={label} onClose={() => setZoom(false)}>
        <ChartCanvas spec={spec} className="md-chart-canvas-zoom" />
      </Overlay>
    </figure>
  )
}

/**
 * K 线画布宿主（M34 §6.1）：消息块（KlineBlock）与画布节点（KlineNode）共用。
 * 唯一接触 klinecharts 的位置是 lib/kline（动态 import 独立 chunk，不进主包）。
 */
import * as React from 'react'
import { cn } from '../../lib/utils'
import type { KlineAnnotation, KlineDataset, KlineIndicator } from '../../lib/kline-spec'

/** 与 lib/kline 的 KlineHandle 结构一致（不静态引入 klinecharts，保持 chunk 懒加载） */
interface KlineHandle {
  resize(): void
  dispose(): void
}

const NO_ANNOTATIONS: KlineAnnotation[] = []

export function KlineCanvas({
  dataset,
  indicators,
  annotations = NO_ANNOTATIONS,
  label,
  className,
}: {
  dataset: KlineDataset
  indicators: KlineIndicator[]
  annotations?: KlineAnnotation[]
  label?: string
  className?: string
}): React.JSX.Element {
  const ref = React.useRef<HTMLDivElement>(null)
  const [state, setState] = React.useState<'loading' | 'ready' | 'failed'>('loading')

  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    let disposed = false
    let handle: KlineHandle | undefined
    setState('loading')
    void import('../../lib/kline')
      .then((mod) => {
        if (disposed) return
        try {
          handle = mod.createKline(el, { dataset, indicators, annotations, ...(label ? { label } : {}) })
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
  }, [dataset, indicators, annotations, label])

  return (
    <div className="md-kline-frame">
      <div ref={ref} className={cn('md-kline-canvas', className)} data-state={state} />
      {state === 'loading' && <div className="md-chart-note">K 线加载中…</div>}
      {state === 'failed' && <div className="md-chart-note is-error">K 线渲染失败（渲染内核不可用）</div>}
    </div>
  )
}

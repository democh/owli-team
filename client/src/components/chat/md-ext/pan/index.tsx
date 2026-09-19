/**
 * M54-A t3 / M54-B / M54-C：盘面统一入口 `PanView`（§7.1 / §7.9）——kind 分发 + ErrorBoundary + Suspense。
 *
 * - 四盘板（§4）全部按需懒加载（pan 目录整体单 chunk）；渲染失败一律回退 `fallback`
 *   （= 调用方静态表格，零回归路径）；
 * - 唯一有状态外壳：板内选中态不进会话存储（存储一律由 PanCard / 外壳注入，§7.9 约束①）；
 * - M54-C：会话级设施在此统一持有——GuaBoard 底部「亲手摇卦」→ 摇卦台（对照基线 = 本卡卦盘）；
 *   研习足迹（去重计数）由本外壳读写，子板经回调上报事件；无会话上下文全部静默降级；
 * - M54 续完善：摇卦台宿主上提至 AppLayout（PanTossHost，弹窗不随消息行回收 / 面板卸载消失）——
 *   本壳只发 openPanToss 请求；足迹经 subscribeTrail 订阅跳组件刷新。
 */
import * as React from 'react'
import { useUiStore } from '../../../../stores/ui-store'
import type { PanModel } from './model'
import { formatTrail, readTrail, recordAsk, recordPalace, recordView, subscribeTrail, type PnTrail } from './trail'

const BaziBoard = React.lazy(() => import('./BaziBoard').then((m) => ({ default: m.BaziBoard })))
const ZiweiBoard = React.lazy(() => import('./ZiweiBoard').then((m) => ({ default: m.ZiweiBoard })))
const GuaBoard = React.lazy(() => import('./GuaBoard').then((m) => ({ default: m.GuaBoard })))
const NatalWheel = React.lazy(() => import('./NatalWheel').then((m) => ({ default: m.NatalWheel })))

class PanBoundary extends React.Component<{ fallback?: React.ReactNode; children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  render(): React.ReactNode {
    return this.state.failed ? this.props.fallback ?? null : this.props.children
  }
}

export interface PanViewProps {
  model: PanModel
  /** 草稿回填（缺省 noop）；板内不直接触达 Composer */
  onAsk?: (text: string) => void
  /** 不可用 / 加载中 / 失败的兜底（调用方传静态表格） */
  fallback?: React.ReactNode
  /** 流式冻结等只读场景（M54-A 由 PanCard 在流式期回退表格实现，此处保留契约位） */
  interactive?: boolean
  /** 会话 id（研习足迹键）；缺省（独立渲染 / 单测）→ 不记录、不显示足迹 */
  sessionId?: string
  /** 盘来源去重键（PanCard 传 messageId；面板传 chart.id） */
  sourceKey?: string
  /** 盘标题（足迹去重兜底 / 对照展示用） */
  title?: string
}

export function PanView({ model, onAsk, fallback, sessionId, sourceKey, title }: PanViewProps): React.JSX.Element {
  const openPanToss = useUiStore((s) => s.openPanToss)
  const [trail, setTrail] = React.useState<PnTrail | null>(null)

  // 看过一张盘（来源去重；无会话上下文不记录——§5.5 本地私密）
  React.useEffect(() => {
    if (!sessionId) return
    setTrail(recordView(sessionId, sourceKey ?? `${model.kind}:${title ?? ''}`))
  }, [sessionId, sourceKey, model.kind, title])

  // 足迹订阅（M54 续完善）：摇卦台宿主在 AppLayout——成卦 / 请教程不在本组件内发生，订阅跳组件刷新
  React.useEffect(() => {
    if (!sessionId) return
    return subscribeTrail((sid) => {
      if (sid === sessionId) setTrail(readTrail(sessionId))
    })
  }, [sessionId])

  /** 统一草稿回填：回调外壳 + 记「请教」足迹 */
  const ask = React.useCallback(
    (text: string) => {
      onAsk?.(text)
      if (sessionId) setTrail(recordAsk(sessionId))
    },
    [onAsk, sessionId],
  )

  /** 点宫事件（紫微）：记足迹 */
  const onPalace = React.useCallback(
    (zhi: string) => {
      if (sessionId) setTrail(recordPalace(sessionId, zhi))
    },
    [sessionId],
  )

  const board =
    model.kind === 'bazi' ? (
      <BaziBoard model={model} onAsk={ask} />
    ) : model.kind === 'ziwei' ? (
      <ZiweiBoard model={model} onAsk={ask} onPalace={onPalace} />
    ) : model.kind === 'gua' ? (
      <GuaBoard
        model={model}
        onOpenToss={() =>
          openPanToss({
            compare: { title: model.ben, yao: model.yao.map((y) => ({ yin: y.yin })) },
            sessionId,
          })
        }
      />
    ) : (
      <NatalWheel model={model} onAsk={ask} />
    )

  const trailText = trail ? formatTrail(trail) : ''

  if (!board) return <>{fallback ?? null}</>

  return (
    <>
      <PanBoundary fallback={fallback}>
        <React.Suspense fallback={fallback ?? null}>{board}</React.Suspense>
      </PanBoundary>
      {trailText !== '' ? (
        <div className="pn-trail" aria-label="研习足迹（本地、只读）">
          本次研习：{trailText}
        </div>
      ) : null}
    </>
  )
}

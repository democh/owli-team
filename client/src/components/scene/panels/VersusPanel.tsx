/**
 * M52-A 面板 · versus 局势面板（§7.4）：多空计分 + 局势条 + 信号列 + 裁决卡——
 * 数据源 `::: verdict` 裁决实例（多方 / 空方 / 僵持；正反方同构）；点信号回填追问；
 * 随对弈轮次更新（信号列跨轮累计，局面头与局势条取最新裁决）。
 * M52-E：局面头——最新裁决的胜负（空方领先 / 多方领先 / 僵持）与置信度上移为面板头部；
 * 局势条按「方向 × 置信度」加权（设计 §7.6 置信度聚合口径落地，不再全有或全无）；
 * 胜负 / 置信度 / 声明等元信息条目不重复进信号列（裁决卡内仍全量展示）。
 * M52-F：条目逐条归因分侧（lib/verdict.verdictItemSide）——不再按裁决方向整列倾泻：
 * 翻盘条件归败方（落后方的翻盘路径）、显式阵营词归各方、其余归裁决方向，
 * 消除「空方领先 → 多方列恒空」的信息架构缺陷。
 */
import * as React from 'react'
import { Scale } from 'lucide-react'
import { useSceneCtx } from '../context'
import type { SceneRow, SceneVerdict, SceneVerdictStatus } from '../derive'
import { verdictConfidenceOf, verdictItemSide, type VerdictConfidence } from '../../../lib/verdict'
import { MomentumBar, VerdictPart } from '../parts'
import { useSceneVerdicts } from '../use-scene-data'
import { PanelEmpty, PanelShell } from './PanelShell'

/** 局面头文案（状态词派生；none 走裁决标题兜底） */
const HEADLINE: Record<Exclude<SceneVerdictStatus, 'none'>, string> = {
  long: '多方领先',
  short: '空方领先',
  draw: '僵持',
}

interface VersusHead {
  status: SceneVerdictStatus
  headline: string
  confidence?: VerdictConfidence
}

interface VersusModel {
  longs: SceneRow[]
  shorts: SceneRow[]
  draws: SceneRow[]
  /** -100（空方满）.. 0（均势）.. 100（多方满） */
  momentum: number
  head?: VersusHead
  latest?: SceneVerdict
}

function buildModel(verdicts: SceneVerdict[]): VersusModel {
  const longs: SceneRow[] = []
  const shorts: SceneRow[] = []
  const draws: SceneRow[] = []
  // M52-F：逐条归因分侧（元信息与方向不明的条目由裁决卡全量兜底）
  for (const v of verdicts) {
    for (const it of v.items) {
      const side = verdictItemSide(it.label, v.status)
      if (side === 'long') longs.push(it)
      else if (side === 'short') shorts.push(it)
      else if (side === 'draw') draws.push(it)
    }
  }
  const latest = verdicts[verdicts.length - 1]
  const total = longs.length + shorts.length
  // 基准口径：累计信号条目数差（无最新裁决时的兜底）
  let momentum = total === 0 ? 0 : Math.round(((longs.length - shorts.length) / total) * 100)
  let head: VersusHead | undefined
  if (latest) {
    const confidence = verdictConfidenceOf(latest.items)
    if (latest.status !== 'none') {
      // 局势条：最新裁决「方向 × 置信度」（无置信度条目 → 满偏兜底）
      const dir = latest.status === 'long' ? 1 : latest.status === 'short' ? -1 : 0
      momentum = dir * (confidence?.pct ?? 100)
    }
    const headline = latest.status === 'none' ? latest.title : HEADLINE[latest.status]
    if (headline !== '') head = { status: latest.status, headline, ...(confidence ? { confidence } : {}) }
  }
  return { longs, shorts, draws, momentum, head, latest }
}

export function VersusPanel(): React.JSX.Element {
  const ctx = useSceneCtx()
  const verdicts = useSceneVerdicts()
  const model = React.useMemo(() => buildModel(verdicts), [verdicts])

  if (verdicts.length === 0) {
    return (
      <PanelShell title="局势面板" icon={Scale}>
        <PanelEmpty icon={Scale} text="多空信号与局势将在这里显示" hint="研判产生的多方 / 空方信号会随对弈轮次实时汇入" />
      </PanelShell>
    )
  }

  const col = (side: 'long' | 'short', label: string, rows: SceneRow[]): React.JSX.Element => (
    <div className={`scene-vs-col scene-vs-${side}`}>
      <div className="scene-vs-cap">
        <span className="scene-vs-cap-label">{label}</span>
        <span className="scene-vs-cap-count">{rows.length}</span>
      </div>
      {rows.length === 0 ? (
        <div className="scene-vs-silent">暂无信号</div>
      ) : (
        rows.map((r, i) => (
          <button
            type="button"
            className="scene-vs-signal"
            key={i}
            title="追问这条信号"
            onClick={() => ctx?.insert(`请围绕${label}信号「${r.label || r.value}」进一步分析：依据与置信度如何？`)}
          >
            {r.label ? <span className="scene-vs-signal-label">{r.label}</span> : null}
            <span className="scene-vs-signal-value">{r.value}</span>
          </button>
        ))
      )}
    </div>
  )

  return (
    <PanelShell title="局势面板" icon={Scale}>
      <div className="scene-versus">
        {model.head ? (
          <div className={`scene-vs-head scene-vs-head-${model.head.status}`}>
            <span className="scene-vs-headline" title={model.head.headline}>
              {model.head.headline}
            </span>
            {model.head.confidence ? (
              <span className="scene-vs-conf" title="终局裁决置信度（模型自评）">
                置信度 {model.head.confidence.label}
              </span>
            ) : null}
          </div>
        ) : null}
        <MomentumBar value={model.momentum} />
        <div className="scene-vs-cols">
          {col('long', '多方', model.longs)}
          {col('short', '空方', model.shorts)}
        </div>
        {model.draws.length > 0 ? (
          <div className="scene-vs-draw">
            {model.draws.map((r, i) => (
              <span className="scene-vs-draw-row" key={i}>
                <b>{r.label}</b>
                {r.value}
              </span>
            ))}
          </div>
        ) : null}
        {model.latest ? (
          <VerdictPart status={model.latest.status} title={model.latest.title} items={model.latest.items} />
        ) : null}
      </div>
    </PanelShell>
  )
}

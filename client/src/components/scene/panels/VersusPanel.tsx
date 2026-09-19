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
 * M63（批一 · N1 / G4）：四路观点卡（claim 扩展字段聚合，多空分歧提示）+
 * 博弈走子板（```game 围栏：轮次 / 模型 / 种子 / 快照 + 推演声明）+「发起多空对弈」回填入口。
 */
import * as React from 'react'
import { Scale, Swords } from 'lucide-react'
import { useSceneCtx } from '../context'
import type { SceneRow, SceneVerdict, SceneVerdictStatus } from '../derive'
import { gameMovesOf } from '../derive'
import { verdictConfidenceOf, verdictItemSide, type VerdictConfidence } from '../../../lib/verdict'
import {
  claimMetaOf,
  claimReasonsOfLines,
  DUEL_PROMPT,
  stanceToneOf,
  TEMPLATES,
} from '../../../lib/pk'
import { MomentumBar, MoveBoard, VerdictPart, ViewCards, type ViewCardData } from '../parts'
import { useSceneContainers, useSceneMessages, useSceneVerdicts } from '../use-scene-data'
import { PanelEmpty, PanelShell } from './PanelShell'

/** 局面头文案（状态词派生；none 走裁决标题兜底） */
const HEADLINE: Record<Exclude<SceneVerdictStatus, 'none'>, string> = {
  long: '多方领先',
  short: '空方领先',
  draw: '僵持',
}

/** 四路视角注册表序（未知视角按出现序追加在后） */
const VIEW_ORDER = ['基本面', '技术面', '舆情', '量化']

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
  const containers = useSceneContainers()
  const messages = useSceneMessages()
  const model = React.useMemo(() => buildModel(verdicts), [verdicts])

  // M63 N1：四路观点（带「视角」字段的 claim；同视角取最新一条；注册表序优先）
  const views = React.useMemo<ViewCardData[]>(() => {
    const map = new Map<string, ViewCardData>()
    for (const c of containers) {
      if (c.name !== 'claim' || c.arg === '') continue
      const meta = claimMetaOf(c.lines)
      if (meta.perspective === undefined) continue
      const agent = c.messageAgentId ? ctx?.agentOf(c.messageAgentId) : undefined
      map.set(meta.perspective, {
        perspective: meta.perspective,
        ...(meta.stance !== undefined ? { stance: meta.stance } : {}),
        ...(meta.confidence !== undefined ? { confidence: meta.confidence } : {}),
        claim: c.arg,
        reasons: claimReasonsOfLines(c.lines).length,
        messageId: c.messageId,
        ...(agent ? { agent } : {}),
      })
    }
    const rank = (p: string): number => {
      const i = VIEW_ORDER.indexOf(p)
      return i < 0 ? VIEW_ORDER.length : i
    }
    return [...map.values()].sort((a, b) => rank(a.perspective) - rank(b.perspective))
  }, [containers, ctx])
  const divergent = React.useMemo(() => {
    const tones = views.map((v) => stanceToneOf(v.stance ?? ''))
    return tones.includes('long') && tones.includes('short')
  }, [views])

  // M63 G4：博弈走子（```game 围栏扫描）
  const moves = React.useMemo(() => gameMovesOf(messages), [messages])

  if (verdicts.length === 0 && views.length === 0 && moves.length === 0) {
    return (
      <PanelShell title="局势面板" icon={Scale}>
        <PanelEmpty icon={Scale} text="多空信号与局势将在这里显示" />
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
        <ViewCards
          views={views}
          divergent={divergent}
          onAsk={(v) => ctx?.insert(TEMPLATES.viewAsk(v.perspective, v.claim))}
          onFocus={(id) => ctx?.focus(id)}
          onAdjudicate={() => ctx?.insert(TEMPLATES.splitAdjudicate())}
        />
        <div className="scene-vs-cols">
          {col('long', '多方', model.longs)}
          {col('short', '空方', model.shorts)}
        </div>
        <MoveBoard moves={moves} onFocus={(id) => ctx?.focus(id)} />
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
        {verdicts.length === 0 ? (
          <button
            type="button"
            className="scene-vs-initiate"
            title="预填多空对弈开场指令（可编辑后发送）"
            onClick={() => ctx?.insert(DUEL_PROMPT)}
          >
            <Swords className="size-3" aria-hidden />
            发起多空对弈
          </button>
        ) : null}
      </div>
    </PanelShell>
  )
}

/**
 * M52-A：arena 形态——顶计分板 + 左席 / 中轴（回合轴 + 消息流）/ 右席（§7.2）。
 * v1 口径（§7.9）：席位分栏 + 回合轴 + 计分板；裁决容器随消息流呈现。
 * M52-D：左右席下栏接入选席发言流（SideFeed）——该席消息投影 + 点击定位，填上两侧留白。
 * M43（§72.5）：中轴合流目标形态——回合轴之下增加「裁决流」（verdict 时间线 chips，点击定位）
 * 与「博弈面板」（论断树聚合 ClaimTree / 报价流 + 让步对比；有数据才显示；
 * 数据源均为 `::: claim` / `::: offer` 容器的纯前端派生，流式冻结口径同工作区）。
 * M60（§81）：双源接入——席位发言流（SideFeed）走实时快照 useSceneLiveMessages（流式期间照常
 * 刷新，条目即时入流）；容器解析面（裁决流 / 博弈面板）仍走冻结口径（ADR 0129）。
 * M63（批一 · A1–A6 / G1–G2）：对抗博弈主面深化——
 * A1 交锋计量板（发言 / 主张 / 交锋 x/y + 轮次分 + 终局徽标）；A2 交锋看板 CrossFire（中轴
 * insights 首位；未响应优先 + 催回应）；A4 轮次判定（ruling 派生：回合轴色点 + 轮次分）；
 * A5 对抗参与条（加一轮 / 叫停 / 倾向，只回填草稿）；A6 终局结论条（会话级关闭记忆）；
 * G1/G2 报价折线 + 收敛走廊 + 让步刻度（negotiation）。
 * 窄屏：降级为「单流 + 席位横条高亮 + 回合轴」（§7.3-4）。
 */
import * as React from 'react'
import type { AgentDefinition } from '@multi-agent/shared'
import { ChevronDown, ChevronUp, Handshake, Scale, Swords } from 'lucide-react'
import { cn } from '../../lib/utils'
import { verdictConfidenceOf } from '../../lib/verdict'
import {
  claimNodesOfContent,
  crossFireOf,
  duelTally,
  duelVerdictLabel,
  formatOfferAmount,
  offersOfContent,
  offerSeriesOf,
  TEMPLATES,
  type ClaimNodeData,
  type OfferInstance,
} from '../../lib/pk'
import { useSceneCtx } from './context'
import { rulingsOf } from './derive'
import {
  ArenaActions,
  ConclusionBar,
  CrossFire,
  OfferChart,
  OfferConcessions,
  RoundTrack,
  Scoreboard,
  SeatCard,
} from './parts'
import { ClaimTree } from './parts/ClaimTree'
import { loadConclusionClosed, saveConclusionClosed, useSceneTab } from './persist'
import { partEnabled } from './registry'
import { SeatStrip } from './SeatStrip'
import { SideFeed } from './SideFeed'
import { useSceneBusy, useSceneLiveMessages, useSceneMessages, useSceneVerdicts } from './use-scene-data'

export function ArenaStage({ children }: { children: React.ReactNode }): React.JSX.Element {
  const ctx = useSceneCtx()
  const narrow = ctx?.narrow ?? false
  const busy = useSceneBusy()
  const verdicts = useSceneVerdicts()
  const messages = useSceneMessages()
  // M60：席位发言流实时通道（不冻结）——仅纯文本投影面；容器面（claims / offers / verdicts）用冻结 messages
  const liveMessages = useSceneLiveMessages()

  const parts = ctx?.stage.parts ?? []
  // M52-A / v68：parts 裁剪单一事实来源（registry.partEnabled）；空声明 = 场景默认集全启用
  const on = (name: string): boolean => partEnabled(parts, name)

  const seats = ctx?.stage.seats
  const resolveSeat = (ids: string[] | undefined): AgentDefinition[] =>
    (ids ?? []).map((id) => ctx?.agentOf(id)).filter((a): a is AgentDefinition => !!a)
  const leftAgents = resolveSeat(seats?.left)
  const rightAgents = resolveSeat(seats?.right)
  const centerAgents = resolveSeat(seats?.center)

  const longs = verdicts.filter((v) => v.status === 'long').length
  const shorts = verdicts.filter((v) => v.status === 'short').length
  const leftLabel = leftAgents[0]?.name ?? '左席'
  const rightLabel = rightAgents[0]?.name ?? '右席'

  // M63：交锋计量 / 交锋看板 / 轮次判定 / 报价序列（纯前端派生，冻结口径）
  const sides = React.useMemo(
    () => ({ left: seats?.left ?? [], right: seats?.right ?? [] }),
    [seats?.left, seats?.right],
  )
  const tally = React.useMemo(() => duelTally(messages, sides), [messages, sides])
  const crossFire = React.useMemo(() => crossFireOf(messages, sides), [messages, sides])
  const rulings = React.useMemo(() => rulingsOf(messages), [messages])
  const series = React.useMemo(() => offerSeriesOf(messages, sides), [messages, sides])

  // 终局裁决（最后一条非 none）：终局徽标 / 结论条数据源
  const finals = React.useMemo(() => verdicts.filter((v) => v.status !== 'none'), [verdicts])
  const latestFinal = finals.length > 0 ? finals[finals.length - 1] : undefined
  const finalLabel = latestFinal
    ? [
        duelVerdictLabel(latestFinal.status, leftLabel, rightLabel) ?? latestFinal.title,
        verdictConfidenceOf(latestFinal.items)?.label,
      ]
        .filter((v): v is string => typeof v === 'string' && v !== '')
        .join(' · 置信度 ')
    : undefined
  const flipItem = latestFinal?.items.find((it) => it.label.startsWith('翻盘'))

  // G1：报价段「图 / 表」视图（本会话记忆 ma:sc:tab:*；默认图 = 图表 + 列表并存，表 = 仅列表）
  const [offerView, setOfferView] = useSceneTab('offerchart', 'chart', ctx?.sessionId)
  // 报价段收起 / 展开（本会话记忆；收起 = 仅头部一行，图表 / 让步刻度 / 明细整体让位）
  const [offerClosed, setOfferClosed] = useSceneTab('offer-collapsed', '0', ctx?.sessionId)
  const offerCollapsed = offerClosed === '1'
  const offerChartReady = series.points.length >= 2
  const offerChartOn = offerView !== 'table' && offerChartReady

  // A6 结论条：会话级关闭记忆（sessionStorage，不落库）
  const sessionId = ctx?.sessionId ?? ''
  const [conclClosed, setConclClosed] = React.useState(() => loadConclusionClosed(sessionId))
  React.useEffect(() => {
    const closed = loadConclusionClosed(sessionId)
    setConclClosed((prev) => (prev === closed ? prev : closed))
  }, [sessionId])

  // A1 轮次读数：ruling 存在 → 轮次分语义；否则回落波次口径（v1 行为零变化）
  const note =
    rulings.length > 0
      ? latestFinal
        ? `共 ${rulings.length} 轮`
        : `第 ${rulings.length + 1} 轮`
      : busy.waveCount > 0
        ? `第 ${busy.waveCount} 轮`
        : '未开赛'
  const roundMarks = React.useMemo(() => {
    const marks: Record<number, 'long' | 'short' | 'draw'> = {}
    const titles: Record<number, string> = {}
    rulings.forEach((r, i) => {
      if (r.side !== 'none') marks[i] = r.side
      const label = duelVerdictLabel(r.side, leftLabel, rightLabel)
      if (label) titles[i] = `判定：${label}`
    })
    return { marks, titles }
  }, [rulings, leftLabel, rightLabel])

  // A5 未决点：最新 ruling 的「未决点」条目值（加一轮模板引用源）
  const pendingPoint = React.useMemo(() => {
    for (let i = rulings.length - 1; i >= 0; i--) {
      const it = rulings[i]!.items.find((row) => row.label.startsWith('未决'))
      if (it && it.value.trim() !== '') return it.value.trim()
    }
    return undefined
  }, [rulings])

  // 博弈面板数据源（M43）：claim 论断树 / offer 报价流（纯前端派生；无容器则不显示）
  const claimNodes = React.useMemo<ClaimNodeData[]>(() => {
    const out: ClaimNodeData[] = []
    for (const m of messages) {
      if (m.role === 'user' || !m.content.includes('::: claim')) continue
      out.push(...claimNodesOfContent(m.content))
    }
    return out
  }, [messages])
  const offers = React.useMemo<OfferInstance[]>(() => {
    const out: OfferInstance[] = []
    for (const m of messages) {
      if (m.role === 'user' || !m.content.includes('::: offer')) continue
      out.push(...offersOfContent(m.content, m.id))
    }
    return out
  }, [messages])

  const waiting = new Set(ctx?.waitingIds ?? [])
  const onSeat = (agentId: string): void => {
    const agent = ctx?.agentOf(agentId)
    if (agent) ctx?.insert(`@${agent.name} `)
  }
  const onSeek = (turn: number): void => {
    // M63：有轮次判定 → 优先定位判定消息；否则保持波次定位（v1 口径）
    const ruling = rulings[turn]
    if (ruling) {
      ctx?.focus(ruling.messageId)
      return
    }
    const m = messages.find((x) => x.role === 'agent' && x.turnIndex === turn)
    if (m) ctx?.focus(m.id)
  }
  // A1：交锋读数 → 该侧首个未响应缺陷（否则首条挑刺）
  const onSeekCross = (side: 'left' | 'right'): void => {
    const items = crossFire[side]
    const target = items.find((it) => !it.responded) ?? items[0]
    if (target) ctx?.focus(target.messageId)
  }

  const seatColumn = (side: 'left' | 'right', agents: AgentDefinition[]): React.JSX.Element => (
    <aside className={cn('scene-arena-side', side === 'left' ? 'scene-arena-left' : 'scene-arena-right')}>
      {agents.map((a) => (
        <SeatCard
          key={a.id}
          agent={a}
          side={side}
          speaking={a.id === busy.speakingId}
          waiting={waiting.has(a.id)}
          onSelect={onSeat}
        />
      ))}
      {agents.length > 0 ? (
        <SideFeed
          agents={agents}
          messages={liveMessages}
          label={side === 'left' ? '左席发言流' : '右席发言流'}
          onSeek={(id) => ctx?.focus(id)}
        />
      ) : null}
    </aside>
  )

  const hasCrossFire = crossFire.left.length > 0 || crossFire.right.length > 0

  // M66（U5）：窄屏洞察区收纳——默认收起为底部「洞察」条，展开为内联抽屉（宽屏行为零变化）
  const hasInsights =
    (on('cross-fire') && hasCrossFire) ||
    (on('claim-tree') && claimNodes.length > 0) ||
    (on('offers') && offers.length > 0)
  const insightSegCount = [
    on('cross-fire') && hasCrossFire,
    on('claim-tree') && claimNodes.length > 0,
    on('offers') && offers.length > 0,
  ].filter(Boolean).length
  const [insightsOpen, setInsightsOpen] = React.useState(false)

  return (
    <div className={cn('scene-arena', narrow && 'scene-arena-narrow')}>
      {on('scoreboard') ? (
        <Scoreboard
          left={{ label: leftLabel, score: longs, speaks: tally.left.speaks, claims: tally.left.claims, findings: tally.left.findings, responded: tally.left.responded }}
          right={{ label: rightLabel, score: shorts, speaks: tally.right.speaks, claims: tally.right.claims, findings: tally.right.findings, responded: tally.right.responded }}
          note={note}
          {...(finalLabel ? { verdictLabel: finalLabel } : {})}
          {...(latestFinal ? { onSeekVerdict: () => ctx?.focus(latestFinal.messageId) } : {})}
          onSeekCross={onSeekCross}
        />
      ) : null}
      {narrow ? (
        <SeatStrip
          agents={ctx?.participants ?? []}
          speakingId={busy.speakingId}
          waitingIds={ctx?.waitingIds ?? []}
          onSelect={onSeat}
        />
      ) : null}
      <div className="scene-arena-body">
        {!narrow ? seatColumn('left', leftAgents) : null}
        <div className="scene-arena-axis">
          {!narrow && centerAgents.length > 0 ? (
            <div className="scene-arena-center">
              {centerAgents.map((a) => (
                <SeatCard
                  key={a.id}
                  agent={a}
                  side="center"
                  speaking={a.id === busy.speakingId}
                  waiting={waiting.has(a.id)}
                  onSelect={onSeat}
                />
              ))}
            </div>
          ) : null}
          {/* A6：终局结论条（L1 结论层；点条 → 定位裁决，关闭 → 本会话隐藏） */}
          {latestFinal && !conclClosed && latestFinal.status !== 'none' ? (
            <ConclusionBar
              status={latestFinal.status}
              headline={duelVerdictLabel(latestFinal.status, leftLabel, rightLabel) ?? latestFinal.title}
              {...(verdictConfidenceOf(latestFinal.items)?.label !== undefined
                ? { confidence: verdictConfidenceOf(latestFinal.items)!.label }
                : {})}
              {...(flipItem ? { flip: flipItem.value } : {})}
              onSeek={() => ctx?.focus(latestFinal.messageId)}
              onClose={() => {
                saveConclusionClosed(sessionId)
                setConclClosed(true)
              }}
            />
          ) : null}
          {busy.waveCount > 0 && on('round-track') ? (
            <div className="scene-arena-track">
              <RoundTrack
                total={busy.waveCount}
                current={busy.waveCount - 1}
                marks={roundMarks.marks}
                markTitles={roundMarks.titles}
                onSeek={onSeek}
              />
            </div>
          ) : null}
          {verdicts.length > 0 && on('verdicts') ? (
            <div className="scene-arena-verdicts" data-verdict-flow="" aria-label="裁决流">
              {verdicts.map((v, i) => (
                <button
                  key={`${v.messageId}-${i}`}
                  type="button"
                  data-status={v.status}
                  className="scene-verdict-chip"
                  title={v.title || '点击定位该次裁决'}
                  onClick={() => ctx?.focus(v.messageId)}
                >
                  <span className="scene-verdict-chip-text">
                    {v.title || duelVerdictLabel(v.status, leftLabel, rightLabel) || '裁决'}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
          {/* A5：对抗参与条（左右席均非空且已开赛；一切点击只回填草稿） */}
          {leftAgents.length > 0 && rightAgents.length > 0 && busy.waveCount > 0 ? (
            <ArenaActions
              leftLabel={leftLabel}
              rightLabel={rightLabel}
              center={centerAgents[0]?.name ?? '裁判'}
              {...(pendingPoint !== undefined ? { point: pendingPoint } : {})}
              onInsert={(text) => ctx?.insert(text)}
            />
          ) : null}
          {hasInsights ? (
            <>
              {narrow ? (
                <button
                  type="button"
                  className="scene-insights-bar"
                  data-insights-bar=""
                  aria-expanded={insightsOpen}
                  onClick={() => setInsightsOpen((v) => !v)}
                >
                  <Swords className="size-3" aria-hidden />
                  洞察区（{insightSegCount} 段）· {insightsOpen ? '收起' : '展开'}
                </button>
              ) : null}
              {!narrow || insightsOpen ? (
                <div className="scene-arena-insights" data-insights="">
              {/* A2：交锋看板（首位；未响应优先 + 催回应） */}
              {on('cross-fire') && hasCrossFire ? (
                <section className="scene-insight" data-insight="cross-fire">
                  <div className="scene-insight-head">
                    <Swords className="size-3" />
                    交锋看板
                    <span className="ml-auto font-normal">
                      {crossFire.left.length + crossFire.right.length} 条挑刺
                    </span>
                  </div>
                  <div className="scene-insight-body">
                    <CrossFire
                      left={{ label: leftLabel, items: crossFire.left }}
                      right={{ label: rightLabel, items: crossFire.right }}
                      onFocus={(id) => ctx?.focus(id)}
                      onChase={(it) => ctx?.insert(TEMPLATES.chaseFinding(it.id))}
                    />
                  </div>
                </section>
              ) : null}
              {on('claim-tree') && claimNodes.length > 0 ? (
                <section className="scene-insight" data-insight="claims">
                  <div className="scene-insight-head">
                    <Scale className="size-3" />
                    论断树
                    <span className="ml-auto font-normal">{claimNodes.length} 条主张</span>
                  </div>
                  <div className="scene-insight-body">
                    <ClaimTree
                      nodes={claimNodes}
                      onPick={(text) => ctx?.insert(`请补充论据「${text}」的证据与出处。`)}
                      onEvidenceAsk={(text) => ctx?.insert(TEMPLATES.askEvidence(text))}
                      onHypoAsk={(text) => ctx?.insert(TEMPLATES.markHypothesis(text))}
                    />
                  </div>
                </section>
              ) : null}
              {on('offers') && offers.length > 0 ? (
                <section className="scene-insight" data-insight="offers">
                  <div className="scene-insight-head">
                    <Handshake className="size-3" />
                    报价流
                    <span className="ml-auto font-normal">{offers.length} 次出价</span>
                    {offerChartReady && !offerCollapsed ? (
                      <div className="scene-offer-view" role="group" aria-label="报价视图" data-offer-view="">
                        <button
                          type="button"
                          className={cn('scene-ov-btn', offerView !== 'table' && 'is-on')}
                          aria-pressed={offerView !== 'table'}
                          title="图表视图：报价折线 / 收敛走廊 / 让步刻度"
                          onClick={() => setOfferView('chart')}
                        >
                          图
                        </button>
                        <button
                          type="button"
                          className={cn('scene-ov-btn', offerView === 'table' && 'is-on')}
                          aria-pressed={offerView === 'table'}
                          title="列表视图：仅报价明细"
                          onClick={() => setOfferView('table')}
                        >
                          表
                        </button>
                      </div>
                    ) : null}
                    <button
                      type="button"
                      className="scene-insight-toggle"
                      data-offer-toggle=""
                      aria-expanded={!offerCollapsed}
                      title={offerCollapsed ? '展开报价流（图表 / 让步刻度 / 明细）' : '收起报价流（仅留头部一行）'}
                      onClick={() => setOfferClosed(offerCollapsed ? '0' : '1')}
                    >
                      {offerCollapsed ? <ChevronDown className="size-3" /> : <ChevronUp className="size-3" />}
                      {offerCollapsed ? '展开' : '收起'}
                    </button>
                  </div>
                  {!offerCollapsed ? (
                  <div className="scene-insight-body scene-offer-flow">
                    {/* G1/G2：报价折线 + 收敛走廊 + 让步刻度（有效金额点 ≥2 且图表视图才渲染） */}
                    {offerChartOn ? (
                      <OfferChart
                        series={series}
                        leftLabel={leftLabel}
                        rightLabel={rightLabel}
                        onFocus={(id) => ctx?.focus(id)}
                      />
                    ) : null}
                    {offerChartOn ? (
                      <OfferConcessions
                        series={series}
                        leftLabel={leftLabel}
                        rightLabel={rightLabel}
                        onFocus={(id) => ctx?.focus(id)}
                        onExplain={(text) => ctx?.insert(text)}
                      />
                    ) : null}
                    {offers.map((o, i) => {
                      const prev = i > 0 ? offers[i - 1] : undefined
                      const delta =
                        o.amount !== undefined && prev?.amount !== undefined ? o.amount - prev.amount : undefined
                      return (
                        <button
                          key={`${o.messageId}-${i}`}
                          type="button"
                          className="scene-offer-item"
                          title="点击定位该次报价"
                          onClick={() => ctx?.focus(o.messageId)}
                        >
                          <span className="scene-offer-title">{o.title || `第 ${i + 1} 次报价`}</span>
                          <span className="scene-offer-amount">{o.headline || '—'}</span>
                          {delta !== undefined && delta !== 0 ? (
                            <span className={cn('scene-offer-delta', delta < 0 ? 'is-down' : 'is-up')}>
                              {delta < 0 ? '↓' : '↑'}
                              {formatOfferAmount(Math.abs(delta))}
                            </span>
                          ) : null}
                        </button>
                      )
                    })}
                  </div>
                  ) : null}
                </section>
              ) : null}
                </div>
              ) : null}
            </>
          ) : null}
          <div className="scene-arena-main">{children}</div>
        </div>
        {!narrow ? seatColumn('right', rightAgents) : null}
      </div>
    </div>
  )
}

/**
 * M52-A：arena 形态——顶计分板 + 左席 / 中轴（回合轴 + 消息流）/ 右席（§7.2）。
 * v1 口径（§7.9）：席位分栏 + 回合轴 + 计分板；裁决容器随消息流呈现。
 * M52-D：左右席下栏接入选席发言流（SideFeed）——该席消息投影 + 点击定位，填上两侧留白。
 * M43（§72.5）：中轴合流目标形态——回合轴之下增加「裁决流」（verdict 时间线 chips，点击定位）
 * 与「博弈面板」（论断树聚合 ClaimTree / 报价流 + 让步对比；有数据才显示；
 * 数据源均为 `::: claim` / `::: offer` 容器的纯前端派生，流式冻结口径同工作区）。
 * M60（§81）：双源接入——席位发言流（SideFeed）走实时快照 useSceneLiveMessages（流式期间照常
 * 刷新，条目即时入流）；容器解析面（裁决流 / 博弈面板）仍走冻结口径（半截容器不进派生，ADR 0129）。
 * 窄屏：降级为「单流 + 席位横条高亮 + 回合轴」（§7.3-4）。
 */
import * as React from 'react'
import type { AgentDefinition } from '@multi-agent/shared'
import { Handshake, Scale } from 'lucide-react'
import { cn } from '../../lib/utils'
import {
  claimNodesOfContent,
  duelVerdictLabel,
  formatOfferAmount,
  offersOfContent,
  type ClaimNodeData,
  type OfferInstance,
} from '../../lib/pk'
import { useSceneCtx } from './context'
import { RoundTrack, Scoreboard, SeatCard } from './parts'
import { ClaimTree } from './parts/ClaimTree'
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
  const on = (name: string): boolean => parts.length === 0 || parts.includes(name)

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
    const m = messages.find((x) => x.role === 'agent' && x.turnIndex === turn)
    if (m) ctx?.focus(m.id)
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

  return (
    <div className={cn('scene-arena', narrow && 'scene-arena-narrow')}>
      {on('scoreboard') ? (
        <Scoreboard
          left={{ label: leftLabel, score: longs }}
          right={{ label: rightLabel, score: shorts }}
          note={busy.waveCount > 0 ? `第 ${busy.waveCount} 轮` : '未开赛'}
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
          {busy.waveCount > 0 && on('round-track') ? (
            <div className="scene-arena-track">
              <RoundTrack total={busy.waveCount} current={busy.waveCount - 1} onSeek={onSeek} />
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
          {on('insights') && (claimNodes.length > 0 || offers.length > 0) ? (
            <div className="scene-arena-insights" data-insights="">
              {claimNodes.length > 0 ? (
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
                    />
                  </div>
                </section>
              ) : null}
              {offers.length > 0 ? (
                <section className="scene-insight" data-insight="offers">
                  <div className="scene-insight-head">
                    <Handshake className="size-3" />
                    报价流
                    <span className="ml-auto font-normal">{offers.length} 次出价</span>
                  </div>
                  <div className="scene-insight-body scene-offer-flow">
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
                </section>
              ) : null}
            </div>
          ) : null}
          <div className="scene-arena-main">{children}</div>
        </div>
        {!narrow ? seatColumn('right', rightAgents) : null}
      </div>
    </div>
  )
}

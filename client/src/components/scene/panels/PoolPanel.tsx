/**
 * M52-A 面板 · pool 汇聚板（§7.4）：容器条目卡墙——研讨产物（点子 / 来源 / 立场 / 选项）实时沉淀；
 * 点卡头定位来源消息；点条目 / 「深入」回填草稿（composerInsert 统一语义，用户确认后发送）。
 * M38（§92）：研讨容器专业化——点子池（idea）/ 评分矩阵（score）/ 来源墙（sources）/ 决议（decision）
 * 与消息内卡片同组件（IdeaCard / ScoreCard / SourcesCard / DecisionCard）；点亮态经 LIGHTS_EVENT 跨实例同步。
 * M63（批一 A2）：红队看板——存在对抗姿态对（DUEL_STANCE：ideator ↔ challenger）且产出了
 * findings 时，榜首沉淀「提缺 → 已响应」配对（只读模式，不提供催回应——红队对无固定轮次纪律）。
 */
import * as React from 'react'
import { ArrowRight, Crosshair, LayoutGrid } from 'lucide-react'
import { AgentAvatar } from '../../agents/AgentAvatar'
import { ClaimCard } from '../../chat/md-ext/ClaimCard'
import { DecisionCard } from '../../chat/md-ext/DecisionCard'
import { IdeaCard } from '../../chat/md-ext/IdeaCard'
import { ScoreCard } from '../../chat/md-ext/ScoreCard'
import { SourcesCard } from '../../chat/md-ext/SourcesCard'
import { parseRoll } from '../../chat/md-ext/RollCard'
import { SplitCard } from '../../chat/md-ext/SplitCard'
import { StanceCard } from '../../chat/md-ext/StanceCard'
import { parseIdeaArg, parseScoreLines, parseSourceLines, ideaStatusOf } from '../../chat/md-ext/remark-ext'
import { crossFireOf, DUEL_STANCE, claimMetaOf, claimReasonsOfLines } from '../../../lib/pk'
import { useSceneCtx } from '../context'
import { panRowsOf, type SceneContainer } from '../derive'
import { useSceneLights } from '../persist'
import { CrossFire } from '../parts'
import { useSceneContainers, useSceneMessages } from '../use-scene-data'
import { PanelEmpty, PanelShell } from './PanelShell'

/** 容器名 → 中文徽标（未知容器显示原名） */
const CONTAINER_LABEL: Record<string, string> = {
  ideas: '点子',
  idea: '点子',
  sources: '来源',
  score: '评分',
  decision: '决议',
  claim: '主张',
  offer: '报价',
  verdict: '裁决',
  checklist: '清单',
  pan: '盘面',
  pool: '汇聚',
}

/** 卡片墙最多呈现的条目数（其余由「深入」回填展开） */
const MAX_ITEMS = 4

/** 逐场景空态文案（M38：研讨场景语汇各异，未收录场景用中性默认） */
const POOL_EMPTY: Record<string, string> = {
  brainstorm: '点子将汇聚在这里',
  research: '来源与证据将汇聚在这里',
  strategy: '决议与矩阵将汇聚在这里',
  society: '立场与事实将汇聚在这里',
  // M69：跑团工坊（线索与骰子记录）/ 哲学茶室（论点与思想实验）
  trpg: '线索与骰子记录将汇聚在这里',
  philosophy: '论点与思想实验将汇聚在这里',
}
const POOL_EMPTY_DEFAULT = '研讨产物将汇聚在这里'

/** 专业化卡片容器名（generic 卡墙不重复呈现；stance / split 走泳道与共识板专用段） */
const SPECIAL_CARDS = new Set(['idea', 'score', 'sources', 'decision', 'claim'])
/** 不入通用卡墙的容器名（专业化卡 + 立场泳道 / 共识分歧板 + phase 分隔条 + roll 骰子记录段） */
const NON_GENERIC = new Set([...SPECIAL_CARDS, 'stance', 'split', 'phase', 'roll'])

/** 立场方 → 泳道色相（稳定哈希取 6 色板；展示用，不参与解析） */
function laneHueOf(role: string): number {
  let sum = 0
  for (const ch of role) sum += ch.codePointAt(0) ?? 0
  return sum % 6
}

/** 定位按钮（专业化卡片共用的来源跳转） */
function FocusButton({ onClick }: { onClick: () => void }): React.JSX.Element {
  return (
    <button type="button" className="scene-pool-focus" title="定位来源消息" onClick={onClick}>
      <Crosshair size={12} />
    </button>
  )
}

export function PoolPanel(): React.JSX.Element {
  const ctx = useSceneCtx()
  const containers = useSceneContainers()
  const messages = useSceneMessages()
  const groupId = ctx?.group?.id ?? ''
  const [lights, toggleLight] = useSceneLights(ctx?.sessionId ?? '')

  // M63 A2：红队对（对抗姿态注册表；两侧均有人在座才成立）——findings 配对沉淀
  const duelSideIds = React.useMemo(() => {
    const left: string[] = []
    const right: string[] = []
    for (const a of ctx?.participants ?? []) {
      if (DUEL_STANCE[a.id] === 'left') left.push(a.id)
      else if (DUEL_STANCE[a.id] === 'right') right.push(a.id)
    }
    return { left, right }
  }, [ctx?.participants])
  const crossFire = React.useMemo(
    () =>
      duelSideIds.left.length > 0 && duelSideIds.right.length > 0
        ? crossFireOf(messages, duelSideIds)
        : { left: [], right: [] },
    [messages, duelSideIds],
  )
  const hasCrossFire = crossFire.left.length > 0 || crossFire.right.length > 0
  const cfLeftLabel = (duelSideIds.left[0] ? ctx?.agentOf(duelSideIds.left[0])?.name : undefined) ?? '左席'
  const cfRightLabel = (duelSideIds.right[0] ? ctx?.agentOf(duelSideIds.right[0])?.name : undefined) ?? '右席'

  // M66（N4）：立场泳道 / 共识分歧板（society；有容器才渲染）
  const stanceLanes = React.useMemo(() => {
    const map = new Map<string, SceneContainer[]>()
    for (const c of containers) {
      if (c.name !== 'stance') continue
      const role = c.arg || '相关方'
      const list = map.get(role)
      if (list) list.push(c)
      else map.set(role, [c])
    }
    return [...map.entries()].map(([role, list]) => ({ role, items: list, hue: laneHueOf(role) }))
  }, [containers])
  const splits = React.useMemo(() => containers.filter((c) => c.name === 'split'), [containers])
  const hasStance = stanceLanes.length > 0
  const hasSplit = splits.length > 0
  // M69：骰子记录（trpg——roll 容器按消息序聚合；点条目定位来源消息）
  const rolls = React.useMemo(
    () =>
      containers
        .filter((c) => c.name === 'roll')
        .map((c) => ({
          id: `${c.messageId}:${c.seq}`,
          messageId: c.messageId,
          title: c.arg || '掷骰',
          parsed: parseRoll(JSON.stringify(panRowsOf(c.lines).fields)),
        })),
    [containers],
  )
  const hasRolls = rolls.length > 0

  // 通用容器卡（SPECIAL_CARDS 走专业化渲染，stance / split / phase 另段呈现，不在此列）
  const generic = React.useMemo(
    () =>
      containers
        .filter((c) => !NON_GENERIC.has(c.name))
        .map((c) => {
          const { fields, items } = panRowsOf(c.lines)
          return {
            id: `${c.messageId}:${c.seq}`,
            name: c.name,
            title: c.arg,
            agentId: c.messageAgentId,
            messageId: c.messageId,
            items: items.slice(0, MAX_ITEMS),
            fields: fields.slice(0, 2),
            total: items.length + fields.length,
          }
        })
        // 无结构化行且无标题的纯文本块不产生卡（正文由消息流呈现）
        .filter((c) => c.total > 0 || c.title !== '')
        .reverse(),
    [containers],
  )
  const special = React.useMemo(
    () => [...containers].reverse().filter((c) => SPECIAL_CARDS.has(c.name)),
    [containers],
  )

  const total = generic.length + special.length

  if (total === 0 && !hasCrossFire && !hasStance && !hasSplit && !hasRolls) {
    return (
      <PanelShell title="汇聚板" icon={LayoutGrid}>
        <PanelEmpty icon={LayoutGrid} text={POOL_EMPTY[groupId] ?? POOL_EMPTY_DEFAULT} />
      </PanelShell>
    )
  }

  const insert = ctx?.insert
  const focus = ctx?.focus ?? ((): void => {})

  return (
    <PanelShell title="汇聚板" icon={LayoutGrid} badge={<span className="scene-panel-count">{total}</span>}>
      <div className="scene-pool" role="list" aria-label="汇聚板">
        {hasCrossFire ? (
          <section className="scene-pool-sec" data-pool-cross-fire="">
            <div className="scene-pool-cap">红队看板</div>
            <CrossFire
              left={{ label: cfLeftLabel, items: crossFire.left }}
              right={{ label: cfRightLabel, items: crossFire.right }}
              readOnly
              onFocus={(id) => ctx?.focus(id)}
            />
          </section>
        ) : null}
        {hasStance ? (
          <section className="scene-pool-sec" data-pool-stance="">
            <div className="scene-pool-cap">立场泳道</div>
            {stanceLanes.map((lane) => (
              <div className="scene-stance-lane" data-hue={lane.hue} key={lane.role}>
                <div className="scene-stance-lane-head">
                  <span className="scene-stance-lane-role">{lane.role}</span>
                  <span className="scene-stance-lane-count">{lane.items.length} 席</span>
                </div>
                {lane.items.map((c) => {
                  const { fields, items } = panRowsOf(c.lines)
                  const agent = c.messageAgentId ? ctx?.agentOf(c.messageAgentId) : undefined
                  return (
                    <div className="scene-pool-card scene-pool-card-special" key={`${c.messageId}:${c.seq}`} role="listitem">
                      <div className="scene-pool-head scene-pool-head-static">
                        {agent ? (
                          <AgentAvatar agent={agent} size={18} animated={false} className="shrink-0" />
                        ) : (
                          <span className="scene-pool-dot" aria-hidden />
                        )}
                        <span className="scene-pool-badge">立场</span>
                        <FocusButton onClick={() => focus(c.messageId)} />
                      </div>
                      <StanceCard
                        title={c.arg || '相关方'}
                        fields={JSON.stringify(fields)}
                        items={JSON.stringify(items)}
                        onInsert={insert ? (text) => insert(text) : undefined}
                      />
                    </div>
                  )
                })}
              </div>
            ))}
          </section>
        ) : null}
        {hasSplit ? (
          <section className="scene-pool-sec" data-pool-split="">
            <div className="scene-pool-cap">共识分歧板</div>
            {splits.map((c) => {
              const { items } = panRowsOf(c.lines)
              const agent = c.messageAgentId ? ctx?.agentOf(c.messageAgentId) : undefined
              return (
                <div className="scene-pool-card scene-pool-card-special" key={`${c.messageId}:${c.seq}`} role="listitem">
                  <div className="scene-pool-head scene-pool-head-static">
                    {agent ? (
                      <AgentAvatar agent={agent} size={18} animated={false} className="shrink-0" />
                    ) : (
                      <span className="scene-pool-dot" aria-hidden />
                    )}
                    <span className="scene-pool-badge">共识分歧</span>
                    <FocusButton onClick={() => focus(c.messageId)} />
                  </div>
                  <SplitCard title={c.arg || undefined} items={JSON.stringify(items)} onInsert={insert ? (text) => insert(text) : undefined} />
                </div>
              )
            })}
          </section>
        ) : null}
        {hasRolls ? (
          <section className="scene-pool-sec" data-pool-rolls="">
            <div className="scene-pool-cap">骰子记录</div>
            {rolls.map((r) => (
              <button
                type="button"
                className="scene-pool-roll"
                key={r.id}
                title="定位来源消息"
                onClick={() => focus(r.messageId)}
              >
                <span className="scene-pool-roll-title">{r.title}</span>
                {r.parsed ? (
                  <span className="scene-pool-roll-meta">
                    {r.parsed.formula} = {r.parsed.total}
                    {r.parsed.seed ? ` · 种子 ${r.parsed.seed}` : ''}
                  </span>
                ) : null}
              </button>
            ))}
          </section>
        ) : null}
        {special.map((c) => {
          const agent = c.messageAgentId ? ctx?.agentOf(c.messageAgentId) : undefined
          const id = `${c.messageId}:${c.seq}`
          let body: React.ReactNode = null
          if (c.name === 'idea') {
            const { no, title } = parseIdeaArg(c.arg)
            const fields = panRowsOf(c.lines).fields
            const status = ideaStatusOf(fields)
            const key = `${c.messageId}:${no ?? ''}:${title ?? ''}`
            body = (
              <IdeaCard
                no={no}
                title={title}
                fields={JSON.stringify(fields)}
                {...(status !== 'none' ? { status } : {})}
                onInsert={insert ? (text) => insert(text) : undefined}
                litOverride={lights.has(key)}
                onToggleLight={() => toggleLight(key)}
              />
            )
          } else if (c.name === 'score') {
            body = <ScoreCard title={c.arg || undefined} scores={JSON.stringify(parseScoreLines(c.lines))} />
          } else if (c.name === 'sources') {
            body = (
              <SourcesCard
                title={c.arg || undefined}
                sources={JSON.stringify(parseSourceLines(c.lines))}
                onInsert={insert ? (text) => insert(text) : undefined}
              />
            )
          } else if (c.name === 'decision') {
            body = (
              <DecisionCard
                title={c.arg || undefined}
                fields={JSON.stringify(panRowsOf(c.lines).fields)}
                onInsert={insert ? (text) => insert(text) : undefined}
              />
            )
          } else if (c.name === 'claim') {
            // M69：论点池（philosophy / society）——主张卡与消息内同组件；扩展字段经 claimMetaOf 单一解析
            const meta = claimMetaOf(c.lines)
            const detail = c.lines.map((l) => /^细节\s*[：:]\s*(.+)$/.exec(l.trim())?.[1]?.trim()).find(Boolean)
            body = (
              <ClaimCard
                title={c.arg || undefined}
                detail={detail}
                reasons={JSON.stringify(claimReasonsOfLines(c.lines))}
                perspective={meta.perspective}
                stance={meta.stance}
                confidence={meta.confidence}
                raw={c.raw}
              />
            )
          }
          return (
            <div className="scene-pool-card scene-pool-card-special" key={id} role="listitem">
              {/* 专业化卡自带标题：面板条仅保留作者 / 类型徽标 / 定位 */}
              <div className="scene-pool-head scene-pool-head-static">
                {agent ? (
                  <AgentAvatar agent={agent} size={18} animated={false} className="shrink-0" />
                ) : (
                  <span className="scene-pool-dot" aria-hidden />
                )}
                <span className="scene-pool-badge">{CONTAINER_LABEL[c.name] ?? c.name}</span>
                <FocusButton onClick={() => focus(c.messageId)} />
              </div>
              {body}
            </div>
          )
        })}
        {generic.map((card) => {
          const agent = card.agentId ? ctx?.agentOf(card.agentId) : undefined
          return (
            <div className="scene-pool-card" key={card.id} role="listitem">
              <button
                type="button"
                className="scene-pool-head"
                title="定位来源消息"
                onClick={() => ctx?.focus(card.messageId)}
              >
                {agent ? (
                  <AgentAvatar agent={agent} size={18} animated={false} className="shrink-0" />
                ) : (
                  <span className="scene-pool-dot" aria-hidden />
                )}
                <span className="scene-pool-badge">{CONTAINER_LABEL[card.name] ?? card.name}</span>
                <span className="scene-pool-title">{card.title || '（未命名）'}</span>
                <span className="scene-pool-count">{card.total}</span>
              </button>
              {card.items.length > 0 ? (
                <ul className="scene-pool-items">
                  {card.items.map((it, i) => (
                    <li key={i}>
                      <button
                        type="button"
                        className="scene-pool-item"
                        title="引用这条内容"
                        onClick={() =>
                          ctx?.insert(it.label ? `关于「${it.label}」：${it.value}——请进一步展开。` : `${it.value}——请进一步展开。`)
                        }
                      >
                        {it.label ? <span className="scene-pool-item-label">{it.label}</span> : null}
                        <span className="scene-pool-item-value">{it.value}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {card.fields.length > 0 ? (
                <div className="scene-pool-fields">
                  {card.fields.map((f, i) => (
                    <span className="scene-pool-field" key={i}>
                      <b>{f.label}</b>
                      {f.value}
                    </span>
                  ))}
                </div>
              ) : null}
              <button
                type="button"
                className="scene-pool-dig"
                onClick={() => ctx?.insert(`请深入展开「${card.title || card.name}」。`)}
              >
                <ArrowRight size={12} />
                深入
              </button>
            </div>
          )
        })}
      </div>
    </PanelShell>
  )
}

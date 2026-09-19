/**
 * M52-A 面板 · console 看板面板（§7.4）：管道看板 / 活动时间轴 / 交付件——
 * 看板数据源：`::: kanban|pipe|board` 容器条目（每容器一列）；时间轴取最近成员消息；点卡 / 点条目定位来源消息。
 * M66（批二 · N2/N3）：场景分支——bi = 指标区（`::: kpi` 五列含口径徽章）+ 取数链（```sql 围栏聚合，
 * SQL 正文仍由消息内代码块承载）；sre = 事故时间轴（`::: timeline` 第三列语义为等级：P0/P1/P2 + 色带 +
 * 筛选 chips，无容器时回落通用活动时间轴）+ SLO 区（`::: kpi`）；其余场景行为零变化。
 * 批六（console 二批）：sales = 客户管道（`::: pipeline` 阶段列 + 金额合计，未知阶段归「其他」）；
 * ecommerce = 经营指标（kpi）+ 大促节奏（timeline）；marketing = 内容节奏（timeline）；
 * legal-personal = 案件时间线（timeline）+ 主张与依据（`::: claim`）；funding = 融资进度（`::: progress`）
 * + 投资人问答（`::: qa`）——进度 / 问答与消息内卡片**同组件渲染**（单一解析共用，ADR 0144 红线）。
 * 单一解析：kpiRowOf / timelineRowOf / parsePipelineItems / numberWithSuffix / parseProgressItems /
 * parseQaPairs / parseClaimLines 自 remark-ext 导出共用（ADR 0144 红线）。
 */
import * as React from 'react'
import { Activity, Database } from 'lucide-react'
import { AgentAvatar } from '../../agents/AgentAvatar'
import { KpiItem } from '../../chat/md-ext/KpiGroup'
import { ProgressCard } from '../../chat/md-ext/ProgressCard'
import { QaCard } from '../../chat/md-ext/QaCard'
import {
  kpiRowOf,
  numberWithSuffix,
  parseClaimLines,
  parsePipelineItems,
  parseProgressItems,
  parseQaPairs,
  timelineRowOf,
  type ClaimReasonItem,
} from '../../chat/md-ext/remark-ext'
import { useUiStore } from '../../../stores/ui-store'
import { useSceneCtx } from '../context'
import {
  artifactsOf,
  incidentLevelOf,
  panRowsOf,
  sqlRunsOf,
  type SceneContainer,
  type SceneIncidentLevel,
} from '../derive'
import { readStored, writeStored } from '../persist'
import { DeliveryPanel, KanbanBoard, type KanbanCard, type KanbanColumn } from '../parts'
import { useSceneContainers, useSceneMessages } from '../use-scene-data'
import { PanelEmpty, PanelShell } from './PanelShell'

/** 识别为管道看板的容器名（M41 管道容器接入前，先承接口头 kanban） */
const KANBAN_NAMES = new Set(['kanban', 'pipe', 'board'])

/** 时间轴呈现的最近成员消息条数 */
const TIMELINE_MAX = 12

/** M66 N3：等级筛选键（sessionStorage `ma:sc:tl:<sessionId>`，本地态不落库） */
const INCIDENT_KEY = (sid: string): string => `ma:sc:tl:${sid || '-'}`

interface KpiCell {
  id: string
  messageId: string
  agentId?: string
  title: string
  rows: Array<{ name: string; value: string; delta: string; target: string; scope: string; raw: string }>
}

interface IncidentRow {
  key: string
  messageId: string
  time: string
  text: string
  level: SceneIncidentLevel
  /** 原始等级文本（徽标文案） */
  levelText: string
}

/** 消息正文首行摘要（跳过空行 / 容器标记行；截断 52 字符） */
function firstLine(content: string): string {
  for (const raw of content.split('\n')) {
    const t = raw
      .trim()
      .replace(/^[#>*\-\s]+/, '')
      .replace(/[`*_]/g, '')
    if (t === '' || t.startsWith(':::')) continue
    return t.length > 52 ? `${t.slice(0, 52)}…` : t
  }
  return '（无正文）'
}

function columnsOf(containers: SceneContainer[]): KanbanColumn[] {
  const out: KanbanColumn[] = []
  for (const c of containers) {
    if (!KANBAN_NAMES.has(c.name)) continue
    const { items, fields } = panRowsOf(c.lines)
    const colId = `${c.messageId}:${c.seq}`
    const cards: KanbanCard[] = [
      ...items.map((it, i) => ({
        id: `${c.messageId}:i${i}`,
        title: it.label || it.value,
        meta: it.label ? it.value : undefined,
      })),
      ...fields.map((f, i) => ({
        id: `${c.messageId}:f${i}`,
        title: f.label,
        meta: f.value,
      })),
    ]
    if (cards.length > 0) out.push({ id: colId, title: c.arg || '管道', cards })
  }
  return out
}

/** kpi 容器 → 指标组（M66 N2；单一解析 kpiRowOf） */
function kpiCellsOf(containers: SceneContainer[]): KpiCell[] {
  const out: KpiCell[] = []
  for (const c of containers) {
    if (c.name !== 'kpi') continue
    const rows = c.lines
      .map((line) => ({ ...kpiRowOf(line), raw: line.trim() }))
      .filter((r) => r.name !== '')
    if (rows.length === 0) continue
    out.push({
      id: `${c.messageId}:${c.seq}`,
      messageId: c.messageId,
      ...(c.messageAgentId !== undefined ? { agentId: c.messageAgentId } : {}),
      title: c.arg || '指标',
      rows,
    })
  }
  return out
}

/** timeline 容器 → 事故时间轴条目（M66 N3；单一解析 timelineRowOf；第三列语义 = 等级） */
function incidentsOf(containers: SceneContainer[]): IncidentRow[] {
  const out: IncidentRow[] = []
  for (const c of containers) {
    if (c.name !== 'timeline') continue
    c.lines.forEach((line, i) => {
      const row = timelineRowOf(line)
      if (row.text === '') return
      out.push({
        key: `${c.messageId}:${c.seq}:${i}`,
        messageId: c.messageId,
        time: row.date,
        text: row.text,
        level: incidentLevelOf(row.owner),
        levelText: row.owner.trim() || '—',
      })
    })
  }
  return out
}

const LEVEL_LABEL: Record<SceneIncidentLevel, string> = { p0: 'P0', p1: 'P1', p2: 'P2', other: '其他' }

/** kpi 卡网格（bi 指标 / sre SLO / ecommerce 经营指标共用；DOM 与 M66 分支一致） */
function KpiCells({ cells, onFocus }: { cells: KpiCell[]; onFocus: (id: string) => void }): React.JSX.Element {
  return (
    <>
      {cells.map((cell) => (
        <div className="scene-kpi-grid" key={cell.id}>
          {cell.rows.map((row, i) => (
            <div className="scene-kpi-cell" key={i}>
              <KpiItem
                name={row.name}
                value={row.value}
                delta={row.delta}
                target={row.target}
                {...(row.scope !== '' ? { scope: row.scope } : {})}
                raw={row.raw}
              />
              <button type="button" className="scene-kpi-focus" title="定位来源消息" onClick={() => onFocus(cell.messageId)}>
                定位
              </button>
            </div>
          ))}
        </div>
      ))}
    </>
  )
}

/** 管道阶段列（批六：`::: pipeline` 容器聚合；未知阶段归「其他」——与消息卡同口径） */
interface PipelineStageCol {
  stage: string
  label: string
  cards: Array<{ name: string; amount: string; next: string; messageId: string }>
  /** 可解析金额合计（含数字的行才计入；全不可解析 → undefined 不显示） */
  total?: number
}

const STAGE_LABELS: Record<string, string> = { 线索: '线索', 意向: '意向', 报价: '报价', 成交: '成交', other: '其他' }

function pipelineStagesOf(containers: SceneContainer[]): PipelineStageCol[] {
  const buckets = new Map<string, PipelineStageCol['cards']>()
  const sums = new Map<string, number>()
  let anyNumeric = false
  for (const c of containers) {
    if (c.name !== 'pipeline') continue
    for (const row of parsePipelineItems(c.lines)) {
      const list = buckets.get(row.stage) ?? []
      list.push({ name: row.name, amount: row.amount, next: row.next, messageId: c.messageId })
      buckets.set(row.stage, list)
      const n = row.amount === '' ? undefined : numberWithSuffix(row.amount)
      if (n !== undefined) {
        sums.set(row.stage, (sums.get(row.stage) ?? 0) + n)
        anyNumeric = true
      }
    }
  }
  const out: PipelineStageCol[] = []
  for (const stage of ['线索', '意向', '报价', '成交', 'other']) {
    const cards = buckets.get(stage)
    if (!cards || cards.length === 0) continue
    const total = sums.get(stage)
    out.push({ stage, label: STAGE_LABELS[stage] ?? stage, cards, ...(anyNumeric && total !== undefined ? { total } : {}) })
  }
  return out
}

/** 金额合计格式：≥1 万 → 「¥N.N万」（去 .0）；否则「¥N」 */
function fmtMoney(n: number): string {
  if (n >= 10000) return `¥${String(Math.round((n / 10000) * 10) / 10).replace(/\.0$/, '')}万`
  return `¥${n}`
}

/** 节奏行（timeline 容器：日期 | 事项 | 渠道/节点）——marketing / ecommerce / legal 共用 */
interface RhythmRow {
  key: string
  messageId: string
  date: string
  text: string
  owner: string
}

function rhythmOf(containers: SceneContainer[]): RhythmRow[] {
  const out: RhythmRow[] = []
  for (const c of containers) {
    if (c.name !== 'timeline') continue
    c.lines.forEach((line, i) => {
      const row = timelineRowOf(line)
      if (row.text === '') return
      out.push({ key: `${c.messageId}:${c.seq}:${i}`, messageId: c.messageId, date: row.date, text: row.text, owner: row.owner })
    })
  }
  return out
}

/** 消息卡嵌入单元（批六：progress / qa 与消息内卡片同组件渲染——单一解析） */
interface EmbedCell {
  id: string
  messageId: string
  title: string
  rowsJson: string
}

function embedCellsOf(containers: SceneContainer[], name: 'progress' | 'qa'): EmbedCell[] {
  const out: EmbedCell[] = []
  for (const c of containers) {
    if (c.name !== name) continue
    const rows = name === 'progress' ? parseProgressItems(c.lines) : parseQaPairs(c.lines)
    if (rows.length === 0) continue
    out.push({
      id: `${c.messageId}:${c.seq}`,
      messageId: c.messageId,
      title: c.arg || (name === 'progress' ? '进度' : '问答'),
      rowsJson: JSON.stringify(rows),
    })
  }
  return out
}

/** 主张单元（批六：claim 容器；单一解析 parseClaimLines） */
interface ClaimCell {
  id: string
  messageId: string
  title: string
  items: ClaimReasonItem[]
}

function claimsOf(containers: SceneContainer[]): ClaimCell[] {
  const out: ClaimCell[] = []
  for (const c of containers) {
    if (c.name !== 'claim') continue
    const items = parseClaimLines(c.lines)
    if (items.length === 0) continue
    out.push({ id: `${c.messageId}:${c.seq}`, messageId: c.messageId, title: c.arg, items })
  }
  return out
}

export function ConsolePanel(): React.JSX.Element {
  const ctx = useSceneCtx()
  const messages = useSceneMessages()
  const containers = useSceneContainers()
  const groupId = ctx?.group?.id ?? ''
  const isBi = groupId === 'bi'
  const isSre = groupId === 'sre'
  // 批六：console 二批——sales / ecommerce / marketing / legal-personal / funding 分支
  const isSales = groupId === 'sales'
  const isEcommerce = groupId === 'ecommerce'
  const isMarketing = groupId === 'marketing'
  const isLegal = groupId === 'legal-personal'
  const isFunding = groupId === 'funding'
  /** 节奏段场景（timeline 容器 → 内容/大促/案件节奏；有专用时间轴时通用时间轴让位） */
  const rhythmScene = isMarketing || isEcommerce || isLegal
  const sessionId = ctx?.sessionId ?? ''

  const timeline = React.useMemo(
    () =>
      messages
        .filter((m) => m.role === 'agent' && m.agentId)
        .slice(-TIMELINE_MAX)
        .reverse()
        .map((m) => ({
          id: m.id,
          agentId: m.agentId!,
          text: firstLine(m.content),
          turn: m.turnIndex,
        })),
    [messages],
  )
  const columns = React.useMemo(() => columnsOf(containers), [containers])
  const deliveries = React.useMemo(() => artifactsOf(messages), [messages])

  // M66（N2/N3）：场景分支数据源（纯前端派生；有数据才渲染对应段）
  const kpiCells = React.useMemo(() => kpiCellsOf(containers), [containers])
  const incidents = React.useMemo(() => incidentsOf(containers), [containers])
  const sqlRuns = React.useMemo(() => sqlRunsOf(messages), [messages])
  // 批六：新增分支数据源（纯前端派生；有数据才渲染对应段）
  const pipelineStages = React.useMemo(() => pipelineStagesOf(containers), [containers])
  const rhythm = React.useMemo(() => rhythmOf(containers), [containers])
  const progressCells = React.useMemo(() => embedCellsOf(containers, 'progress'), [containers])
  const qaCells = React.useMemo(() => embedCellsOf(containers, 'qa'), [containers])
  const claimCells = React.useMemo(() => claimsOf(containers), [containers])

  // 等级筛选（M66 N3；sessionStorage 本地态，默认全部）
  const [levelFilter, setLevelFilter] = React.useState<string>(() => readStored('session', INCIDENT_KEY(sessionId), 'all'))
  React.useEffect(() => {
    setLevelFilter(readStored('session', INCIDENT_KEY(sessionId), 'all'))
  }, [sessionId])
  const pickLevel = (v: string): void => {
    setLevelFilter(v)
    writeStored('session', INCIDENT_KEY(sessionId), v)
  }
  const shownIncidents = levelFilter === 'all' ? incidents : incidents.filter((it) => it.level === levelFilter)

  const hasGeneric = timeline.length > 0 || columns.length > 0 || deliveries.length > 0
  if (
    !hasGeneric &&
    kpiCells.length === 0 &&
    incidents.length === 0 &&
    sqlRuns.length === 0 &&
    pipelineStages.length === 0 &&
    rhythm.length === 0 &&
    progressCells.length === 0 &&
    qaCells.length === 0 &&
    claimCells.length === 0
  ) {
    return (
      <PanelShell title="看板面板" icon={Activity}>
        <PanelEmpty icon={Activity} text="活动与产出将在这里显示" />
      </PanelShell>
    )
  }

  const timelineSection = (
    <section className="scene-console-sec">
      <div className="scene-console-cap">活动时间轴</div>
      <div className="scene-console-tl" role="list" aria-label="活动时间轴">
        {timeline.map((it) => {
          const agent = ctx?.agentOf(it.agentId)
          return (
            <button
              type="button"
              role="listitem"
              key={it.id}
              className="scene-console-item"
              title="定位来源消息"
              onClick={() => ctx?.focus(it.id)}
            >
              {agent ? (
                <AgentAvatar agent={agent} size={18} animated={false} className="shrink-0" />
              ) : (
                <span className="scene-pool-dot" aria-hidden />
              )}
              <span className="scene-console-text">{it.text}</span>
              {it.turn != null && it.turn >= 0 ? <span className="scene-console-turn">R{it.turn + 1}</span> : null}
            </button>
          )
        })}
      </div>
    </section>
  )

  return (
    <PanelShell title="看板面板" icon={Activity}>
      <div className="scene-console">
        {/* M66（N2）：指标区（bi）——kpi 卡网格（口径徽章 + 定位） */}
        {isBi && kpiCells.length > 0 ? (
          <section className="scene-console-sec" data-console-kpis="">
            <div className="scene-console-cap">指标</div>
            <KpiCells cells={kpiCells} onFocus={(id) => ctx?.focus(id)} />
          </section>
        ) : null}
        {/* M66（N2）：取数链（bi）——```sql 围栏聚合（SQL 正文由消息内代码块承载） */}
        {isBi && sqlRuns.length > 0 ? (
          <section className="scene-console-sec" data-console-sql="">
            <div className="scene-console-cap">取数链</div>
            <div className="scene-console-tl" role="list" aria-label="取数链">
              {sqlRuns.map((run) => {
                const agent = run.agentId ? ctx?.agentOf(run.agentId) : undefined
                return (
                  <button
                    type="button"
                    role="listitem"
                    key={run.messageId}
                    className="scene-sql-run"
                    title="定位取数消息（查看 SQL 全文）"
                    onClick={() => ctx?.focus(run.messageId)}
                  >
                    {agent ? (
                      <AgentAvatar agent={agent} size={18} animated={false} className="shrink-0" />
                    ) : (
                      <span className="scene-pool-dot" aria-hidden />
                    )}
                    <span className="scene-console-text">{run.excerpt || '（SQL 查询）'}</span>
                    <span className="scene-sql-badge">
                      <Database className="size-3" aria-hidden />
                      SQL ×{run.sqlCount}
                    </span>
                  </button>
                )
              })}
            </div>
          </section>
        ) : null}
        {/* M66（N3）：事故时间轴（sre）——等级色带 + 筛选；无容器回落通用时间轴 */}
        {isSre && incidents.length > 0 ? (
          <section className="scene-console-sec" data-console-incidents="">
            <div className="scene-console-cap">
              事故时间轴
              <span className="scene-incident-chips" role="toolbar" aria-label="按等级筛选">
                {[
                  ['all', '全部'],
                  ['p0', 'P0'],
                  ['p1', 'P1'],
                  ['p2', 'P2'],
                ].map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    className={`scene-incident-chip${levelFilter === key ? ' is-on' : ''}`}
                    onClick={() => pickLevel(key!)}
                  >
                    {label}
                  </button>
                ))}
              </span>
            </div>
            <div className="scene-incident" role="list" aria-label="事故时间轴">
              {shownIncidents.length === 0 ? (
                <div className="scene-cf-silent">该等级暂无事件</div>
              ) : (
                shownIncidents.map((it) => (
                  <button
                    type="button"
                    role="listitem"
                    key={it.key}
                    className={`scene-incident-row is-${it.level}`}
                    data-level={it.level}
                    title="定位来源消息"
                    onClick={() => ctx?.focus(it.messageId)}
                  >
                    <span className="scene-incident-time">{it.time}</span>
                    <span className="scene-incident-text">{it.text}</span>
                    <span className={`scene-incident-badge is-${it.level}`}>{LEVEL_LABEL[it.level]}</span>
                  </button>
                ))
              )}
            </div>
          </section>
        ) : null}
        {/* M66（N3）：SLO 区（sre）——kpi 复用指标卡渲染 */}
        {isSre && kpiCells.length > 0 ? (
          <section className="scene-console-sec" data-console-slo="">
            <div className="scene-console-cap">SLO / 错误预算</div>
            <KpiCells cells={kpiCells} onFocus={(id) => ctx?.focus(id)} />
          </section>
        ) : null}
        {/* 批六：经营指标（ecommerce）——kpi 复用指标卡 */}
        {isEcommerce && kpiCells.length > 0 ? (
          <section className="scene-console-sec" data-console-kpis="">
            <div className="scene-console-cap">经营指标</div>
            <KpiCells cells={kpiCells} onFocus={(id) => ctx?.focus(id)} />
          </section>
        ) : null}
        {/* 批六：客户管道（sales）——pipeline 容器阶段列 + 金额合计 */}
        {isSales && pipelineStages.length > 0 ? (
          <section className="scene-console-sec" data-console-pipeline="">
            <div className="scene-console-cap">客户管道</div>
            <div className="scene-pipe-cols">
              {pipelineStages.map((col) => (
                <div className="scene-pipe-col" key={col.stage} data-pipe-stage={col.stage}>
                  <div className="scene-pipe-col-head">
                    <span className="scene-pipe-stage">{col.label}</span>
                    <span className="scene-pipe-count">{col.cards.length}</span>
                    {col.total !== undefined ? (
                      <span className="scene-pipe-total" title="可解析金额合计">
                        {fmtMoney(col.total)}
                      </span>
                    ) : null}
                  </div>
                  {col.cards.map((card) => (
                    <button
                      type="button"
                      key={`${card.messageId}:${card.name}`}
                      className="scene-pipe-card"
                      title="定位来源消息"
                      onClick={() => ctx?.focus(card.messageId)}
                    >
                      <span className="scene-pipe-name">{card.name}</span>
                      {card.amount !== '' ? <span className="scene-pipe-amount">{card.amount}</span> : null}
                      {card.next !== '' ? <span className="scene-pipe-next">{card.next}</span> : null}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </section>
        ) : null}
        {/* 批六：节奏段（marketing / ecommerce / legal）——timeline 容器（第三列 = 渠道 / 节点） */}
        {rhythmScene && rhythm.length > 0 ? (
          <section className="scene-console-sec" data-console-rhythm="">
            <div className="scene-console-cap">
              {isMarketing ? '内容节奏' : isEcommerce ? '大促节奏' : '案件时间线'}
            </div>
            <div className="scene-console-tl" role="list" aria-label="节奏">
              {rhythm.map((it) => (
                <button
                  type="button"
                  role="listitem"
                  key={it.key}
                  className="scene-rhythm-row"
                  title="定位来源消息"
                  onClick={() => ctx?.focus(it.messageId)}
                >
                  <span className="scene-rhythm-date">{it.date}</span>
                  <span className="scene-console-text">{it.text}</span>
                  {it.owner !== '' ? <span className="scene-rhythm-owner">{it.owner}</span> : null}
                </button>
              ))}
            </div>
          </section>
        ) : null}
        {/* 批六：融资进度（funding）——与消息卡同组件渲染 */}
        {isFunding && progressCells.length > 0 ? (
          <section className="scene-console-sec" data-console-progress="">
            <div className="scene-console-cap">融资进度</div>
            <div className="scene-console-embed">
              {progressCells.map((cell) => (
                <div className="scene-embed-item" key={cell.id}>
                  <ProgressCard title={cell.title} rows={cell.rowsJson} />
                  <button type="button" className="scene-kpi-focus" title="定位来源消息" onClick={() => ctx?.focus(cell.messageId)}>
                    定位
                  </button>
                </div>
              ))}
            </div>
          </section>
        ) : null}
        {/* 批六：投资人问答（funding）——与消息卡同组件渲染 */}
        {isFunding && qaCells.length > 0 ? (
          <section className="scene-console-sec" data-console-qa="">
            <div className="scene-console-cap">投资人问答</div>
            <div className="scene-console-embed">
              {qaCells.map((cell) => (
                <div className="scene-embed-item" key={cell.id}>
                  <QaCard title={cell.title} rows={cell.rowsJson} />
                  <button type="button" className="scene-kpi-focus" title="定位来源消息" onClick={() => ctx?.focus(cell.messageId)}>
                    定位
                  </button>
                </div>
              ))}
            </div>
          </section>
        ) : null}
        {/* 批六：主张与依据（legal-personal）——claim 容器（单一解析 parseClaimLines） */}
        {isLegal && claimCells.length > 0 ? (
          <section className="scene-console-sec" data-console-claims="">
            <div className="scene-console-cap">主张与依据</div>
            {claimCells.map((cell) => (
              <div className="scene-claimcell" key={cell.id}>
                <div className="scene-claimcell-head">
                  <span className="scene-claimcell-title">{cell.title || '主张'}</span>
                  <button type="button" className="scene-kpi-focus" title="定位来源消息" onClick={() => ctx?.focus(cell.messageId)}>
                    定位
                  </button>
                </div>
                <div className="scene-claimcell-items">
                  {cell.items.map((item, i) => (
                    <div className="scene-claimcell-item" key={i}>
                      <span className="scene-claimcell-text">{item.text}</span>
                      {item.evidence !== undefined && item.evidence !== '' ? (
                        <span className="scene-claimcell-evidence">{item.evidence}</span>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </section>
        ) : null}
        {columns.length > 0 ? (
          <section className="scene-console-sec">
            <div className="scene-console-cap">管道</div>
            <KanbanBoard columns={columns} onCard={(card) => ctx?.focus(card.id.split(':')[0]!)} />
          </section>
        ) : null}
        {/* sre / 节奏场景有专用时间轴时不重复渲染通用时间轴；其余场景与 bi 保持现行口径 */}
        {!isSre && !rhythmScene && timeline.length > 0 ? timelineSection : null}
        {isSre && incidents.length === 0 && timeline.length > 0 ? timelineSection : null}
        {rhythmScene && rhythm.length === 0 && timeline.length > 0 ? timelineSection : null}
        {deliveries.length > 0 ? (
          <section className="scene-console-sec">
            <div className="scene-console-cap">交付件</div>
            <DeliveryPanel
              items={deliveries.map((path) => ({ path }))}
              onOpen={(path) => useUiStore.getState().requestArtifact(path)}
            />
          </section>
        ) : null}
      </div>
    </PanelShell>
  )
}

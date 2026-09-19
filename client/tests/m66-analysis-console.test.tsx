/**
 * M66（批二 · 分析域）：指标/取数链 · 事故时间轴 · 立场泳道与共识分歧板 · 窄屏洞察收纳 组件与派生测试。
 * - lib/derive：incidentLevelOf（P0/P1/P2/other 映射与容忍词）· sqlRunsOf（```sql 围栏计数与摘要）；
 * - remark-ext：kpiRowOf（五列含口径 / 四列兼容）· timelineRowOf（列表标记剥离）；
 * - 消息渲染：kpi 口径徽章（有/无）· stance 立场卡（三要素序 / 依据等级徽标 / 推演回填 / raw 兜底）·
 *   split 共识分歧板（三列分桶 / 未知键落其他 / 分歧与存疑回填）；
 * - ConsolePanel 场景分支：bi 指标区与取数链（点击定位）· sre 事故时间轴（等级徽章 + 筛选 +
 *   sessionStorage 记忆）与 SLO 区（无容器回落通用时间轴）· 其他场景零变化；
 * - PoolPanel：立场泳道分组（色相数据属性）与共识分歧板沉淀、stance/split 不入通用卡墙；
 * - ArenaStage U5：窄屏洞察条（默认收起 → 展开；宽屏行为不变）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type * as React from 'react'
import type { AgentDefinition, AgentGroup, ChatMessage } from '@multi-agent/shared'
import { Markdown } from '../src/components/chat/Markdown'
import { MessageContext } from '../src/components/chat/md-ext/message-context'
import { kpiRowOf, timelineRowOf } from '../src/components/chat/md-ext/remark-ext'
import { incidentLevelOf, sqlRunsOf } from '../src/components/scene/derive'
import { ArenaStage } from '../src/components/scene/ArenaStage'
import { SceneContext, type SceneCtx } from '../src/components/scene/context'
import { ConsolePanel, PoolPanel } from '../src/components/scene/panels'
import { TEMPLATES } from '../src/lib/pk'
import { useAgentStore } from '../src/stores/agent-store'
import { useSessionStore } from '../src/stores/session-store'
import { useUiStore } from '../src/stores/ui-store'

const T0 = '2026-09-19T02:00:00.000Z'

// ---------- fixtures ----------

function makeAgent(over: Partial<AgentDefinition> & { id: string; name: string }): AgentDefinition {
  return {
    role: '成员',
    title: '',
    description: '',
    capabilities: [],
    group: 'bi',
    avatar: { gradient: ['#6366f1', '#818cf8'], icon: 'user' },
    handoff: [],
    ...over,
  }
}

const SHENXI = makeAgent({ id: 'bi', name: '沈析' })
const JIANGYU = makeAgent({ id: 'sre', name: '江屿', group: 'sre' })
const FANGHENG = makeAgent({ id: 'stakeholder', name: '方衡', group: 'society' })
const QIGUAN = makeAgent({ id: 'moderator', name: '齐观', group: 'society' })
const LIYAN = makeAgent({ id: 'affirmative', name: '立言', group: 'debate' })
const LIFENG = makeAgent({ id: 'negative', name: '砺锋', group: 'debate' })
const MINGDUAN = makeAgent({ id: 'judge', name: '明断', group: 'debate' })
const ALL = [SHENXI, JIANGYU, FANGHENG, QIGUAN, LIYAN, LIFENG, MINGDUAN]

function agentMsg(id: string, agentId: string, content: string, over: Partial<ChatMessage> = {}): ChatMessage {
  return { id, sessionId: 'sa', runId: 'r1', role: 'agent', agentId, content, mentions: [], status: 'complete', createdAt: T0, ...over }
}

function seed(messages: ChatMessage[]): void {
  const byId = new Map<string, ChatMessage>()
  const order: string[] = []
  for (const m of messages) {
    byId.set(m.id, m)
    order.push(m.id)
  }
  useSessionStore.setState({ byId, order })
}

function makeGroup(id: string): AgentGroup {
  return {
    id,
    name: id,
    description: '',
    icon: 'activity',
    theme: ['#6366f1', '#818cf8'],
    objective: '',
    chain: [],
    defaultSkills: [],
    parallel: false,
    rounds: false,
    order: 100,
    stage: { layout: 'dock', panel: 'console' },
  } as AgentGroup
}

function makeCtx(over: Partial<SceneCtx> = {}): SceneCtx {
  return {
    sessionId: 'sa',
    stage: { layout: 'arena', seats: { left: ['affirmative'], right: ['negative'], center: ['judge'] }, parts: [], fallback: false },
    participants: [LIYAN, LIFENG, MINGDUAN],
    narrow: false,
    waitingIds: [],
    insert: () => {},
    focus: () => {},
    agentOf: (agentId) => ALL.find((a) => a.id === agentId),
    ...over,
  }
}

function wrapConsole(groupId: string, over: Partial<SceneCtx> = {}): React.JSX.Element {
  return (
    <SceneContext.Provider value={makeCtx({ group: makeGroup(groupId), participants: [SHENXI, JIANGYU], ...over })}>
      <ConsolePanel />
    </SceneContext.Provider>
  )
}

function wrap(ui: React.ReactElement, ctx: SceneCtx = makeCtx()): React.JSX.Element {
  return <SceneContext.Provider value={ctx}>{ui}</SceneContext.Provider>
}

function wrapMd(ui: React.ReactElement): React.JSX.Element {
  return <MessageContext.Provider value={{ messageId: 'm1', sessionId: 'sa' }}>{ui}</MessageContext.Provider>
}

beforeEach(() => {
  useAgentStore.setState({ agents: [...ALL], groups: [], skills: [], loaded: true, loading: false, statuses: {} })
  useSessionStore.setState({ currentId: 'sa', byId: new Map(), order: [] })
  useUiStore.setState({ composerInsert: undefined })
  sessionStorage.clear()
})

// ---------- 纯函数 ----------

describe('M66 · 行级解析与派生（纯函数）', () => {
  it('kpiRowOf：五列含口径 / 四列兼容 / 列表标记剥离', () => {
    expect(kpiRowOf('- 月度营收 | 1,284 | +8.4% | 1,400 | GMV 口径')).toEqual({
      name: '月度营收',
      value: '1,284',
      delta: '+8.4%',
      target: '1,400',
      scope: 'GMV 口径',
    })
    expect(kpiRowOf('可用性 | 99.92% | -0.03% | 99.9%').scope).toBe('')
  })

  it('timelineRowOf：`日期 | 事项 | 等级` 拆分与标记剥离', () => {
    expect(timelineRowOf('- 10:02 | P95 延迟突增 | P0')).toEqual({ date: '10:02', text: 'P95 延迟突增', owner: 'P0' })
  })

  it('incidentLevelOf：P0/P1/P2 与中文档位容忍；其余归 other', () => {
    expect(incidentLevelOf('P0')).toBe('p0')
    expect(incidentLevelOf('严重')).toBe('p0')
    expect(incidentLevelOf('高')).toBe('p1')
    expect(incidentLevelOf('P2')).toBe('p2')
    expect(incidentLevelOf('中')).toBe('p2')
    expect(incidentLevelOf('观察')).toBe('other')
    expect(incidentLevelOf('')).toBe('other')
  })

  it('sqlRunsOf：```sql 围栏计数与摘要；用户消息与无围栏消息跳过', () => {
    const runs = sqlRunsOf([
      agentMsg('m1', 'bi', ['先对齐口径。', '```sql', 'SELECT 1', '```', '```sql', 'SELECT 2', '```'].join('\n')),
      agentMsg('m2', 'bi', '无 SQL 的消息'),
      { ...agentMsg('m3', 'bi', '```sql\nSELECT 3\n```'), role: 'user' },
    ])
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ messageId: 'm1', agentId: 'bi', sqlCount: 2 })
    expect(runs[0]!.excerpt).toContain('先对齐口径')
  })
})

// ---------- 消息渲染 ----------

describe('M66 · 指标口径徽章（::: kpi 五列）', () => {
  it('五列：口径徽章渲染（截断 + title 全文）；四列：无徽章', () => {
    const withScope = ['::: kpi 核心指标', '- 月度营收 | 1,284 | +8.4% | 1,400 | GMV 口径，剔除退货', ':::'].join('\n')
    const plain = ['::: kpi 旧指标', '- 订单量 | 9,860 | +3.1% | 11,000', ':::'].join('\n')
    const a = render(wrapMd(<Markdown content={withScope} />))
    const scope = a.container.querySelector('.md-kpi-scope')!
    expect(scope).not.toBeNull()
    expect(scope.textContent).toContain('口径')
    expect(scope.getAttribute('title')).toContain('GMV 口径，剔除退货')
    const b = render(wrapMd(<Markdown content={plain} />))
    expect(b.container.querySelector('.md-kpi-scope')).toBeNull()
  })
})

const STANCE = [
  '::: stance 灵活就业群体',
  '主张：平台应承担基本社保配套',
  '核心关切：收入稳定性与职业伤害保障',
  '被忽视视角：小微平台方的成本承受力',
  '- 依据 | 2025 年灵活就业规模约 2 亿（统计局，已核实）',
  ':::',
].join('\n')

describe('M66 · 立场卡（::: stance）', () => {
  it('Markdown 路由：三要素序 + 依据等级徽标 + 推演关切回填', () => {
    const { container } = render(wrapMd(<Markdown content={STANCE} />))
    const card = container.querySelector('.md-stance[data-stance-card]')!
    expect(card).not.toBeNull()
    expect(card.querySelector('.md-stance-badge')?.textContent).toBe('立场')
    expect(card.querySelector('.md-stance-title')?.textContent).toBe('灵活就业群体')
    const keys = Array.from(card.querySelectorAll('.md-stance-k')).map((n) => n.textContent)
    expect(keys).toEqual(['主张', '核心关切', '被忽视视角'])
    expect(card.querySelector('.scene-claim-grade.is-official')?.textContent).toBe('官方')
    fireEvent.click(card.querySelector('.md-stance-ask')!)
    expect(useUiStore.getState().composerInsert?.text).toBe(
      TEMPLATES.stanceAsk('灵活就业群体', '收入稳定性与职业伤害保障'),
    )
  })

  it('无字段无条目 → 正文照常渲染（不丢内容）', () => {
    const plain = render(wrapMd(<Markdown content={['::: stance 某方', '仅一段正文', ':::'].join('\n')} />))
    expect(plain.getByText('仅一段正文')).toBeInTheDocument()
  })
})

const SPLIT = [
  '::: split 议题共识与分歧',
  '- 共识 | 事实基线与主要数据来源无争议',
  '- 分歧 | 成本分摊比例（平台 / 个人 / 公共财政）',
  '- 存疑 | 地方试点效果的样本代表性',
  '- 其他键 | 兜底保留',
  ':::',
].join('\n')

describe('M66 · 共识分歧板（::: split）', () => {
  it('Markdown 路由：三列分桶 + 未知键落其他行 + 分歧/存疑回填', () => {
    const { container } = render(wrapMd(<Markdown content={SPLIT} />))
    const board = container.querySelector('.md-split[data-split-card]')!
    expect(board).not.toBeNull()
    const cols = board.querySelectorAll('.md-split-col')
    expect(cols).toHaveLength(3)
    expect(board.querySelector('.md-split-col.is-consensus .md-split-item')?.textContent).toBe('事实基线与主要数据来源无争议')
    expect(board.querySelectorAll('.md-split-col.is-split .md-split-item.is-action')).toHaveLength(1)
    expect(board.querySelectorAll('.md-split-col.is-doubt .md-split-item.is-action')).toHaveLength(1)
    expect(board.querySelector('.md-split-other')?.textContent).toContain('其他键：兜底保留')
    fireEvent.click(board.querySelector('.md-split-col.is-split .md-split-item.is-action')!)
    expect(useUiStore.getState().composerInsert?.text).toBe(TEMPLATES.splitPath('成本分摊比例（平台 / 个人 / 公共财政）'))
    fireEvent.click(board.querySelector('.md-split-col.is-doubt .md-split-item.is-action')!)
    expect(useUiStore.getState().composerInsert?.text).toBe(TEMPLATES.splitVerify('地方试点效果的样本代表性'))
  })
})

// ---------- ConsolePanel 场景分支 ----------

const KPI_MSG = [
  '::: kpi 核心指标（口径见列）',
  '- 月度营收（万元） | 1,284 | +8.4% | 1,400 | GMV 口径，剔除退货',
  '- 订单量（单） | 9,860 | +3.1% | 11,000 | 支付口径',
  ':::',
].join('\n')

const SQL_MSG = ['对齐口径后取数。', '```sql', 'SELECT 1', '```'].join('\n')

const TIMELINE_MSG = [
  '::: timeline 事故时间轴',
  '- 10:02 | 监控告警：P95 延迟突增 | P0',
  '- 10:06 | 值班确认影响面 | P0',
  '- 10:12 | 回滚上一版发布 | P1',
  '- 10:40 | 定位为连接池耗尽 | P2',
  ':::',
].join('\n')

describe('M66 · ConsolePanel bi 分支（指标区 + 取数链）', () => {
  it('指标卡（口径徽章）+ 取数链条目；点击条目定位来源消息', () => {
    seed([agentMsg('m1', 'bi', KPI_MSG), agentMsg('m2', 'bi', SQL_MSG)])
    const focus = vi.fn()
    const { container } = render(wrapConsole('bi', { focus }))
    const kpis = container.querySelector('[data-console-kpis]')!
    expect(kpis).not.toBeNull()
    expect(kpis.querySelectorAll('.scene-kpi-cell')).toHaveLength(2)
    expect(kpis.querySelector('.md-kpi-scope')?.textContent).toContain('口径')
    const sqls = container.querySelector('[data-console-sql]')!
    expect(sqls).not.toBeNull()
    const run = sqls.querySelector('.scene-sql-run')!
    expect(run.textContent).toContain('SQL ×1')
    fireEvent.click(run)
    expect(focus).toHaveBeenCalledWith('m2')
    fireEvent.click(kpis.querySelector('.scene-kpi-focus')!)
    expect(focus).toHaveBeenCalledWith('m1')
  })

  it('非 bi / sre 场景：新段不渲染（通用口径零变化）', () => {
    seed([agentMsg('m1', 'bi', KPI_MSG), agentMsg('m2', 'bi', SQL_MSG)])
    const { container } = render(wrapConsole('sales'))
    expect(container.querySelector('[data-console-kpis]')).toBeNull()
    expect(container.querySelector('[data-console-sql]')).toBeNull()
    expect(screen.getByText('活动时间轴')).toBeInTheDocument()
  })
})

describe('M66 · ConsolePanel sre 分支（事故时间轴 + SLO）', () => {
  it('分级时间轴 + 筛选 chips（sessionStorage 记忆）+ SLO 区；通用时间轴让位', () => {
    seed([agentMsg('m1', 'sre', TIMELINE_MSG), agentMsg('m2', 'sre', KPI_MSG)])
    const { container } = render(wrapConsole('sre', { participants: [JIANGYU] }))
    const incidents = container.querySelector('[data-console-incidents]')!
    expect(incidents).not.toBeNull()
    expect(incidents.querySelectorAll('.scene-incident-row')).toHaveLength(4)
    expect(incidents.querySelectorAll('.scene-incident-row[data-level="p0"]')).toHaveLength(2)
    expect(incidents.querySelector('.scene-incident-badge.is-p0')?.textContent).toBe('P0')
    // 筛选：P0 → 仅 2 条；本地态记忆
    fireEvent.click(incidents.querySelector('[role="toolbar"] .scene-incident-chip:nth-child(2)')!)
    expect(incidents.querySelectorAll('.scene-incident-row[data-level="p0"]')).toHaveLength(2)
    expect(incidents.querySelectorAll('.scene-incident-row')).toHaveLength(2)
    expect(sessionStorage.getItem('ma:sc:tl:sa')).toBe('"p0"')
    // SLO 区（kpi 复用指标卡）
    const slo = container.querySelector('[data-console-slo]')!
    expect(slo).not.toBeNull()
    expect(slo.textContent).toContain('SLO / 错误预算')
    // 事故时间轴在场 → 通用「活动时间轴」不重复渲染
    expect(screen.queryByText('活动时间轴')).toBeNull()
  })

  it('无 timeline 容器 → 回落通用活动时间轴', () => {
    seed([agentMsg('m1', 'sre', '巡检完成，SLO 稳定。')])
    render(wrapConsole('sre', { participants: [JIANGYU] }))
    expect(screen.getByText('活动时间轴')).toBeInTheDocument()
    expect(screen.queryByText('事故时间轴')).toBeNull()
  })
})

// ---------- PoolPanel 立场泳道与共识分歧板 ----------

describe('M66 · PoolPanel（立场泳道 + 共识分歧板）', () => {
  const STANCE_B = [
    '::: stance 平台企业方',
    '主张：按订单灵活参保、成本共担',
    '核心关切：单位用工成本与合规确定性',
    '- 依据 | 行业调研（权威媒体，已核实）',
    ':::',
  ].join('\n')

  it('两立场方 → 两条泳道（色相属性）+ 共识分歧板；stance / split 不入通用卡墙', () => {
    seed([
      agentMsg('m1', 'stakeholder', STANCE),
      agentMsg('m2', 'stakeholder', STANCE_B),
      agentMsg('m3', 'moderator', SPLIT),
    ])
    const focus = vi.fn()
    const { container } = render(wrap(<PoolPanel />, makeCtx({ group: makeGroup('society'), participants: [FANGHENG, QIGUAN], focus })))
    const lanes = container.querySelector('[data-pool-stance]')!
    expect(lanes).not.toBeNull()
    const laneEls = lanes.querySelectorAll('.scene-stance-lane')
    expect(laneEls).toHaveLength(2)
    expect(laneEls[0]!.getAttribute('data-hue')).not.toBeNull()
    expect(laneEls[0]!.textContent).toContain('灵活就业群体')
    expect(lanes.querySelectorAll('.md-stance[data-stance-card]')).toHaveLength(2)
    const board = container.querySelector('[data-pool-split]')!
    expect(board).not.toBeNull()
    expect(board.querySelectorAll('.md-split-col')).toHaveLength(3)
    // 定位：泳道条 focus 按钮
    fireEvent.click(lanes.querySelector('.scene-pool-focus')!)
    expect(focus).toHaveBeenCalledWith('m1')
  })
})

// ---------- ArenaStage U5：窄屏洞察条 ----------

describe('M66 · arena 窄屏洞察收纳（U5）', () => {
  const FINDINGS = ['::: findings 反方挑刺', '- 缺陷 1 | 样本区间偏窄', ':::'].join('\n')

  it('窄屏：洞察条默认收起 → 点击展开；宽屏：无条直接渲染', () => {
    seed([agentMsg('m1', 'negative', FINDINGS, { turnIndex: 0 })])
    const narrow = render(wrap(<ArenaStage><div>流</div></ArenaStage>, makeCtx({ narrow: true })))
    const bar = narrow.container.querySelector('[data-insights-bar]')!
    expect(bar).not.toBeNull()
    expect(bar.textContent).toContain('洞察区')
    expect(narrow.container.querySelector('[data-insights]')).toBeNull()
    fireEvent.click(bar)
    expect(narrow.container.querySelector('[data-insights]')).not.toBeNull()
    narrow.unmount()

    const wide = render(wrap(<ArenaStage><div>流</div></ArenaStage>, makeCtx()))
    expect(wide.container.querySelector('[data-insights-bar]')).toBeNull()
    expect(wide.container.querySelector('[data-insights]')).not.toBeNull()
  })
})

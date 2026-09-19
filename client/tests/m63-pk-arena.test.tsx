/**
 * M63（批一 · PK · 博弈 · 分析三域）：对抗博弈主面组件与派生测试。
 * - lib/evidence 证据等级词表（优先级 / 未命中）；
 * - lib/pk 扩展：claim 扩展字段 / 交锋计量（claims）/ crossFireOf / offerSeriesOf / TEMPLATES；
 * - `::: ruling` 判定卡消息渲染（状态色 / data-head / raw 兜底）；
 * - ClaimTree 证据徽标（等级 / 补证据 / 假设回填）与元信息 chips；
 * - arena 集成：A1 计分板读数与交锋定位 / A2 交锋看板（未响应优先 + 催回应）/
 *   A4 回合轴判定色点与轮次读数 / A5 参与条（叫停 / 加一轮引用未决点）/ A6 结论条（关闭记忆）/
 *   G1/G2 报价图（点位定位 / 收敛走廊 / 基准线）与让步刻度（警示回填）；
 * - versus 集成：N1 四路观点卡（分歧 chip / 追问 / 定位）/ G4 走子板（种子复制 / 推演声明）
 *   与发起多空对弈；pool 红队看板（只读）；
 * - panelReady：versus 扩展口径（带视角 claim / ```game 围栏）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type * as React from 'react'
import type { AgentDefinition, ChatMessage } from '@multi-agent/shared'
import { Markdown } from '../src/components/chat/Markdown'
import { RulingCard } from '../src/components/chat/md-ext/RulingCard'
import { MessageContext } from '../src/components/chat/md-ext/message-context'
import { ArenaStage } from '../src/components/scene/ArenaStage'
import { SceneContext, type SceneCtx } from '../src/components/scene/context'
import { panelReady } from '../src/components/scene/panel-ready'
import { PoolPanel, VersusPanel } from '../src/components/scene/panels'
import { ClaimTree } from '../src/components/scene/parts'
import { containersOf, gameMovesOf, rulingsOf, verdictsOf } from '../src/components/scene/derive'
import { EVIDENCE_LABEL, gradeOf } from '../src/lib/evidence'
import {
  claimMetaOf,
  claimNodesOfContent,
  crossFireOf,
  duelTally,
  DUEL_PROMPT,
  offerSeriesOf,
  TEMPLATES,
} from '../src/lib/pk'
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
    group: 'debate',
    avatar: { gradient: ['#6366f1', '#818cf8'], icon: 'user' },
    handoff: [],
    ...over,
  }
}

const LIYAN = makeAgent({ id: 'affirmative', name: '立言' })
const LIFENG = makeAgent({ id: 'negative', name: '砺锋' })
const MINGDUAN = makeAgent({ id: 'judge', name: '明断' })
const TANCHENG = makeAgent({ id: 'negotiator', name: '谭成', group: 'negotiation' })
const QIYI = makeAgent({ id: 'counterpart', name: '祁弈', group: 'negotiation' })
const SUZONG = makeAgent({ id: 'tactician', name: '苏纵', group: 'negotiation' })
const QINYAN = makeAgent({ id: 'analyst-fa', name: '秦砚', group: 'invest' })
const LEIDONG = makeAgent({ id: 'analyst-ta', name: '雷动', group: 'invest' })
const ZHUHENG = makeAgent({ id: 'invest-lead', name: '祝衡', group: 'invest' })
const IDEO = makeAgent({ id: 'ideator', name: '阿发', group: 'brainstorm' })
const CHALL = makeAgent({ id: 'challenger', name: '挑刺', group: 'brainstorm' })
const ALL_AGENTS = [LIYAN, LIFENG, MINGDUAN, TANCHENG, QIYI, SUZONG, QINYAN, LEIDONG, ZHUHENG, IDEO, CHALL]

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

function makeCtx(over: Partial<SceneCtx> = {}): SceneCtx {
  return {
    sessionId: 'sa',
    stage: { layout: 'arena', seats: { left: ['affirmative'], right: ['negative'], center: ['judge'] }, parts: [], fallback: false },
    participants: [LIYAN, LIFENG, MINGDUAN],
    narrow: false,
    waitingIds: [],
    insert: () => {},
    focus: () => {},
    agentOf: (agentId) => ALL_AGENTS.find((a) => a.id === agentId),
    ...over,
  }
}

function wrap(ui: React.ReactElement, ctx: SceneCtx = makeCtx()): React.JSX.Element {
  return <SceneContext.Provider value={ctx}>{ui}</SceneContext.Provider>
}

function wrapMd(ui: React.ReactElement): React.JSX.Element {
  return <MessageContext.Provider value={{ messageId: 'm1', sessionId: 'sa' }}>{ui}</MessageContext.Provider>
}

beforeEach(() => {
  useAgentStore.setState({ agents: [...ALL_AGENTS], groups: [], skills: [], loaded: true, loading: false, statuses: {} })
  useSessionStore.setState({ currentId: 'sa', byId: new Map(), order: [] })
  useUiStore.setState({ composerInsert: undefined })
  sessionStorage.clear()
})

// ---------- lib/evidence ----------

describe('证据等级徽标（lib/evidence）', () => {
  it('词表优先级：官方 > 学术 > 权威媒体 > 待核实；未命中 undefined', () => {
    expect(gradeOf('官方通报（统计局）')).toBe('official')
    expect(gradeOf('学术论文（期刊）')).toBe('academic')
    expect(gradeOf('权威媒体报道')).toBe('media')
    expect(gradeOf('网传消息，待核实')).toBe('unverified')
    expect(gradeOf('官方渠道发布的公告，细节待核实')).toBe('official')
    expect(gradeOf('一份来源')).toBeUndefined()
    expect(gradeOf('')).toBeUndefined()
    expect(EVIDENCE_LABEL.official).toBe('官方')
  })
})

// ---------- lib/pk 扩展 ----------

const VIEW_FA = ['::: claim 估值处于历史低位', '视角：基本面', '倾向：多方', '置信度：高', '- 依据 | PE 分位 18%', ':::'].join('\n')
const FINDINGS_L = ['::: findings 反方挑刺', '- 缺陷 1 | 样本区间偏窄', '- 缺陷 2 | 口径不一致 | 补口径', ':::'].join('\n')

describe('claim 扩展字段（N1 数据源）', () => {
  it('claimMetaOf / claimNodesOfContent：视角 / 倾向 / 置信度解析（各取首条）', () => {
    const meta = claimMetaOf(['视角：基本面', '倾向：多方', '置信度：高', '视角：技术面'])
    expect(meta).toEqual({ perspective: '基本面', stance: '多方', confidence: '高' })
    const nodes = claimNodesOfContent(VIEW_FA)
    expect(nodes).toHaveLength(1)
    expect(nodes[0]!.perspective).toBe('基本面')
    expect(nodes[0]!.stance).toBe('多方')
    expect(nodes[0]!.confidence).toBe('高')
    expect(nodes[0]!.reasons).toHaveLength(1)
  })
})

describe('交锋计量与交锋看板（A1/A2 数据源）', () => {
  it('duelTally：claims 计数与 findings / responded 口径', () => {
    const tally = duelTally(
      [
        { id: 'm1', role: 'agent', agentId: 'affirmative', content: `${VIEW_FA}\n\n${FINDINGS_L}` },
        { id: 'm2', role: 'agent', agentId: 'negative', content: '按编号回补：「缺陷 1」已补样本，「缺陷 2」给了口径。' },
      ],
      { left: ['affirmative'], right: ['negative'] },
    )
    expect(tally.left).toEqual({ speaks: 1, claims: 1, findings: 2, responded: 2 })
    expect(tally.right).toEqual({ speaks: 1, claims: 0, findings: 0, responded: 0 })
  })

  it('crossFireOf：未响应优先排序 + 已响应状态（全量提及扫描）', () => {
    const model = crossFireOf(
      [
        { id: 'm1', role: 'agent', agentId: 'affirmative', content: FINDINGS_L },
        { id: 'm2', role: 'agent', agentId: 'negative', content: '「缺陷 2」回应一下：口径已统一。' },
      ],
      { left: ['affirmative'], right: ['negative'] },
    )
    expect(model.left).toHaveLength(2)
    expect(model.left[0]!.id).toBe(1)
    expect(model.left[0]!.responded).toBe(false)
    expect(model.left[1]!.id).toBe(2)
    expect(model.left[1]!.responded).toBe(true)
    expect(model.left[0]!.messageId).toBe('m1')
  })

  it('offerSeriesOf：两侧序列 + 基准线 + 让步理由（不可解析点跳过）', () => {
    const O1 = ['::: offer 首轮出价', '报价：98 万', '目标：120 万', '底线：82 万', 'BATNA：70 万', ':::'].join('\n')
    const O2 = ['::: offer 反出价', '报价：68 万', ':::'].join('\n')
    const series = offerSeriesOf(
      [
        { id: 'm1', role: 'agent', agentId: 'negotiator', content: O1, turnIndex: 0 },
        { id: 'm2', role: 'agent', agentId: 'counterpart', content: O2, turnIndex: 0 },
      ],
      { left: ['negotiator'], right: ['counterpart'] },
    )
    expect(series.points).toHaveLength(2)
    expect(series.points[0]).toMatchObject({ side: 'left', amount: 980000, headline: '98 万' })
    expect(series.points[1]).toMatchObject({ side: 'right', amount: 680000 })
    expect(series.baselines).toEqual({ target: 1200000, bottom: 820000, batna: 700000 })
  })

  it('TEMPLATES：交锋 / 证据 / 参与条 / 观点模板文案', () => {
    expect(TEMPLATES.chaseFinding(3)).toBe('请回应「缺陷 3」：给出修补或反驳，不要跳过。')
    expect(TEMPLATES.askEvidence('论据')).toContain('官方 / 学术 / 权威媒体 / 待核实')
    expect(TEMPLATES.markHypothesis('论据')).toContain('明示其假设地位')
    expect(TEMPLATES.extraRound('明断', '成本口径')).toContain('重点交锋「成本口径」')
    expect(TEMPLATES.extraRound('明断')).toContain('尚未回应的分歧点')
    expect(TEMPLATES.stopAndVerdict('明断')).toContain('终局裁决')
    expect(TEMPLATES.leanSide('明断', '立言')).toContain('我的观感倾向：立言')
    expect(TEMPLATES.viewAsk('基本面', '结论')).toBe('请围绕基本面观点「结论」补充依据与置信度说明。')
    expect(TEMPLATES.concessionExplain('5 万', '3 万')).toContain('相比上一轮（3 万）扩大')
    expect(DUEL_PROMPT).toContain('多空对弈')
  })
})

// ---------- `::: ruling` 消息渲染 ----------

describe('判定卡（::: ruling）', () => {
  const RULING = ['::: ruling 正方 第 1 轮小结', '- 亮点 | 量化了成本口径', '- 未决点 | 边际成本是否成立', ':::'].join('\n')

  it('Markdown 路由：状态色类族 + data-head 原文徽标 + 条目', () => {
    const { container } = render(wrapMd(<Markdown content={RULING} />))
    const card = container.querySelector('.md-ruling.md-ruling-long[data-ruling-card]')!
    expect(card).not.toBeNull()
    expect(card.querySelector('.md-ruling-badge')?.textContent).toBe('正方')
    expect(card.querySelector('.md-ruling-title')?.textContent).toBe('第 1 轮小结')
    const items = card.querySelectorAll('.md-ruling-item')
    expect(items).toHaveLength(2)
    expect(items[0]!.textContent).toContain('亮点')
    expect(items[1]!.textContent).toContain('未决点')
  })

  it('未命中状态词 → 中性徽标；空条目 → raw 兜底', () => {
    const { container } = render(
      wrapMd(<Markdown content={['::: ruling 第 1 轮小节', '- 亮点 | 各自完成一轮', ':::'].join('\n')} />),
    )
    expect(container.querySelector('.md-ruling-badge.is-neutral')?.textContent).toBe('小结')
    // 无条目：正文照常渲染（不丢内容）；data-raw 兜底为独立路径（下方直测）
    const plain = render(wrapMd(<Markdown content={['::: ruling 正方 小结', '无条目正文', ':::'].join('\n')} />))
    expect(plain.getByText('无条目正文')).toBeInTheDocument()
    const bare = render(<RulingCard items="oops" raw="备份文本" />)
    expect(bare.container.querySelector('.md-ruling-static')?.textContent).toBe('备份文本')
  })

  it('rulingsOf：容器派生（side / title / items / messageId）', () => {
    const out = rulingsOf([agentMsg('m1', 'judge', RULING, { turnIndex: 0 })])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ side: 'long', title: '第 1 轮小结', messageId: 'm1' })
    expect(out[0]!.items).toHaveLength(2)
  })
})

// ---------- ClaimTree 证据徽标 ----------

describe('ClaimTree 证据徽标与 chips（A3）', () => {
  const node = {
    claim: '主张',
    perspective: '基本面',
    stance: '多方',
    confidence: '高',
    reasons: [
      { text: '论据甲', evidence: '官方 通报' },
      { text: '论据乙', evidence: '某处听说' },
      { text: '论据丙' },
    ],
  }

  it('等级徽标 / 补证据 / 假设回填 / 元信息 chips', () => {
    const onEvidenceAsk = vi.fn()
    const onHypoAsk = vi.fn()
    const { container } = render(
      <ClaimTree nodes={[node]} onEvidenceAsk={onEvidenceAsk} onHypoAsk={onHypoAsk} />,
    )
    expect(container.querySelector('.scene-claim-chip.is-perspective')?.textContent).toBe('基本面')
    expect(container.querySelector('.scene-claim-chip.is-stance.is-long')?.textContent).toBe('多方')
    expect(container.querySelector('.scene-claim-chip.is-conf')?.textContent).toBe('置信度 高')
    fireEvent.click(container.querySelector('.scene-claim-head')!)
    const rows = container.querySelectorAll('.scene-claim-reason')
    expect(rows).toHaveLength(3)
    expect(rows[0]!.querySelector('.scene-claim-grade.is-official')?.textContent).toBe('官方')
    fireEvent.click(rows[1]!.querySelector('.scene-claim-ask')!)
    expect(onEvidenceAsk).toHaveBeenCalledWith('论据乙')
    fireEvent.click(rows[2]!.querySelector('.scene-claim-ask.is-hypo')!)
    expect(onHypoAsk).toHaveBeenCalledWith('论据丙')
  })
})

// ---------- arena 集成 ----------

const VERDICT = ['::: verdict 正方 辩论裁决（3 轮制）', '- 置信度 | 高', '- 翻盘条件 | 出现跨周期样本会逆转结论', ':::'].join('\n')
const RULING1 = ['::: ruling 正方 第 1 轮小结', '- 未决点 | 规模化后的边际成本是否成立', ':::'].join('\n')
const OFFER_L2 = ['::: offer 第二轮', '报价：88 万', ':::'].join('\n')
const OFFER_L3 = ['::: offer 第三轮', '报价：70 万', ':::'].join('\n')
const OFFER_R1 = ['::: offer 反出价', '报价：68 万', ':::'].join('\n')
const OFFER_R2 = ['::: offer 对手二轮', '报价：76 万', ':::'].join('\n')

function negoCtx(over: Partial<SceneCtx> = {}): SceneCtx {
  return makeCtx({
    stage: { layout: 'arena', seats: { left: ['negotiator'], right: ['counterpart'], center: ['tactician'] }, parts: [], fallback: false },
    participants: [TANCHENG, QIYI, SUZONG],
    ...over,
  })
}

describe('arena 集成：A1 计分板 / A2 交锋看板 / A4 回合轴 / A5 参与条 / A6 结论条', () => {
  it('A1 交锋计量板：读数与交锋点击 → 定位未响应缺陷消息', () => {
    seed([
      agentMsg('m1', 'negative', FINDINGS_L, { turnIndex: 0 }),
      agentMsg('m2', 'affirmative', '「缺陷 2」回应：口径已统一。', { turnIndex: 0 }),
    ])
    const focus = vi.fn()
    const { container } = render(wrap(<ArenaStage><div>流</div></ArenaStage>, makeCtx({ focus })))
    const sb = container.querySelector('.scene-scoreboard')!
    const metrics = sb.querySelectorAll('.scene-sb-metrics')
    expect(metrics).toHaveLength(2)
    expect(metrics[0]!.textContent).toContain('发言')
    expect(metrics[0]!.textContent).toContain('交锋')
    // 右席（反方）提缺 2 条、已响应 1 条；交锋读数点击 → 定位首个未响应缺陷消息（m1）
    const crosses = sb.querySelectorAll('.scene-sb-cross')
    expect(metrics[0]!.querySelector('.scene-sb-cross')?.textContent).toContain('0')
    expect(crosses[1]!.textContent).toContain('2')
    fireEvent.click(crosses[1]!)
    expect(focus).toHaveBeenCalledWith('m1')
  })

  it('A2 交锋看板：未响应优先 + 催回应回填；A5 参与条：叫停 / 加一轮引用未决点', () => {
    seed([
      agentMsg('m1', 'judge', RULING1, { turnIndex: 0 }),
      agentMsg('m2', 'negative', FINDINGS_L, { turnIndex: 0 }),
      agentMsg('m3', 'affirmative', '「缺陷 2」回应：口径已统一。', { turnIndex: 0 }),
    ])
    const insert = vi.fn()
    const focus = vi.fn()
    const { container } = render(wrap(<ArenaStage><div>流</div></ArenaStage>, makeCtx({ insert, focus })))
    const board = container.querySelector('[data-insight="cross-fire"]')!
    expect(board).not.toBeNull()
    const items = board.querySelectorAll('.scene-cf-item')
    expect(items).toHaveLength(2)
    expect(items[0]!.getAttribute('data-responded')).toBe('false')
    expect(items[0]!.textContent).toContain('#1')
    expect(items[1]!.getAttribute('data-responded')).toBe('true')
    // 催回应（仅未响应条目）
    fireEvent.click(items[0]!.querySelector('.scene-cf-chase')!)
    expect(insert).toHaveBeenCalledWith(TEMPLATES.chaseFinding(1))
    expect(items[1]!.querySelector('.scene-cf-chase')).toBeNull()
    // 参与条：叫停模板 @ 中轴席；加一轮引用 ruling 未决点
    const actions = container.querySelector('[data-arena-actions]')!
    fireEvent.click(actions.querySelector('[data-aa="stop"]')!)
    expect(insert).toHaveBeenCalledWith(TEMPLATES.stopAndVerdict('明断'))
    fireEvent.click(actions.querySelector('[data-aa="extra"]')!)
    expect(insert).toHaveBeenCalledWith(TEMPLATES.extraRound('明断', '规模化后的边际成本是否成立'))
    fireEvent.click(actions.querySelector('[data-aa="lean-left"]')!)
    expect(insert).toHaveBeenCalledWith(TEMPLATES.leanSide('明断', '立言'))
  })

  it('A4 回合轴判定色点 + 轮次读数；A6 结论条：定位与关闭记忆', () => {
    seed([
      agentMsg('m1', 'judge', RULING1, { turnIndex: 0 }),
      agentMsg('m2', 'judge', VERDICT, { turnIndex: 1 }),
    ])
    const focus = vi.fn()
    const { container } = render(wrap(<ArenaStage><div>流</div></ArenaStage>, makeCtx({ focus })))
    expect(container.querySelector('.scene-rt-mark.is-long')).not.toBeNull()
    expect(container.querySelector('.scene-sb-note')?.textContent).toBe('共 1 轮')
    const bar = container.querySelector('[data-conclusion]')!
    expect(bar.textContent).toContain('立言 胜')
    expect(bar.textContent).toContain('置信度 高')
    expect(bar.textContent).toContain('翻盘条件')
    fireEvent.click(container.querySelector('.scene-conclusion-main')!)
    expect(focus).toHaveBeenCalledWith('m2')
    fireEvent.click(container.querySelector('.scene-conclusion-close')!)
    expect(container.querySelector('[data-conclusion]')).toBeNull()
    expect(sessionStorage.getItem('ma:sc:concl:sa')).toBe('true')
  })

  it('G1/G2 报价图与让步刻度：点位定位 / 走廊 / 基准线 / 警示回填', () => {
    const L1 = ['::: offer 首轮出价', '报价：98 万', '目标：120 万', '底线：82 万', ':::'].join('\n')
    seed([
      agentMsg('m1', 'negotiator', L1, { turnIndex: 0 }),
      agentMsg('m2', 'negotiator', OFFER_L2, { turnIndex: 1 }),
      agentMsg('m3', 'negotiator', OFFER_L3, { turnIndex: 2 }),
      agentMsg('m4', 'counterpart', OFFER_R1, { turnIndex: 0 }),
      agentMsg('m5', 'counterpart', OFFER_R2, { turnIndex: 1 }),
    ])
    const focus = vi.fn()
    const insert = vi.fn()
    const { container } = render(wrap(<ArenaStage><div>流</div></ArenaStage>, negoCtx({ focus, insert })))
    const chart = container.querySelector('[data-offer-chart]')!
    expect(chart).not.toBeNull()
    const dots = chart.querySelectorAll('.scene-oc-point')
    expect(dots).toHaveLength(5)
    fireEvent.click(dots[0]!)
    expect(focus).toHaveBeenCalledWith('m1')
    expect(chart.querySelector('.scene-oc-corridor')).not.toBeNull()
    expect(chart.querySelectorAll('.scene-oc-base')).toHaveLength(2)
    // 让步刻度：左席 98→88（10 万）→70（18 万）→ 第三步警示
    const warn = container.querySelectorAll('.scene-conc-item[data-warn="true"]')
    expect(warn).toHaveLength(1)
    fireEvent.click(warn[0]!)
    expect(insert).toHaveBeenCalledWith(TEMPLATES.concessionExplain('18 万', '10 万'))
  })

  it('G1/G2 交互：图例图层显隐 / 悬停浮层 / 图-表切换（会话记忆）', () => {
    const L1 = ['::: offer 首轮出价（锚定）', '报价：98 万', '目标：120 万', '底线：82 万', ':::'].join('\n')
    seed([
      agentMsg('m1', 'negotiator', L1, { turnIndex: 0 }),
      agentMsg('m2', 'negotiator', OFFER_L2, { turnIndex: 1 }),
      agentMsg('m3', 'negotiator', OFFER_L3, { turnIndex: 2 }),
      agentMsg('m4', 'counterpart', OFFER_R1, { turnIndex: 0 }),
      agentMsg('m5', 'counterpart', OFFER_R2, { turnIndex: 1 }),
    ])
    const focus = vi.fn()
    const { container } = render(wrap(<ArenaStage><div>流</div></ArenaStage>, negoCtx({ focus })))
    const chart = container.querySelector('[data-offer-chart]')!
    expect(chart).not.toBeNull()

    // 图例显隐：隐藏我方 → 左折线与左点离场（右席保留）；再点恢复
    fireEvent.click(chart.querySelector('.scene-oc-lg.is-left')!)
    expect(chart.querySelector('.scene-oc-line.is-left')).toBeNull()
    expect(chart.querySelectorAll('.scene-oc-point.is-left')).toHaveLength(0)
    expect(chart.querySelectorAll('.scene-oc-point.is-right')).toHaveLength(2)
    fireEvent.click(chart.querySelector('.scene-oc-lg.is-left')!)
    expect(chart.querySelectorAll('.scene-oc-point.is-left')).toHaveLength(3)

    // 基准线 / 收敛走廊：各自可关闭
    fireEvent.click(chart.querySelector('.scene-oc-lg.is-base')!)
    expect(chart.querySelectorAll('.scene-oc-base')).toHaveLength(0)
    fireEvent.click(chart.querySelector('.scene-oc-lg.is-corridor')!)
    expect(chart.querySelector('.scene-oc-corridor')).toBeNull()

    // 悬停浮层：序号 / 席名 / 金额
    const dot = chart.querySelectorAll('.scene-oc-point')[0]!
    fireEvent.mouseOver(dot)
    fireEvent.mouseEnter(dot)
    const tip = chart.querySelector('.scene-oc-tip')
    expect(tip).not.toBeNull()
    expect(tip!.textContent).toContain('第 1 次 · 谭成')
    expect(tip!.textContent).toContain('98 万')
    fireEvent.mouseOut(dot)
    fireEvent.mouseLeave(dot)
    expect(chart.querySelector('.scene-oc-tip')).toBeNull()

    // 图-表切换：表视图仅列表（图表与让步刻度离场）；本会话记忆落 sessionStorage
    fireEvent.click(container.querySelectorAll('.scene-ov-btn')[1]!)
    expect(container.querySelector('[data-offer-chart]')).toBeNull()
    expect(container.querySelectorAll('.scene-conc-item')).toHaveLength(0)
    expect(container.querySelectorAll('.scene-offer-item')).toHaveLength(5)
    expect(sessionStorage.getItem('ma:sc:tab:sa:offerchart')).toContain('table')
    fireEvent.click(container.querySelectorAll('.scene-ov-btn')[0]!)
    expect(container.querySelector('[data-offer-chart]')).not.toBeNull()

    // 段级收起 / 展开：收起 → body 整体离场（头部计数与切换控件让位）；本会话记忆
    fireEvent.click(container.querySelector('[data-offer-toggle]')!)
    expect(container.querySelector('[data-offer-chart]')).toBeNull()
    expect(container.querySelector('[data-offer-view]')).toBeNull()
    expect(container.querySelector('.scene-offer-item')).toBeNull()
    expect(sessionStorage.getItem('ma:sc:tab:sa:offer-collapsed')).toContain('1')
    fireEvent.click(container.querySelector('[data-offer-toggle]')!)
    expect(container.querySelector('[data-offer-chart]')).not.toBeNull()
    expect(container.querySelector('.scene-offer-item')).not.toBeNull()
  })

  it('无 findings / 无报价时新段不渲染（零破坏）', () => {
    seed([agentMsg('m1', 'affirmative', '正方立论：远程办公利大于弊。', { turnIndex: 0 })])
    const { container } = render(wrap(<ArenaStage><div>流</div></ArenaStage>))
    expect(container.querySelector('[data-insight="cross-fire"]')).toBeNull()
    expect(container.querySelector('[data-offer-chart]')).toBeNull()
    expect(container.querySelector('[data-conclusion]')).toBeNull()
  })
})

// ---------- versus 集成 ----------

describe('versus 集成：N1 四路观点 / G4 走子板与发起', () => {
  const VIEW_TA = ['::: claim 量价背离未修复', '视角：技术面', '倾向：空方', '置信度：中', '- 依据 | 成交额收缩 32%', ':::'].join('\n')
  const GAME = [
    '```game title="茅台多空对峙推演"',
    '{"model":"matrix","title":"茅台多空对峙推演","src":"charts/game-duikang-202609181030.json","data":{"kind":"game","model":"matrix","seed":20260918}}',
    '```',
  ].join('\n')

  function investCtx(over: Partial<SceneCtx> = {}): SceneCtx {
    return makeCtx({ participants: [QINYAN, LEIDONG, ZHUHENG], ...over })
  }

  it('四路观点卡：注册表序 + 分歧 chip + 追问回填 + 定位', () => {
    seed([agentMsg('m1', 'analyst-fa', VIEW_FA), agentMsg('m2', 'analyst-ta', VIEW_TA)])
    const insert = vi.fn()
    const focus = vi.fn()
    const { container } = render(wrap(<VersusPanel />, investCtx({ insert, focus })))
    const cards = container.querySelectorAll('.scene-view-card')
    expect(cards).toHaveLength(2)
    expect(cards[0]!.getAttribute('data-perspective')).toBe('基本面')
    expect(cards[1]!.getAttribute('data-perspective')).toBe('技术面')
    expect(cards[1]!.className).toContain('is-short')
    const split = container.querySelector('.scene-views-split')!
    expect(split.textContent).toContain('存在多空分歧')
    fireEvent.click(cards[0]!.querySelector('.scene-view-main')!)
    expect(insert).toHaveBeenCalledWith(TEMPLATES.viewAsk('基本面', '估值处于历史低位'))
    fireEvent.click(cards[0]!.querySelector('.scene-view-locate')!)
    expect(focus).toHaveBeenCalledWith('m1')
    fireEvent.click(split)
    expect(insert).toHaveBeenCalledWith(TEMPLATES.splitAdjudicate())
  })

  it('走子板：条目 / 模型徽标 / 快照名 / 种子复制 / 推演声明', async () => {
    const user = userEvent.setup()
    seed([agentMsg('m1', 'analyst-fa', GAME, { turnIndex: 1 })])
    const { container } = render(wrap(<VersusPanel />, investCtx()))
    const board = container.querySelector('[data-move-board]')!
    expect(board).not.toBeNull()
    const move = board.querySelector('.scene-move')!
    expect(move.querySelector('.scene-move-round')?.textContent).toBe('R2')
    expect(move.querySelector('.scene-move-model')?.textContent).toBe('静态矩阵博弈')
    expect(move.querySelector('.scene-move-title')?.textContent).toBe('茅台多空对峙推演')
    expect(move.querySelector('.scene-move-src')?.textContent).toBe('game-duikang-202609181030.json')
    expect(board.querySelector('.scene-moves-note')?.textContent).toContain('模型推演，非预测')
    await user.click(board.querySelector('.scene-move-seed')!)
    expect(await navigator.clipboard.readText()).toBe('20260918')
  })

  it('发起多空对弈：有空态数据（观点）时按钮回填 DUEL_PROMPT', () => {
    seed([agentMsg('m1', 'analyst-fa', VIEW_FA)])
    const insert = vi.fn()
    const { container } = render(wrap(<VersusPanel />, investCtx({ insert })))
    const btn = container.querySelector('.scene-vs-initiate')!
    expect(btn).not.toBeNull()
    fireEvent.click(btn)
    expect(insert).toHaveBeenCalledWith(DUEL_PROMPT)
  })

  it('零数据：保持引导空态（无读数不变化）', () => {
    const { container } = render(wrap(<VersusPanel />, investCtx()))
    expect(screen.getByText('多空信号与局势将在这里显示')).toBeInTheDocument()
    expect(container.querySelector('[data-move-board]')).toBeNull()
  })
})

// ---------- pool 红队看板 ----------

describe('pool 红队看板（A2 复用 · 只读）', () => {
  it('ideator ↔ challenger 对决姿态：findings 沉淀 + 无催回应', () => {
    seed([agentMsg('m1', 'challenger', FINDINGS_L)])
    const { container } = render(wrap(<PoolPanel />, makeCtx({ participants: [IDEO, CHALL] })))
    const section = container.querySelector('[data-pool-cross-fire]')!
    expect(section).not.toBeNull()
    expect(section.querySelector('.scene-cf-item')).not.toBeNull()
    expect(section.querySelector('.scene-cf-chase')).toBeNull()
    expect(section.textContent).toContain('挑刺')
  })
})

// ---------- panelReady 扩展 ----------

describe('panelReady · versus 扩展口径', () => {
  const data = (messages: ChatMessage[]): Parameters<typeof panelReady>[1] => ({
    containers: containersOf(messages),
    verdicts: verdictsOf(messages),
    messages,
  })

  it('带「视角」字段的 claim 与 ```game 围栏均视为就绪；纯文本仍否', () => {
    expect(panelReady('versus', data([agentMsg('m1', 'a', '纯文本')]))).toBe(false)
    expect(panelReady('versus', data([agentMsg('m1', 'analyst-fa', VIEW_FA)]))).toBe(true)
    expect(panelReady('versus', data([agentMsg('m1', 'quant', '```game title="x"\n{"model":"matrix"}\n```')]))).toBe(true)
  })

  it('gameMovesOf：围栏解析（src basename / seed / model / turnIndex）', () => {
    const moves = gameMovesOf([
      agentMsg('m1', 'quant', ['```game title="推演甲"', '{"model":"simulate","src":"charts/game-a.json","data":{"seed":42}}', '```'].join('\n'), { turnIndex: 2 }),
      agentMsg('m2', 'quant', '普通消息'),
    ])
    expect(moves).toHaveLength(1)
    expect(moves[0]).toMatchObject({ messageId: 'm1', model: 'simulate', src: 'charts/game-a.json', seed: 42, turnIndex: 2 })
  })
})

/**
 * M43（§72）：多方 PK 范式组件测试。
 * - 四卡路由（::: findings / claim / offer / debate）：结构断言 + 交互回填；
 * - 缺陷-修补配对卡：「已响应」由后续消息提及推导（无上下文 / 尾条不误标）；
 * - 主张卡：折叠 → 点论据 → composerInsert 追问模板；报价卡：价格类键高亮；
 * - 评审判定卡（PK-3）：pass / fail 两态渲染 + target 格式化 + 徽章同源；
 * - 对决组（PK-1/4/5）：arena 席位分侧二栏、阶段徽章、计分板、裁决按钮回填、
 *   窄屏回退单流、非最新波不提示裁决、无场景 / 席位不匹配降级普通并行组、运行中禁用；
 * - arena 中轴合流（§72.5）：裁决流 chips 定位 + 论断树 / 报价流面板（增量色标）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type * as React from 'react'
import type { AgentDefinition, ChatMessage, ReviewRecord } from '@multi-agent/shared'
import { Markdown } from '../src/components/chat/Markdown'
import { MessageContext } from '../src/components/chat/md-ext/message-context'
import { ClaimCard } from '../src/components/chat/md-ext/ClaimCard'
import { DebateCard } from '../src/components/chat/md-ext/DebateCard'
import { FindingsCard } from '../src/components/chat/md-ext/FindingsCard'
import { formatReviewTarget, ReviewVerdictBadge, ReviewVerdictCard } from '../src/components/chat/ReviewVerdictCard'
import { WaveGroup } from '../src/components/chat/WaveGroup'
import { ArenaStage } from '../src/components/scene/ArenaStage'
import { SceneContext, type SceneCtx } from '../src/components/scene/context'
import { useAgentStore } from '../src/stores/agent-store'
import { useRunStore } from '../src/stores/run-store'
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
const PM = makeAgent({ id: 'pm', name: '费利', group: 'development' })
const ARCHITECT = makeAgent({ id: 'architect', name: '艾达', group: 'development' })
const ALL_AGENTS = [LIYAN, LIFENG, MINGDUAN, PM, ARCHITECT]

function agentMsg(id: string, agentId: string, content: string, over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    sessionId: 'sa',
    runId: 'r1',
    role: 'agent',
    agentId,
    content,
    mentions: [],
    status: 'complete',
    createdAt: T0,
    ...over,
  }
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

/** arena 场景上下文（辩论场席位：立言 / 砺锋 / 明断） */
function makeCtx(over: Partial<SceneCtx> = {}): SceneCtx {
  return {
    sessionId: 'sa',
    stage: {
      layout: 'arena',
      seats: { left: ['affirmative'], right: ['negative'], center: ['judge'] },
      parts: [],
      fallback: false,
    },
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

function wrapMd(sid: string, messageId: string, ui: React.ReactElement): React.JSX.Element {
  return <MessageContext.Provider value={{ messageId, sessionId: sid }}>{ui}</MessageContext.Provider>
}

beforeEach(() => {
  useAgentStore.setState({ agents: [...ALL_AGENTS], groups: [], skills: [], loaded: true, loading: false, statuses: {} })
  useSessionStore.setState({ currentId: 'sa', byId: new Map(), order: [] })
  useRunStore.setState({ active: false, queue: [] })
  useUiStore.setState({ composerInsert: undefined })
})

// ---------- 缺陷-修补配对卡（PK-2） ----------

const FINDINGS = [
  '反方挑刺如下。',
  '::: findings 反方挑刺：三处薄弱环节',
  '- 缺陷 1 | 样本区间偏窄 | 补充跨周期样本',
  '- 缺陷 2 | 口径不一致',
  '- 缺陷 3 | 成本漏项 | 补测算口径',
  ':::',
].join('\n')

describe('缺陷-修补配对卡（::: findings）', () => {
  it('Markdown 路由：标题 / 已响应计数由后续消息提及推导 / 行级状态与徽章', () => {
    seed([
      agentMsg('m1', 'negative', FINDINGS),
      agentMsg('m2', 'evidence', '按编号回补：「缺陷 1」跨周期样本已补充、「缺陷 3」给了测算口径。'),
    ])
    const { container } = render(wrapMd('m43-findings', 'm1', <Markdown content={FINDINGS} />))
    const card = container.querySelector('.md-findings')!
    expect(card.querySelector('.md-findings-title')?.textContent).toBe('反方挑刺：三处薄弱环节')
    expect(card.querySelector('.md-findings-count')?.textContent).toBe('2/3 已响应')
    const rows = card.querySelectorAll('.md-findings-row')
    expect(rows).toHaveLength(3)
    expect(rows[0]!.getAttribute('data-responded')).toBe('true')
    expect(rows[0]!.className).toContain('is-responded')
    expect(rows[1]!.getAttribute('data-responded')).toBe('false')
    expect(rows[2]!.getAttribute('data-responded')).toBe('true')
    expect(rows[0]!.querySelector('.md-findings-badge')?.textContent).toContain('已响应')
    expect(rows[1]!.querySelector('.md-findings-badge')).toBeNull()
    expect(rows[0]!.querySelector('.md-findings-fix')?.textContent).toBe('修补：补充跨周期样本')
    expect(rows[1]!.querySelector('.md-findings-nofix')?.textContent).toBe('未附修补方向')
  })

  it('尾条 / 无消息上下文 → 不标已响应（仅统计自身之后的提及）', () => {
    seed([agentMsg('m1', 'negative', FINDINGS), agentMsg('m2', 'evidence', '「缺陷 1」已补。')])
    const last = render(wrapMd('m43-findings-last', 'm2', <Markdown content={FINDINGS} />))
    expect(last.container.querySelector('.md-findings-count')?.textContent).toBe('0/3 已响应')
    last.unmount()

    const bare = render(<Markdown content={FINDINGS} />)
    expect(bare.container.querySelector('.md-findings-count')?.textContent).toBe('0/3 已响应')
  })

  it('无条目兜底：raw 静态渲染', () => {
    const { container } = render(<FindingsCard items={'oops'} raw={'备份文本'} />)
    expect(container.querySelector('.md-findings-static')?.textContent).toBe('备份文本')
  })

  it('点缺陷编号 → 回应草稿回填「回应缺陷 N：」（发送后由配对机制点亮「已响应」）', () => {
    const { container } = render(wrapMd('m43-findings-fill', 'm1', <Markdown content={FINDINGS} />))
    const ids = container.querySelectorAll('.md-findings-id')
    fireEvent.click(ids[1]!)
    expect(useUiStore.getState().composerInsert?.text).toBe('回应缺陷 2：')
  })
})

// ---------- 主张卡 / 报价卡 / 对决声明卡 ----------

const CLAIM = [
  '::: claim 正方核心主张：净收益为正',
  '细节：先把流程对冲讲清楚',
  '- 论据 1 | 证据 1',
  '- 论据 2',
  ':::',
].join('\n')

describe('主张卡（::: claim）', () => {
  it('Markdown 路由：主张 / 细节 / 论据分层折叠；点论据 → 追问模板回填草稿', () => {
    const { container } = render(wrapMd('m43-claim', 'm1', <Markdown content={CLAIM} />))
    const card = container.querySelector('.md-claim[data-claim-card]')!
    expect(card.querySelector('.scene-claim-title')?.textContent).toBe('正方核心主张：净收益为正')
    expect(card.querySelector('.scene-claim-detail')?.textContent).toBe('先把流程对冲讲清楚')
    expect(card.querySelector('.scene-claim-count')?.textContent).toBe('2 论据')
    // 初始折叠：论据不可见；点击主张头展开
    expect(card.querySelector('.scene-claim-reason')).toBeNull()
    fireEvent.click(card.querySelector('.scene-claim-head')!)
    const reasons = card.querySelectorAll('.scene-claim-reason')
    expect(reasons).toHaveLength(2)
    expect(reasons[0]!.querySelector('.scene-claim-evidence')?.textContent).toBe('证据：证据 1')
    expect(reasons[1]!.querySelector('.scene-claim-evidence')).toBeNull()
    fireEvent.click(reasons[0]!)
    expect(useUiStore.getState().composerInsert?.text).toBe('请补充论据「论据 1」的证据与出处。')
  })

  it('无主张兜底：raw 静态渲染', () => {
    const { container } = render(<ClaimCard reasons={'oops'} raw={'备份'} />)
    expect(container.querySelector('.md-claim-static')?.textContent).toBe('备份')
  })
})

const OFFER = ['::: offer 首轮出价（锚定）', '报价：98 万', '底线：82 万', '- 依据 | 行情中位', ':::'].join('\n')

describe('报价卡（::: offer）', () => {
  it('Markdown 路由：字段 + 条目行；价格类键高亮、非价格键与条目不高亮', () => {
    const { container } = render(wrapMd('m43-offer', 'm1', <Markdown content={OFFER} />))
    const card = container.querySelector('.md-offer')!
    expect(card.querySelector('.md-offer-kind')?.textContent).toBe('报价')
    expect(card.querySelector('.md-offer-title')?.textContent).toBe('首轮出价（锚定）')
    const rows = card.querySelectorAll('.md-offer-row')
    expect(rows).toHaveLength(3)
    expect(Array.from(rows).map((r) => r.querySelector('.md-offer-label')?.textContent)).toEqual(['报价', '底线', '依据'])
    expect(Array.from(rows).map((r) => r.querySelector('.md-offer-value')?.textContent)).toEqual(['98 万', '82 万', '行情中位'])
    const priced = card.querySelectorAll('.md-offer-row.is-price')
    expect(priced).toHaveLength(1)
    expect(priced[0]!.textContent).toContain('98 万')
  })

  it('点值复制：写入剪贴板并短暂显示勾选（与 KPI 同模式）', async () => {
    const user = userEvent.setup()
    const { container } = render(wrapMd('m43-offer-copy', 'm1', <Markdown content={OFFER} />))
    const values = container.querySelectorAll('.md-offer-value')
    await user.click(values[0]!)
    await waitFor(() => expect(values[0]!.querySelector('.lucide-check')).not.toBeNull())
    expect(await navigator.clipboard.readText()).toBe('98 万')
  })
})

const DEBATE = ['::: debate 该不该上盲盒体验', '- 正方 | 净收益为正，风险可对冲', '- 反方 | 风险不可控，样本偏窄', ':::'].join('\n')

describe('对决声明卡（::: debate）', () => {
  it('Markdown 路由：题面 + 双方立场行（纯声明卡）', () => {
    const { container } = render(wrapMd('m43-debate', 'm1', <Markdown content={DEBATE} />))
    const card = container.querySelector('.md-debate')!
    expect(card.querySelector('.md-debate-kind')?.textContent).toBe('对决')
    expect(card.querySelector('.md-debate-title')?.textContent).toBe('该不该上盲盒体验')
    const sides = card.querySelectorAll('.md-debate-side')
    expect(sides).toHaveLength(2)
    expect(sides[0]!.querySelector('.md-debate-label')?.textContent).toBe('正方')
    expect(sides[0]!.querySelector('.md-debate-value')?.textContent).toBe('净收益为正，风险可对冲')
    expect(sides[1]!.querySelector('.md-debate-label')?.textContent).toBe('反方')
  })

  it('无条目兜底：raw 静态渲染（题面照常）', () => {
    const { container } = render(<DebateCard title={'题面'} items={'oops'} raw={'备份文本'} />)
    expect(container.querySelector('.md-debate-title')?.textContent).toBe('题面')
    expect(container.querySelector('.md-debate-static')?.textContent).toBe('备份文本')
  })
})

// ---------- 评审判定卡（PK-3） ----------

const REVIEW_PASS: ReviewRecord = {
  id: 'rv1',
  sessionId: 'sa',
  agentId: 'qa',
  target: 'plan:pl_1',
  verdict: 'pass',
  findings: ['用例覆盖完整', '性能抽样达标'],
  evidence: ['e1', 'e2'],
  createdAt: T0,
}

describe('评审判定卡（PK-3）', () => {
  it('formatReviewTarget：plan / step / artifact / message 前缀格式化；未知原样', () => {
    expect(formatReviewTarget('plan:pl_1')).toBe('计划 pl_1')
    expect(formatReviewTarget('step:st_2')).toBe('步骤 st_2')
    expect(formatReviewTarget('artifact:docs/a.md')).toBe('交付件 docs/a.md')
    expect(formatReviewTarget('message:m1')).toBe('消息 m1')
    expect(formatReviewTarget('misc:x')).toBe('misc:x')
  })

  it('pass 态：判定徽章 + 目标 + 发现清单 + 证据计数，无联动说明', () => {
    const { container } = render(<ReviewVerdictCard review={REVIEW_PASS} />)
    const card = container.querySelector('.review-verdict-card')!
    expect(card.getAttribute('data-verdict')).toBe('pass')
    expect(within(card as HTMLElement).getByText('评审通过')).toBeInTheDocument()
    expect(card.querySelector('.rvc-target')?.textContent).toContain('计划 pl_1')
    expect(card.querySelectorAll('.rvc-finding')).toHaveLength(2)
    expect(card.querySelector('.rvc-evidence')?.textContent).toContain('证据 2 条')
    expect(card.querySelector('.rvc-note')).toBeNull()
  })

  it('fail 态：未通过徽章 + 阻塞联动说明；空发现清单不渲染分组', () => {
    const { container } = render(<ReviewVerdictCard review={{ ...REVIEW_PASS, verdict: 'fail', findings: [] }} />)
    const card = container.querySelector('.review-verdict-card')!
    expect(card.getAttribute('data-verdict')).toBe('fail')
    expect(within(card as HTMLElement).getByText('评审未通过')).toBeInTheDocument()
    expect(card.querySelector('.rvc-findings')).toBeNull()
    expect(card.querySelector('.rvc-note')?.textContent).toContain('blocked')
  })

  it('头部徽章与任务面板判定标签同源（conditional 琥珀）', () => {
    render(<ReviewVerdictBadge verdict="conditional" />)
    expect(screen.getByText('有条件通过')).toBeInTheDocument()
  })
})

// ---------- 对决组（PK-1 / 4 / 5） ----------

describe('WaveGroup 对决组（PK-1/4/5）', () => {
  const m1 = agentMsg('m1', 'affirmative', '正方立论：净收益为正', { turnIndex: 0 })
  const m2 = agentMsg('m2', 'negative', '反方立论：风险不可控', { turnIndex: 0 })
  const m3 = agentMsg('m3', 'judge', '中轴裁决：双方各有理', { turnIndex: 0 })

  it('arena 席位分侧：二栏对决布局 + 阶段徽章 + 计分板 + 中轴整行 + 裁决回填', async () => {
    seed([m1, m2, m3])
    const insert = vi.fn()
    const { container } = render(wrap(<WaveGroup ids={['m1', 'm2', 'm3']} />, makeCtx({ insert })))

    expect(container.querySelector('[data-wave-group="duel"]')).not.toBeNull()
    expect(screen.getByText('对决')).toBeInTheDocument()
    expect(container.querySelector('[data-duel-phase]')?.textContent).toBe('立论')

    const columns = container.querySelector('[data-duel-columns]')!
    expect(columns).not.toBeNull()
    const sides = columns.querySelectorAll('[data-side]')
    expect(sides).toHaveLength(2)
    expect(sides[0]!.getAttribute('data-side')).toBe('left')
    expect(sides[0]!.textContent ?? '').toContain('立言')
    expect(sides[0]!.textContent ?? '').toContain('正方立论：净收益为正')
    expect(sides[0]!.textContent ?? '').toContain('1 条')
    expect(sides[1]!.getAttribute('data-side')).toBe('right')
    expect(sides[1]!.textContent ?? '').toContain('砺锋')
    expect(sides[1]!.textContent ?? '').toContain('反方立论：风险不可控')
    // 中轴（裁判）不在二栏内
    const centerMsg = within(columns as HTMLElement).getByText('中轴裁决：双方各有理')
    expect(centerMsg.closest('[data-side]')).toBeNull()
    expect(centerMsg.closest('[data-duel-columns]')).not.toBeNull()

    // PK-5 计分板：发言数 / 被响应缺陷数（本波无 findings → 0）
    const meter = container.querySelector('[data-duel-meter]')!
    expect(meter.textContent ?? '').toContain('vs')
    await waitFor(() => {
      expect(Array.from(meter.querySelectorAll('b')).map((b) => b.textContent)).toEqual(['1', '0', '1', '0'])
    })

    // PK-4 裁决卡：四模板按钮；点击 → 统一回填草稿
    const actions = container.querySelector('[data-duel-actions]')!
    const keys = Array.from(actions.querySelectorAll('[data-verdict-key]')).map((b) => b.getAttribute('data-verdict-key'))
    expect(keys).toEqual(['left', 'right', 'both', 'again'])
    fireEvent.click(actions.querySelector('[data-verdict-key="left"]')!)
    expect(insert).toHaveBeenCalledTimes(1)
    expect(insert.mock.calls[0]![0]).toContain('采纳「立言」')
  })

  it('窄屏回退：对决头保留、二栏撤除走单流、裁决卡仍在', () => {
    seed([m1, m2, m3])
    const { container } = render(wrap(<WaveGroup ids={['m1', 'm2', 'm3']} />, makeCtx({ narrow: true })))
    expect(container.querySelector('[data-wave-group="duel"]')).not.toBeNull()
    expect(container.querySelector('[data-duel-columns]')).toBeNull()
    expect(screen.getByText('正方立论：净收益为正')).toBeInTheDocument()
    expect(screen.getByText('反方立论：风险不可控')).toBeInTheDocument()
    expect(screen.getByText('中轴裁决：双方各有理')).toBeInTheDocument()
    expect(container.querySelector('[data-duel-actions]')).not.toBeNull()
  })

  it('非最新成员波：不挂裁决卡（历史对决波不重复提示）', () => {
    seed([m1, m2, m3, agentMsg('m4', 'affirmative', '补充发言', { turnIndex: 1 })])
    const { container } = render(wrap(<WaveGroup ids={['m1', 'm2', 'm3']} />))
    expect(container.querySelector('[data-wave-group="duel"]')).not.toBeNull()
    expect(container.querySelector('[data-duel-actions]')).toBeNull()
  })

  it('无场景上下文 / 席位不匹配 → 降级普通并行组（不触发对决）', () => {
    seed([m1, m2])
    const bare = render(<WaveGroup ids={['m1', 'm2']} />)
    expect(bare.container.querySelector('[data-wave-group="parallel"]')).not.toBeNull()
    expect(bare.container.querySelector('[data-duel-columns]')).toBeNull()
    bare.unmount()

    seed([agentMsg('p1', 'pm', '甲方案'), agentMsg('p2', 'architect', '乙方案')])
    const mismatch = render(wrap(<WaveGroup ids={['p1', 'p2']} />))
    expect(mismatch.container.querySelector('[data-wave-group="parallel"]')).not.toBeNull()
    expect(screen.getByText('并行协作')).toBeInTheDocument()

    // 混合波（部分成员有站位 / 部分无站位）→ 降级普通并行组（m16-brainstorm 回归口径：全员同波不成对决）
    mismatch.unmount()
    seed([
      agentMsg('x1', 'ideator', '发散一波'),
      agentMsg('x2', 'challenger', '挑刺一波'),
      agentMsg('x3', 'facilitator', '主持推进'),
    ])
    const mixed = render(wrap(<WaveGroup ids={['x1', 'x2', 'x3']} />))
    expect(mixed.container.querySelector('[data-wave-group="parallel"]')).not.toBeNull()
    expect(mixed.container.querySelector('[data-duel-columns]')).toBeNull()
  })

  it('运行中（流式）禁用裁决按钮', () => {
    seed([m1, agentMsg('m2', 'negative', '反方立论…', { turnIndex: 0, status: 'streaming' }), m3])
    const { container } = render(wrap(<WaveGroup ids={['m1', 'm2', 'm3']} />))
    const actions = container.querySelector('[data-duel-actions]')!
    const btns = Array.from(actions.querySelectorAll('[data-verdict-key]')) as HTMLButtonElement[]
    expect(btns).toHaveLength(4)
    for (const b of btns) {
      expect(b.disabled).toBe(true)
      expect(b.title).toContain('运行中不可裁决')
    }
  })
})

// ---------- arena 中轴合流（§72.5） ----------

const VERDICT = ['::: verdict 正方 辩论裁决（3 轮制）', '- 置信度 | 高', ':::'].join('\n')
const CLAIM2 = ['::: claim 正方主张：净收益为正', '- 论据 1 | 证据 1', ':::'].join('\n')
const OFFER1 = ['::: offer 首轮出价', '报价：98 万', ':::'].join('\n')
const OFFER2 = ['::: offer 反出价', '报价：68 万', ':::'].join('\n')

describe('arena 中轴合流（裁决流 / 论断树 / 报价流）', () => {
  function seedArena(): void {
    seed([
      agentMsg('m1', 'judge', VERDICT, { turnIndex: 0 }),
      agentMsg('m2', 'affirmative', CLAIM2, { turnIndex: 0 }),
      agentMsg('m3', 'affirmative', OFFER1, { turnIndex: 0 }),
      agentMsg('m4', 'negative', OFFER2, { turnIndex: 0 }),
    ])
  }

  it('裁决流：verdict 容器 → 时间线 chips（状态色）+ 点击定位', () => {
    seedArena()
    const focus = vi.fn()
    const { container } = render(wrap(<ArenaStage><div>消息流</div></ArenaStage>, makeCtx({ focus })))
    const flow = container.querySelector('[data-verdict-flow]')!
    expect(flow).not.toBeNull()
    const chip = flow.querySelector('.scene-verdict-chip')!
    expect(chip.getAttribute('data-status')).toBe('long')
    expect(chip.textContent ?? '').toContain('辩论裁决（3 轮制）')
    fireEvent.click(chip)
    expect(focus).toHaveBeenCalledWith('m1')
  })

  it('博弈面板：论断树聚合 + 报价流让步差值（is-down）+ 交互回填 / 定位', () => {
    seedArena()
    const focus = vi.fn()
    const insert = vi.fn()
    const { container } = render(wrap(<ArenaStage><div>消息流</div></ArenaStage>, makeCtx({ focus, insert })))
    const insights = container.querySelector('[data-insights]')!
    expect(insights).not.toBeNull()

    // 论断树：claim 容器聚合；点论据 → 追问模板回填
    expect(insights.querySelector('[data-insight="claims"] .scene-claim-title')?.textContent).toBe('正方主张：净收益为正')
    fireEvent.click(insights.querySelector('[data-insight="claims"] .scene-claim-head')!)
    fireEvent.click(insights.querySelector('[data-insight="claims"] .scene-claim-reason')!)
    expect(insert).toHaveBeenCalledWith('请补充论据「论据 1」的证据与出处。')

    // 报价流：98 万 → 68 万（↓30 万）；点击定位报价消息
    const items = insights.querySelectorAll('.scene-offer-item')
    expect(items).toHaveLength(2)
    expect(items[0]!.textContent ?? '').toContain('98 万')
    expect(items[1]!.textContent ?? '').toContain('68 万')
    const delta = items[1]!.querySelector('.scene-offer-delta')!
    expect(delta.classList.contains('is-down')).toBe(true)
    expect(delta.textContent ?? '').toContain('↓30 万')
    fireEvent.click(items[0]!)
    expect(focus).toHaveBeenCalledWith('m3')
  })
})

/**
 * M41（§103）：服务型渲染包测试。
 * - 纯函数：parsePipelineItems（阶段归一 / 缺省列）· parseFigureRows（关键行启发）·
 *   parseRiskArg（高/中/低 / 未命中中性）· parseProgressItems（状态归一）· parseQaPairs ·
 *   calcExpressionOf（FI-2 徽章派生）；
 * - 渲染：pipeline 四列 + 其他列 + 点卡回填 · figures 关键行加粗 · risk 色带三态 ·
 *   progress 总进度条与状态 · qa 折叠对 · fail-safe（未闭合展开 / raw 兜底）；
 * - FI-2：MessageItem 头部「已核算」徽章（title 携表达式）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import type * as React from 'react'
import type { AgentDefinition, ChatMessage } from '@multi-agent/shared'
import { Markdown } from '../src/components/chat/Markdown'
import { MessageItem } from '../src/components/chat/MessageItem'
import { calcExpressionOf } from '../src/lib/calc-badge'
import {
  parseFigureRows,
  parsePipelineItems,
  parseProgressItems,
  parseQaPairs,
  parseRiskArg,
} from '../src/components/chat/md-ext/remark-ext'
import { useAgentStore } from '../src/stores/agent-store'
import { usePlanStore } from '../src/stores/plan-store'
import { useRunStore } from '../src/stores/run-store'
import { useSessionStore } from '../src/stores/session-store'
import { useUiStore } from '../src/stores/ui-store'

const T0 = '2026-09-19T10:00:00.000Z'

function makeAgent(over: Partial<AgentDefinition> & { id: string; name: string }): AgentDefinition {
  return {
    role: '角色',
    title: '',
    description: '',
    capabilities: [],
    group: 'sales',
    avatar: { gradient: ['#3b82f6', '#f59e0b'], icon: 'user' },
    handoff: [],
    ...over,
  }
}

const SALES = makeAgent({ id: 'sales', name: '陆征', role: '销售负责人' })
const FINANCE = makeAgent({ id: 'finance', name: '周正', role: '财务管家', group: 'finance' })

function agentMsg(id: string, agentId: string, content: string, over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    sessionId: 'sa',
    runId: 'r1',
    turnIndex: 0,
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
  useSessionStore.setState({ currentId: 'sa', byId, order })
}

beforeEach(() => {
  useAgentStore.setState({ agents: [SALES, FINANCE], groups: [], skills: [], loaded: true, loading: false, statuses: {} })
  useSessionStore.setState({ currentId: 'sa', byId: new Map(), order: [] })
  useRunStore.setState({ active: false, queue: [] })
  usePlanStore.setState({ plans: [], reviews: [] })
  useUiStore.setState({ composerInsert: undefined, quietMode: true, mainTab: 'chat', editingMessageId: undefined })
})

// ---------- 纯函数 ----------

describe('M41 纯函数：容器行解析', () => {
  it('parsePipelineItems：四列阶段归一 + 未知阶段归 other + 缺省列容错', () => {
    const rows = parsePipelineItems([
      '- 云启科技 | 意向 | ¥12.8万 | 周五前发对比方案',
      '- 未来实验室 | 试点 | ¥3.2万',
      '- 极简客户',
      '-  | 线索', // 空名忽略
      '',
    ])
    expect(rows).toHaveLength(3)
    expect(rows[0]).toEqual({ name: '云启科技', stage: '意向', amount: '¥12.8万', next: '周五前发对比方案' })
    expect(rows[1]!.stage).toBe('other')
    expect(rows[1]!.next).toBe('')
    expect(rows[2]).toEqual({ name: '极简客户', stage: 'other', amount: '', next: '' })
  })

  it('parseFigureRows：关键行启发（合计 / 毛利 / 税后 / EBITDA）', () => {
    const rows = parseFigureRows([
      '- 营业收入 | ¥52.0万 | 含未开票 ¥4.2万',
      '- 费用合计 | ¥18.4万',
      '- 净利额 | ¥3.4万',
      '- EBITDA | ¥8.1万',
      '- 备注行',
    ])
    expect(rows.map((r) => r.key)).toEqual([false, true, true, true, false])
  })

  it('parseRiskArg：高|中|低 命中；未命中整串为标题且中性', () => {
    expect(parseRiskArg('高 三流一致性')).toEqual({ level: 'high', title: '三流一致性' })
    expect(parseRiskArg('低')).toEqual({ level: 'low', title: '' })
    expect(parseRiskArg('待评估风险')).toEqual({ level: 'none', title: '待评估风险' })
  })

  it('parseProgressItems：状态归一（未识别 / 缺省 → todo）', () => {
    const rows = parseProgressItems(['- BP | 完成', '- 数据室 | 进行中', '- 条款 | 待办', '- 交割', '- 打款 | 未知'])
    expect(rows.map((r) => r.state)).toEqual(['done', 'doing', 'todo', 'todo', 'todo'])
  })

  it('parseQaPairs：答案内 | 保留合并；空问忽略', () => {
    const rows = parseQaPairs(['- 估值？ | 对标 A | 对标 B', '- 用途？', '-  | 忽略'])
    expect(rows).toEqual([
      { q: '估值？', a: '对标 A | 对标 B' },
      { q: '用途？', a: '' },
    ])
  })

  it('calcExpressionOf：首个成功 calc 表达式；非 calc / 非 ok / 缺表达式 → undefined', () => {
    const ok = { id: 'c1', name: 'calc', args: { expression: '302000 / 520000 * 100' }, status: 'ok' as const, startedAt: T0 }
    expect(calcExpressionOf([ok])).toBe('302000 / 520000 * 100')
    expect(calcExpressionOf([{ ...ok, status: 'running' }])).toBeUndefined()
    expect(calcExpressionOf([{ ...ok, args: {} }])).toBeUndefined()
    expect(calcExpressionOf([{ ...ok, name: 'date_calc' }])).toBeUndefined()
    expect(calcExpressionOf(undefined)).toBeUndefined()
  })
})

// ---------- 卡片渲染 ----------

const PIPELINE = [
  '::: pipeline 客户管道（本周）',
  '- 云启科技 | 意向 | ¥12.8万 | 周五前发对比方案',
  '- 蓝湾传媒 | 报价 | ¥6.4万',
  '- 星禾教育 | 线索 | ¥0',
  '- 恒达物流 | 成交 | ¥9.6万',
  '- 未来实验室 | 试点 | ¥3.2万',
  ':::',
].join('\n')

describe('客户管道看板（::: pipeline）', () => {
  it('四列 + 其他列（未知阶段）+ 点卡回填跟进草稿', () => {
    const { container } = render(<Markdown content={PIPELINE} />)
    const card = container.querySelector('.md-pipeline[data-pipeline-card]')!
    expect(card.querySelector('[data-pipeline-col="线索"]')?.textContent).toContain('星禾教育')
    expect(card.querySelector('[data-pipeline-col="意向"]')?.textContent).toContain('云启科技')
    expect(card.querySelector('[data-pipeline-col="报价"]')?.textContent).toContain('蓝湾传媒')
    expect(card.querySelector('[data-pipeline-col="成交"]')?.textContent).toContain('恒达物流')
    expect(card.querySelector('[data-pipeline-col="other"]')?.textContent).toContain('未来实验室')
    fireEvent.click(card.querySelector('[data-pipeline-col="意向"] .md-pipeline-card')!)
    expect(useUiStore.getState().composerInsert?.text).toBe('跟进 云启科技：')
  })

  it('fail-safe：未闭合 pipeline 内容展开（无卡壳、内容保留）', () => {
    const broken = ['::: pipeline 未完', '- 甲 | 线索'].join('\n')
    const { container } = render(<Markdown content={broken} />)
    expect(container.querySelector('[data-pipeline-card]')).toBeNull()
    expect(container.textContent).toContain('甲')
  })
})

describe('测算表卡（::: figures）与风险色带（::: risk）', () => {
  it('figures：关键行加粗（is-key）与值列右对齐', () => {
    const content = [
      '::: figures 测算表（月度）',
      '- 营业收入 | ¥52.0万 | 含未开票',
      '- 费用合计 | ¥18.4万',
      ':::',
    ].join('\n')
    const { container } = render(<Markdown content={content} />)
    const rows = container.querySelectorAll('.md-figures-table tr')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.getAttribute('data-figure-key')).toBeNull()
    expect(rows[1]!.getAttribute('data-figure-key')).toBe('true')
    expect(rows[1]!.className).toContain('is-key')
    expect(container.querySelector('.md-figures-value')?.className).toContain('md-figures-value')
  })

  it('risk 三态：高 → 红带 + 高风险；未命中 → 中性且无等级标签；children 保留', () => {
    const high = render(<Markdown content={'::: risk 高 三流一致性\n- 逐笔核对\n:::'} />)
    expect(high.container.querySelector('[data-risk-band="high"]')).toBeTruthy()
    expect(high.container.textContent).toContain('高风险')
    expect(high.container.textContent).toContain('逐笔核对')
    high.unmount()

    const none = render(<Markdown content={'::: risk 待评估\n:::'} />)
    expect(none.container.querySelector('[data-risk-band="none"]')).toBeTruthy()
    expect(none.container.textContent).not.toContain('高风险')
    expect(none.container.textContent).toContain('待评估')
  })
})

describe('进度卡（::: progress）与问答卡（::: qa）', () => {
  it('progress：总进度条（data-progress-pct）+ 状态类名', () => {
    const content = ['::: progress 融资里程碑', '- BP | 完成', '- 数据室 | 进行中', '- 条款 | 待办', '- 交割 | 待办', ':::'].join('\n')
    const { container } = render(<Markdown content={content} />)
    const card = container.querySelector('[data-progress-card]')!
    expect(card.textContent).toContain('1/4 完成')
    expect(card.querySelector('[data-progress-pct="25"]')).toBeTruthy()
    expect(card.querySelectorAll('[data-progress-state="done"]')).toHaveLength(1)
    expect(card.querySelectorAll('[data-progress-state="doing"]')).toHaveLength(1)
    expect(card.querySelectorAll('[data-progress-state="todo"]')).toHaveLength(2)
  })

  it('qa：折叠对（原生 details）与答文展开', () => {
    const content = ['::: qa 投资人问答', '- 估值？ | 对标近 6 个月同类交易', '- 用途？', ':::'].join('\n')
    const { container } = render(<Markdown content={content} />)
    const card = container.querySelector('[data-qa-card]')!
    const rows = card.querySelectorAll('details[data-qa-row]')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.querySelector('summary')?.textContent).toBe('估值？')
    expect(rows[0]!.textContent).toContain('对标近 6 个月同类交易')
    expect(rows[1]!.textContent).toContain('（暂无答案）')
  })
})

// ---------- FI-2 口径校验徽章 ----------

describe('口径校验徽章（FI-2）', () => {
  it('成功 calc → 头部「已核算」徽章（title 携表达式）；无 calc → 不渲染', () => {
    seed([
      agentMsg('m1', 'finance', '口径先对齐。', {
        toolCalls: [
          { id: 'c1', name: 'calc', args: { expression: '302000 / 520000 * 100' }, status: 'ok', startedAt: T0 },
        ],
      }),
    ])
    const withCalc = render(<MessageItem messageId="m1" />)
    const badge = withCalc.container.querySelector('[data-calc-badge]')!
    expect(badge.textContent).toContain('已核算')
    expect(badge.getAttribute('title')).toBe('已核算：302000 / 520000 * 100')
    withCalc.unmount()

    seed([agentMsg('m2', 'finance', '普通发言。')])
    const plain = render(<MessageItem messageId="m2" />)
    expect(plain.container.querySelector('[data-calc-badge]')).toBeNull()
  })
})

/**
 * 批六（console 面板二批）：sales 客户管道 · marketing/ecommerce/legal 节奏段 · funding 融资进度与问答 ·
 * legal 主张与依据 —— 组件测试（镜像 m66-analysis-console 夹具）。
 * - 纯函数：parseClaimLines（主张 | 依据；空主张跳过 / 纯文本项）；
 * - sales：pipeline 容器 → 阶段列（未知归「其他」，与消息卡同口径）+ 金额合计（可解析才显示）+ 定位；
 * - funding：progress / qa 与消息卡**同组件渲染**（[data-console-progress] / [data-console-qa]）+ 定位；
 * - marketing / ecommerce / legal：timeline 容器 → 节奏段（标题按场景 / owner 徽标）+ 通用时间轴让位；
 * - legal：claim 容器 → 主张与依据（标题 + 条目 + 依据）；
 * - 边界：非目标场景不渲染新段；节奏容器缺席时回落通用时间轴。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type * as React from 'react'
import type { AgentDefinition, AgentGroup, ChatMessage } from '@multi-agent/shared'
import { MessageContext } from '../src/components/chat/md-ext/message-context'
import { parseClaimLines } from '../src/components/chat/md-ext/remark-ext'
import { SceneContext, type SceneCtx } from '../src/components/scene/context'
import { ConsolePanel } from '../src/components/scene/panels'
import { useAgentStore } from '../src/stores/agent-store'
import { useSessionStore } from '../src/stores/session-store'
import { useUiStore } from '../src/stores/ui-store'

const T0 = '2026-09-19T03:00:00.000Z'

const ANY = makeAgent('x', '某员')

function makeAgent(id: string, name: string): AgentDefinition {
  return {
    id,
    name,
    role: '成员',
    title: '',
    description: '',
    capabilities: [],
    group: 'sales',
    avatar: { gradient: ['#6366f1', '#818cf8'], icon: 'user' },
    handoff: [],
  }
}

function agentMsg(id: string, agentId: string, content: string): ChatMessage {
  return { id, sessionId: 'sa', runId: 'r1', role: 'agent', agentId, content, mentions: [], status: 'complete', createdAt: T0 }
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
    stage: { layout: 'dock', panel: 'console', parts: [], fallback: false },
  } as AgentGroup
}

function makeCtx(over: Partial<SceneCtx> = {}): SceneCtx {
  return {
    sessionId: 'sa',
    stage: { layout: 'dock', panel: 'console', parts: [], fallback: false },
    participants: [ANY],
    narrow: false,
    waitingIds: [],
    insert: () => {},
    focus: () => {},
    agentOf: (agentId) => (agentId === ANY.id ? ANY : undefined),
    ...over,
  }
}

function wrapConsole(groupId: string, over: Partial<SceneCtx> = {}): React.JSX.Element {
  return (
    <SceneContext.Provider value={makeCtx({ group: makeGroup(groupId), ...over })}>
      <ConsolePanel />
    </SceneContext.Provider>
  )
}

function wrapMd(ui: React.ReactElement): React.JSX.Element {
  return <MessageContext.Provider value={{ messageId: 'm1', sessionId: 'sa' }}>{ui}</MessageContext.Provider>
}

beforeEach(() => {
  useAgentStore.setState({ agents: [ANY], groups: [], skills: [], loaded: true, loading: false, statuses: {} })
  useSessionStore.setState({ currentId: 'sa', byId: new Map(), order: [] })
  useUiStore.setState({ composerInsert: undefined })
  sessionStorage.clear()
})

// ---------- 纯函数 ----------

describe('批六 · parseClaimLines（单一解析）', () => {
  it('主张 | 依据 拆分：空主张跳过 / 空依据只留文本 / 无竖线纯文本项', () => {
    expect(
      parseClaimLines(['- 未提前 30 日通知 | 劳动合同法第四十条', '- 仅主张', '-  | 孤儿依据', '- 解除理由不符 | 考核表（已归档）']),
    ).toEqual([
      { text: '未提前 30 日通知', evidence: '劳动合同法第四十条' },
      { text: '仅主张' },
      { text: '解除理由不符', evidence: '考核表（已归档）' },
    ])
  })
})

// ---------- ConsolePanel · sales 客户管道 ----------

const PIPELINE_MSG = [
  '::: pipeline 客户管道（本周）',
  '- 云启科技 | 意向 | ¥12.8万 | 周五前发对比方案',
  '- 蓝湾传媒 | 报价 | ¥6.4万',
  '- 星禾教育 | 线索 | ¥0',
  '- 恒达物流 | 成交 | ¥9.6万',
  '- 未来实验室 | 试点 | ¥3.2万',
  ':::',
].join('\n')

describe('批六 · ConsolePanel sales（客户管道）', () => {
  it('阶段列 + 未知归「其他」+ 金额合计 + 点卡定位', () => {
    seed([agentMsg('m1', 'any', PIPELINE_MSG.replace(/any/g, 'x'))])
    const focus = vi.fn()
    const { container } = render(wrapConsole('sales', { focus }))
    const sec = container.querySelector('[data-console-pipeline]')!
    expect(sec).not.toBeNull()
    expect(sec.querySelectorAll('.scene-pipe-col')).toHaveLength(5)
    expect(sec.querySelector('[data-pipe-stage="意向"]')!.textContent).toContain('云启科技')
    expect(sec.querySelector('[data-pipe-stage="other"]')!.textContent).toContain('未来实验室')
    // 金额合计：意向 12.8万 / 报价 6.4万 / 成交 9.6万 / 其他 3.2万 / 线索 ¥0
    expect(sec.querySelector('[data-pipe-stage="意向"] .scene-pipe-total')!.textContent).toBe('¥12.8万')
    expect(sec.querySelector('[data-pipe-stage="other"] .scene-pipe-total')!.textContent).toBe('¥3.2万')
    fireEvent.click(sec.querySelector('[data-pipe-stage="意向"] .scene-pipe-card')!)
    expect(focus).toHaveBeenCalledWith('m1')
  })

  it('非 sales 场景不渲染客户管道段（通用口径零变化）', () => {
    seed([agentMsg('m1', 'x', PIPELINE_MSG)])
    const { container } = render(wrapConsole('funding'))
    expect(container.querySelector('[data-console-pipeline]')).toBeNull()
  })
})

// ---------- ConsolePanel · funding 融资进度 + 问答 ----------

const PROGRESS_MSG = [
  '::: progress 融资里程碑（Pre-A）',
  '- BP 与一页纸 | 完成',
  '- 数据室材料 | 进行中',
  '- 条款清单 | 待办',
  '- 交割与打款 | 待办',
  ':::',
].join('\n')

const QA_MSG = [
  '::: qa 投资人常见问答',
  '- 为什么是这个估值？ | 对标近 6 个月同类交易',
  '- 资金用途？ | 60% 投研发，30% 投放验证，10% 储备',
  ':::',
].join('\n')

describe('批六 · ConsolePanel funding（融资进度 + 投资人问答）', () => {
  it('progress / qa 与消息卡同组件渲染 + 定位', () => {
    seed([agentMsg('m1', 'x', PROGRESS_MSG), agentMsg('m2', 'x', QA_MSG)])
    const focus = vi.fn()
    const { container } = render(wrapConsole('funding', { focus }))
    const prog = container.querySelector('[data-console-progress]')!
    expect(prog).not.toBeNull()
    expect(prog.textContent).toContain('融资里程碑（Pre-A）')
    expect(prog.textContent).toContain('1/4 完成')
    expect(prog.querySelector('[data-progress-card]')).not.toBeNull()
    const qa = container.querySelector('[data-console-qa]')!
    expect(qa).not.toBeNull()
    expect(qa.querySelector('[data-qa-card]')).not.toBeNull()
    expect(qa.textContent).toContain('为什么是这个估值？')
    fireEvent.click(qa.querySelector('.scene-kpi-focus')!)
    expect(focus).toHaveBeenCalledWith('m2')
  })
})

// ---------- ConsolePanel · 节奏段（marketing / ecommerce / legal） ----------

const RHYTHM_MSG = [
  '::: timeline 内容日历（两周排期）',
  '- 09-20 | 案例拆解长图文定稿与预热 | 林悦',
  '- 09-22 | 公众号首发 + 社群同步 | 高扬',
  ':::',
].join('\n')

describe('批六 · ConsolePanel 节奏段（timeline 容器）', () => {
  it('marketing：内容节奏（owner 徽标）+ 通用时间轴让位 + 定位', () => {
    seed([agentMsg('m1', 'x', RHYTHM_MSG)])
    const focus = vi.fn()
    const { container } = render(wrapConsole('marketing', { focus }))
    const sec = container.querySelector('[data-console-rhythm]')!
    expect(sec).not.toBeNull()
    expect(sec.textContent).toContain('内容节奏')
    expect(sec.textContent).toContain('09-20')
    expect(sec.querySelectorAll('.scene-rhythm-row')).toHaveLength(2)
    expect(sec.querySelector('.scene-rhythm-owner')!.textContent).toBe('林悦')
    // 节奏段在场 → 通用「活动时间轴」不重复渲染
    expect(screen.queryByText('活动时间轴')).toBeNull()
    fireEvent.click(sec.querySelector('.scene-rhythm-row')!)
    expect(focus).toHaveBeenCalledWith('m1')
  })

  it('ecommerce：经营指标 + 大促节奏（标题按场景）', () => {
    const kpi = ['::: kpi 店铺经营（近 7 日）', '- GMV | ¥48.6万 | +12% | ¥52万', ':::'].join('\n')
    const rhythm = ['::: timeline 大促节点（双十一）', '- 11-11 | 爆发期：主推 SKU | 爆发', ':::'].join('\n')
    seed([agentMsg('m1', 'x', kpi), agentMsg('m2', 'x', rhythm)])
    const { container } = render(wrapConsole('ecommerce'))
    expect(container.querySelector('[data-console-kpis]')!.textContent).toContain('经营指标')
    expect(container.querySelector('[data-console-rhythm]')!.textContent).toContain('大促节奏')
  })

  it('legal：案件时间线 + 主张与依据（标题 / 条目 / 依据 / 定位）', () => {
    const claim = [
      '::: claim 主张与依据',
      '细节：公司应支付违法解除赔偿金',
      '- 未提前 30 日书面通知 | 劳动合同法第四十条',
      '- 解除理由与考核不符 | 月度考核表（已归档）',
      ':::',
    ].join('\n')
    seed([agentMsg('m1', 'x', claim)])
    const focus = vi.fn()
    const { container } = render(wrapConsole('legal-personal', { focus }))
    expect(container.querySelector('[data-console-rhythm]')).toBeNull() // 无 timeline → 无节奏段
    const claims = container.querySelector('[data-console-claims]')!
    expect(claims).not.toBeNull()
    expect(claims.querySelector('.scene-claimcell-title')!.textContent).toBe('主张与依据')
    expect(claims.querySelectorAll('.scene-claimcell-item')).toHaveLength(2)
    expect(claims.querySelector('.scene-claimcell-evidence')!.textContent).toBe('劳动合同法第四十条')
    fireEvent.click(claims.querySelector('.scene-kpi-focus')!)
    expect(focus).toHaveBeenCalledWith('m1')
  })

  it('节奏容器缺席 → 回落通用活动时间轴（既有口径保持）', () => {
    seed([agentMsg('m1', 'x', '本周内容复盘完成，下周延续三连节奏。')])
    render(wrapConsole('marketing'))
    expect(screen.getByText('活动时间轴')).toBeInTheDocument()
    expect(screen.queryByText('内容节奏')).toBeNull()
  })
})

// ---------- 消息卡路径回归：claim 容器照常渲染（parseClaimLines 重构零回归） ----------

describe('批六 · claim 卡渲染回归', () => {
  it('数据属性与条目结构不变（重构 finalizeClaim 后）', async () => {
    const { Markdown } = await import('../src/components/chat/Markdown')
    const content = ['::: claim 正方核心主张：净收益为正', '细节：先把流程对冲讲清楚', '- 论据 1 | 证据 1', '- 论据 2', ':::'].join('\n')
    const { container } = render(wrapMd(<Markdown content={content} />))
    const card = container.querySelector('.md-claim[data-claim-card]')!
    expect(card).not.toBeNull()
    expect(card.querySelector('.scene-claim-title')!.textContent).toBe('正方核心主张：净收益为正')
    expect(card.textContent).toContain('先把流程对冲讲清楚')
    // 条目层由 ClaimTree 承接（折叠结构），形状断言归 m43-cards 既有覆盖；此处仅保证重构后卡片不退化
    expect(card.querySelector('.scene-claim-count')!.textContent).toContain('论据')
  })
})

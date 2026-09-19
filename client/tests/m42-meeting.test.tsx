/**
 * M42（§71）：圆桌会议范式前端测试。
 * - lib/meeting 纯函数：会议 / 纪要容器解析、议题状态合并（容器更新优先、本地勾选兜底）、
 *   进度推导（running 首未决项点亮）、议题头词与待办负责人拆分；
 * - 本地勾选 store：`ma:meeting:<sessionId>` 落 sessionStorage + 开关翻转；
 * - 会议卡（::: meeting）：三态渲染 / 待议行勾选 / 容器显式态静态 / 流式禁用 / 空条目兜底；
 * - 纪要卡（::: minutes）：三栏分组（未识别键归决议）/ 待办派活回填 `@负责人 ` / 流式禁点 / 兜底；
 * - 散会胶囊（RT-5）：尾条派生（纪要容器 + 非运行中）+ 指纹隔离（非纪要 / 流式不闪现）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import type * as React from 'react'
import type { AgentDefinition, ChatMessage } from '@multi-agent/shared'
import { AdjournPill, adjournOfTail } from '../src/components/chat/AdjournPill'
import { Markdown } from '../src/components/chat/Markdown'
import { MessageContext } from '../src/components/chat/md-ext/message-context'
import { MeetingCard } from '../src/components/chat/md-ext/MeetingCard'
import { MinutesCard } from '../src/components/chat/md-ext/MinutesCard'
import {
  effectiveState,
  meetingChecks,
  meetingItemsOfLines,
  meetingLabelHead,
  meetingProgress,
  mergeMeetingItems,
  parseMeetingItems,
  parseMinutesItems,
  splitMinutesOwner,
  toggleMeetingCheck,
} from '../src/lib/meeting'
import { useAgentStore } from '../src/stores/agent-store'
import { useRunStore } from '../src/stores/run-store'
import { useSessionStore } from '../src/stores/session-store'
import { useUiStore } from '../src/stores/ui-store'

const T0 = '2026-09-19T02:00:00.000Z'

// ---------- fixtures ----------

function makeAgent(id: string, name: string): AgentDefinition {
  return {
    id,
    name,
    role: '成员',
    title: '',
    description: '',
    capabilities: [],
    group: 'strategy',
    avatar: { gradient: ['#6366f1', '#818cf8'], icon: 'user' },
    handoff: [],
  }
}

const ZHOU_ZHENG = makeAgent('finance', '周正')

function agentMsg(id: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    sessionId: 'sa',
    runId: 'r1',
    role: 'agent',
    agentId: 'chief',
    content: '纪要如下',
    mentions: [],
    status: 'complete',
    createdAt: T0,
    ...overrides,
  }
}

/** 会话上下文（会议卡本地勾选键依赖 sessionId；每个用例独立 sid 防模块缓存串扰） */
function wrapMd(sid: string, ui: React.ReactElement): React.JSX.Element {
  return <MessageContext.Provider value={{ messageId: 'm1', sessionId: sid }}>{ui}</MessageContext.Provider>
}

const MEETING = [
  '先定议程，再逐项过。',
  '::: meeting 本周经营例会',
  '- 增长复盘：渠道与内容',
  '- [>] 财务盘点：回款与成本',
  '- [x] 客户与回款：重点跟进',
  ':::',
].join('\n')

const MINUTES = [
  '::: minutes 本周经营例会纪要',
  '- 决议 | 数字口径统一按财务版本',
  '- 备注 | 待下次例会复核',
  '- 待办 | @周正 按本周结论更新执行排期并同步工作区',
  '- 待办 | 补齐数据口径说明',
  '- 风险 | 关键指标若未回暖则收缩投入',
  ':::',
].join('\n')

beforeEach(() => {
  useAgentStore.setState({ agents: [], groups: [], skills: [], loaded: true, loading: false, statuses: {} })
  useSessionStore.setState({ currentId: 'sa', byId: new Map(), order: [] })
  useRunStore.setState({ active: false, queue: [] })
  useUiStore.setState({ composerInsert: undefined })
})

// ---------- lib/meeting 纯函数 ----------

describe('lib/meeting：容器解析（fail-safe）', () => {
  it('parseMeetingItems：合法 JSON 取三态；非法 / 形状不符 / 空标签 → 空数组', () => {
    const json = JSON.stringify([
      { label: '议题一', state: 'todo' },
      { label: '议题二', state: 'doing' },
      { label: '议题三', state: 'done' },
      { label: '议题四', state: '未知态' },
      { label: '', state: 'todo' },
      { state: 'todo' },
      'x',
    ])
    expect(parseMeetingItems(json)).toEqual([
      { label: '议题一', state: 'todo' },
      { label: '议题二', state: 'doing' },
      { label: '议题三', state: 'done' },
      { label: '议题四', state: 'todo' },
    ])
    expect(parseMeetingItems('{oops')).toEqual([])
    expect(parseMeetingItems('{"a":1}')).toEqual([])
    expect(parseMeetingItems(undefined)).toEqual([])
  })

  it('meetingItemsOfLines：`- [x] / - [>] / - 项` 三态；非列表行 / 空标签跳过', () => {
    const items = meetingItemsOfLines([
      '- [x] 已决项',
      '- [>] 进行项',
      '- [X] 大写也认',
      '- 待议项',
      '* 星号项',
      '普通段落',
      '- [ ]',
    ])
    expect(items).toEqual([
      { label: '已决项', state: 'done' },
      { label: '进行项', state: 'doing' },
      { label: '大写也认', state: 'done' },
      { label: '待议项', state: 'todo' },
      { label: '星号项', state: 'todo' },
    ])
  })

  it('parseMinutesItems：键缺失归空键；空值 / 非法 JSON → 空数组', () => {
    const json = JSON.stringify([
      { key: '决议', value: 'A' },
      { value: '无键行' },
      { key: '待办', value: '' },
      'x',
    ])
    expect(parseMinutesItems(json)).toEqual([
      { key: '决议', value: 'A' },
      { key: '', value: '无键行' },
    ])
    expect(parseMinutesItems('not-json')).toEqual([])
  })
})

describe('lib/meeting：议题合并与进度', () => {
  it('mergeMeetingItems：后声明显式态覆盖、todo 不覆盖、新标签按首见追加（不改入参）', () => {
    const first = [
      { label: 'A', state: 'todo' as const },
      { label: 'B', state: 'todo' as const },
      { label: 'C', state: 'todo' as const },
    ]
    const second = [
      { label: 'B', state: 'doing' as const },
      { label: 'D', state: 'done' as const },
    ]
    const third = [{ label: 'A', state: 'done' as const }]
    const fourth = [{ label: 'A', state: 'todo' as const }]
    expect(mergeMeetingItems([first, second, third, fourth])).toEqual([
      { label: 'A', state: 'done' },
      { label: 'B', state: 'doing' },
      { label: 'C', state: 'todo' },
      { label: 'D', state: 'done' },
    ])
    expect(first[0]!.state).toBe('todo')
  })

  it('effectiveState：容器显式态优先；todo 时本地勾选兜底', () => {
    const local = new Set(['议题一'])
    expect(effectiveState({ label: '议题一', state: 'todo' }, local)).toBe('done')
    expect(effectiveState({ label: '议题二', state: 'todo' }, local)).toBe('todo')
    expect(effectiveState({ label: '议题一', state: 'doing' }, local)).toBe('doing')
    expect(effectiveState({ label: '议题一', state: 'done' }, new Set())).toBe('done')
  })

  it('meetingProgress：doneCount / currentIndex；running 时首未决 todo 点亮为 doing', () => {
    const items = [
      { label: '一', state: 'done' as const },
      { label: '二', state: 'todo' as const },
      { label: '三', state: 'todo' as const },
    ]
    const idle = meetingProgress(items, new Set(), false)
    expect(idle.doneCount).toBe(1)
    expect(idle.currentIndex).toBe(1)
    expect(idle.view[1]!.state).toBe('todo')

    const running = meetingProgress(items, new Set(), true)
    expect(running.view[1]!.state).toBe('doing')
    expect(running.view[2]!.state).toBe('todo')

    // 容器已显式 doing：不再改写；本地兜底已决时跳过本地项去找下一个未决
    expect(meetingProgress([{ label: '二', state: 'doing' }], new Set(), true).view[0]!.state).toBe('doing')
    const skipped = meetingProgress(items, new Set(['二']), false)
    expect(skipped.doneCount).toBe(2)
    expect(skipped.currentIndex).toBe(2)
    expect(meetingProgress([{ label: '一', state: 'done' }], new Set(), true).currentIndex).toBe(-1)
  })

  it('meetingLabelHead / splitMinutesOwner', () => {
    expect(meetingLabelHead('经营简报：四方数据汇总')).toBe('经营简报')
    expect(meetingLabelHead('增长复盘')).toBe('增长复盘')
    expect(meetingLabelHead('：开头')).toBe('：开头')
    expect(splitMinutesOwner('@周正 更新排期')).toEqual({ owner: '周正', text: '更新排期' })
    expect(splitMinutesOwner('补齐说明')).toEqual({ text: '补齐说明' })
    expect(splitMinutesOwner('@ 空负责人')).toEqual({ text: '@ 空负责人' })
  })

  it('本地勾选 store：翻转 + sessionStorage 落盘（ma:meeting:<sid>）', () => {
    const sid = 'm42-store-1'
    expect(meetingChecks(sid)).toEqual([])
    toggleMeetingCheck(sid, '议题一')
    expect(meetingChecks(sid)).toEqual(['议题一'])
    expect(JSON.parse(sessionStorage.getItem(`ma:meeting:${sid}`)!)).toEqual(['议题一'])
    toggleMeetingCheck(sid, '议题一')
    expect(meetingChecks(sid)).toEqual([])
    expect(JSON.parse(sessionStorage.getItem(`ma:meeting:${sid}`)!)).toEqual([])
  })

  it('本地勾选 store：存储损坏 → 回到未勾选态（fail-safe）', () => {
    sessionStorage.setItem('ma:meeting:m42-store-bad', '{oops')
    expect(meetingChecks('m42-store-bad')).toEqual([])
  })
})

// ---------- 会议声明卡（::: meeting） ----------

describe('会议声明卡（::: meeting）', () => {
  it('Markdown 路由：标题 / 计数 / 三态行（容器显式态驱动）', () => {
    const { container } = render(<Markdown content={MEETING} />)
    const card = container.querySelector('.md-meeting')!
    expect(card.querySelector('.md-meeting-title')?.textContent).toBe('本周经营例会')
    expect(card.querySelector('.md-meeting-count')?.textContent).toBe('1/3 已决')
    const rows = card.querySelectorAll('.md-meeting-row')
    expect(rows).toHaveLength(3)
    expect(rows[0]!.getAttribute('data-state')).toBe('todo')
    expect(rows[1]!.getAttribute('data-state')).toBe('doing')
    expect(rows[2]!.getAttribute('data-state')).toBe('done')
    // 容器显式态行（doing / done）静态展示，仅待议行可点
    expect((rows[0] as HTMLButtonElement).disabled).toBe(false)
    expect((rows[1] as HTMLButtonElement).disabled).toBe(true)
    expect((rows[2] as HTMLButtonElement).disabled).toBe(true)
  })

  it('待议行勾选 → 本地已决并写入 sessionStorage；再点取消', () => {
    const sid = 'm42-card-toggle'
    const { container } = render(wrapMd(sid, <Markdown content={MEETING} />))
    const row = container.querySelectorAll('.md-meeting-row')[0] as HTMLButtonElement
    fireEvent.click(row)
    expect(meetingChecks(sid)).toEqual(['增长复盘：渠道与内容'])
    const after = container.querySelectorAll('.md-meeting-row')[0]!
    expect(after.getAttribute('data-state')).toBe('done')
    expect(after.className).toContain('is-done')
    expect(container.querySelector('.md-meeting-count')?.textContent).toBe('2/3 已决')
    fireEvent.click(container.querySelectorAll('.md-meeting-row')[0]!)
    expect(meetingChecks(sid)).toEqual([])
    expect(container.querySelector('.md-meeting-count')?.textContent).toBe('1/3 已决')
  })

  it('流式期间待议行禁用（容器显式态仍静态可读）', () => {
    const { container } = render(<Markdown content={MEETING} streaming />)
    const rows = container.querySelectorAll('.md-meeting-row')
    for (const r of rows) expect((r as HTMLButtonElement).disabled).toBe(true)
    expect(rows[2]!.getAttribute('data-state')).toBe('done')
  })

  it('空条目兜底：raw 静态渲染 + children 照常', () => {
    const { container } = render(
      <MeetingCard items={'oops'} raw={'- [x] 备份'} />,
    )
    expect(container.querySelector('.md-meeting-static')?.textContent).toBe('- [x] 备份')
  })
})

// ---------- 纪要卡（::: minutes） ----------

describe('纪要卡（::: minutes）', () => {
  it('Markdown 路由：三栏分组 / 未识别键归决议 / 待办派活行与普通行区分', () => {
    useAgentStore.setState({ agents: [ZHOU_ZHENG] })
    const { container } = render(<Markdown content={MINUTES} />)
    const card = container.querySelector('.md-minutes')!
    expect(card.querySelector('.md-minutes-title')?.textContent).toBe('本周经营例会纪要')
    const cols = card.querySelectorAll('.md-minutes-col')
    expect(cols).toHaveLength(3)
    expect(cols[0]!.getAttribute('data-col')).toBe('决议')
    // 未识别键（备注）归入决议栏
    expect(cols[0]!.textContent).toContain('数字口径统一按财务版本')
    expect(cols[0]!.textContent).toContain('待下次例会复核')
    expect(cols[1]!.textContent).toContain('按本周结论更新执行排期并同步工作区')
    expect(cols[2]!.textContent).toContain('关键指标若未回暖则收缩投入')
    // 待办：@负责人 行 → 可点派活（头像命中在场成员）；无 owner 行 → 普通行
    const todos = cols[1]!.querySelectorAll('.md-minutes-row, .md-minutes-todo')
    expect(todos).toHaveLength(2)
    const assign = cols[1]!.querySelector('.md-minutes-todo')!
    expect(assign.getAttribute('data-owner')).toBe('周正')
    expect(assign.querySelector('[title="周正"]')).not.toBeNull()
    expect(cols[1]!.querySelector('.md-minutes-owner-fallback')).toBeNull()
  })

  it('待办派活点击 → Composer 草稿 `@负责人 `（只写草稿不直发）', () => {
    useAgentStore.setState({ agents: [ZHOU_ZHENG] })
    const { container } = render(<Markdown content={MINUTES} />)
    fireEvent.click(container.querySelector('.md-minutes-todo')!)
    expect(useUiStore.getState().composerInsert?.text).toBe('@周正 ')
  })

  it('负责人无头像资产 → 首字回退；流式期间派活行禁用', () => {
    const { container } = render(<Markdown content={MINUTES} streaming />)
    const assign = container.querySelector('.md-minutes-todo') as HTMLButtonElement
    expect(assign.querySelector('.md-minutes-owner-fallback')?.textContent).toBe('周')
    expect(assign.disabled).toBe(true)
    expect(assign.title).toContain('负责')
  })

  it('空条目兜底：raw 静态渲染 + children 照常', () => {
    const { container } = render(<MinutesCard items={''} raw={'- 决议 | A'} />)
    expect(container.querySelector('.md-minutes-static')?.textContent).toBe('- 决议 | A')
  })
})

// ---------- 散会胶囊（RT-5） ----------

describe('散会胶囊（RT-5）', () => {
  it('adjournOfTail：仅「agent + complete + 含 minutes 容器」构成散会', () => {
    expect(adjournOfTail(MINUTES, 'agent', 'complete')).toBe(true)
    expect(adjournOfTail('普通收尾文案', 'agent', 'complete')).toBe(false)
    expect(adjournOfTail(MINUTES, 'agent', 'streaming')).toBe(false)
    expect(adjournOfTail(MINUTES, 'user', 'complete')).toBe(false)
  })

  function seedTail(message: ChatMessage): void {
    useSessionStore.setState({ byId: new Map([[message.id, message]]), order: [message.id] })
  }

  it('尾条含纪要容器且运行已收束 → 渲染「散会」静态胶囊', () => {
    seedTail(agentMsg('m-tail', { content: MINUTES }))
    useRunStore.setState({ active: false })
    const { container } = render(<AdjournPill />)
    const pill = container.querySelector('[data-adjourn-pill]')!
    expect(pill.textContent).toContain('散会 · 会议已收尾')
    expect(pill.getAttribute('role')).toBe('status')
  })

  it('运行中 / 尾条无纪要 / 尾条流式 → 不渲染', () => {
    act(() => {
      useRunStore.setState({ active: true })
    })
    seedTail(agentMsg('m-tail', { content: MINUTES }))
    const first = render(<AdjournPill />)
    expect(first.container.querySelector('[data-adjourn-pill]')).toBeNull()
    first.unmount()

    act(() => {
      useRunStore.setState({ active: false })
      seedTail(agentMsg('m-tail', { content: '普通收尾' }))
    })
    const second = render(<AdjournPill />)
    expect(second.container.querySelector('[data-adjourn-pill]')).toBeNull()
    second.unmount()

    act(() => {
      seedTail(agentMsg('m-tail', { content: MINUTES, status: 'streaming' }))
    })
    const third = render(<AdjournPill />)
    expect(third.container.querySelector('[data-adjourn-pill]')).toBeNull()
  })

  it('system 事件条不算尾条（向上找最近非 system 消息）', () => {
    const agent = agentMsg('m-agent', { content: MINUTES })
    const sys = agentMsg('m-sys', { role: 'system', agentId: undefined, content: '运行完成' })
    useSessionStore.setState({ byId: new Map([[agent.id, agent], [sys.id, sys]]), order: [agent.id, sys.id] })
    useRunStore.setState({ active: false })
    const { container } = render(<AdjournPill />)
    expect(container.querySelector('[data-adjourn-pill]')).not.toBeNull()
  })
})

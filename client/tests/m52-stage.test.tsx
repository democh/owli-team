/**
 * M52-A：场景工作区体系前端测试。
 * - resolveStage：解析 / 降级链（未声明 / 非法 / arena 缺席位 / listMode 兜底）；
 * - derive：容器解析 / 盘面行 / 裁决 / 清单 / 波次 / 标题（纯函数）；
 * - 面板空态：不空白、不报错（coach / chartboard / console / versus / pool / board）
 * - M52-C 细化：面板空态文案逐场景化（board：gamedesign / writing / housing；coach：health / learning / travel / wealth / personal / career / care + 中性默认）
 * - 面板内容态：console 管道与时间轴 / board 目录树与版本线 / versus 多空列 / chartboard 盘面 tabs；
 * - pool 集成：容器条目卡墙渲染 + 「深入」回填注入；
 * - SceneStage 宿主：stream 直通 / dock 就绪渲染（M58：无数据不渲染工作区）/ 窄屏抽屉（默认收起，可展开）；
 * - M52-D：席位发言流投影（SideFeed：该席过滤 / 最新在上 / 点击定位 / 空态）；
 * - M52-E：裁决状态容错（自然语言前缀 / 胜负条目兜底）与局面头（胜负 + 置信度 + 加权局势条）；
 * - M52-F：信号列逐条归因分侧（翻盘条件归败方 / 显式阵营词归各方 / 其余归裁决方向）。
 * - M58：面板就绪判定（panelReady 六口径）与「无数据不展示」；标题合行（宿主经 chrome 注入操作钮）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type * as React from 'react'
import type { AgentDefinition, AgentGroup, ChatMessage } from '@multi-agent/shared'
import {
  checklistItemsOf,
  containersOf,
  excerptOf,
  headingsOf,
  panRowsOf,
  parseContainers,
  speakingIdOf,
  verdictsOf,
  wavesOf,
} from '../src/components/scene/derive'
import { panelReady } from '../src/components/scene/panel-ready'
import { toggleMeetingCheck } from '../src/lib/meeting'
import {
  BoardPanel,
  ChartboardPanel,
  CoachPanel,
  ConsolePanel,
  PoolPanel,
  VersusPanel,
} from '../src/components/scene/panels'
import { SceneContext, type SceneCtx } from '../src/components/scene/context'
import { clampDockW, dockDefaultW, dockMaxW, loadDockPref, SC_DOCK_KEY } from '../src/components/scene/persist'
import { resolveStage } from '../src/components/scene/resolve'
import { RoundtableStage } from '../src/components/scene/RoundtableStage'
import { SceneStage } from '../src/components/scene/SceneStage'
import { useAgentStore } from '../src/stores/agent-store'
import { useSceneStore } from '../src/stores/scene-store'
import { useSessionStore } from '../src/stores/session-store'
import { useUiStore } from '../src/stores/ui-store'

// ---------- fixtures ----------

function agentMsg(id: string, agentId: string, content: string, turnIndex?: number): ChatMessage {
  return {
    id,
    sessionId: 'sa',
    role: 'agent',
    agentId,
    content,
    mentions: [],
    status: 'complete',
    createdAt: new Date().toISOString(),
    ...(turnIndex != null ? { turnIndex } : {}),
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

const GROUP_DOCK: AgentGroup = {
  id: 'metaphysics',
  name: '传统数术',
  description: '排盘研习',
  icon: 'moon',
  theme: ['#1f2937', '#8b5cf6'],
  objective: '命理研习',
  chain: [],
  defaultSkills: ['chinese-metaphysics'],
  parallel: true,
  rounds: false,
  order: 118,
  stage: { layout: 'dock', panel: 'chartboard' },
}

function makeCtx(insert: (t: string) => void = () => {}, focus: (id: string) => void = () => {}): SceneCtx {
  return {
    sessionId: 'sa',
    stage: { layout: 'dock', panel: 'pool', parts: [], fallback: false },
    participants: [],
    narrow: false,
    waitingIds: [],
    insert,
    focus,
    agentOf: () => undefined,
  }
}

function wrap(ui: React.ReactElement, ctx: SceneCtx = makeCtx()): React.JSX.Element {
  return <SceneContext.Provider value={ctx}>{ui}</SceneContext.Provider>
}

/** `::: pan` 盘面容器（chartboard 就绪数据） */
const PAN_MAIN = ['::: pan bazi 主盘', '- 日柱 | 甲子', ':::'].join('\n')

/** 模拟窄屏（<900px；useMediaQuery 依赖 matchMedia）；返回还原函数 */
function stubNarrow(): () => void {
  const orig = window.matchMedia
  window.matchMedia = ((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
  return () => {
    window.matchMedia = orig
  }
}

beforeEach(() => {
  useSessionStore.setState({ byId: new Map(), order: [], currentId: undefined })
  useSceneStore.setState({ listMode: false })
  useAgentStore.setState({ agents: [] })
  useUiStore.setState({ focusRequest: undefined })
})

// ---------- resolveStage ----------

describe('resolveStage（形态解析与降级链）', () => {
  it('未声明 / 非法 layout → stream 回退（fallback=true）', () => {
    expect(resolveStage(undefined).layout).toBe('stream')
    expect(resolveStage(undefined).fallback).toBe(true)
    expect(resolveStage({ layout: 'grid' }).layout).toBe('stream')
    expect(resolveStage({ layout: 'grid' }).fallback).toBe(true)
  })

  it('listMode（切回纯列表）优先且不算异常降级', () => {
    const r = resolveStage({ layout: 'arena', seats: { left: ['a'] } }, { listMode: true })
    expect(r.layout).toBe('stream')
    expect(r.fallback).toBe(false)
  })

  it('dock + 合法 panel 原样解析', () => {
    const r = resolveStage({ layout: 'dock', panel: 'chartboard' })
    expect(r.layout).toBe('dock')
    expect(r.panel).toBe('chartboard')
    expect(r.fallback).toBe(false)
  })

  it('panel 非法值被忽略（保留 layout，无 panel）', () => {
    const r = resolveStage({ layout: 'dock', panel: 'nope' })
    expect(r.layout).toBe('dock')
    expect(r.panel).toBeUndefined()
  })

  it('arena 缺席位 → stream 回退；有席位 → 正常', () => {
    expect(resolveStage({ layout: 'arena' }).layout).toBe('stream')
    expect(resolveStage({ layout: 'arena' }).fallback).toBe(true)
    expect(resolveStage({ layout: 'arena', seats: { left: ['a'], center: ['judge'] } }).layout).toBe('arena')
  })

  it('parts 过滤非法项（非字符串 / 空串）', () => {
    const r = resolveStage({ layout: 'arena', seats: { left: ['a'] }, parts: ['round-track', '', 3, 'scoreboard'] })
    expect(r.parts).toEqual(['round-track', 'scoreboard'])
  })
})

// ---------- derive ----------

describe('derive（纯前端派生）', () => {
  it('parseContainers：块解析 + 未闭合忽略', () => {
    const src = ['开场', '::: ideas 池', '- A | 1', ':::', '中段', '::: bad', 'x'].join('\n')
    const blocks = parseContainers(src)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.name).toBe('ideas')
    expect(blocks[0]!.arg).toBe('池')
    expect(blocks[0]!.lines).toEqual(['- A | 1'])
  })

  it('panRowsOf：字段行（键：值）+ 条目行（- 键 | 值）', () => {
    const { fields, items } = panRowsOf(['四柱：甲子 乙丑', '- 命宫 | 紫微', '- 纯值'])
    expect(fields).toEqual([{ label: '四柱', value: '甲子 乙丑' }])
    expect(items).toEqual([
      { label: '命宫', value: '紫微' },
      { label: '', value: '纯值' },
    ])
  })

  it('verdictsOf：多空 / 正反同构映射与标题解析', () => {
    const vs = verdictsOf([agentMsg('m1', 'lead', ['::: verdict 多方 终局', '- 置信度 | 中', ':::'].join('\n'))])
    expect(vs).toHaveLength(1)
    expect(vs[0]!.status).toBe('long')
    expect(vs[0]!.title).toBe('终局')
    expect(vs[0]!.items).toEqual([{ label: '置信度', value: '中' }])
    const vs2 = verdictsOf([agentMsg('m2', 'judge', ['::: verdict 正方', ':::'].join('\n'))])
    expect(vs2[0]!.status).toBe('long')
  })

  it('verdictsOf：自然语言状态前缀与「胜负」条目兜底（M52-E）', () => {
    // 前缀词：「空方领先」→ short（无剩余标题 → 保留原文）
    const vs = verdictsOf([
      agentMsg('m1', 'lead', ['::: verdict 空方领先', '- 胜负 | 空方领先', ':::'].join('\n')),
    ])
    expect(vs[0]!.status).toBe('short')
    expect(vs[0]!.title).toBe('空方领先')
    // 首词未知 → 条目「胜负」值前缀兜底；标题保留整串
    const vs2 = verdictsOf([
      agentMsg('m2', 'judge', ['::: verdict 结论如下', '- 胜负 | 多方占优（程序性）', ':::'].join('\n')),
    ])
    expect(vs2[0]!.status).toBe('long')
    expect(vs2[0]!.title).toBe('结论如下')
  })

  it('checklistItemsOf：勾选态与纯文本项', () => {
    const items = checklistItemsOf(['- [x] 跑步 3 次', '- 睡眠 7h'])
    expect(items[0]).toMatchObject({ label: '跑步 3 次', checked: true })
    expect(items[1]).toMatchObject({ label: '睡眠 7h', checked: false })
  })

  it('wavesOf / speakingIdOf：波次分组与当前发言者', () => {
    const msgs = [agentMsg('m1', 'a', 'x', 0), agentMsg('m2', 'b', 'y', 0), agentMsg('m3', 'c', 'z', 1)]
    const waves = wavesOf(msgs)
    expect(waves.map((w) => w.turnIndex)).toEqual([0, 1])
    expect(waves[0]!.memberIds).toEqual(['a', 'b'])
    expect(speakingIdOf(msgs)).toBe('c')
  })

  it('headingsOf：提取标题并跳过代码围栏', () => {
    const heads = headingsOf(['# 一', '```', '## fake', '```', '## 二'].join('\n'))
    expect(heads).toEqual([
      { level: 1, text: '一' },
      { level: 2, text: '二' },
    ])
  })
})

// ---------- 面板空态 ----------

describe('面板空态（不空白、不报错）', () => {
  it('coach：无 checklist 容器 → 中性默认空态（未收录场景兜底）', () => {
    render(wrap(<CoachPanel />))
    expect(screen.getByText('清单与进度将在这里显示')).toBeInTheDocument()
  })

  it('coach：空态文案逐场景化（health / learning / travel / wealth / personal / career / care）', () => {
    const coachCtx = (id: string): SceneCtx => ({
      ...makeCtx(),
      group: { ...GROUP_DOCK, id, stage: { layout: 'dock', panel: 'coach' } },
    })
    const cases: [string, string][] = [
      ['health', '打卡与周计划将在这里显示'],
      ['learning', '学习路径与打卡将在这里显示'],
      ['travel', '行程与预算将在这里显示'],
      ['wealth', '预算与目标进度将在这里显示'],
      ['personal', '事务清单与提醒将在这里显示'],
      ['career', '求职进度与产出物将在这里显示'],
      ['care', '照护排班与清单将在这里显示'],
    ]
    for (const [id, text] of cases) {
      const r = render(wrap(<CoachPanel />, coachCtx(id)))
      expect(screen.getByText(text)).toBeInTheDocument()
      r.unmount()
    }
  })

  it('chartboard：无 ::: pan 容器 → 引导空态', () => {
    render(wrap(<ChartboardPanel />))
    expect(screen.getByText('对话中产生的盘面将显示在这里')).toBeInTheDocument()
  })

  it('console：无活动 → 引导空态', () => {
    render(wrap(<ConsolePanel />))
    expect(screen.getByText('活动与产出将在这里显示')).toBeInTheDocument()
  })

  it('versus：无裁决 → 引导空态', () => {
    render(wrap(<VersusPanel />))
    expect(screen.getByText('多空信号与局势将在这里显示')).toBeInTheDocument()
  })

  it('pool：无容器 → 引导空态', () => {
    render(wrap(<PoolPanel />))
    expect(screen.getByText('研讨产物将汇聚在这里')).toBeInTheDocument()
  })

  it('board：无标题成员消息 → 中性默认空态（未收录场景兜底）', () => {
    render(wrap(<BoardPanel />))
    expect(screen.getByText('文档结构与版本将在这里显示')).toBeInTheDocument()
  })

  it('board：空态文案逐场景化（gamedesign / writing / housing）', () => {
    const boardCtx = (id: string): SceneCtx => ({
      ...makeCtx(),
      group: { ...GROUP_DOCK, id, stage: { layout: 'dock', panel: 'board' } },
    })
    const g = render(wrap(<BoardPanel />, boardCtx('gamedesign')))
    expect(screen.getByText('设计文档与数值表将在这里显示')).toBeInTheDocument()
    g.unmount()
    const w = render(wrap(<BoardPanel />, boardCtx('writing')))
    expect(screen.getByText('文稿结构与版本将在这里显示')).toBeInTheDocument()
    w.unmount()
    render(wrap(<BoardPanel />, boardCtx('housing')))
    expect(screen.getByText('方案对比与预算测算将在这里显示')).toBeInTheDocument()
  })
})

// ---------- coach 内容态 ----------

const COACH_LIST = ['::: checklist', '- [x] 跑步 3 次', '- 睡眠 7h', ':::'].join('\n')
const COACH_LIST_TITLED = ['::: checklist 每周训练计划', '- 拉伸 10 分钟', ':::'].join('\n')

describe('coach 陪跑面板（容器内容 + 兜底标题）', () => {
  const coachCtx = (id: string): SceneCtx => ({
    ...makeCtx(),
    group: { ...GROUP_DOCK, id, stage: { layout: 'dock', panel: 'coach' } },
  })

  it('容器无标题 → 场景化兜底标题 ×7 与中性默认（未收录场景）', () => {
    seed([agentMsg('m1', 'guide', COACH_LIST)])
    const cases: [string, string][] = [
      ['health', '打卡清单'],
      ['learning', '学习清单'],
      ['travel', '行程清单'],
      ['wealth', '目标清单'],
      ['personal', '事务清单'],
      ['career', '求职清单'],
      ['care', '照护清单'],
    ]
    for (const [id, title] of cases) {
      const r = render(wrap(<CoachPanel />, coachCtx(id)))
      expect(screen.getByText(title)).toBeInTheDocument()
      r.unmount()
    }
    render(wrap(<CoachPanel />))
    expect(screen.getByText('清单')).toBeInTheDocument()
  })

  it('容器带标题 → 原标题优先（不落兜底）', () => {
    seed([agentMsg('m1', 'coach', COACH_LIST_TITLED)])
    render(wrap(<CoachPanel />))
    expect(screen.getByText('每周训练计划')).toBeInTheDocument()
    expect(screen.queryByText('清单')).not.toBeInTheDocument()
  })
})

// ---------- 面板内容态（console / board / versus / chartboard） ----------

describe('面板内容态（容器 / 消息驱动）', () => {
  it('console：kanban 容器 → 管道列与卡片；成员消息 → 活动时间轴', () => {
    const KANBAN = ['::: kanban 待处理', '- 线索 A | 高潜', ':::'].join('\n')
    seed([agentMsg('m1', 'lead', KANBAN, 0)])
    render(wrap(<ConsolePanel />))
    expect(screen.getByText('管道')).toBeInTheDocument()
    expect(screen.getByText('待处理')).toBeInTheDocument()
    expect(screen.getByText('线索 A')).toBeInTheDocument()
    expect(screen.getByText('高潜')).toBeInTheDocument()
    expect(screen.getByText('活动时间轴')).toBeInTheDocument()
    expect(screen.getByText('线索 A | 高潜')).toBeInTheDocument()
    expect(screen.getByText('R1')).toBeInTheDocument()
  })

  it('board：多稿消息 → 当前稿结构 + 版本线（最新为当前稿）', () => {
    seed([
      agentMsg('m1', 'writer', '# 第一章 立项\n\n## 1.1 背景'),
      agentMsg('m2', 'writer', '# 第二章 方案\n\n## 2.1 架构'),
    ])
    render(wrap(<BoardPanel />))
    expect(screen.getByText('当前稿结构')).toBeInTheDocument()
    expect(screen.getByText('第二章 方案')).toBeInTheDocument()
    expect(screen.getByText('2.1 架构')).toBeInTheDocument()
    expect(screen.getByText('版本线')).toBeInTheDocument()
    expect(screen.getByText('第一章 立项')).toBeInTheDocument()
    expect(screen.getByText('v1')).toBeInTheDocument()
    expect(screen.getByText('2 节')).toBeInTheDocument()
    expect(screen.getByText('v2')).toBeInTheDocument()
  })

  it('versus：verdict 容器 → 多空列与裁决卡（空方占位）', () => {
    const VERDICT = ['::: verdict 多方 终局', '- 量价齐升 | 高置信', ':::'].join('\n')
    seed([agentMsg('m1', 'analyst', VERDICT)])
    render(wrap(<VersusPanel />))
    expect(screen.getAllByText('量价齐升')).toHaveLength(2)
    expect(screen.getByText('暂无信号')).toBeInTheDocument()
    expect(screen.getByText('终局')).toBeInTheDocument()
  })

  it('versus：自然语言状态词 → 局面头（胜负 / 置信度）与加权局势条（M52-E）', () => {
    const VERDICT = [
      '::: verdict 空方领先',
      '- 胜负 | 空方领先（程序性优势，非实质性压倒）',
      '- 置信度 | 中（60%）',
      '- 核心依据 | 月 / 周 / 日三周期空头结构',
      '- 翻盘条件 | 周线收盘站上压力位',
      ':::',
    ].join('\n')
    seed([agentMsg('m1', 'analyst', VERDICT)])
    const { container } = render(wrap(<VersusPanel />))
    // 局面头：胜负 + 置信度（显式百分比直取）
    expect(container.querySelector('.scene-vs-head-short')).not.toBeNull()
    expect(container.querySelector('.scene-vs-headline')?.textContent).toBe('空方领先')
    expect(container.querySelector('.scene-vs-conf')?.textContent).toBe('置信度 60%')
    // 信号列（M52-F 逐条分侧）：元信息剔除；核心依据归空方（胜方）、翻盘条件归多方（败方）
    const shortCol = container.querySelector('.scene-vs-short')!
    expect(shortCol.querySelectorAll('.scene-vs-signal')).toHaveLength(1)
    expect(shortCol.textContent).toContain('三周期空头结构')
    expect(shortCol.textContent).not.toContain('置信度')
    const longCol = container.querySelector('.scene-vs-long')!
    expect(longCol.querySelectorAll('.scene-vs-signal')).toHaveLength(1)
    expect(longCol.textContent).toContain('周线收盘站上压力位')
    expect(container.querySelector('.scene-vs-silent')).toBeNull()
    // 局势条：方向（空）× 置信度 60% → 半轨 30%
    expect((container.querySelector('.scene-mo-right') as HTMLElement).style.width).toBe('30%')
  })

  it('versus：条目按语义分侧——阵营词 / 翻盘条件 / 其余兜底（M52-F）', () => {
    const VERDICT = [
      '::: verdict 空方领先',
      '- 核心依据 | 三周期空头未破坏',
      '- 空方失效条件 | 站上 1355 压力',
      '- 多方失效条件 | 跌破 1268 支撑',
      '- 翻盘条件 | 底背离确认',
      ':::',
    ].join('\n')
    seed([agentMsg('m1', 'analyst', VERDICT)])
    const { container } = render(wrap(<VersusPanel />))
    // 显式阵营词归各方；无标识条目归裁决方向（空方）；翻盘条件归败方（多方）
    const shortCol = container.querySelector('.scene-vs-short')!
    expect(shortCol.querySelectorAll('.scene-vs-signal')).toHaveLength(2)
    expect(shortCol.textContent).toContain('三周期空头未破坏')
    expect(shortCol.textContent).toContain('站上 1355 压力')
    const longCol = container.querySelector('.scene-vs-long')!
    expect(longCol.querySelectorAll('.scene-vs-signal')).toHaveLength(2)
    expect(longCol.textContent).toContain('跌破 1268 支撑')
    expect(longCol.textContent).toContain('底背离确认')
  })

  it('versus：多方领先 → 翻盘条件归空方（mock 多空对弈同构）（M52-F）', () => {
    const VERDICT = [
      '::: verdict 多方 多空对弈裁决',
      '- 核心依据 | 估值与现金流证据等级占优',
      '- 翻盘条件 | 放量跌破密集区支撑 → 裁决翻转空方',
      ':::',
    ].join('\n')
    seed([agentMsg('m1', 'lead', VERDICT)])
    const { container } = render(wrap(<VersusPanel />))
    expect(container.querySelector('.scene-vs-long .scene-vs-signal')?.textContent).toContain('证据等级占优')
    expect(container.querySelector('.scene-vs-short .scene-vs-signal')?.textContent).toContain('裁决翻转空方')
    expect(container.querySelector('.scene-vs-silent')).toBeNull()
  })

  it('chartboard：pan 容器 → 盘面 tabs（类型徽标 + 标题）', () => {
    const PAN = ['::: pan bazi 主盘', '- 日柱 | 甲子', ':::'].join('\n')
    seed([agentMsg('m1', 'diviner', PAN)])
    render(wrap(<ChartboardPanel />))
    expect(screen.getAllByText('八字').length).toBeGreaterThan(0)
    expect(screen.getAllByText('主盘').length).toBeGreaterThan(0)
    expect(screen.getByText('看解读')).toBeInTheDocument()
  })
})

// ---------- pool 集成 ----------

const IDEAS = ['::: ideas 点子池', '- 双周冲刺 | ICE 8.2', '- 用户访谈 | ICE 6.5', ':::'].join('\n')

describe('pool 汇聚板（容器卡墙 + 回填）', () => {
  it('容器条目渲染为卡片（徽标 / 标题 / 条目）', () => {
    seed([agentMsg('m1', 'ideator', IDEAS)])
    render(wrap(<PoolPanel />))
    expect(screen.getByText('点子')).toBeInTheDocument()
    expect(screen.getByText('点子池')).toBeInTheDocument()
    expect(screen.getByText('双周冲刺')).toBeInTheDocument()
    expect(screen.getByText('用户访谈')).toBeInTheDocument()
  })

  it('点「深入」→ 回填回调（composerInsert 语义）', () => {
    const insert = vi.fn()
    seed([agentMsg('m1', 'ideator', IDEAS)])
    render(wrap(<PoolPanel />, makeCtx(insert)))
    fireEvent.click(screen.getByText('深入'))
    expect(insert).toHaveBeenCalledTimes(1)
    expect(String(insert.mock.calls[0]![0])).toContain('深入展开')
  })
})

// ---------- SceneStage 宿主 ----------

describe('SceneStage 宿主（四形态渲染与降级）', () => {
  it('未声明 stage → stream 直通（零新增结构）', () => {
    const { container } = render(
      <SceneStage participants={[]}>
        <div data-testid="stream-child">对话流</div>
      </SceneStage>,
    )
    expect(screen.getByTestId('stream-child')).toBeInTheDocument()
    expect(container.querySelector('.scene-dock')).toBeNull()
    expect(container.querySelector('.scene-rt')).toBeNull()
  })

  it('dock + chartboard 声明 → 无数据不渲染工作区（直通纯对话流）', () => {
    const { container } = render(
      <SceneStage group={GROUP_DOCK} participants={[]}>
        <div data-testid="stream-child">对话流</div>
      </SceneStage>,
    )
    expect(container.querySelector('.scene-dock')).toBeNull()
    expect(container.querySelector('.scene-dock-aside')).toBeNull()
    expect(screen.queryByText('盘面面板')).toBeNull()
    expect(screen.getByTestId('stream-child')).toBeInTheDocument()
  })

  it('dock + chartboard 有盘面数据 → 渲染右工作区（标题合行：折叠 / 关闭钮在标题行）', () => {
    seed([agentMsg('m1', 'diviner', PAN_MAIN)])
    const { container } = render(
      <SceneStage group={GROUP_DOCK} participants={[]}>
        <div data-testid="stream-child">对话流</div>
      </SceneStage>,
    )
    expect(container.querySelector('.scene-dock')).not.toBeNull()
    const aside = container.querySelector('.scene-dock-aside')!
    expect(aside).not.toBeNull()
    // M58：折叠 / 关闭钮收口进面板标题行（不再占独立操作条）
    const head = aside.querySelector('.scene-panel-head')!
    expect(head.textContent).toContain('盘面面板')
    expect(head.querySelectorAll('.scene-panel-actions button')).toHaveLength(2)
    expect(screen.getByTitle('折叠工作区')).toBeInTheDocument()
    expect(screen.getByTitle('关闭工作区')).toBeInTheDocument()
    // 有数据 → 空态不出现；消息流仍在（dock 左区）
    expect(screen.queryByText('对话中产生的盘面将显示在这里')).toBeNull()
    expect(screen.getByTestId('stream-child')).toBeInTheDocument()
  })

  it('窄屏（<900px）dock → 有数据时底部抽屉默认收起，展开后显示面板', () => {
    const restore = stubNarrow()
    try {
      seed([agentMsg('m1', 'diviner', PAN_MAIN)])
      const { container } = render(
        <SceneStage group={GROUP_DOCK} participants={[]}>
          <div data-testid="stream-child">对话流</div>
        </SceneStage>,
      )
      expect(container.querySelector('.scene-drawer')).not.toBeNull()
      expect(container.querySelector('.scene-dock-aside')).toBeNull()
      // 默认收起：面板不渲染（仅抽屉条）
      expect(screen.queryByText('盘面面板')).toBeNull()
      fireEvent.click(screen.getByText('工作区'))
      expect(screen.getByText('盘面面板')).toBeInTheDocument()
    } finally {
      restore()
    }
  })

  it('窄屏（<900px）dock → 无数据时抽屉也不渲染（工作区整体不展示）', () => {
    const restore = stubNarrow()
    try {
      const { container } = render(
        <SceneStage group={GROUP_DOCK} participants={[]}>
          <div data-testid="stream-child">对话流</div>
        </SceneStage>,
      )
      expect(container.querySelector('.scene-drawer')).toBeNull()
      expect(screen.getByTestId('stream-child')).toBeInTheDocument()
    } finally {
      restore()
    }
  })

  it('listMode 开启 → 声明 dock 也回退 stream（切回纯列表）', () => {
    useSceneStore.setState({ listMode: true })
    seed([agentMsg('m1', 'diviner', PAN_MAIN)])
    const { container } = render(
      <SceneStage group={GROUP_DOCK} participants={[]}>
        <div data-testid="stream-child">对话流</div>
      </SceneStage>,
    )
    expect(container.querySelector('.scene-dock')).toBeNull()
    expect(screen.getByTestId('stream-child')).toBeInTheDocument()
  })
})

// ---------- 批九：dock 右区宽度（自适应默认 / 半屏上限） ----------

/** 视口宽夹具（无 RO 环境时容器宽以视口宽为首帧估计；返回还原函数） */
function stubViewport(w: number): () => void {
  const orig = Object.getOwnPropertyDescriptor(window, 'innerWidth')
  Object.defineProperty(window, 'innerWidth', { value: w, configurable: true, writable: true })
  return () => {
    if (orig) Object.defineProperty(window, 'innerWidth', orig)
  }
}

describe('批九 · dock 右区宽度（自适应默认 / 半屏上限 / 复位）', () => {
  it('纯函数口径：上限 = 容器一半（下取整）；默认 = 容器 1/3（clamp 380–600，不越上限）', () => {
    expect(dockMaxW(1024)).toBe(512)
    expect(dockMaxW(300)).toBe(280) // 容器极小： DOCK_MIN_W 保底
    expect(dockDefaultW(1024)).toBe(380)
    expect(dockDefaultW(1440)).toBe(480)
    expect(dockDefaultW(2400)).toBe(600) // 1/3 越 600 → 封顶
    expect(dockDefaultW(300)).toBe(280) // 不越半屏上限
    expect(clampDockW(5000, 1024)).toBe(512)
    expect(clampDockW(100, 1024)).toBe(280)
  })

  it('存量偏好迁移：旧固定默认 360 → 自适应；显式值原样保留（下限护栏）', () => {
    try {
      localStorage.setItem(SC_DOCK_KEY, JSON.stringify({ width: 360, collapsed: true, closed: false }))
      expect(loadDockPref()).toEqual({ width: null, collapsed: true, closed: false })
      localStorage.setItem(SC_DOCK_KEY, JSON.stringify({ width: 720 }))
      expect(loadDockPref().width).toBe(720)
      localStorage.setItem(SC_DOCK_KEY, JSON.stringify({ width: 100 }))
      expect(loadDockPref().width).toBe(280)
    } finally {
      localStorage.removeItem(SC_DOCK_KEY)
    }
  })

  it('默认渲染（视口 1024）：右区 380px；把手 aria：min 280 / now 380 / max 512', () => {
    const restore = stubViewport(1024)
    try {
      seed([agentMsg('m1', 'diviner', PAN_MAIN)])
      const { container } = render(
        <SceneStage group={GROUP_DOCK} participants={[]}>
          <div data-testid="stream-child">对话流</div>
        </SceneStage>,
      )
      const aside = container.querySelector('.scene-dock-aside') as HTMLElement
      expect(aside.style.width).toBe('380px')
      const grip = container.querySelector('.scene-dock-grip') as HTMLElement
      expect(grip.getAttribute('aria-valuemin')).toBe('280')
      expect(grip.getAttribute('aria-valuenow')).toBe('380')
      expect(grip.getAttribute('aria-valuemax')).toBe('512')
    } finally {
      restore()
      localStorage.removeItem(SC_DOCK_KEY)
    }
  })

  it('显式宽超半屏 → 渲染期收敛一半（不改写存储意图）；双击复位自适应；键盘 ← 调宽', () => {
    const restore = stubViewport(1024)
    try {
      localStorage.setItem(SC_DOCK_KEY, JSON.stringify({ width: 5000, collapsed: false, closed: false }))
      seed([agentMsg('m1', 'diviner', PAN_MAIN)])
      const { container } = render(
        <SceneStage group={GROUP_DOCK} participants={[]}>
          <div data-testid="stream-child">对话流</div>
        </SceneStage>,
      )
      const aside = container.querySelector('.scene-dock-aside') as HTMLElement
      expect(aside.style.width).toBe('512px')
      // 存储保留原始意图（窗口再放宽 → 恢复）
      expect((JSON.parse(localStorage.getItem(SC_DOCK_KEY)!) as { width: number }).width).toBe(5000)

      // 双击复位 → 自适应（视口 1024 → 380）
      const grip = container.querySelector('.scene-dock-grip') as HTMLElement
      fireEvent.doubleClick(grip)
      expect(aside.style.width).toBe('380px')
      expect((JSON.parse(localStorage.getItem(SC_DOCK_KEY)!) as { width: number | null }).width).toBeNull()

      // 键盘 ← 调宽（+16 落显式宽）
      fireEvent.keyDown(grip, { key: 'ArrowLeft' })
      expect(aside.style.width).toBe('396px')
      expect((JSON.parse(localStorage.getItem(SC_DOCK_KEY)!) as { width: number }).width).toBe(396)
    } finally {
      restore()
      localStorage.removeItem(SC_DOCK_KEY)
    }
  })
})

// ---------- M52-B：四形态组件级走查（seats / agenda 数据驱动） ----------

function makeAgent(id: string, name: string): AgentDefinition {
  return {
    id,
    name,
    role: '成员',
    title: '',
    description: '',
    capabilities: [],
    group: 'society',
    avatar: { gradient: ['#0ea5e9', '#14b8a6'], icon: 'user' },
    handoff: [],
  }
}

const LI_YAN = makeAgent('affirmative', '立言')
const LI_FENG = makeAgent('negative', '砺锋')
const MING_DUAN = makeAgent('judge', '明断')
const QI_GUAN = makeAgent('moderator', '齐观')
const SHANG_ZHEN = makeAgent('fact-checker', '尚真')
const FANG_HENG = makeAgent('stakeholder', '方衡')
const YUN_ZHONG = makeAgent('policy-advisor', '允中')

const GROUP_ARENA: AgentGroup = {
  ...GROUP_DOCK,
  id: 'debate',
  name: '辩论场',
  stage: { layout: 'arena', seats: { left: ['affirmative'], right: ['negative'], center: ['judge'] } },
}

const GROUP_RT: AgentGroup = {
  ...GROUP_DOCK,
  id: 'society',
  name: '议题圆桌',
  stage: { layout: 'roundtable', panel: 'pool' },
  agenda: [
    { label: '组织议题研讨', prompt: '围绕议题组织研讨：' },
    { label: '核查一组说法', prompt: '核查这组说法：' },
  ],
}

describe('M52-B 四形态组件级走查（seats / agenda 数据驱动）', () => {
  it('arena：seats → 左右席栏 + 中轴席位 + 计分板 + 回合轴', () => {
    useAgentStore.setState({ agents: [LI_YAN, LI_FENG, MING_DUAN] })
    seed([agentMsg('m1', 'affirmative', '正方立论：远程办公提升专注。', 0)])
    const { container } = render(
      <SceneStage group={GROUP_ARENA} participants={[LI_YAN, LI_FENG, MING_DUAN]}>
        <div data-testid="stream-child">对话流</div>
      </SceneStage>,
    )
    expect(container.querySelector('.scene-arena')).not.toBeNull()
    expect(container.querySelector('.scene-arena-left')!.textContent).toContain('立言')
    expect(container.querySelector('.scene-arena-right')!.textContent).toContain('砺锋')
    // M85 合并：裁决席签 + 参与条同行（原计分板读数并入会话标题行；中轴席位卡行已并入）
    const actionrow = container.querySelector('.scene-arena-actionrow')
    expect(actionrow).not.toBeNull()
    expect(actionrow!.querySelector('.scene-arena-preside')?.textContent).toContain('明断')
    expect(screen.getByTestId('stream-child')).toBeInTheDocument()
  })

  it('arena：席位成员不在场 → 席位栏为空但结构完整（左席 / 右席占位标签）', () => {
    seed([])
    const { container } = render(
      <SceneStage group={GROUP_ARENA} participants={[]}>
        <div data-testid="stream-child">对话流</div>
      </SceneStage>,
    )
    expect(container.querySelector('.scene-arena-left')!.childElementCount).toBe(0)
    // 计分板已删除（M85 合并至会话标题行）；无席位成员 → 席签 / 参与条不渲染
    expect(container.querySelector('.scene-arena-actionrow')).toBeNull()
    expect(container.querySelector('.scene-arena-preside')).toBeNull()
  })

  it('arena：parts 声明裁剪——negotiation 保报价流；debate 保论断树并裁报价流', () => {
    const NEGO: AgentGroup = {
      ...GROUP_ARENA,
      id: 'negotiation',
      name: '谈判桌',
      stage: {
        layout: 'arena',
        seats: { left: ['negotiator'], right: ['counterpart'], center: ['tactician'] },
        parts: ['round-track', 'verdicts', 'claim-tree', 'offers'],
      },
    }
    seed([
      agentMsg('n1', 'negotiator', '::: claim 锚定策略\n- 论据 1 | 先出高锚\n:::\n\n::: offer 首轮出价\n报价：98 万\n:::', 0),
    ])
    const { container } = render(
      <SceneStage group={NEGO} participants={[LI_YAN, LI_FENG, MING_DUAN]}>
        <div data-testid="stream-child">对话流</div>
      </SceneStage>,
    )
    expect(container.querySelector('.scene-arena')).not.toBeNull()
    // 计分板 / 回合轴均已下线（M85）：谈判仅验报价流 / 论断树保留
    expect(container.querySelector('[data-insight="offers"]')).not.toBeNull()
    expect(container.querySelector('[data-insight="claims"]')).not.toBeNull()

    // debate：论断树保留；报价流（辩论无此语义）被裁剪
    const DEBATE: AgentGroup = {
      ...GROUP_ARENA,
      stage: {
        layout: 'arena',
        seats: { left: ['affirmative'], right: ['negative'], center: ['judge'] },
        parts: ['round-track', 'scoreboard', 'verdicts', 'claim-tree'],
      },
    }
    seed([agentMsg('d1', 'affirmative', '::: claim 正方主张：净收益为正\n- 论据 1 | 证据 1\n:::', 0)])
    const { container: c2 } = render(
      <SceneStage group={DEBATE} participants={[LI_YAN, LI_FENG, MING_DUAN]}>
        <div data-testid="stream-child-2">对话流</div>
      </SceneStage>,
    )
    expect(c2.querySelector('[data-insight="claims"]')).not.toBeNull()
    expect(c2.querySelector('[data-insight="offers"]')).toBeNull()
  })

  it('roundtable：席位环 4 席 + 议程条推进 + 有产物时汇聚板渲染', () => {
    useAgentStore.setState({ agents: [QI_GUAN, SHANG_ZHEN, FANG_HENG, YUN_ZHONG] })
    // m2 同波次（turn 0）携带产物容器：议程推进不变（第 1 波 → 第 1 步 doing）
    seed([agentMsg('m1', 'moderator', '开场：先定议程。', 0), agentMsg('m2', 'fact-checker', IDEAS, 0)])
    const { container } = render(
      <SceneStage group={GROUP_RT} participants={[QI_GUAN, SHANG_ZHEN, FANG_HENG, YUN_ZHONG]}>
        <div data-testid="stream-child">对话流</div>
      </SceneStage>,
    )
    const ring = container.querySelector('.scene-seat-ring')!
    for (const n of ['齐观', '尚真', '方衡', '允中']) expect(ring.textContent).toContain(n)
    const ag = container.querySelector('.scene-agenda')!
    expect(ag.textContent).toContain('组织议题研讨')
    // 第 1 波 → 第 1 步 doing
    expect(container.querySelector('.scene-ag-doing')!.textContent).toContain('组织议题研讨')
    // 汇聚板（pool 面板注入右区）：有产物 → 渲染卡片墙（空态不出现）
    expect(container.querySelector('.scene-rt-aside')).not.toBeNull()
    expect(screen.getByText('汇聚板')).toBeInTheDocument()
    expect(screen.getByText('点子池')).toBeInTheDocument()
    expect(screen.queryByText('研讨产物将汇聚在这里')).toBeNull()
  })

  it('roundtable：无产物 → 汇聚板不渲染（无数据不展示）', () => {
    useAgentStore.setState({ agents: [QI_GUAN, SHANG_ZHEN, FANG_HENG, YUN_ZHONG] })
    seed([agentMsg('m1', 'moderator', '开场：先定议程。', 0)])
    const { container } = render(
      <SceneStage group={GROUP_RT} participants={[QI_GUAN, SHANG_ZHEN, FANG_HENG, YUN_ZHONG]}>
        <div data-testid="stream-child">对话流</div>
      </SceneStage>,
    )
    expect(container.querySelector('.scene-rt-aside')).toBeNull()
    expect(screen.queryByText('研讨产物将汇聚在这里')).toBeNull()
    // 席位环与议程条不受影响（仅工作区隐去）
    expect(container.querySelector('.scene-seat-ring')).not.toBeNull()
    expect(container.querySelector('.scene-agenda')).not.toBeNull()
  })
})

// ---------- M59：汇聚板收起（折叠窄条 / 关闭浮动恢复，口径同 dock） ----------

describe('M59 汇聚板收起（折叠 / 展开 / 关闭 / 恢复）', () => {
  beforeEach(() => {
    window.localStorage.removeItem('ma:sc:rt')
  })

  it('折叠 → 窄条 rail（面板卸载）；展开归位；关闭 → 浮动恢复胶囊并可复位', () => {
    useAgentStore.setState({ agents: [QI_GUAN, SHANG_ZHEN, FANG_HENG, YUN_ZHONG] })
    // 同波次携带产物容器 → 汇聚板就绪渲染（panelReady 前提）
    seed([agentMsg('m1', 'moderator', '开场：先定议程。', 0), agentMsg('m2', 'fact-checker', IDEAS, 0)])
    const { container } = render(
      <SceneStage group={GROUP_RT} participants={[QI_GUAN, SHANG_ZHEN, FANG_HENG, YUN_ZHONG]}>
        <div data-testid="stream-child">对话流</div>
      </SceneStage>,
    )
    expect(container.querySelector('.scene-rt-aside')).not.toBeNull()
    expect(container.querySelector('.scene-rt-rail')).toBeNull()

    // 折叠：rail 出现（展开钮 + 竖标），面板内容随之卸载
    fireEvent.click(screen.getByTitle('折叠汇聚板'))
    expect(container.querySelector('.scene-rt-aside.scene-rt-rail')).not.toBeNull()
    expect(screen.getByTitle('展开汇聚板')).toBeInTheDocument()
    expect(screen.queryByText('点子池')).toBeNull()

    // 展开归位：卡墙回来、rail 退场
    fireEvent.click(screen.getByTitle('展开汇聚板'))
    expect(container.querySelector('.scene-rt-rail')).toBeNull()
    expect(screen.getByText('点子池')).toBeInTheDocument()

    // 关闭：aside 卸载、浮动恢复胶囊出现；点恢复归位
    fireEvent.click(screen.getByTitle('关闭汇聚板'))
    expect(container.querySelector('.scene-rt-aside')).toBeNull()
    fireEvent.click(screen.getByTitle('显示汇聚板'))
    expect(container.querySelector('.scene-rt-aside')).not.toBeNull()
  })

  it('顶区收起 → 迷你条（席位环与议程卸载、摘要保留）；展开恢复', () => {
    useAgentStore.setState({ agents: [QI_GUAN, SHANG_ZHEN, FANG_HENG, YUN_ZHONG] })
    seed([agentMsg('m1', 'moderator', '开场：先定议程。', 0), agentMsg('m2', 'fact-checker', IDEAS, 0)])
    const { container } = render(
      <SceneStage group={GROUP_RT} participants={[QI_GUAN, SHANG_ZHEN, FANG_HENG, YUN_ZHONG]}>
        <div data-testid="stream-child">对话流</div>
      </SceneStage>,
    )
    expect(container.querySelector('.scene-seat-ring')).not.toBeNull()

    // 收起：迷你条（小头像堆叠 + 展开钮），席位环与议程条卸载
    fireEvent.click(screen.getByTitle('收起席位环与议程'))
    const mini = container.querySelector('.scene-rt-top-mini')
    expect(mini).not.toBeNull()
    expect(container.querySelector('.scene-seat-ring')).toBeNull()
    expect(mini!.querySelector('.scene-rt-mini-seat')).not.toBeNull()

    // 展开恢复
    fireEvent.click(screen.getByTitle('展开席位环与议程'))
    expect(container.querySelector('.scene-rt-top-mini')).toBeNull()
    expect(container.querySelector('.scene-seat-ring')).not.toBeNull()
  })
})

// ---------- M42：议题进度容器化（RT-3） ----------

describe('M42 议题进度容器化（RT-3：容器更新优先 / 本地勾选兜底 / 点击定位）', () => {
  const DECLARE = ['开场：先定议程。', '::: meeting 议题圆桌', '- 议题一：先发散', '- 议题二：再收敛', ':::'].join('\n')
  const PROGRESS = [
    '议题一：先发散 已推进。',
    '::: meeting 议题圆桌',
    '- [x] 议题一：先发散',
    '- 补充议题：竞品对齐',
    ':::',
  ].join('\n')

  function seedMeeting(): void {
    useAgentStore.setState({ agents: [QI_GUAN, SHANG_ZHEN] })
    seed([agentMsg('m1', 'moderator', DECLARE, 0), agentMsg('m2', 'fact-checker', PROGRESS, 1)])
  }

  it('会议容器驱动：议题合并推进（回标覆盖）+ heading 摘要；agenda 资产不再作数据源', () => {
    seedMeeting()
    const { container } = render(wrap(<RoundtableStage>{<div />}</RoundtableStage>, { ...makeCtx(), group: GROUP_RT }))
    // 议题来自容器（声明的两项 + 更新容器新加的一项，按首见顺序）
    const steps = container.querySelectorAll('.scene-ag-step')
    expect([...steps].map((s) => s.querySelector('.scene-ag-label')?.textContent)).toEqual([
      '议题一：先发散',
      '议题二：再收敛',
      '补充议题：竞品对齐',
    ])
    expect(container.textContent).not.toContain('组织议题研讨')
    // 容器回标：议题一 done → 进度 1/3，当前 = 首个未决项
    expect(container.querySelector('.scene-ag-done')?.textContent).toContain('议题一：先发散')
    expect(container.querySelector('[data-ag-heading]')?.textContent).toBe('议题 1/3 · 当前：议题二：再收敛')
  })

  it('点击议题 → 定位首条含头词的成员发言（新议题落提出者消息；声明议题回会议声明）', () => {
    seedMeeting()
    const focus = vi.fn()
    const { container } = render(wrap(<RoundtableStage>{<div />}</RoundtableStage>, { ...makeCtx(() => {}, focus), group: GROUP_RT }))
    const steps = container.querySelectorAll('.scene-ag-step')
    // 「补充议题」只在 m2（更新容器）出现 → 定位 m2；「议题二」首现在 m1（会议声明）
    fireEvent.click(steps[2]!)
    expect(focus).toHaveBeenLastCalledWith('m2')
    fireEvent.click(steps[1]!)
    expect(focus).toHaveBeenLastCalledWith('m1')
    // 会议容器存在时不走回填路线
    expect(focus).toHaveBeenCalledTimes(2)
  })

  it('本地勾选兜底：容器未标记 + 本地已决 → 进度推进（容器显式态优先于本地）', () => {
    act(() => toggleMeetingCheck('sa', '议题二：再收敛'))
    seedMeeting()
    const { container } = render(wrap(<RoundtableStage>{<div />}</RoundtableStage>, { ...makeCtx(), group: GROUP_RT }))
    expect(container.querySelector('[data-ag-heading]')?.textContent).toBe('议题 2/3 · 当前：补充议题：竞品对齐')
    // 容器显式 done 的「议题一」不会被本地取消影响（容器更新优先）
    expect(container.querySelector('.scene-ag-done')?.textContent).toContain('议题一：先发散')
    act(() => toggleMeetingCheck('sa', '议题二：再收敛'))
  })
})

// ---------- M52-D：席位发言流（arena 左右席投影） ----------

describe('M52-D 席位发言流（arena 左右席投影）', () => {
  it('derive.excerptOf：跳过围栏 / 容器 / 表格行，剥标记后取首段并截断', () => {
    const src = ['```ts', 'const x = 1', '```', '::: verdict 正方', ':::', '| a | b |', '- **要点**：远程办公[研究](https://x)支持专注。'].join('\n')
    expect(excerptOf(src)).toBe('要点：远程办公研究支持专注。')
    expect(excerptOf('# 标题行\n正文')).toBe('标题行')
    expect(excerptOf('a'.repeat(80))).toBe(`${'a'.repeat(56)}…`)
    expect(excerptOf('::: pan bazi 主盘\n:::')).toBe('')
  })

  it('arena：左席发言流 = 该席消息（最新在上 + 轮次徽标）；右席同步投影', () => {
    useAgentStore.setState({ agents: [LI_YAN, LI_FENG, MING_DUAN] })
    seed([
      agentMsg('m1', 'affirmative', '正方立论：远程办公提升专注。', 0),
      agentMsg('m2', 'negative', '反方回应：协作成本被低估。', 0),
      agentMsg('m3', 'affirmative', '正方回应：异步协作抵消成本。', 1),
    ])
    const { container } = render(
      <SceneStage group={GROUP_ARENA} participants={[LI_YAN, LI_FENG, MING_DUAN]}>
        <div data-testid="stream-child">对话流</div>
      </SceneStage>,
    )
    const items = container.querySelectorAll('.scene-arena-left .scene-side-item')
    expect(items).toHaveLength(2)
    // 最新在上：m3 在前
    expect(items[0]!.textContent).toContain('第 2 轮')
    expect(items[0]!.textContent).toContain('异步协作抵消成本')
    expect(items[1]!.textContent).toContain('第 1 轮')
    const rightItems = container.querySelectorAll('.scene-arena-right .scene-side-item')
    expect(rightItems).toHaveLength(1)
    expect(rightItems[0]!.textContent).toContain('协作成本被低估')
  })

  it('arena：点击条目 → focusMessage（定位原消息）', () => {
    useAgentStore.setState({ agents: [LI_YAN, LI_FENG, MING_DUAN] })
    seed([agentMsg('m1', 'affirmative', '正方立论。', 0), agentMsg('m2', 'affirmative', '正方再申。', 1)])
    const { container } = render(
      <SceneStage group={GROUP_ARENA} participants={[LI_YAN, LI_FENG, MING_DUAN]}>
        <div data-testid="stream-child">对话流</div>
      </SceneStage>,
    )
    fireEvent.click(container.querySelector('.scene-arena-left .scene-side-item')!)
    expect(useUiStore.getState().focusRequest?.id).toBe('m2')
  })

  it('arena：该席无消息 → 空态提示；空席位 → 不渲染发言流', () => {
    useAgentStore.setState({ agents: [LI_YAN, LI_FENG, MING_DUAN] })
    seed([agentMsg('m1', 'affirmative', '正方立论。', 0)])
    const { container, unmount } = render(
      <SceneStage group={GROUP_ARENA} participants={[LI_YAN, LI_FENG, MING_DUAN]}>
        <div data-testid="stream-child">对话流</div>
      </SceneStage>,
    )
    const right = container.querySelector('.scene-arena-right')!
    expect(right.querySelector('.scene-side-empty')!.textContent).toContain('该席发言将显示在这里')
    unmount()
    // 零编制（成员不在场）：左右席栏保持空（结构干净，不注入发言流）
    useAgentStore.setState({ agents: [] })
    seed([])
    const r2 = render(
      <SceneStage group={GROUP_ARENA} participants={[]}>
        <div data-testid="stream-child">对话流</div>
      </SceneStage>,
    )
    expect(r2.container.querySelector('.scene-arena-left')!.childElementCount).toBe(0)
  })
})

// ---------- M58：面板就绪判定（无数据不展示的单一口径） ----------

describe('M58 panelReady（六面板就绪口径）', () => {
  const data = (messages: ChatMessage[]): Parameters<typeof panelReady>[1] => ({
    containers: containersOf(messages),
    verdicts: verdictsOf(messages),
    messages,
  })

  it('chartboard：有 `::: pan` 盘面容器或 `::: cards` 牌阵容器才就绪', () => {
    expect(panelReady('chartboard', data([]))).toBe(false)
    expect(panelReady('chartboard', data([agentMsg('m1', 'a', '纯文本')]))).toBe(false)
    expect(panelReady('chartboard', data([agentMsg('m1', 'a', IDEAS)]))).toBe(false)
    expect(panelReady('chartboard', data([agentMsg('m1', 'a', PAN_MAIN)]))).toBe(true)
    // M69 塔罗牌阵台：tarot 场景无 pan 卡，`::: cards` 亦构成就绪
    const CARDS = [
      '::: cards 三张牌阵',
      '- 过去 | 死神 | 逆位 | 结束 · 转化',
      '- 现在 | 命运之轮 | 正位 | 转机 · 周期',
      ':::',
    ].join('\n')
    expect(panelReady('chartboard', data([agentMsg('m1', 'a', CARDS)]))).toBe(true)
  })

  it('pool：存在「有结构化行或带标题」的容器卡才就绪', () => {
    expect(panelReady('pool', data([]))).toBe(false)
    expect(panelReady('pool', data([agentMsg('m1', 'a', '纯文本')]))).toBe(false)
    // 仅标题（arg 非空、无行）也算卡（与 PoolPanel 卡 total/标题口径一致）
    expect(panelReady('pool', data([agentMsg('m1', 'a', ['::: ideas 点子池', ':::'].join('\n'))]))).toBe(true)
    expect(panelReady('pool', data([agentMsg('m1', 'a', IDEAS)]))).toBe(true)
  })

  it('versus：有 `::: verdict` 裁决实例才就绪', () => {
    expect(panelReady('versus', data([agentMsg('m1', 'a', '纯文本')]))).toBe(false)
    const V = ['::: verdict 空方领先', '- 核心依据 | 三周期空头未破坏', ':::'].join('\n')
    expect(panelReady('versus', data([agentMsg('m1', 'a', V)]))).toBe(true)
  })

  it('board：成员消息带 Markdown 标题或存在交付件才就绪', () => {
    expect(panelReady('board', data([]))).toBe(false)
    expect(panelReady('board', data([agentMsg('m1', 'a', '无标题正文')]))).toBe(false)
    expect(panelReady('board', data([agentMsg('m1', 'a', '# 需求\n正文')]))).toBe(true)
    const withArtifact: ChatMessage = { ...agentMsg('m1', 'a', '正文'), artifacts: ['docs/a.md'] }
    expect(panelReady('board', data([withArtifact]))).toBe(true)
  })

  it('console：成员消息（时间轴）/ 管道列 / 交付件任一非空即就绪', () => {
    expect(panelReady('console', data([]))).toBe(false)
    expect(panelReady('console', data([agentMsg('m1', 'a', '纯文本')]))).toBe(true)
    const K = ['::: kanban 管道', '- 卡其一 | 进行中', ':::'].join('\n')
    expect(panelReady('console', data([agentMsg('m1', 'a', K)]))).toBe(true)
  })

  it('coach：有 `::: checklist` 清单容器才就绪', () => {
    expect(panelReady('coach', data([agentMsg('m1', 'a', '纯文本')]))).toBe(false)
    const C = ['::: checklist 求职清单', '- [x] 一', '- 二', ':::'].join('\n')
    expect(panelReady('coach', data([agentMsg('m1', 'a', C)]))).toBe(true)
  })
})

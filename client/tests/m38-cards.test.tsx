/**
 * M38（§92）：研讨容器族测试。
 * - remark 纯函数：parseIdeaArg / ideaStatusOf / parseScoreLines（ICE 乘积口径 + 显式总分 + 降序）
 *   / parseSourceLines（五列 / 缺省列 / markdown 链接 / 域名）/ domainOf；
 * - 容器渲染：::: idea / phase / score / sources / decision（结构、状态徽章、分级色带）；
 * - 交互：点亮本地计数（sessionStorage 持久化）/ 深入 / 引用 / 确认拍板（composerInsert 回填）；
 * - fail-safe：未闭合容器内容展开（无壳）、无条目 raw 兜底；
 * - 汇聚板专业化：idea / score / sources / decision 同组件渲染 + 逐场景空态 + 点亮同步。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type * as React from 'react'
import type { AgentDefinition, AgentGroup, ChatMessage } from '@multi-agent/shared'
import { Markdown } from '../src/components/chat/Markdown'
import { MessageContext } from '../src/components/chat/md-ext/message-context'
import { parseDecisionFields } from '../src/components/chat/md-ext/DecisionCard'
import { parseIdeaFields } from '../src/components/chat/md-ext/IdeaCard'
import {
  domainOf,
  ideaStatusOf,
  parseIdeaArg,
  parseScoreLines,
  parseSourceLines,
} from '../src/components/chat/md-ext/remark-ext'
import { parseScores } from '../src/components/chat/md-ext/ScoreCard'
import { parseSources } from '../src/components/chat/md-ext/SourcesCard'
import { SceneContext, type SceneCtx } from '../src/components/scene/context'
import { PoolPanel } from '../src/components/scene/panels'
import { loadLights, lightsKey } from '../src/components/scene/persist'
import { useAgentStore } from '../src/stores/agent-store'
import { useSessionStore } from '../src/stores/session-store'
import { useUiStore } from '../src/stores/ui-store'

// ---------- fixtures ----------

const T0 = '2026-09-19T04:00:00.000Z'

function agentMsg(id: string, agentId: string, content: string): ChatMessage {
  return {
    id,
    sessionId: 'sa',
    role: 'agent',
    agentId,
    content,
    mentions: [],
    status: 'complete',
    createdAt: T0,
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

const LUNA: AgentDefinition = {
  id: 'ideator',
  name: '卢娜',
  role: '狂想发散者',
  title: '',
  description: '',
  capabilities: [],
  group: 'brainstorm',
  avatar: { gradient: ['#f59e0b', '#fbbf24'], icon: 'sparkles' },
  handoff: [],
}

const BRAINSTORM: AgentGroup = {
  id: 'brainstorm',
  name: '头脑风暴',
  description: '',
  icon: 'lightbulb',
  theme: ['#f59e0b', '#fbbf24'],
  objective: '',
  chain: [],
  defaultSkills: [],
  parallel: true,
  rounds: true,
  order: 20,
}

function makeCtx(over: Partial<SceneCtx> = {}): SceneCtx {
  return {
    sessionId: 'sa',
    stage: { layout: 'roundtable', panel: 'pool', parts: [], fallback: false },
    participants: [LUNA],
    narrow: false,
    waitingIds: [],
    insert: () => {},
    focus: () => {},
    agentOf: (id) => (id === 'ideator' ? LUNA : undefined),
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
  sessionStorage.clear()
  useAgentStore.setState({ agents: [LUNA], groups: [BRAINSTORM], skills: [], loaded: true, loading: false, statuses: {} })
  useSessionStore.setState({ currentId: 'sa', byId: new Map(), order: [] })
  useUiStore.setState({ composerInsert: undefined })
})

// ---------- remark 纯函数 ----------

describe('M38 纯函数：idea / score / sources 解析', () => {
  it('parseIdeaArg：编号可选（数字 + 标题 / 纯标题）', () => {
    expect(parseIdeaArg('3 免登录体验')).toEqual({ no: '3', title: '免登录体验' })
    expect(parseIdeaArg('未来向导')).toEqual({ title: '未来向导' })
    expect(parseIdeaArg('')).toEqual({ title: '' })
  })

  it('ideaStatusOf：状态字段 → 语义键；未知词 → none', () => {
    expect(ideaStatusOf([{ label: '状态', value: '入选' }])).toBe('chosen')
    expect(ideaStatusOf([{ label: '状态', value: '被毙' }])).toBe('rejected')
    expect(ideaStatusOf([{ label: '状态', value: '待定' }])).toBe('none')
    expect(ideaStatusOf([])).toBe('none')
  })

  it('parseScoreLines：ICE 乘积口径 + 显式总分 + 降序 + 无效行忽略', () => {
    const entries = parseScoreLines([
      '- 方案 B | 影响 6 | 信心 8 | 易度 5',
      '- 方案 A | 影响 8 | 信心 5 | 易度 7',
      '- 方案 C | 影响 7 | 信心 4 | 易度 6 | 总分 150',
      '- 无评分行',
      '',
    ])
    expect(entries.map((e) => e.name)).toEqual(['方案 A', '方案 B', '方案 C'])
    expect(entries.map((e) => e.total)).toEqual([280, 240, 150]) // 8×5×7 与 6×8×5 乘积；C 显式总分优先
    expect(entries[0]!.parts).toEqual([
      { label: '影响', value: 8 },
      { label: '信心', value: 5 },
      { label: '易度', value: 7 },
    ])
  })

  it('parseSourceLines：五列 / 缺省列 / markdown 链接 / 等级词容错', () => {
    const items = parseSourceLines([
      '- 互联网络报告 | https://www.cnnic.net.cn/report | 2026-08-30 | 网民结构数据 | 高',
      '- 行业白皮书（内部） | | 2026-09-01 | 市场规模测算 | 中',
      '- [官方统计口径](https://stats.gov.cn/2026) | 低可信',
      '- 裸标题来源',
    ])
    expect(items).toHaveLength(4)
    expect(items[0]).toMatchObject({ title: '互联网络报告', domain: 'cnnic.net.cn', date: '2026-08-30', level: 'high' })
    expect(items[0]!.note).toBe('网民结构数据')
    expect(items[1]).toMatchObject({ url: '', date: '2026-09-01', level: 'mid' })
    expect(items[2]).toMatchObject({ title: '官方统计口径', url: 'https://stats.gov.cn/2026', domain: 'stats.gov.cn', level: 'low' })
    expect(items[3]).toMatchObject({ title: '裸标题来源', level: 'none', note: '' })
  })

  it('domainOf：去 www / 非 URL → 空串', () => {
    expect(domainOf('https://www.example.com/a/b')).toBe('example.com')
    expect(domainOf('example.com')).toBe('')
    expect(domainOf('')).toBe('')
  })

  it('卡片侧 JSON 解析：非法输入 → 空数组（raw 兜底路径）', () => {
    expect(parseIdeaFields('oops')).toEqual([])
    expect(parseDecisionFields('{"a":1}')).toEqual([])
    expect(parseScores('nope')).toEqual([])
    expect(parseSources('[]')).toEqual([])
  })
})

// ---------- 容器渲染 ----------

const IDEA = ['::: idea 3 免登录体验', '一句话：不注册也能先玩三分钟', '状态：候选', 'ICE：8.5', ':::'].join('\n')

describe('点子卡（::: idea）', () => {
  it('结构：编号 / 标题 / 状态徽章 / 字段（状态不重复）/ 点亮与深入入口', () => {
    const { container } = render(wrapMd('m38-idea', 'm1', <Markdown content={IDEA} />))
    const card = container.querySelector('.md-idea[data-idea-card]')!
    expect(card.querySelector('.md-idea-no')?.textContent).toBe('3')
    expect(card.querySelector('.md-idea-title')?.textContent).toBe('免登录体验')
    expect(card.querySelector('.md-idea-status')?.textContent).toBe('候选')
    expect(card.textContent).toContain('一句话')
    expect(card.textContent).toContain('不注册也能先玩三分钟')
    expect(card.querySelector('.md-idea-light')).toBeTruthy()
    expect(card.querySelector('.md-idea-dig')).toBeTruthy()
  })

  it('点亮：本地计数写入 sessionStorage（ma:sc:lights），再点取消', () => {
    const { container } = render(wrapMd('m38-idea-lit', 'm1', <Markdown content={IDEA} />))
    const btn = container.querySelector('.md-idea-light')!
    fireEvent.click(btn)
    expect(container.querySelector('.md-idea-light')?.textContent).toContain('已点亮')
    expect([...loadLights('m38-idea-lit')]).toEqual(['m1:3:免登录体验'])
    fireEvent.click(container.querySelector('.md-idea-light')!)
    expect([...loadLights('m38-idea-lit')]).toEqual([])
  })

  it('点「深入」→ composerInsert 草稿（只写草稿不直发）', () => {
    const { container } = render(wrapMd('m38-idea-dig', 'm1', <Markdown content={IDEA} />))
    fireEvent.click(container.querySelector('.md-idea-dig')!)
    expect(useUiStore.getState().composerInsert?.text).toContain('请深入展开点子「免登录体验」')
  })

  it('fail-safe：未闭合 idea 容器内容展开（无卡壳、内容保留）', () => {
    const broken = ['::: idea 9 未完', '一句话：半截内容'].join('\n')
    const { container } = render(<Markdown content={broken} />)
    expect(container.querySelector('.md-idea[data-idea-card]')).toBeNull()
    expect(container.textContent).toContain('一句话：半截内容')
  })
})

describe('阶段条（::: phase）', () => {
  it('发散 → 暖色；收敛 → 冷色；标题保留', () => {
    const warm = render(<Markdown content={'::: phase 发散期\n:::'} />)
    expect(warm.container.querySelector('.md-phase-warm[data-phase-bar]')).toBeTruthy()
    expect(warm.container.textContent).toContain('发散期')
    warm.unmount()
    const cool = render(<Markdown content={'::: phase 收敛期\n:::'} />)
    expect(cool.container.querySelector('.md-phase-cool')).toBeTruthy()
  })
})

describe('评分卡（::: score）', () => {
  const SCORE = ['::: score ICE 评分', '- 盲盒引导页 | 影响 8 | 信心 5 | 易度 7', '- 老用户召回 | 影响 6 | 信心 8 | 易度 5', ':::'].join('\n')

  it('按总分降序 + 子项与总分展示 + 条形宽度按最大值归一', () => {
    const { container } = render(<Markdown content={SCORE} />)
    const card = container.querySelector('.md-score[data-score-card]')!
    const rows = card.querySelectorAll('.md-score-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.querySelector('.md-score-name')?.textContent).toContain('盲盒引导页')
    expect(rows[0]!.querySelector('.md-score-total')?.textContent).toContain('280')
    const bars = card.querySelectorAll<HTMLElement>('.md-score-bar > span')
    expect(bars[0]!.style.width).toBe('100%')
    expect(bars[1]!.style.width).toBe('86%') // 240/280
  })

  it('无有效条目 → raw 兜底静态渲染', () => {
    const { container } = render(<Markdown content={'::: score\n- 纯文字没有评分\n:::'} />)
    expect(container.querySelector('.md-score[data-score-card]')).toBeNull()
    expect(container.textContent).toContain('纯文字没有评分')
  })
})

describe('来源卡组（::: sources）', () => {
  const SOURCES = [
    '::: sources 来源清单',
    '- 互联网络报告 | https://www.cnnic.net.cn/report | 2026-08-30 | 网民结构数据 | 高',
    '- 行业白皮书（内部） | | 2026-09-01 | 市场规模测算 | 中',
    ':::',
  ].join('\n')

  it('结构：链接 / 域名 chip / 日期 / 可信度徽章 / 要点', () => {
    const { container } = render(wrapMd('m38-src', 'm2', <Markdown content={SOURCES} />))
    const card = container.querySelector('.md-sources[data-sources-card]')!
    const link = card.querySelector<HTMLAnchorElement>('a.md-source-title')!
    expect(link.getAttribute('href')).toBe('https://www.cnnic.net.cn/report')
    expect(card.textContent).toContain('cnnic.net.cn')
    expect(card.querySelector('.md-source-level.is-high')?.textContent).toBe('高可信')
    expect(card.querySelector('.md-source-level.is-mid')?.textContent).toBe('中可信')
    expect(card.textContent).toContain('市场规模测算')
  })

  it('点「引用」→ composerInsert 草稿（含标题与 URL）', () => {
    const { container } = render(wrapMd('m38-src-quote', 'm2', <Markdown content={SOURCES} />))
    fireEvent.click(container.querySelector('.md-source-quote')!)
    const text = useUiStore.getState().composerInsert?.text ?? ''
    expect(text).toContain('引用来源《互联网络报告》')
    expect(text).toContain('https://www.cnnic.net.cn/report')
  })
})

describe('决议卡（::: decision）', () => {
  const DECISION = ['::: decision 增长实验先行', '背景：品牌投放 ROI 走低', '决策：本周先投增长实验', '后果：流量波动，设 -8% 止损线', ':::'].join('\n')

  it('三要素按 背景 → 决策 → 后果 排序渲染', () => {
    const { container } = render(wrapMd('m38-dec', 'm3', <Markdown content={DECISION} />))
    const card = container.querySelector('.md-decision[data-decision-card]')!
    const keys = [...card.querySelectorAll('.md-decision-k')].map((k) => k.textContent)
    expect(keys).toEqual(['背景', '决策', '后果'])
    expect(card.querySelector('.md-decision-title')?.textContent).toBe('增长实验先行')
  })

  it('点「确认拍板」→ composerInsert 草稿', () => {
    const { container } = render(wrapMd('m38-dec-fill', 'm3', <Markdown content={DECISION} />))
    fireEvent.click(container.querySelector('.md-decision-confirm')!)
    expect(useUiStore.getState().composerInsert?.text).toContain('确认拍板：《增长实验先行》')
  })
})

// ---------- 汇聚板专业化 ----------

const PANEL_IDEA = ['::: idea 1 双周冲刺', '一句话：两周一个可演示版本', '状态：入选', ':::'].join('\n')
const PANEL_SCORE = ['::: score ICE 评分', '- 双周冲刺 | 影响 8 | 信心 5 | 易度 7', ':::'].join('\n')
const PANEL_SOURCES = ['::: sources 来源清单', '- 报告 A | https://a.example.com/r | 2026-09-01 | 要点 | 高', ':::'].join('\n')
const PANEL_DECISION = ['::: decision 实验先行', '背景：投放 ROI 走低', '决策：先投实验', ':::'].join('\n')

describe('汇聚板专业化（M38）', () => {
  it('idea / score / sources / decision → 专业化卡片（与消息内同组件）', () => {
    seed([
      agentMsg('m1', 'ideator', PANEL_IDEA),
      agentMsg('m2', 'refiner', PANEL_SCORE),
      agentMsg('m3', 'ideator', PANEL_SOURCES),
      agentMsg('m4', 'ideator', PANEL_DECISION),
    ])
    const { container } = render(wrap(<PoolPanel />))
    expect(container.querySelector('.md-idea[data-idea-card]')).toBeTruthy()
    expect(container.querySelector('.md-score[data-score-card]')).toBeTruthy()
    expect(container.querySelector('.md-sources[data-sources-card]')).toBeTruthy()
    expect(container.querySelector('.md-decision[data-decision-card]')).toBeTruthy()
    expect(container.querySelectorAll('.scene-pool-card-special')).toHaveLength(4)
    expect(container.textContent).toContain('入选')
  })

  it('面板内点亮 → 与消息卡同源键持久化（ma:sc:lights）', () => {
    seed([agentMsg('m1', 'ideator', PANEL_IDEA)])
    const { container } = render(wrap(<PoolPanel />, makeCtx({ sessionId: 'm38-panel-lit' })))
    fireEvent.click(container.querySelector('.md-idea-light')!)
    expect(container.querySelector('.md-idea-light')?.textContent).toContain('已点亮')
    expect([...loadLights('m38-panel-lit')]).toEqual(['m1:1:双周冲刺'])
    expect(typeof lightsKey('m38-panel-lit')).toBe('string')
  })

  it('逐场景空态文案（brainstorm / research / strategy / society + 中性默认）', () => {
    const cases: Array<[string, string]> = [
      ['brainstorm', '点子将汇聚在这里'],
      ['research', '来源与证据将汇聚在这里'],
      ['strategy', '决议与矩阵将汇聚在这里'],
      ['society', '立场与事实将汇聚在这里'],
      ['marketing', '研讨产物将汇聚在这里'],
    ]
    for (const [gid, text] of cases) {
      const group: AgentGroup = { ...BRAINSTORM, id: gid }
      const r = render(wrap(<PoolPanel />, makeCtx({ group })))
      expect(r.getByText(text)).toBeTruthy()
      r.unmount()
    }
  })

  it('相位容器不入面板卡墙（消息流分隔条语义）', () => {
    seed([agentMsg('m1', 'ideator', '::: phase 发散期\n:::')])
    const { container } = render(wrap(<PoolPanel />, makeCtx({ group: BRAINSTORM })))
    expect(container.querySelector('.scene-pool-card-special')).toBeNull()
    expect(screen.getByText('点子将汇聚在这里')).toBeTruthy()
  })
})

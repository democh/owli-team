/**
 * M69：场景玩法容器测试（::: roll 骰卡 / ::: cards 牌阵卡 / ::: sim 回合结算卡）。
 * - remark 渲染链：容器分派 + data 属性（seed / 牌阵 / 回合）；
 * - 纯函数：parseRoll / parseCards / parseSim（宽松解析与容错）；
 * - 交互：再掷一次 / 深入解读 / 下个回合（composerInsert 回填草稿）；
 * - fail-safe：无字段无条目 → 不渲染结构化卡（raw 兜底、无壳）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import type * as React from 'react'
import type { AgentGroup, ChatMessage } from '@multi-agent/shared'
import { Markdown } from '../src/components/chat/Markdown'
import { MessageContext } from '../src/components/chat/md-ext/message-context'
import { parseRoll } from '../src/components/chat/md-ext/RollCard'
import { parseCards } from '../src/components/chat/md-ext/CardsCard'
import { parseSim } from '../src/components/chat/md-ext/SimCard'
import { SceneContext, type SceneCtx } from '../src/components/scene/context'
import { ChartboardPanel, PoolPanel } from '../src/components/scene/panels'
import { useAgentStore } from '../src/stores/agent-store'
import { useSessionStore } from '../src/stores/session-store'
import { useUiStore } from '../src/stores/ui-store'

function wrapMd(sid: string, messageId: string, ui: React.ReactElement): React.JSX.Element {
  return <MessageContext.Provider value={{ messageId, sessionId: sid }}>{ui}</MessageContext.Provider>
}

beforeEach(() => {
  sessionStorage.clear()
  useAgentStore.setState({ agents: [], groups: [], skills: [], loaded: true, loading: false, statuses: {} })
  useSessionStore.setState({ currentId: 'sa', byId: new Map(), order: [] })
  useUiStore.setState({ composerInsert: undefined })
})

const ROLL = ['::: roll 攀爬检定', '骰式：d20+3 | 种子：482910', '明细：15 | 修正：+3 | 总值：18', ':::'].join('\n')
const CARDS = [
  '::: cards 三张牌阵',
  '- 过去 | 死神 | 逆位 | 结束 · 转化 · 重生',
  '- 现在 | 命运之轮 | 正位 | 转机 · 周期 · 时机',
  '- 未来 | 星星 | 正位 | 希望 · 疗愈 · 指引',
  ':::',
].join('\n')
const SIM = [
  '::: sim 第 2 回合',
  '- 决策 | 降价 5% 换量 | 反馈 | 需求 +12% 但毛利承压 | 指标 | 营收 ↑3% · 现金 ↓2% · 市占 ↑1%',
  ':::',
].join('\n')

describe('M69 纯函数：roll / cards / sim 解析', () => {
  it('parseRoll：骰式 / 种子 / 骰面 / 修正 / 总值（宽松拆段）', () => {
    const parsed = parseRoll(JSON.stringify([
      { label: '骰式', value: 'd20+3 | 种子：482910' },
      { label: '明细', value: '15 | 修正：+3 | 总值：18' },
    ]))
    expect(parsed).toEqual({ formula: 'd20+3', seed: '482910', rolls: ['15'], modifier: '+3', total: '18' })
    expect(parseRoll(undefined)).toBeUndefined()
    expect(parseRoll('not-json')).toBeUndefined()
    expect(parseRoll('[]')).toBeUndefined()
  })

  it('parseCards：牌位 / 牌名 / 正逆位 / 关键词拆分', () => {
    const rows = parseCards(JSON.stringify([
      { label: '过去', value: '死神 | 逆位 | 结束 · 转化 · 重生' },
      { label: '现在', value: '命运之轮 | 正位 | 转机 / 周期 / 时机' },
    ]))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({ position: '过去', name: '死神', orientation: '逆位', keywords: ['结束', '转化', '重生'] })
    expect(rows[1]?.keywords).toEqual(['转机', '周期', '时机'])
    expect(parseCards('<<>>')).toEqual([])
  })

  it('parseSim：整行折叠为决策 / 反馈 / 指标三段', () => {
    const turns = parseSim(JSON.stringify([
      { label: '决策', value: '降价 5% 换量 | 反馈 | 需求 +12% 但毛利承压 | 指标 | 营收 ↑3% · 现金 ↓2% · 市占 ↑1%' },
    ]))
    expect(turns).toHaveLength(1)
    expect(turns[0]?.decision).toBe('降价 5% 换量')
    expect(turns[0]?.feedback).toBe('需求 +12% 但毛利承压')
    expect(turns[0]?.metrics).toEqual(['营收 ↑3%', '现金 ↓2%', '市占 ↑1%'])
    expect(parseSim('null')).toEqual([])
  })
})

describe('M69 渲染：::: roll 骰卡', () => {
  it('结构：骰面 / 总值 / 种子徽章', () => {
    const { container } = render(wrapMd('m69-roll', 'm1', <Markdown content={ROLL} />))
    const card = container.querySelector('.md-roll[data-roll-card]')
    expect(card).toBeTruthy()
    expect(container.textContent).toContain('攀爬检定')
    expect(container.textContent).toContain('种子 482910')
    expect(container.textContent).toContain('15')
    expect(container.textContent).toContain('18')
  })

  it('点「再掷一次」→ 新种子重掷草稿；点「复现本次」→ 同种子草稿', () => {
    const first = render(wrapMd('m69-roll-2', 'm1', <Markdown content={ROLL} />))
    fireEvent.click(first.container.querySelector('.md-roll-again')!)
    const again = useUiStore.getState().composerInsert?.text ?? ''
    expect(again).toContain('重掷')
    expect(again).toContain('d20+3')
    expect(again).toContain('换新种子')
    first.unmount()
    const second = render(wrapMd('m69-roll-3', 'm1', <Markdown content={ROLL} />))
    fireEvent.click(second.container.querySelector('.md-roll-replay')!)
    expect(useUiStore.getState().composerInsert?.text).toContain('482910')
  })

  it('fail-safe：无字段容器不渲染结构化卡', () => {
    const { container } = render(<Markdown content={'::: roll 空卡\n:::'} />)
    expect(container.querySelector('.md-roll[data-roll-card]')).toBeNull()
  })
})

describe('M69 渲染：::: cards 牌阵卡', () => {
  it('结构：三张牌行 + 逆位行标记', () => {
    const { container } = render(wrapMd('m69-cards', 'm2', <Markdown content={CARDS} />))
    expect(container.querySelector('.md-cards[data-cards-card]')).toBeTruthy()
    const rows = container.querySelectorAll('.md-card-row')
    expect(rows).toHaveLength(3)
    expect(rows[0]?.className).toContain('md-card-row-rev')
    expect(container.textContent).toContain('死神')
    expect(container.textContent).toContain('命运之轮')
    expect(container.textContent).toContain('3 张')
  })

  it('点「深入解读这组牌」→ composerInsert 草稿', () => {
    const { container } = render(wrapMd('m69-cards-2', 'm2', <Markdown content={CARDS} />))
    fireEvent.click(container.querySelector('.md-cards-enter')!)
    expect(useUiStore.getState().composerInsert?.text).toContain('深入解读这组牌')
  })

  it('点「重抽一组」→ composerInsert 草稿（新种子）', () => {
    const { container } = render(wrapMd('m69-cards-3', 'm2', <Markdown content={CARDS} />))
    fireEvent.click(container.querySelector('.md-cards-redraw')!)
    expect(useUiStore.getState().composerInsert?.text).toContain('重抽')
  })
})

describe('M69 渲染：::: sim 回合结算卡', () => {
  it('结构：三段 + 指标 chips', () => {
    const { container } = render(wrapMd('m69-sim', 'm3', <Markdown content={SIM} />))
    expect(container.querySelector('.md-sim[data-sim-card]')).toBeTruthy()
    expect(container.textContent).toContain('第 2 回合')
    expect(container.textContent).toContain('降价 5% 换量')
    expect(container.textContent).toContain('需求 +12% 但毛利承压')
    expect(container.querySelectorAll('.md-sim-chip')).toHaveLength(3)
  })

  it('点「下个回合」→ composerInsert 草稿', () => {
    const { container } = render(wrapMd('m69-sim-2', 'm3', <Markdown content={SIM} />))
    fireEvent.click(container.querySelector('.md-sim-next')!)
    expect(useUiStore.getState().composerInsert?.text).toContain('下一个回合')
  })

  it('fail-safe：无条目容器不渲染结构化卡', () => {
    const { container } = render(<Markdown content={'::: sim 空回合\n:::'} />)
    expect(container.querySelector('.md-sim[data-sim-card]')).toBeNull()
  })
})

// ---------- M69 面板：tarot 牌阵台（chartboard cards 区） ----------

const TAROT: AgentGroup = {
  id: 'tarot',
  name: '塔罗研习',
  description: '',
  icon: 'moon',
  theme: ['#3b0764', '#d8b4fe'],
  objective: '',
  chain: [],
  defaultSkills: [],
  parallel: true,
  rounds: false,
  order: 134,
}

function tarotCtx(over: Partial<SceneCtx> = {}): SceneCtx {
  return {
    sessionId: 'sa',
    group: TAROT,
    stage: { layout: 'dock', panel: 'chartboard', parts: [], fallback: false },
    participants: [],
    narrow: false,
    waitingIds: [],
    insert: () => {},
    focus: () => {},
    agentOf: () => undefined,
    ...over,
  }
}

function seedCards(content: string, agentId = 'tarot-reader'): void {
  const m: ChatMessage = {
    id: 'c1',
    sessionId: 'sa',
    role: 'agent',
    agentId,
    content,
    mentions: [],
    status: 'complete',
    createdAt: '2026-09-19T04:00:00.000Z',
  }
  useSessionStore.setState({ currentId: 'sa', byId: new Map([[m.id, m]]), order: [m.id] })
}

describe('M69 面板：tarot 牌阵台（chartboard cards 区）', () => {
  it('cards 容器 → 牌阵台（is-3 布局）+ 点牌高亮 + 无摇卦 + 计数徽章', () => {
    seedCards(CARDS)
    const { container } = render(
      <SceneContext.Provider value={tarotCtx()}>
        <ChartboardPanel />
      </SceneContext.Provider>,
    )
    const board = container.querySelector('.scene-cards-board[data-cards-board="is-3"]')
    expect(board).toBeTruthy()
    const tiles = container.querySelectorAll('.scene-card-tile')
    expect(tiles).toHaveLength(3)
    expect(container.querySelector('.pn-toss-enter')).toBeNull()
    expect(container.querySelector('.scene-panel-count')?.textContent).toBe('1')
    // 点牌高亮 + 关键词横幅（再点收起）
    fireEvent.click(tiles[0]!)
    expect(container.querySelectorAll('.scene-card-tile.is-active')).toHaveLength(1)
    expect(container.querySelector('.scene-cards-keys')?.textContent).toContain('死神')
    expect(container.querySelector('.scene-cards-keys')?.textContent).toContain('转化')
    fireEvent.click(tiles[0]!)
    expect(container.querySelector('.scene-cards-keys')).toBeNull()
  })

  it('点「重抽一组」/「深入解读」→ ctx.insert 回填草稿', () => {
    seedCards(CARDS)
    const captured: string[] = []
    const { container } = render(
      <SceneContext.Provider value={tarotCtx({ insert: (t) => captured.push(t) })}>
        <ChartboardPanel />
      </SceneContext.Provider>,
    )
    fireEvent.click(container.querySelector('.scene-cards-board-foot .md-cards-redraw')!)
    expect(captured[0]).toContain('重抽')
    fireEvent.click(container.querySelector('.scene-cards-board-foot .md-cards-enter')!)
    expect(captured[1]).toContain('深入解读这组牌')
  })

  it('tarot 空态牌阵文案且无摇卦；metaphysics 空态保留摇卦入口', () => {
    const a = render(
      <SceneContext.Provider value={tarotCtx()}>
        <ChartboardPanel />
      </SceneContext.Provider>,
    )
    expect(a.container.textContent).toContain('对话中抽出的牌阵将显示在这里')
    expect(a.container.querySelector('.pn-toss-enter')).toBeNull()
    a.unmount()
    const b = render(
      <SceneContext.Provider value={tarotCtx({ group: { ...TAROT, id: 'metaphysics' } })}>
        <ChartboardPanel />
      </SceneContext.Provider>,
    )
    expect(b.container.textContent).toContain('对话中产生的盘面将显示在这里')
    expect(b.container.querySelector('.pn-toss-enter')).toBeTruthy()
  })
})

// ---------- M69 面板：trpg 汇聚板骰子记录段 ----------

const TRPG: AgentGroup = { ...TAROT, id: 'trpg', name: '跑团工坊', icon: 'sparkles', order: 132, parallel: false }

function trpgCtx(over: Partial<SceneCtx> = {}): SceneCtx {
  return tarotCtx({ group: TRPG, stage: { layout: 'roundtable', panel: 'pool', parts: [], fallback: false }, ...over })
}

describe('M69 面板：trpg 汇聚板骰子记录段', () => {
  it('roll 容器 → 骰子记录条目（骰式 = 总值 · 种子）', () => {
    seedCards(ROLL, 'gm-host')
    const { container } = render(
      <SceneContext.Provider value={trpgCtx()}>
        <PoolPanel />
      </SceneContext.Provider>,
    )
    const sec = container.querySelector('[data-pool-rolls]')
    expect(sec).toBeTruthy()
    expect(sec?.textContent).toContain('攀爬检定')
    expect(sec?.textContent).toContain('d20+3 = 18')
    expect(sec?.textContent).toContain('种子 482910')
  })
})

// ---------- M69 面板：philosophy 论点池（claim 专业化） ----------

const CLAIM_FIX = [
  '::: claim 程序正义是对权力的可预期约束',
  '细节：程序让权力可被预见',
  '视角：法理',
  '倾向：多方',
  '置信度：高',
  '- 论据 | 程序约束权力 | 《宪法学》',
  '- 论据 | 历史教训 | 案例集',
  ':::',
].join('\n')

const PHILO: AgentGroup = { ...TRPG, id: 'philosophy', name: '哲学茶室', order: 140 }

function philoCtx(over: Partial<SceneCtx> = {}): SceneCtx {
  return trpgCtx({ group: PHILO, ...over })
}

describe('M69 面板：philosophy 论点池（claim 专业化）', () => {
  it('claim 容器 → ClaimCard（扩展字段 + 论据），不再走通用卡墙', () => {
    seedCards(CLAIM_FIX, 'socratic-host')
    const { container } = render(
      <SceneContext.Provider value={philoCtx()}>
        <PoolPanel />
      </SceneContext.Provider>,
    )
    expect(container.querySelector('.md-claim')).toBeTruthy()
    expect(container.querySelector('.scene-pool-card-special')).toBeTruthy()
    expect(container.textContent).toContain('程序正义')
    expect(container.textContent).toContain('法理')
    expect(container.textContent).toContain('多方')
  })
})

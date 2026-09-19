/**
 * M40（§104）：陪跑渲染包测试。
 * - habit 纯函数：本地日期 / 周网格（周一锚定）/ streak（今天或昨天起算、断签）/ toggle / 读写容错；
 * - 解析器：tracks / quiz / goals（万后缀）/ ledger（脏值不猜）/ itinerary / numberWithSuffix；
 * - 卡片：三轨打卡（点格落盘 + streak 徽标 + 进度环）/ 每日一练（点选 + 提交回填）/ 情绪签到（档位 + 回填）/
 *   目标环（百分比）/ 流水（负数着色）/ 行程（按天分组 + 今天高亮）；fail-safe 未闭合展开。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import type * as React from 'react'
import { Markdown } from '../src/components/chat/Markdown'
import { MessageContext } from '../src/components/chat/md-ext/message-context'
import {
  loadHabit,
  localDateOf,
  shiftDate,
  streakOf,
  toggleHabitDay,
  weekDatesOf,
} from '../src/lib/habit'
import { moodDraft } from '../src/components/chat/md-ext/MoodCard'
import {
  numberWithSuffix,
  parseGoalLines,
  parseItineraryLines,
  parseLedgerLines,
  parseQuizLines,
  parseTrackLines,
} from '../src/components/chat/md-ext/remark-ext'
import { dayLabelOf, groupByDay } from '../src/components/chat/md-ext/ItineraryCard'
import { useUiStore } from '../src/stores/ui-store'

function wrapMd(ui: React.ReactElement): React.JSX.Element {
  return <MessageContext.Provider value={{ messageId: 'm1', sessionId: 'sa' }}>{ui}</MessageContext.Provider>
}

beforeEach(() => {
  localStorage.clear()
  useUiStore.setState({ composerInsert: undefined, quietMode: true, mainTab: 'chat' })
})

// ---------- habit 纯函数 ----------

describe('M40 habit：本地日期与 streak 口径', () => {
  it('localDateOf / shiftDate / weekDatesOf：本地日期与周一锚定', () => {
    const d = new Date(2026, 8, 19) // 2026-09-19 周六
    expect(localDateOf(d)).toBe('2026-09-19')
    expect(shiftDate('2026-09-19', -1)).toBe('2026-09-18')
    expect(shiftDate('2026-09-30', 1)).toBe('2026-10-01')
    expect(weekDatesOf('2026-09-19')).toEqual([
      '2026-09-14',
      '2026-09-15',
      '2026-09-16',
      '2026-09-17',
      '2026-09-18',
      '2026-09-19',
      '2026-09-20',
    ])
  })

  it('streakOf：今天起算 / 昨天起算 / 断签归零', () => {
    expect(streakOf([], '2026-09-19')).toBe(0)
    expect(streakOf(['2026-09-19'], '2026-09-19')).toBe(1)
    expect(streakOf(['2026-09-18', '2026-09-17'], '2026-09-19')).toBe(2)
    expect(streakOf(['2026-09-19', '2026-09-18', '2026-09-16'], '2026-09-19')).toBe(2)
    expect(streakOf(['2026-09-15'], '2026-09-19')).toBe(0)
  })

  it('toggleHabitDay：增删 / 空集合清键 / 落盘容错读取', () => {
    const a = toggleHabitDay({}, '训练', '2026-09-19')
    expect(a).toEqual({ 训练: ['2026-09-19'] })
    const b = toggleHabitDay(a, '训练', '2026-09-19')
    expect(b).toEqual({})
    localStorage.setItem('ma:habit:sa', JSON.stringify({ 训练: ['2026-09-19', 'oops', 3], 饮食: 'bad' }))
    expect(loadHabit('sa')).toEqual({ 训练: ['2026-09-19'] })
    localStorage.setItem('ma:habit:bad', 'not-json')
    expect(loadHabit('bad')).toEqual({})
  })
})

// ---------- 解析器 ----------

describe('M40 解析器', () => {
  it('tracks / quiz / goals / ledger / itinerary 行解析（缺省列容错）', () => {
    expect(parseTrackLines(['- 训练 | 跑步 3 公里', '- 睡眠'])).toEqual([
      { track: '训练', plan: '跑步 3 公里' },
      { track: '睡眠', plan: '' },
    ])
    expect(parseQuizLines(['- A | 选项一', '- B'])).toEqual([
      { key: 'A', text: '选项一' },
      { key: 'B', text: '' },
    ])
    const goals = parseGoalLines(['- 应急金 | 2.4 | 6', '- 旅行基金 | 8000 | 1.5万', '- 裸目标'])
    expect(goals[0]).toMatchObject({ name: '应急金', currentNum: 2.4, targetNum: 6 })
    expect(goals[1]).toMatchObject({ currentNum: 8000, targetNum: 15000 })
    expect(goals[2]!.targetNum).toBeUndefined()
    const ledger = parseLedgerLines(['- 09-01 | 房租 | -5200', '- 09-05 | 工资 | ¥18,000'])
    expect(ledger[0]).toMatchObject({ amountNum: -5200 })
    expect(ledger[1]).toMatchObject({ amountNum: 18000 })
    expect(parseItineraryLines(['- 2026-09-19 | 高铁 | 民宿 | 西湖', '- 未标日期行'])[1]).toMatchObject({
      date: '未标日期行',
      transport: '',
    })
  })

  it('numberWithSuffix：¥ / 千分位 / 万后缀 / 非法', () => {
    expect(numberWithSuffix('¥1,200')).toBe(1200)
    expect(numberWithSuffix('1.5万')).toBe(15000)
    expect(numberWithSuffix('-50')).toBe(-50)
    expect(numberWithSuffix('约 50')).toBeUndefined()
    expect(numberWithSuffix('6（个月）')).toBeUndefined()
  })

  it('itinerary 分组与日期头（含周几 / 未标日期）', () => {
    const rows = parseItineraryLines([
      '- 2026-09-19 | 高铁 | 民宿 | 西湖',
      '- 2026-09-19 | | | 夜游',
      '- 2026-09-20 | 返程',
      '- 备忘 | | | 带伞',
    ])
    const groups = groupByDay(rows)
    expect(groups.map((g) => g.date)).toEqual(['2026-09-19', '2026-09-20', ''])
    expect(groups[0]!.rows).toHaveLength(2)
    expect(dayLabelOf('2026-09-19')).toBe('09-19 周六')
    expect(dayLabelOf('')).toBe('未标日期')
  })
})

// ---------- 卡片渲染 ----------

describe('三轨打卡卡（::: tracks）', () => {
  const TRACKS = ['::: tracks 本周三轨计划', '- 训练 | 跑步 3 公里', '- 饮食 | 蛋白 1.6g/kg', '- 睡眠 | 23:30 前入睡', ':::'].join('\n')

  it('渲染三轨 + 周网格；点格落盘 + streak 徽标出现', () => {
    const today = localDateOf()
    const { container } = render(wrapMd(<Markdown content={TRACKS} />))
    const card = container.querySelector('[data-tracks-card]')!
    expect(card.querySelectorAll('[data-track]')).toHaveLength(3)
    expect(card.querySelectorAll('[data-day-dot]')).toHaveLength(21)

    const dot = card.querySelector(`[data-track="训练"] [data-day-dot="${today}"]`) as HTMLElement
    expect(dot.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(dot)
    expect(dot.getAttribute('aria-pressed')).toBe('true')
    expect(dot.className).toContain('is-done')
    expect(loadHabit('sa')).toEqual({ 训练: [today] })
    expect(card.querySelector('[data-track="训练"] [data-streak="1"]')).toBeTruthy()
    expect(card.textContent).toContain('连续 1 天')
  })

  it('预置昨日打卡 → 今日点亮即连续 2 天；再点取消回 1', () => {
    const today = localDateOf()
    localStorage.setItem('ma:habit:sa', JSON.stringify({ 训练: [shiftDate(today, -1)] }))
    const { container } = render(wrapMd(<Markdown content={TRACKS} />))
    const card = container.querySelector('[data-tracks-card]')!
    fireEvent.click(card.querySelector(`[data-track="训练"] [data-day-dot="${today}"]`)!)
    expect(card.querySelector('[data-track="训练"] [data-streak="2"]')).toBeTruthy()
    fireEvent.click(card.querySelector(`[data-track="训练"] [data-day-dot="${today}"]`)!)
    expect(card.querySelector('[data-track="训练"] [data-streak="1"]')?.getAttribute('data-streak')).toBe('1')
  })

  it('fail-safe：未闭合 tracks 内容展开（无卡壳）', () => {
    const broken = ['::: tracks 未完', '- 训练 | 跑步'].join('\n')
    const { container } = render(<Markdown content={broken} />)
    expect(container.querySelector('[data-tracks-card]')).toBeNull()
    expect(container.textContent).toContain('跑步')
  })
})

describe('每日一练卡（::: quiz）', () => {
  const QUIZ = ['::: quiz 每日一练：动词时态', '- A | 选项一', '- B | 选项二', ':::'].join('\n')

  it('点选 + 提交回填（未选禁用）', () => {
    const { container } = render(<Markdown content={QUIZ} />)
    const card = container.querySelector('[data-quiz-card]')!
    const submit = card.querySelector('[data-quiz-submit]') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.click(card.querySelector('[data-quiz-option="B"]')!)
    expect(card.querySelector('[data-quiz-option="B"]')!.className).toContain('is-picked')
    expect((card.querySelector('[data-quiz-submit]') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(card.querySelector('[data-quiz-submit]')!)
    expect(useUiStore.getState().composerInsert?.text).toBe('我的答案：B。请批改并讲解。')
  })
})

describe('情绪签到卡（::: mood）', () => {
  it('档位点选 + 提交回填（含档位词）', () => {
    const { container } = render(<Markdown content={'::: mood 今日情绪签到\n:::'} />)
    const card = container.querySelector('[data-mood-card]')!
    fireEvent.click(card.querySelector('[data-mood-level="4"]')!)
    expect(card.querySelector('[data-mood-level="4"]')!.className).toContain('is-picked')
    fireEvent.click(card.querySelector('[data-mood-submit]')!)
    expect(useUiStore.getState().composerInsert?.text).toBe(moodDraft(4))
    expect(moodDraft(4)).toBe('今日状态：4/5（不错）。请据此调整今日建议。')
  })
})

describe('目标进度环（::: goals）与记账流水（::: ledger）', () => {
  it('goals：百分比（含万后缀）与非法行降级', () => {
    const content = ['::: goals 目标进度', '- 应急金 | 2.4 | 6', '- 旅行基金 | 8000 | 1.5万', '- 裸目标', ':::'].join('\n')
    const { container } = render(<Markdown content={content} />)
    const card = container.querySelector('[data-goals-card]')!
    expect(card.querySelectorAll('[data-goal]')).toHaveLength(3)
    expect(card.querySelector('[data-goal="应急金"] [data-goal-pct="40"]')).toBeTruthy()
    expect(card.querySelector('[data-goal="旅行基金"] [data-goal-pct="53"]')).toBeTruthy()
    expect(card.querySelector('[data-goal="裸目标"] svg')).toBeNull()
  })

  it('ledger：金额右对齐类与负数着色（脏值不猜正负）', () => {
    const content = ['::: ledger 本月流水', '- 09-01 | 房租 | -5200', '- 09-05 | 工资 | ¥18,000', '- 09-09 | 未知 | 待定', ':::'].join('\n')
    const { container } = render(<Markdown content={content} />)
    const card = container.querySelector('[data-ledger-card]')!
    const rows = card.querySelectorAll('tbody tr')
    expect(rows).toHaveLength(3)
    expect(rows[0]!.querySelector('[data-ledger-negative="true"]')).toBeTruthy()
    expect(rows[1]!.querySelector('[data-ledger-negative]')).toBeNull()
    expect(rows[2]!.querySelector('[data-ledger-negative]')).toBeNull()
    expect(card.querySelector('.md-ledger-amount')!.className).toContain('md-ledger-amount')
  })
})

describe('行程卡（::: itinerary）', () => {
  it('按天分组 + 今天高亮', () => {
    const today = localDateOf()
    const content = [
      '::: itinerary 三日行程',
      `- ${shiftDate(today, -1)} | 高铁 | 民宿 | 西湖`,
      `- ${today} | 地铁 | 民宿 | 龙井茶园`,
      `- ${shiftDate(today, 1)} | 高铁返程 | — | 西溪湿地`,
      ':::',
    ].join('\n')
    const { container } = render(<Markdown content={content} />)
    const card = container.querySelector('[data-itinerary-card]')!
    expect(card.querySelectorAll('[data-itinerary-day]')).toHaveLength(3)
    const todayGroup = card.querySelector(`[data-itinerary-day="${today}"]`)!
    expect(todayGroup.className).toContain('is-today')
    expect(todayGroup.textContent).toContain('今天')
    expect(todayGroup.textContent).toContain('龙井茶园')
  })
})

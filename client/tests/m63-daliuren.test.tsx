/**
 * M63-C：大六壬前端测试——deriveDaliuren 派生 + DaliurenBoard 交互。
 *
 * fixture 与 server 工具实测同源（2026-11-05 14:30 涉害课全卡）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, waitFor } from '@testing-library/react'
import * as React from 'react'
import { PanCard } from '../src/components/chat/md-ext/PanCard'
import { MessageContext } from '../src/components/chat/md-ext/message-context'
import { derivePan } from '../src/components/chat/md-ext/pan/derive'
import type { DaliurenModel, PanKind, PanRowData } from '../src/components/chat/md-ext/pan/model'
import { useUiStore } from '../src/stores/ui-store'

beforeEach(() => {
  useUiStore.setState({ composerInsert: undefined })
  sessionStorage.clear()
})

interface PanProps {
  kind: string
  title: string
  fields: string
  items: string
}

function parseCard(text: string): { kind: PanKind; title: string; fields: PanRowData[]; items: PanRowData[] } {
  const lines = text.trim().split('\n')
  const head = /^::: pan (\w+)(?: (.*))?$/.exec(lines[0]!)!
  const fields: PanRowData[] = []
  const items: PanRowData[] = []
  for (const line of lines.slice(1)) {
    if (line.startsWith(':::') || line.trim() === '') continue
    if (line.startsWith('- ')) {
      const body = line.slice(2)
      const i = body.indexOf('|')
      items.push(i < 0 ? { label: body.trim(), value: '' } : { label: body.slice(0, i).trim(), value: body.slice(i + 1).trim() })
    } else {
      const i = line.indexOf('：')
      fields.push({ label: line.slice(0, i).trim(), value: line.slice(i + 1).trim() })
    }
  }
  return { kind: head[1] as PanKind, title: (head[2] ?? '').trim(), fields, items }
}

function panProps(text: string): PanProps {
  const c = parseCard(text)
  return { kind: c.kind, title: c.title, fields: JSON.stringify(c.fields), items: JSON.stringify(c.items) }
}

async function renderBoard(fx: PanProps): Promise<HTMLElement> {
  const { container } = render(
    <MessageContext.Provider value={null}>
      <PanCard {...fx} />
    </MessageContext.Provider>,
  )
  await waitFor(() => expect(container.querySelector('.pn-board')).not.toBeNull())
  return container
}

function btnByText(container: HTMLElement, text: string): HTMLButtonElement {
  const el = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(text))
  expect(el, `按钮缺失：${text}`).toBeTruthy()
  return el as HTMLButtonElement
}

function draft(): string {
  return useUiStore.getState().composerInsert?.text ?? ''
}

const DALIUREN = `
::: pan daliuren 大六壬 涉害课
起课：丙午年 戊戌月 癸未日 己未时 ｜ 昼占
月将：太冲 卯 ｜ 中气 霜降（2026-10-23 17:37）
天地盘：子→申 丑→酉 寅→戌 卯→亥 辰→子 巳→丑 午→寅 未→卯 申→辰 酉→巳 戌→午 亥→未
- 一课 | 上 酉（下 癸）
- 二课 | 上 巳（下 酉）
- 三课 | 上 卯（下 未）
- 四课 | 上 亥（下 卯）
- 初传 | 卯 ｜ 遁干 己 ｜ 天将 贵人
- 中传 | 亥 ｜ 遁干 乙 ｜ 天将 勾陈
- 末传 | 未 ｜ 遁干 癸 ｜ 天将 太常
课体：涉害课（涉害相等，复等取支上神）
贵人：昼贵 卯（临地盘 未 · 逆布）
天将：子 六合 ｜ 丑 朱雀 ｜ 寅 螣蛇 ｜ 卯 贵人 ｜ 辰 天后 ｜ 巳 太阴 ｜ 午 玄武 ｜ 未 太常 ｜ 申 白虎 ｜ 酉 天空 ｜ 戌 青龙 ｜ 亥 勾陈
口径：时家·中气换将·贵人顺逆法·涉害归地比较
:::
`

describe('M63-C derive：大六壬深卡', () => {
  it('① 四课 / 三传 / 天地盘 / 天将 / 课体解析', () => {
    const c = parseCard(DALIUREN)
    const m = derivePan(c.kind, c.title, c.fields, c.items) as DaliurenModel
    expect(m.kind).toBe('daliuren')
    expect(m.ke).toEqual([
      { idx: 1, label: '一课', upper: '酉', lower: '癸' },
      { idx: 2, label: '二课', upper: '巳', lower: '酉' },
      { idx: 3, label: '三课', upper: '卯', lower: '未' },
      { idx: 4, label: '四课', upper: '亥', lower: '卯' },
    ])
    expect(m.chuan).toEqual([
      { name: '初传', zhi: '卯', dunGan: '己', jiang: '贵人', kong: false },
      { name: '中传', zhi: '亥', dunGan: '乙', jiang: '勾陈', kong: false },
      { name: '末传', zhi: '未', dunGan: '癸', jiang: '太常', kong: false },
    ])
    expect(m.pan).toHaveLength(12)
    expect(m.pan.find((x) => x.di === '未')!.tian).toBe('卯')
    expect(Object.keys(m.jiangOf)).toHaveLength(12)
    expect(m.jiangOf['卯']).toBe('贵人')
    expect(m.keti).toBe('涉害课')
    expect(m.ketiNote).toContain('复等取支上神')
    expect(m.jiangText).toContain('太冲')
  })

  it('② 缺天地盘（损坏卡）→ 派生 null（表格回退）', () => {
    const stripped = DALIUREN.replace(/^天地盘：.*$/mu, '').trim()
    const c = parseCard(stripped)
    expect(derivePan(c.kind, c.title, c.fields, c.items)).toBeNull()
  })
})

describe('M63-C DaliurenBoard：天地盘 / 四课 / 三传交互', () => {
  it('① 渲染：地层 12 / 天盘 12 / 天将 12 / 四课 4 / 三传 3', async () => {
    const container = await renderBoard(panProps(DALIUREN))
    expect(container.querySelector('.pn-daliuren')).not.toBeNull()
    expect(container.querySelectorAll('.pn-dl-di')).toHaveLength(12)
    expect(container.querySelectorAll('.pn-dl-tian')).toHaveLength(12)
    expect(container.querySelectorAll('.pn-dl-jiang')).toHaveLength(12)
    expect(container.querySelectorAll('.pn-ke-col')).toHaveLength(4)
    expect(container.querySelectorAll('.pn-chuan-card')).toHaveLength(3)
    // 四课右起：首列（最左）为四课
    expect(container.querySelectorAll('.pn-ke-col')[0]!.textContent).toContain('四课')
  })

  it('② 点天地盘宫 → 选中态 + 信息条；天将层开关 → 天将文字隐藏', async () => {
    const container = await renderBoard(panProps(DALIUREN))
    const cells = container.querySelectorAll('.pn-dl-cell')
    fireEvent.click(cells[7]!) // 未宫（pan 顺序第 8 个）
    expect(container.querySelector('.pn-dl-selinfo')?.textContent).toContain('地盘 未 上临 天盘 卯')
    expect(container.querySelector('.pn-dl-selinfo')?.textContent).toContain('贵人')
    fireEvent.click(btnByText(container, '天将层'))
    expect(container.querySelectorAll('.pn-dl-jiang')).toHaveLength(0)
  })

  it('③ 三传点击 → 请教草稿（含遁干与天将）；四课点击 → 请教草稿', async () => {
    const container = await renderBoard(panProps(DALIUREN))
    fireEvent.click(btnByText(container, '初传'))
    expect(container.querySelectorAll('.pn-chuan-card.is-on')).toHaveLength(1)
    fireEvent.click(btnByText(container, '请教初传'))
    expect(draft()).toContain('请解读初传（卯·遁干 己·天将 贵人）')
    fireEvent.click(btnByText(container, '三课'))
    fireEvent.click(btnByText(container, '请教三课'))
    expect(draft()).toContain('请解读三课（上 卯 / 下 未）')
  })
})

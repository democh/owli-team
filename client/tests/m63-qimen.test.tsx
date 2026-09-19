/**
 * M63-D：奇门遁甲前端测试——deriveQimen 派生 + QimenBoard 九宫交互。
 *
 * fixture 与 server 工具实测同源（2026-11-05 14:30 阴五局全卡）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, waitFor } from '@testing-library/react'
import * as React from 'react'
import { PanCard } from '../src/components/chat/md-ext/PanCard'
import { MessageContext } from '../src/components/chat/md-ext/message-context'
import { derivePan } from '../src/components/chat/md-ext/pan/derive'
import type { PanKind, PanRowData, QimenModel } from '../src/components/chat/md-ext/pan/model'
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

const QIMEN = `
::: pan qimen 奇门 阴五局
定局：阴遁五局 ｜ 节气 霜降 ｜ 上元 ｜ 符头 己卯（符头后于节气 9 日（拆补））
值符：天英 ｜ 值使：景门 ｜ 旬首：甲寅（癸）
旬空：子 丑（时旬）
- 巽4 | 值符 天英 景门 ｜ 天盘 癸 ｜ 地盘 己
- 离9 | 九天 天芮（禽随） 死门 ｜ 天盘 辛 ｜ 地盘 癸
- 坤2 | 九地 天柱 惊门 ｜ 天盘 丙 ｜ 地盘 辛
- 震3 | 螣蛇 天辅 杜门 ｜ 天盘 己 ｜ 地盘 庚
- 中5 | —— 天禽（寄坤） ｜ 天盘 —— ｜ 地盘 戊
- 兑7 | 玄武 天心 开门 ｜ 天盘 乙 ｜ 地盘 丙
- 艮8 | 太阴 天冲 伤门 ｜ 天盘 庚 ｜ 地盘 丁 ｜ 空
- 坎1 | 六合 天任 生门 ｜ 天盘 丁 ｜ 地盘 壬 ｜ 空
- 乾6 | 白虎 天蓬 休门 ｜ 天盘 壬 ｜ 地盘 乙
口径：时家转盘·拆补法（符头候简化）·中宫寄坤
:::
`

describe('M63-D derive：奇门卡', () => {
  it('① 九宫 / 定局 / 值符值使 / 旬空解析', () => {
    const c = parseCard(QIMEN)
    const m = derivePan(c.kind, c.title, c.fields, c.items) as QimenModel
    expect(m.kind).toBe('qimen')
    expect(m.gongs).toHaveLength(9)
    // 宫 1-9 全覆盖且已排序
    expect(m.gongs.map((g) => g.num)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    // 巽 4：值符宫
    const xun = m.gongs[3]!
    expect(xun).toMatchObject({ name: '巽', shen: '值符', star: '天英', men: '景门', tianGan: '癸', diGan: '己', kong: false })
    // 中宫：八神 / 门 / 天盘干为空
    const zhong = m.gongs[4]!
    expect(zhong).toMatchObject({ name: '中', shen: '', star: '天禽（寄坤）', men: '', tianGan: '', diGan: '戊' })
    // 坎 1 旬空
    expect(m.gongs[0]!.kong).toBe(true)
    expect(m.dingText).toContain('阴遁五局')
    expect(m.dingText).toContain('霜降')
    expect(m.zhiFuText).toContain('天英')
    expect(m.kongText).toContain('子 丑')
  })

  it('② 损坏卡（缺一宫）→ 派生 null', () => {
    const stripped = QIMEN.replace(/^- 乾6 .*$/mu, '').trim()
    const c = parseCard(stripped)
    expect(derivePan(c.kind, c.title, c.fields, c.items)).toBeNull()
  })
})

describe('M63-D QimenBoard：九宫格交互', () => {
  it('① 渲染：9 格洛书布局 + 值符值使角标 + 空亡 2 格 + 定局条', async () => {
    const container = await renderBoard(panProps(QIMEN))
    expect(container.querySelector('.pn-qimen')).not.toBeNull()
    const cells = container.querySelectorAll('.pn-qm-cell')
    expect(cells).toHaveLength(9)
    // 洛书布局：第一格为巽4
    expect(cells[0]!.getAttribute('data-gong')).toBe('4')
    expect(cells[8]!.getAttribute('data-gong')).toBe('6')
    // 值符（巽4）与值使（景门在巽4——同格）角标：值符 + 值使
    expect(cells[0]!.querySelectorAll('.pn-qm-tag').length).toBeGreaterThanOrEqual(2)
    // 空亡 2 格
    expect(container.querySelectorAll('.pn-qm-cell.is-kong')).toHaveLength(2)
    expect(container.querySelector('.pn-qm-ding')?.textContent).toContain('阴遁五局')
  })

  it('② 点宫 → 详情 + 请教草稿（含天盘地盘与旬空标注）', async () => {
    const container = await renderBoard(panProps(QIMEN))
    const kan = container.querySelector('[data-gong="1"]')!
    fireEvent.click(kan)
    const detail = container.querySelector('.pn-qm-detail')!
    expect(detail.textContent).toContain('坎1宫')
    expect(detail.textContent).toContain('天盘 丁')
    expect(detail.textContent).toContain('地盘 壬')
    expect(detail.textContent).toContain('旬空')
    fireEvent.click(btnByText(container, '请教坎1宫'))
    expect(draft()).toContain('请解读坎1宫（六合·天任·生门')
    expect(draft()).toContain('天盘 丁 / 地盘 壬·旬空')
    // 切到中宫：神 / 门为空
    fireEvent.click(container.querySelector('[data-gong="5"]')!)
    expect(container.querySelector('.pn-qm-detail')?.textContent).toContain('中5宫')
    expect(container.querySelector('.pn-qm-detail')?.textContent).toContain('星 天禽（寄坤）')
  })

  it('③ 置闰对照行：meta 显示（M63 续完善；仅两口径不同时卡内输出）', async () => {
    const withDz = QIMEN.replace(
      '旬空：子 丑（时旬）',
      '旬空：子 丑（时旬）\n对照：置闰法 阳遁六局（置闰窗口第 5 天（重复芒种上元））',
    )
    const container = await renderBoard(panProps(withDz))
    const metas = Array.from(container.querySelectorAll('.pn-qm-kong')).map((el) => el.textContent ?? '')
    expect(metas.some((t) => t.includes('置闰法'))).toBe(true)
  })
})

/**
 * M54-C t3/t5：档案抽屉与对照 + 存档入口 + 研习足迹（组件层 / 工具单测）。
 *
 * 覆盖：archive 工具（同内容去重 / 20 上限 FIFO 溢出）、ArchiveDrawer（空态 / 回看 / 对照差异高亮 /
 * 异 kind 仅并排 / 删除同步存储 / 无会话不渲染）、PanBoard 存为档案（落 session + 反馈三态 + onArchived）、
 * PanCard ⭐（聊天路径；hideArchive 隐藏）、trail 工具（看盘去重 / 游历宫去重 / 文案）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, waitFor } from '@testing-library/react'
import * as React from 'react'
import { ArchiveDrawer } from '../src/components/chat/md-ext/pan/ArchiveDrawer'
import { ARCHIVE_MAX, archiveKey, readArchive, removeArchive, saveArchive, type ArchiveEntry } from '../src/components/chat/md-ext/pan/archive'
import { formatTrail, readTrail, recordAsk, recordPalace, recordThrow, recordView } from '../src/components/chat/md-ext/pan/trail'
import { PanCard } from '../src/components/chat/md-ext/PanCard'
import { MessageContext } from '../src/components/chat/md-ext/message-context'
import { PanBoard, type PanChart } from '../src/components/scene/parts/PanBoard'

beforeEach(() => {
  sessionStorage.clear()
})

interface Row {
  label: string
  value: string
}

// 最小可派生八字（四柱 + 五行 + ≥1 大运；B 变体差日柱/日主/五行三项）
const BAZI_FIELDS_A: Row[] = [
  { label: '四柱', value: '庚午 辛巳 丁丑 丁未' },
  { label: '五行', value: '木0 火4 土2 金2 水0 ｜ 日主 丁（阴火）' },
]
const BAZI_ITEMS: Row[] = [{ label: '大运 甲申', value: '29-38 岁 ｜ 2018-2027 · 当前大运' }]
const BAZI_FIELDS_B: Row[] = [
  { label: '四柱', value: '庚午 辛巳 乙巳 丁未' },
  { label: '五行', value: '木1 火4 土1 金2 水0 ｜ 日主 乙（阴木）' },
]

// 最小可派生卦（本卦字段 + 6 爻；两动爻带变卦段）
const GUA_FIELDS: Row[] = [{ label: '本卦', value: '水雷屯' }]
const GUA_ITEMS: Row[] = [
  { label: '初九', value: '青龙 兄弟 庚子 水' },
  { label: '六二', value: '朱雀 官鬼 庚寅 木' },
  { label: '六三', value: '勾陈 子孙 庚辰 土' },
  { label: '六四', value: '腾蛇 子孙 庚午 火' },
  { label: '九五 动', value: '白虎 兄弟 戊申 金 → 戊戌 土 兄弟' },
  { label: '上六 动', value: '玄武 官鬼 戊寅 木 → 戊子 水 父母' },
]

function mkEntry(fields: Row[], items: Row[], over: Partial<ArchiveEntry> = {}): ArchiveEntry {
  return {
    kind: 'bazi',
    title: '四柱测试',
    fields: JSON.stringify(fields),
    items: JSON.stringify(items),
    raw: '',
    savedAt: 1000,
    ...over,
  }
}

function seed(entries: ArchiveEntry[]): void {
  sessionStorage.setItem(archiveKey('s1'), JSON.stringify(entries))
}

function btnOf(container: HTMLElement, text: string): HTMLButtonElement {
  const el = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(text))
  expect(el, `按钮缺失：${text}`).toBeTruthy()
  return el as HTMLButtonElement
}

// ---------------------------------------------------------------------------
// archive 工具（§5.3）
// ---------------------------------------------------------------------------

describe('archive 工具', () => {
  it('同内容去重（dup）；删除按 savedAt', () => {
    expect(saveArchive('s1', mkEntry(BAZI_FIELDS_A, BAZI_ITEMS, { savedAt: 1 })).status).toBe('saved')
    expect(saveArchive('s1', mkEntry(BAZI_FIELDS_A, BAZI_ITEMS, { savedAt: 2 })).status).toBe('dup')
    expect(readArchive('s1')).toHaveLength(1)
    expect(removeArchive('s1', 1)).toHaveLength(0)
    expect(readArchive('s1')).toHaveLength(0)
  })

  it('上限 20 FIFO：第 21 条移除最旧（status=evicted）', () => {
    seed(Array.from({ length: ARCHIVE_MAX }, (_, i) => mkEntry(BAZI_FIELDS_A, BAZI_ITEMS, { savedAt: 100 + i })))
    const { list, status } = saveArchive('s1', mkEntry(BAZI_FIELDS_B, BAZI_ITEMS, { savedAt: 999 }))
    expect(status).toBe('evicted')
    expect(list).toHaveLength(ARCHIVE_MAX)
    expect(list[0]!.savedAt).toBe(101)
    expect(list[list.length - 1]!.savedAt).toBe(999)
  })
})

// ---------------------------------------------------------------------------
// ArchiveDrawer（§5.3：抽屉 / 回看 / 对照）
// ---------------------------------------------------------------------------

describe('ArchiveDrawer 档案抽屉', () => {
  it('无会话上下文 → 不渲染；空档案 → 计数与空提示', () => {
    const none = render(<ArchiveDrawer />)
    expect(none.container.querySelector('.pn-arch')).toBeNull()
    none.unmount()

    const { container } = render(<ArchiveDrawer sessionId="s1" />)
    const head = container.querySelector<HTMLElement>('.pn-arch-head')!
    expect(head.textContent).toContain('档案（0）')
    fireEvent.click(head)
    expect(container.querySelector('.pn-arch-empty')?.textContent).toContain('尚无档案')
  })

  it('回看：点行选中 → PanCard 盘面展开；再点取消；删除同步存储', async () => {
    seed([mkEntry(BAZI_FIELDS_A, BAZI_ITEMS, { title: '盘A', savedAt: 1001 })])
    const { container } = render(<ArchiveDrawer sessionId="s1" />)
    fireEvent.click(container.querySelector<HTMLElement>('.pn-arch-head')!)

    const row = container.querySelector<HTMLButtonElement>('.pn-arch-main')!
    fireEvent.click(row)
    expect(row.getAttribute('aria-pressed')).toBe('true')
    expect(container.querySelector('.pn-arch-view')).not.toBeNull()
    await waitFor(() => expect(container.querySelector('.pn-arch-view .pn-board')).not.toBeNull())

    // 再点取消 → 回看区收起
    fireEvent.click(row)
    expect(row.getAttribute('aria-pressed')).toBe('false')
    expect(container.querySelector('.pn-arch-view')).toBeNull()

    // 删除 → 列表清空、存储同步、空提示出现
    fireEvent.click(container.querySelector<HTMLButtonElement>('.pn-arch-del')!)
    expect(container.querySelectorAll('.pn-arch-row')).toHaveLength(0)
    expect(readArchive('s1')).toHaveLength(0)
    expect(container.querySelector('.pn-arch-empty')).not.toBeNull()
  })

  it('对照：两张同 kind → 并排 + 差异高亮（日柱 is-diff / 年柱 is-same）', async () => {
    seed([
      mkEntry(BAZI_FIELDS_A, BAZI_ITEMS, { title: '盘A', savedAt: 1001 }),
      mkEntry(BAZI_FIELDS_B, BAZI_ITEMS, { title: '盘B', savedAt: 1002 }),
    ])
    const { container } = render(<ArchiveDrawer sessionId="s1" />)
    fireEvent.click(container.querySelector<HTMLElement>('.pn-arch-head')!)
    const mains = Array.from(container.querySelectorAll<HTMLButtonElement>('.pn-arch-main'))
    fireEvent.click(mains[0]!)
    fireEvent.click(mains[1]!)

    await waitFor(() => expect(container.querySelectorAll('.pn-arch-pair .md-pan')).toHaveLength(2))
    expect(container.querySelector('.pn-diff')).not.toBeNull()
    expect(container.querySelector('.pn-diff-head')?.textContent).toContain('差异对照')

    const rowEls = Array.from(container.querySelectorAll('.pn-diff-row'))
    const byLabel = (t: string): HTMLElement => {
      const el = rowEls.find((x) => x.querySelector('.pn-diff-label')?.textContent === t)
      expect(el, `差异行缺失：${t}`).toBeTruthy()
      return el as HTMLElement
    }
    // A/B 差异：日主 / 日柱 / 五行 = 3 处，共 7 行
    expect(container.querySelector('.pn-diff-head')?.textContent).toContain('3 / 7')
    expect(byLabel('日柱').classList.contains('is-diff')).toBe(true)
    expect(byLabel('年柱').classList.contains('is-same')).toBe(true)
    expect(byLabel('日柱').textContent).toContain('丁丑')
    expect(byLabel('日柱').textContent).toContain('乙巳')
  })

  it('异 kind 对照：仅并排（无差异块，给出说明）', async () => {
    seed([
      mkEntry(BAZI_FIELDS_A, BAZI_ITEMS, { savedAt: 1001 }),
      mkEntry(GUA_FIELDS, GUA_ITEMS, { kind: 'gua', title: '水雷屯', savedAt: 1002 }),
    ])
    const { container } = render(<ArchiveDrawer sessionId="s1" />)
    fireEvent.click(container.querySelector<HTMLElement>('.pn-arch-head')!)
    const mains = Array.from(container.querySelectorAll<HTMLButtonElement>('.pn-arch-main'))
    fireEvent.click(mains[0]!)
    fireEvent.click(mains[1]!)

    await waitFor(() => expect(container.querySelectorAll('.pn-arch-pair .md-pan')).toHaveLength(2))
    expect(container.querySelector('.pn-diff')).toBeNull()
    expect(container.querySelector('.pn-arch-mix')?.textContent).toContain('异类盘仅并排')
  })

  it('M63-F 走查：新盘（六壬）回看走盘面 + 同 kind 差异对照', async () => {
    const DL_FIELDS: Row[] = [
      { label: '天地盘', value: '子→申 丑→酉 寅→戌 卯→亥 辰→子 巳→丑 午→寅 未→卯 申→辰 酉→巳 戌→午 亥→未' },
      { label: '月将', value: '太冲 卯 ｜ 中气 霜降' },
    ]
    const dlItems = (last: string): Row[] => [
      { label: '一课', value: '上 酉（下 癸）' },
      { label: '二课', value: '上 巳（下 酉）' },
      { label: '三课', value: '上 卯（下 未）' },
      { label: '四课', value: '上 亥（下 卯）' },
      { label: '初传', value: '卯 ｜ 遁干 己 ｜ 天将 贵人' },
      { label: '中传', value: '亥 ｜ 遁干 乙 ｜ 天将 勾陈' },
      { label: '末传', value: `未 ｜ 遁干 癸 ｜ 天将 ${last}` },
    ]
    seed([
      mkEntry(DL_FIELDS, dlItems('太常'), { kind: 'daliuren', title: '课A', savedAt: 1001 }),
      mkEntry(DL_FIELDS, dlItems('玄武'), { kind: 'daliuren', title: '课B', savedAt: 1002 }),
    ])
    const { container } = render(<ArchiveDrawer sessionId="s1" />)
    fireEvent.click(container.querySelector<HTMLElement>('.pn-arch-head')!)

    // 回看：六壬卡 → 盘面可达（天地盘三层圆盘）
    const rows = Array.from(container.querySelectorAll<HTMLButtonElement>('.pn-arch-main'))
    fireEvent.click(rows[0]!)
    await waitFor(() => expect(container.querySelector('.pn-arch-view .pn-daliuren')).not.toBeNull())
    expect(container.querySelectorAll('.pn-arch-view .pn-dl-di')).toHaveLength(12)
    expect(container.querySelectorAll('.pn-arch-view .pn-chuan-card')).toHaveLength(3)

    // 再加选第二张（同 kind）→ 并排对照 + 差异块（末传天将不同）
    fireEvent.click(rows[1]!)
    await waitFor(() => expect(container.querySelectorAll('.pn-arch-pair .md-pan')).toHaveLength(2))
    expect(container.querySelector('.pn-diff')).not.toBeNull()
    const diffRows = Array.from(container.querySelectorAll('.pn-diff-row'))
    const last = diffRows.find((r) => r.querySelector('.pn-diff-label')?.textContent === '末传')
    expect(last).toBeTruthy()
    expect(last!.classList.contains('is-diff')).toBe(true)
    expect(last!.textContent).toContain('太常')
    expect(last!.textContent).toContain('玄武')
  })
})

// ---------------------------------------------------------------------------
// 存档入口（PanBoard 工具行 / PanCard ⭐）
// ---------------------------------------------------------------------------

describe('存为档案入口', () => {
  const charts: PanChart[] = [
    { id: 'm1:0', kind: 'bazi', title: '四柱测试', fields: BAZI_FIELDS_A, items: BAZI_ITEMS, raw: '' },
  ]

  it('PanBoard「存为档案」：落 session + 反馈三态 + onArchived（去重不重复通知）', async () => {
    const onArchived = vi.fn()
    const { container } = render(<PanBoard charts={charts} sessionId="s1" onArchived={onArchived} />)
    await waitFor(() => expect(container.querySelector('.pn-board')).not.toBeNull())

    const btn = btnOf(container, '存为档案')
    fireEvent.click(btn)
    const list = readArchive('s1')
    expect(list).toHaveLength(1)
    expect(list[0]!.kind).toBe('bazi')
    expect(list[0]!.fields).toContain('四柱')
    expect(btn.textContent).toContain('已存为档案')
    expect(onArchived).toHaveBeenCalledTimes(1)

    // 同内容再存 → dup 提示，不重复通知
    fireEvent.click(btn)
    expect(readArchive('s1')).toHaveLength(1)
    expect(btn.textContent).toContain('已在档案中')
    expect(onArchived).toHaveBeenCalledTimes(1)
  })

  it('PanBoard 无会话 → 不渲染存档按钮（静默降级）', async () => {
    const { container } = render(<PanBoard charts={charts} />)
    await waitFor(() => expect(container.querySelector('.pn-board')).not.toBeNull())
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent?.includes('存为档案'))).toBe(false)
  })

  it('PanCard ⭐（聊天路径）：存档 + 反馈；hideArchive 隐藏入口', async () => {
    const fx = { kind: 'bazi', title: '四柱测试', fields: JSON.stringify(BAZI_FIELDS_A), items: JSON.stringify(BAZI_ITEMS) }
    const info = { messageId: 'm1', sessionId: 's1' }
    const first = render(
      <MessageContext.Provider value={info}>
        <PanCard {...fx} />
      </MessageContext.Provider>,
    )
    await waitFor(() => expect(first.container.querySelector('.pn-board')).not.toBeNull())
    const star = first.container.querySelector<HTMLButtonElement>('button[aria-label="存为档案"]')
    expect(star).not.toBeNull()
    fireEvent.click(star!)
    expect(readArchive('s1')).toHaveLength(1)
    expect(first.container.querySelector('.md-pan-archnote')?.textContent).toContain('已存为档案')
    first.unmount()

    const second = render(
      <MessageContext.Provider value={info}>
        <PanCard {...fx} hideArchive />
      </MessageContext.Provider>,
    )
    expect(second.container.querySelector('button[aria-label="存为档案"]')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// trail 研习足迹（§5.5）
// ---------------------------------------------------------------------------

describe('trail 研习足迹', () => {
  it('记录与去重：看盘按来源去重 / 游历宫按地支去重 / 摇卦与请教计数 + 文案', () => {
    let t = recordView('s9', 'k1')
    t = recordView('s9', 'k1')
    expect(t.chartsViewed).toBe(1)
    t = recordView('s9', 'k2')
    expect(t.chartsViewed).toBe(2)
    t = recordPalace('s9', '子')
    t = recordPalace('s9', '子')
    t = recordPalace('s9', '丑')
    expect(t.palacesTapped).toBe(3)
    expect(t.palacesCovered).toBe(2)
    t = recordThrow('s9')
    t = recordAsk('s9')
    t = recordAsk('s9')
    expect(formatTrail(t)).toBe('看过 2 张盘 · 十二宫已游历 2/12 · 摇卦 1 次 · 请教 2 次')
    expect(readTrail('s9').yaoThrown).toBe(1)
    expect(readTrail('s9').palacesCovered).toBe(2)
  })

  it('空足迹 → 空文案；非法数据回退空足迹', () => {
    sessionStorage.setItem('ma:pn:trail:s9', '{"chartsViewed":"x"}')
    const t = readTrail('s9')
    expect(t.chartsViewed).toBe(0)
    expect(formatTrail(t)).toBe('')
  })
})

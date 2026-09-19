/**
 * M66 续完善：择日卡（::: pan zeri）派生 + 渲染 + 交互测试。
 * - deriveZeri：字段 / 条目 → 模型（事项 / 区间 / 口径 / 日期条目 / 推荐）；无日期条目 → null（回退表格）；
 * - ZeriBoard：推荐高亮 / 星级 / 破日合规表述 / 行点击回填 / AskBar；
 * - 端到端（Markdown 路由）：::: pan zeri → .md-pan-zeri 壳 + 板懒加载异步渲染。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Markdown } from '../src/components/chat/Markdown'
import { clearMarkdownCaches } from '../src/lib/md-cache'
import { ZeriBoard } from '../src/components/chat/md-ext/pan/ZeriBoard'
import { deriveZeri } from '../src/components/chat/md-ext/pan/zeri-model'
import type { PanRowData } from '../src/components/chat/md-ext/pan/model'

const FIELDS: PanRowData[] = [
  { label: '事项', value: '搬家入宅 ｜ 区间：2026-09-20 至 2026-09-28' },
  { label: '口径', value: '建除十二神（节气月建）｜ 评分 1–5（传统宜忌参考）' },
  { label: '推荐', value: '2026-09-22（满） · 2026-09-28（成） · 2026-09-24（定）' },
]
const ITEMS: PanRowData[] = [
  { label: '2026-09-20（丁酉 · 建 · 周日）', value: '3 | 冲兔 煞东 | 宜出行赴任，忌动土开仓' },
  { label: '2026-09-22（己亥 · 满 · 周二）', value: '5 | 冲蛇 煞西 | 宜祭祀祈福开市' },
  { label: '2026-09-24（辛丑 · 定 · 周四）', value: '4 | 冲羊 煞东 | 宜祭祀嫁娶安床，忌出行交涉' },
  { label: '2026-09-26（癸卯 · 破 · 周六）', value: '1 | 冲鸡 煞西 | 传统列为诸事慎用日（宜静不宜动）' },
  { label: '2026-09-28（乙巳 · 成 · 周一）', value: '5 | 冲猪 煞东 | 宜嫁娶开市入宅，忌诉讼' },
  { label: '声明', value: '评分仅反映传统宜忌参考（不以吉凶为必然判断）；以实际安排为先' },
  { label: '声明', value: '节气为近似公式——边界日请以专业历书复核' },
]

const CARD = [
  '::: pan zeri 搬家择日 · 09-20 至 09-28',
  '事项：搬家入宅 ｜ 区间：2026-09-20 至 2026-09-28',
  '口径：建除十二神（节气月建）｜ 评分 1–5（传统宜忌参考）',
  '- 2026-09-22（己亥 · 满 · 周二）| 5 | 冲蛇 煞西 | 宜祭祀祈福开市',
  '- 2026-09-26（癸卯 · 破 · 周六）| 1 | 冲鸡 煞西 | 传统列为诸事慎用日（宜静不宜动）',
  '- 2026-09-28（乙巳 · 成 · 周一）| 5 | 冲猪 煞东 | 宜嫁娶开市入宅，忌诉讼',
  '推荐：2026-09-22（满）· 2026-09-28（成）',
  '- 声明 | 评分仅反映传统宜忌参考（不以吉凶为必然判断）；以实际安排为先',
  ':::',
].join('\n')

beforeEach(() => {
  clearMarkdownCaches()
})

describe('M66 续完善：择日卡', () => {
  it('deriveZeri：事项 / 区间 / 条目 / 推荐解析；无日期条目 → null', () => {
    const m = deriveZeri(FIELDS, ITEMS)
    expect(m).not.toBeNull()
    expect(m!.kind).toBe('zeri')
    expect(m!.purpose).toBe('搬家入宅')
    expect(m!.from).toBe('2026-09-20')
    expect(m!.to).toBe('2026-09-28')
    expect(m!.caliber).toContain('建除十二神')
    expect(m!.days).toHaveLength(5)
    expect(m!.days[1]).toMatchObject({ date: '2026-09-22', ganzhi: '己亥', jianchu: '满', weekday: '周二', score: 5, chongSha: '冲蛇 煞西' })
    expect(m!.recommended).toEqual(['2026-09-22', '2026-09-28', '2026-09-24'])
    expect(m!.notes).toHaveLength(2)

    expect(deriveZeri([{ label: '口径', value: 'x' }], [{ label: '声明', value: 'y' }])).toBeNull()
  })

  it('ZeriBoard：推荐高亮 / 星级 / 破日合规表述 / 行点击回填', () => {
    const m = deriveZeri(FIELDS, ITEMS)!
    const ask = vi.fn()
    const { container } = render(<ZeriBoard model={m} onAsk={ask} />)
    // 推荐区
    const rec = container.querySelector('[data-zr-rec]')!
    expect(rec.textContent).toContain('2026-09-22')
    expect(rec.textContent).toContain('2026-09-28')
    // 星级（评分 5 → 5 星；评分 1 → 1 星）
    const day22 = container.querySelector('[data-zr-day="2026-09-22"]')!
    expect(day22.textContent).toContain('★★★★★')
    const day26 = container.querySelector('[data-zr-day="2026-09-26"]')!
    expect(day26.textContent).toContain('★☆☆☆☆')
    // 破日合规表述
    expect(day26.textContent).toContain('传统列为诸事慎用日')
    // 行点击回填
    fireEvent.click(day22)
    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask.mock.calls[0]![0] as string).toContain('@司南')
    expect(ask.mock.calls[0]![0] as string).toContain('2026-09-22')
    // AskBar：推荐日细节
    fireEvent.click(screen.getByText(/推荐日细节/))
    expect(ask).toHaveBeenCalledTimes(2)
  })

  it('端到端：::: pan zeri 经 Markdown 路由 → 择日卡容器（lazy 板异步渲染）', async () => {
    const { container } = render(<Markdown content={CARD} />)
    expect(container.querySelector('.md-pan.md-pan-zeri')).not.toBeNull()
    expect(await screen.findByText('搬家入宅')).toBeTruthy()
  })
})

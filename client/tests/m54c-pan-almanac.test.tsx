/**
 * M54-C t4：时间轴合参组件测试（§5.4）——真实派生链路（fixture → derivePan → Almanac）。
 * 覆盖：双泳道段数与当前段 ● / 轴双标（年龄 + 年份 = 出生年 + 年龄）/ 点选联动高亮与详情行 /
 * 缺出生年 → 只显年龄（不虚构年份）/ 当前大运内流年点。
 */
import { describe, expect, it } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import * as React from 'react'
import { Almanac } from '../src/components/chat/md-ext/pan/Almanac'
import { derivePan } from '../src/components/chat/md-ext/pan/derive'
import type { BaziModel, ZiweiModel } from '../src/components/chat/md-ext/pan/model'

interface Row {
  label: string
  value: string
}

// 真实风格 fixture（同一命造：公历 1990-05-12；紫微大限 5-14 … 115-124）
const BAZI_TITLE = '四柱 庚午 辛巳 丁丑 丁未'
const BAZI_FIELDS: Row[] = [
  { label: '命造', value: '乾造 ｜ 公历 1990-05-12 14:30' },
  { label: '四柱', value: '庚午 辛巳 丁丑 丁未' },
  { label: '五行', value: '木0 火4 土2 金2 水0 ｜ 日主 丁（阴火）' },
]
const BAZI_ITEMS: Row[] = [
  { label: '大运 庚辰', value: '9-18 岁 ｜ 1998-2007' },
  { label: '大运 辛巳', value: '19-28 岁 ｜ 2008-2017' },
  { label: '大运 壬午', value: '29-38 岁 ｜ 2018-2027 · 当前大运' },
  { label: '流年 2018 戊戌', value: '29 岁' },
  { label: '流年 2020 庚子', value: '31 岁' },
  { label: '流年 2026 丙午', value: '37 岁 · 当前' },
]

const ZIWEI_FIELDS: Row[] = [{ label: '命造', value: '乾造 ｜ 公历 1990-05-12 14:30 ｜ 未时' }]
const ZIWEI_ITEMS: Row[] = [
  { label: '命宫 丙戌', value: '太阴(旺)科 ｜ 大限 5-14' },
  { label: '父母 丁亥', value: '廉贞(陷) 贪狼(陷) ｜ 大限 15-24' },
  { label: '福德 戊子 身宫', value: '巨门(旺) ｜ 大限 25-34' },
  { label: '田宅 己丑', value: '天相(庙) ｜ 大限 35-44 · 当前' },
  { label: '官禄 戊寅', value: '天同(利)忌 天梁(庙) ｜ 大限 45-54' },
  { label: '仆役 己卯', value: '武曲(利)权 七杀(旺) ｜ 大限 55-64' },
  { label: '迁移 庚辰', value: '太阳(旺)禄 ｜ 大限 65-74' },
  { label: '疾厄 辛巳', value: '（空宫） ｜ 大限 75-84' },
  { label: '财帛 壬午', value: '天机(庙) ｜ 大限 85-94' },
  { label: '子女 癸未', value: '紫微(庙) 破军(旺) ｜ 大限 95-104' },
  { label: '夫妻 甲申', value: '（空宫） ｜ 大限 105-114' },
  { label: '兄弟 乙酉', value: '天府(旺) ｜ 大限 115-124' },
]

function renderAlm(baziFields: Row[] = BAZI_FIELDS, ziweiFields: Row[] = ZIWEI_FIELDS): {
  container: HTMLElement
  lanes: NodeListOf<HTMLElement>
} {
  const b = derivePan('bazi', BAZI_TITLE, baziFields, BAZI_ITEMS)
  const z = derivePan('ziwei', '紫微', ziweiFields, ZIWEI_ITEMS)
  expect(b?.kind).toBe('bazi')
  expect(z?.kind).toBe('ziwei')
  const { container } = render(<Almanac bazi={b as BaziModel} ziwei={z as ZiweiModel} />)
  return { container, lanes: container.querySelectorAll<HTMLElement>('.pn-alm-lane') }
}

describe('Almanac 时间轴合参', () => {
  it('双泳道：大运 3 段 / 大限 12 段，当前段 ●（is-current）', () => {
    const { container, lanes } = renderAlm()
    expect(lanes).toHaveLength(2)
    expect(lanes[0]!.querySelectorAll('.pn-alm-seg')).toHaveLength(3)
    expect(lanes[1]!.querySelectorAll('.pn-alm-seg')).toHaveLength(12)
    expect(lanes[0]!.querySelectorAll('.pn-alm-seg.is-current')).toHaveLength(1)
    expect(lanes[0]!.querySelector('.pn-alm-seg.is-current')?.textContent).toContain('壬午')
    expect(lanes[1]!.querySelectorAll('.pn-alm-seg.is-current')).toHaveLength(1)
    expect(lanes[1]!.querySelector('.pn-alm-seg.is-current')?.textContent).toContain('田宅')
    expect(container.querySelector('.pn-alm-cap')?.textContent).toContain('不含推测')
  })

  it('轴：年龄 + 年份双标（出生年 1990 + 年龄）；当前大运内标 10 个流年点中的实有项', () => {
    const { container, lanes } = renderAlm()
    const ticks = container.querySelectorAll('.pn-alm-tick')
    expect(ticks.length).toBe(12) // 10..120 岁（maxAge = 124）
    expect(ticks[0]!.querySelector('.pn-alm-tick-age')?.textContent).toBe('10 岁')
    expect(ticks[0]!.querySelector('.pn-alm-tick-year')?.textContent).toBe('2000')
    expect(ticks[1]!.querySelector('.pn-alm-tick-year')?.textContent).toBe('2010')

    const cur = lanes[0]!.querySelector('.pn-alm-seg.is-current')!
    expect(cur.querySelectorAll('.pn-alm-year-dot')).toHaveLength(3)
    expect(cur.querySelectorAll('.pn-alm-year-dot.is-now')).toHaveLength(1)
  })

  it('联动高亮：点大运壬午 → 双大限（25-34 / 35-44）is-hot + 详情行；再点取消', () => {
    const { container, lanes } = renderAlm()
    const cur = lanes[0]!.querySelector<HTMLButtonElement>('.pn-alm-seg.is-current')!
    fireEvent.click(cur)
    expect(cur.getAttribute('aria-pressed')).toBe('true')
    expect(cur.classList.contains('is-on')).toBe(true)

    const hot = lanes[1]!.querySelectorAll('.pn-alm-seg.is-hot')
    expect(hot).toHaveLength(2) // 29-38 与（25-34）和（35-44）重叠
    const hotTexts = Array.from(hot).map((el) => el.textContent)
    expect(hotTexts.some((t) => t?.includes('福德'))).toBe(true)
    expect(hotTexts.some((t) => t?.includes('田宅'))).toBe(true)

    const detail = container.querySelector('.pn-alm-detail')?.textContent ?? ''
    expect(detail).toContain('壬午大运 29-38 岁（2018-2027）')
    expect(detail).toContain('福德 大限 25-34 岁')
    expect(detail).toContain('田宅 大限 35-44 岁')

    fireEvent.click(cur)
    expect(cur.getAttribute('aria-pressed')).toBe('false')
    expect(lanes[1]!.querySelectorAll('.pn-alm-seg.is-hot')).toHaveLength(0)
    expect(container.querySelector('.pn-alm-hint')).not.toBeNull()
  })

  it('反向联动：点紫微田宅段（35-44）→ 大运壬午（29-38）is-hot', () => {
    const { lanes } = renderAlm()
    const tian = Array.from(lanes[1]!.querySelectorAll<HTMLButtonElement>('.pn-alm-seg')).find((b) =>
      b.textContent?.includes('田宅'),
    )!
    fireEvent.click(tian)
    const hot = lanes[0]!.querySelectorAll('.pn-alm-seg.is-hot')
    expect(hot).toHaveLength(1)
    expect(hot[0]!.textContent).toContain('壬午')
  })

  it('缺出生年 → 只显年龄（轴不显年份，大限标题不含年）', () => {
    const noBirthBazi: Row[] = BAZI_FIELDS.filter((r) => r.label !== '命造')
    const { container, lanes } = renderAlm(noBirthBazi, [])
    expect(container.querySelectorAll('.pn-alm-tick-year')).toHaveLength(0)
    expect(container.querySelector('.pn-alm-tick-age')?.textContent).toBe('10 岁')
    // 段按地支序（子位福德在前）；全部标签均不含年份括号
    const labels = Array.from(lanes[1]!.querySelectorAll('.pn-alm-seg')).map((el) => el.getAttribute('aria-label'))
    expect(labels).toHaveLength(12)
    expect(labels.every((t) => t !== null && !t.includes('（'))).toBe(true)
    expect(labels).toContain('命宫 大限 5-14 岁')
  })
})

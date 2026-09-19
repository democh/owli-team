/**
 * M63-E：七政四余前端测试——deriveQizheng 派生 + QizhengBoard 交互。
 *
 * fixture 与 server 工具实测同源（1990-05-12 14:30 全卡）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, waitFor } from '@testing-library/react'
import * as React from 'react'
import { PanCard } from '../src/components/chat/md-ext/PanCard'
import { MessageContext } from '../src/components/chat/md-ext/message-context'
import { derivePan } from '../src/components/chat/md-ext/pan/derive'
import type { PanKind, PanRowData, QizhengModel } from '../src/components/chat/md-ext/pan/model'
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

const QIZHENG = `
::: pan qizheng 七政 命宫巳
出生：公历 1990-05-12 14:30 ｜ Asia/Shanghai ｜ 31.23°N 121.47°E
- 太阳 | 酉宫 21.2°（51.24°）
- 太阴 | 寅宫 17.6°（257.62°）
- 水星 | 酉宫 8.8°（38.79°）｜ 逆行
- 金星 | 戌宫 9.1°（9.10°）
- 火星 | 亥宫 15.9°（345.90°）
- 木星 | 未宫 8.9°（98.93°）
- 土星 | 丑宫 25.3°（295.30°）｜ 逆行
- 罗睺 | 子宫 11.5°（311.51°）｜ 近似：平交点 · 逆行
- 计都 | 午宫 11.5°（131.51°）｜ 近似：平交点 · 逆行
- 月孛 | 卯宫 21.1°（231.07°）｜ 近似：平远地点 · 逆行
- 紫炁 | 申宫 20.7°（80.66°）｜ 近似：古法线性 · 争议口径
- 命宫 巳 | 宫主 水星
- 财帛 辰 | 宫主 金星
- 兄弟 卯 | 宫主 火星 ｜ 月孛
- 田宅 寅 | 宫主 木星 ｜ 太阴
- 男女 丑 | 宫主 土星 ｜ 土星
- 奴仆 子 | 宫主 土星 ｜ 罗睺
- 夫妻 亥 | 宫主 木星 ｜ 火星
- 疾厄 戌 | 宫主 火星 ｜ 金星
- 迁移 酉 | 宫主 金星 ｜ 太阳 水星
- 官禄 申 | 宫主 水星 ｜ 紫炁
- 福德 未 | 宫主 太阴 ｜ 木星
- 相貌 午 | 宫主 太阳 ｜ 计都
庙旺：太阳 庙戌 旺巳 ｜ 太阴 庙亥 旺酉
口径：回归黄道十二宫·中气过宫·四余近似（罗计平交点 / 月孛平远地点 / 紫炁古法）；v1 不列二十八宿度
:::
`

describe('M63-E derive：七政四余卡', () => {
  it('① 政余 / 十二宫 / 庙旺解析', () => {
    const c = parseCard(QIZHENG)
    const m = derivePan(c.kind, c.title, c.fields, c.items) as QizhengModel
    expect(m.kind).toBe('qizheng')
    expect(m.bodies).toHaveLength(11)
    const sun = m.bodies.find((b) => b.name === '太阳')!
    expect(sun).toMatchObject({ gong: '酉', retro: false })
    expect(sun.deg).toBeCloseTo(21.2, 1)
    expect(sun.lon).toBeCloseTo(51.24, 1)
    // 四余近似标注
    expect(m.bodies.find((b) => b.name === '罗睺')!.note).toContain('平交点')
    expect(m.bodies.find((b) => b.name === '罗睺')!.retro).toBe(true)
    expect(m.bodies.find((b) => b.name === '紫炁')!.note).toContain('争议口径')
    // 十二宫
    expect(m.palaces).toHaveLength(12)
    expect(m.palaces[0]).toMatchObject({ name: '命宫', gong: '巳', sign: '处女', lord: '水星' })
    expect(m.palaces.find((p) => p.name === '迁移')!.bodies).toEqual(['太阳', '水星'])
    expect(m.palaces.find((p) => p.name === '命宫')!.bodies).toEqual([])
    expect(m.miaoWangText).toContain('太阳 庙戌')
  })

  it('② 损坏卡（缺十二宫）→ 派生 null', () => {
    const stripped = QIZHENG.replace(/^- 相貌 .*$/mu, '').trim()
    const c = parseCard(stripped)
    expect(derivePan(c.kind, c.title, c.fields, c.items)).toBeNull()
  })
})

describe('M63-E QizhengBoard：圆盘 / 政余表交互', () => {
  it('① 渲染：12 宫 + 11 政余 chips（近似角标 4）+ 庙旺', async () => {
    const container = await renderBoard(panProps(QIZHENG))
    expect(container.querySelector('.pn-qizheng')).not.toBeNull()
    expect(container.querySelectorAll('.pn-qz-cell')).toHaveLength(12)
    expect(container.querySelectorAll('.pn-qz-bchip')).toHaveLength(11)
    // 四余近似角标（罗计孛炁 4 个）
    expect(container.querySelectorAll('.pn-qz-bchip.is-approx')).toHaveLength(4)
    // 逆行标记：水星 / 土星 / 罗计孛 = 5
    expect(container.querySelectorAll('.pn-qz-bretro')).toHaveLength(5)
    expect(container.querySelector('.pn-qz-miao')?.textContent).toContain('太阳 庙戌')
  })

  it('② 点宫 → 详情 + 请教草稿；点星 → 请教草稿（含近似口径）', async () => {
    const container = await renderBoard(panProps(QIZHENG))
    const cells = container.querySelectorAll('.pn-qz-cell')
    // 点「迁移」（酉宫）——第 9 个宫（命宫起序）
    const qianyi = Array.from(cells).find((c) => c.textContent?.includes('迁移'))!
    fireEvent.click(qianyi)
    expect(container.querySelector('.pn-qz-selinfo')?.textContent).toContain('迁移 酉宫（金牛）')
    expect(container.querySelector('.pn-qz-selinfo')?.textContent).toContain('落 太阳 水星')
    fireEvent.click(btnByText(container, '请教迁移'))
    expect(draft()).toContain('迁移宫（酉宫·金牛·宫主 金星·落 太阳、水星）')
    // 点「紫炁」星
    fireEvent.click(btnByText(container, '紫炁'))
    fireEvent.click(btnByText(container, '请教紫炁'))
    expect(draft()).toContain('紫炁（申宫 20.7°')
    expect(draft()).toContain('近似：古法线性 · 争议口径')
  })
})

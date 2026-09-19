/**
 * M63-B：行运视图（TransitWheel）与合盘矩阵（SynastryBoard）组件测试。
 *
 * fixture 与 server 工具实测同源（简化行数以缩短用例）；旧卡零回归由既有 M54 用例守护。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, waitFor } from '@testing-library/react'
import * as React from 'react'
import { PanCard } from '../src/components/chat/md-ext/PanCard'
import { MessageContext } from '../src/components/chat/md-ext/message-context'
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

function panProps(text: string): PanProps {
  const lines = text.trim().split('\n')
  const head = /^::: pan (\w+)(?: (.*))?$/.exec(lines[0]!)!
  const fields: Array<{ label: string; value: string }> = []
  const items: Array<{ label: string; value: string }> = []
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
  return { kind: head[1]!, title: (head[2] ?? '').trim(), fields: JSON.stringify(fields), items: JSON.stringify(items) }
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

const TRANSIT = `
::: pan transit 行运 2026-11-05
本命：1990-05-12 14:30 ｜ Asia/Shanghai ｜ 31.23°N 121.47°E ｜ Placidus
行运：2026-11-05 14:30（当地钟表时间）｜ UTC 2026-11-05 06:30
- 行运太阳 | 天蝎 12.9°（222.85°）｜ 2 宫
- 行运土星 | 白羊 9.0°（9.03°）｜ 7 宫 ｜ 逆行
- 行运土星-本命金星 | 合相 0.1°
- 行运火星-本命太阳 | 刑相 0.5°
- 行运太阳-本命ASC | 六合 3.1°
扫描：2026-01-01 ~ 2026-12-01
- 行运木星-本命太阳 | 六合 | 精确 2026-01-02 06:00 ｜ 影响窗 ±14 天
- 行运土星-本命月亮 | 对分 | 精确 2026-11-05 14:20 ｜ 影响窗 ±14 天
口径：cross-aspects orb ≤ 6°·主相位；扫描为参考时点非事件断言
:::
`

const TRANSIT_NOSCAN = `
::: pan transit 行运 2026-11-05
本命：1990-05-12 14:30 ｜ Asia/Shanghai ｜ 31.23°N 121.47°E ｜ Placidus
行运：2026-11-05 14:30（当地钟表时间）｜ UTC 2026-11-05 06:30
- 行运太阳 | 天蝎 12.9°（222.85°）｜ 2 宫
- 行运土星-本命金星 | 合相 0.1°
口径：cross-aspects orb ≤ 6°·主相位；扫描为参考时点非事件断言
:::
`

const SYNASTRY = `
::: pan synastry 合盘 A×B
A：1990-05-12 14:30 ｜ Asia/Shanghai ｜ 31.23°N 121.47°E
B：1992-09-03 08:10 ｜ Asia/Shanghai ｜ 31.23°N 121.47°E
知情：本盘仅基于双方出生数据的关系模式参考
- A太阳 | 金牛 21.2°（51.24°）
- A金星 | 白羊 9.1°（9.10°）
- A月亮 | 射手 17.6°（257.62°）
- B月亮 | 天蝎 29.6°（239.64°）
- B火星 | 双子 24.6°（84.59°）
- 组合太阳 | 巨蟹 16.0°（106.00°）
- A太阳-B月亮 | 拱相 2.3°
- A金星-B火星 | 合相 1.1°
- A月亮-BASC | 刑相 1.8°
元素：A 火2 土5 风0 水3 ｜ B 火1 土3 风3 水3 ｜ 互补 风
口径：cross-aspects orb ≤ 8°·主相位·对称去重
:::
`

const TRANSIT_NATAL = TRANSIT.replace(
  '- 行运太阳 | 天蝎 12.9°（222.85°）｜ 2 宫',
  '- 本命太阳 | 金牛 21.2°（51.24°）\n- 本命月亮 | 射手 17.6°（257.62°）\n- 本命金星 | 白羊 9.1°（9.10°）\n- 行运太阳 | 天蝎 12.9°（222.85°）｜ 2 宫',
)

describe('M63-B TransitWheel：星环 / cross 清单 / 扫描 ribbon', () => {
  it('① 渲染：行星 chips / cross chips / ribbon 节点', async () => {
    const container = await renderBoard(panProps(TRANSIT))
    expect(container.querySelector('.pn-transit')).not.toBeNull()
    expect(container.querySelectorAll('.pn-tw-pchip')).toHaveLength(2)
    expect(container.querySelectorAll('.pn-tw-achip')).toHaveLength(3)
    expect(container.querySelectorAll('.pn-tw-node')).toHaveLength(2)
    expect(container.querySelector('.pn-tw-pretro')).not.toBeNull() // 土星逆行
  })

  it('② cross 点击 → 高亮 + 请教草稿；行星 chip 过滤（is-dim）', async () => {
    const container = await renderBoard(panProps(TRANSIT))
    fireEvent.click(btnByText(container, '土星-金星'))
    expect(container.querySelectorAll('.pn-tw-achip.is-on')).toHaveLength(1)
    fireEvent.click(btnByText(container, '请教相位 土星-金星'))
    expect(draft()).toContain('行运土星-本命金星 合相')
    // 点行星 chip → 其他条 is-dim
    fireEvent.click(container.querySelectorAll('.pn-tw-pchip')[0]!) // 太阳
    const dim = container.querySelectorAll('.pn-tw-achip.is-dim')
    expect(dim.length).toBe(2) // 土星-金星 / 火星-太阳 变暗；太阳-ASC 不暗
  })

  it('③ 扫描节点点击 → 时点详情 + 关注时点草稿', async () => {
    const container = await renderBoard(panProps(TRANSIT))
    const nodes = container.querySelectorAll('.pn-tw-node')
    fireEvent.click(nodes[1]!) // 2026-11-05 14:20
    expect(container.querySelector('.pn-tw-hit')?.textContent).toContain('精确 2026-11-05 14:20')
    fireEvent.click(btnByText(container, '关注时点 2026-11-05 14:20'))
    expect(draft()).toContain('精确时点 2026-11-05 14:20')
    expect(draft()).toContain('±14 天')
  })

  it('④ 无扫描字段 → 不渲染 ribbon', async () => {
    const container = await renderBoard(panProps(TRANSIT_NOSCAN))
    expect(container.querySelector('.pn-tw-ribbon')).toBeNull()
    expect(container.querySelectorAll('.pn-tw-achip')).toHaveLength(1)
    expect(container.querySelectorAll('.pn-tw-ndot')).toHaveLength(0) // 无本命行 → 单环零回归
  })

  it('⑤ 双环 v2：本命十星内环；点 cross → 双环联动 + 连线；轴相位不入环', async () => {
    const container = await renderBoard(panProps(TRANSIT_NATAL))
    // 内环：3 条本命行 → 3 点（旧卡（题 ④）→ 0，已零回归）
    expect(container.querySelectorAll('.pn-tw-ndot')).toHaveLength(3)
    expect(container.querySelectorAll('.pn-tw-link')).toHaveLength(0)
    // 点「土星-金星」（cross：行运土星 → 本命金星）→ 外环土星 is-on + 内环金星 is-on + 连线
    fireEvent.click(btnByText(container, '土星-金星'))
    const onDots = container.querySelectorAll('.pn-tw-dot.is-on')
    expect(onDots.length).toBeGreaterThanOrEqual(1)
    expect(container.querySelectorAll('.pn-tw-ndot.is-on')).toHaveLength(1)
    expect(container.querySelector('.pn-tw-link')).not.toBeNull()
    // 点轴相位（太阳-ASC）→ 内环不亮、无连线（轴不入环）
    fireEvent.click(btnByText(container, '太阳-ASC'))
    expect(container.querySelectorAll('.pn-tw-ndot.is-on')).toHaveLength(0)
    expect(container.querySelector('.pn-tw-link')).toBeNull()
  })
})

describe('M63-B SynastryBoard：交角矩阵 / 清单 / 组合盘', () => {
  it('① 矩阵 10×10 渲染；命中 2 格（点对点）+ 轴相位单列', async () => {
    const container = await renderBoard(panProps(SYNASTRY))
    expect(container.querySelector('.pn-synastry')).not.toBeNull()
    expect(container.querySelectorAll('.pn-sy-cell')).toHaveLength(100)
    expect(container.querySelectorAll('.pn-sy-cell.has-asp')).toHaveLength(2)
    // 轴相位（A月亮-BASC）
    expect(container.querySelector('.pn-sy-axes')!.textContent).toContain('A月亮-BASC')
    // 元素行
    expect(container.querySelector('.pn-sy-elem')?.textContent).toContain('互补 风')
  })

  it('② 点格 → 高亮 + 请教相位草稿；再点取消', async () => {
    const container = await renderBoard(panProps(SYNASTRY))
    const cell = container.querySelector('.pn-sy-cell[data-a="太阳"][data-b="月亮"]')!
    fireEvent.click(cell)
    expect(container.querySelectorAll('.pn-sy-cell.is-on')).toHaveLength(1)
    fireEvent.click(btnByText(container, '请教相位 A太阳-B月亮'))
    expect(draft()).toContain('A太阳-B月亮 拱相 2.3°')
    fireEvent.click(cell)
    expect(container.querySelectorAll('.pn-sy-cell.is-on')).toHaveLength(0)
  })

  it('③ 组合盘 toggle（composite 行）', async () => {
    const container = await renderBoard(panProps(SYNASTRY))
    expect(container.querySelector('.pn-sy-composite')).toBeNull()
    fireEvent.click(btnByText(container, '组合盘（中点）'))
    expect(container.querySelector('.pn-sy-compitem')?.textContent).toContain('太阳 巨蟹 16.0°')
    fireEvent.click(btnByText(container, '组合盘（中点）'))
    expect(container.querySelector('.pn-sy-composite')).toBeNull()
  })

  it('④ 无 A 行星行 → 表格回退（必需门失败）', async () => {
    // 删除全部 A 前缀行（保留 cross 以证明是「必需门」而非「无数据」失败）
    const stripped = SYNASTRY.split('\n')
      .filter((l) => !l.startsWith('- 甲') && !l.startsWith('- A'))
      .join('\n')
    const { container } = render(
      <MessageContext.Provider value={null}>
        <PanCard {...panProps(stripped)} />
      </MessageContext.Provider>,
    )
    await waitFor(() => expect(container.querySelector('.md-pan')).not.toBeNull())
    expect(container.querySelector('.pn-board')).toBeNull()
    expect(container.querySelector('.md-pan-board')).toBeNull()
    expect(container.querySelector('.md-pan-body')).not.toBeNull()
  })

  it('⑤ 双环 v2：外环 A / 内环 B；点格与悬停→高亮 + 连线（轴相位不入环）', async () => {
    const container = await renderBoard(panProps(SYNASTRY))
    expect(container.querySelector('.pn-sy-wheel')).not.toBeNull()
    expect(container.querySelectorAll('.pn-sy-dot.is-a')).toHaveLength(3)
    expect(container.querySelectorAll('.pn-sy-dot.is-b')).toHaveLength(2)
    expect(container.querySelectorAll('.pn-sy-link')).toHaveLength(0)
    // 点格（A太阳-B月亮 拱相）→ 两点高亮 + 连线（色随相位类型）
    const cell = container.querySelector('.pn-sy-cell[data-a="太阳"][data-b="月亮"]')!
    fireEvent.click(cell)
    expect(container.querySelectorAll('.pn-sy-dot.is-on')).toHaveLength(2)
    const link = container.querySelector('.pn-sy-link')
    expect(link).not.toBeNull()
    expect(link!.classList.contains('pn-asp-gong')).toBe(true)
    // 再点取消 → 无高亮无连线
    fireEvent.click(cell)
    expect(container.querySelectorAll('.pn-sy-dot.is-on')).toHaveLength(0)
    expect(container.querySelector('.pn-sy-link')).toBeNull()
    // 悬停同效（mouseEnter → 连线；mouseLeave → 收回）
    fireEvent.mouseEnter(cell)
    expect(container.querySelector('.pn-sy-link')).not.toBeNull()
    fireEvent.mouseLeave(cell)
    expect(container.querySelector('.pn-sy-link')).toBeNull()
  })
})

/**
 * M54 续完善：摇卦台全局宿主（PanTossHost）——宿主上提（§5.1 模态性修复）的 store 链路：
 * openPanToss → 弹窗呈现（不依赖请求方组件存活）；closePanToss → 卸载；
 * 请解 → composerInsert 草稿（不自动发送）+ 请教足迹；成卦 → 对照快照上台 + 摇卦足迹（无 sessionId 静默降级）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import * as React from 'react'
import { PanTossHost } from '../src/components/chat/md-ext/pan/TossHost'
import { readTrail } from '../src/components/chat/md-ext/pan/trail'
import { useUiStore } from '../src/stores/ui-store'

beforeEach(() => {
  sessionStorage.clear()
  // quietMode = true：摇卦直出（免 600ms 翻转定时器）；请求 / 草稿通道复位
  useUiStore.setState({ quietMode: true, panToss: null, composerInsert: undefined })
})

const POS = ['初', '二', '三', '四', '五', '上']

function btn(c: HTMLElement, text: string): HTMLButtonElement {
  const el = Array.from(c.querySelectorAll('button')).find((b) => b.textContent?.includes(text))
  expect(el, `按钮缺失：${text}`).toBeTruthy()
  return el as HTMLButtonElement
}

/** 直出模式成卦：开始 + 六爻（每爻即时落定） */
function tossSix(c: HTMLElement): void {
  fireEvent.click(btn(c, '开始'))
  for (let i = 0; i < 6; i++) fireEvent.click(btn(c, `摇${POS[i]}爻`))
}

describe('PanTossHost 摇卦台全局宿主', () => {
  it('openPanToss → 弹窗呈现；closePanToss → 卸载（与请求方组件树解耦）', () => {
    const { baseElement } = render(<PanTossHost />)
    expect(baseElement.querySelector('.pn-toss')).toBeNull()
    act(() => useUiStore.getState().openPanToss({ compare: null, sessionId: 's1' }))
    expect(baseElement.querySelector('.pn-toss')).not.toBeNull()
    act(() => useUiStore.getState().closePanToss())
    expect(baseElement.querySelector('.pn-toss')).toBeNull()
  })

  it('以此卦请解 → 草稿入 Composer 通道 + 请教足迹（草稿不自动发送）', () => {
    const { baseElement } = render(<PanTossHost />)
    act(() => useUiStore.getState().openPanToss({ compare: null, sessionId: 's1' }))
    tossSix(baseElement)
    fireEvent.click(btn(baseElement, '以此卦请解'))
    const draft = useUiStore.getState().composerInsert?.text ?? ''
    expect(draft).toContain('gua_pan（method=coin')
    expect(readTrail('s1').linksAsked).toBe(1)
    // onDone 后即关闭（宿主随之卸载弹窗）
    expect(baseElement.querySelector('.pn-toss')).toBeNull()
  })

  it('成卦 → 对照快照上台 + 摇卦足迹；无 sessionId（独立渲染）不落账', () => {
    const { baseElement } = render(<PanTossHost />)
    const base = Array.from({ length: 6 }, () => ({ yin: true }))
    act(() => useUiStore.getState().openPanToss({ compare: { title: '水雷屯', yao: base }, sessionId: 's2' }))
    tossSix(baseElement)
    expect(baseElement.querySelector('.pn-toss-cmp-cap')?.textContent).toContain('水雷屯')
    expect(baseElement.querySelectorAll('.pn-toss-cmp-row')).toHaveLength(6)
    expect(readTrail('s2').yaoThrown).toBe(1)

    // 无会话上下文：请求可开、成卦不落账（静默降级）；清进度模拟全新会话
    act(() => useUiStore.getState().closePanToss())
    sessionStorage.clear()
    act(() => useUiStore.getState().openPanToss({ compare: null }))
    tossSix(baseElement)
    expect(baseElement.querySelector('.pn-toss-seed')).not.toBeNull()
  })
})

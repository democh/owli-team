/**
 * M54-C t1/t2：摇卦台组件测试（设计 §7.8 组件层）——
 * 六次点击成卦（固定种子 12345 = 工具已验向量，逐位一致）/ 铭牌行与 aria-live 播报 /
 * 报数草稿（模板 2，不本地预测）/ 恢复（只存种子与进度）/ reduced-motion 直出 /
 * 对照标点（一致 / 不一致）/ 键盘（空格 = 开始与摇下一爻）/ 关闭保留进度 /
 * 焦点约束（模态性：Tab 首尾环回 + 逃逸拉回，M54 续完善）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import * as React from 'react'
import { TsToss, TOSS_KEY } from '../src/components/chat/md-ext/pan/TsToss'
import { tossGua } from '../src/components/chat/md-ext/pan/coin'
import { useUiStore } from '../src/stores/ui-store'

beforeEach(() => {
  sessionStorage.clear()
  useUiStore.setState({ quietMode: false })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** 固定种子 12345（= 工具已验向量）：初7 二8 三8 四8 五9 上6 → 水雷屯 → 山雷颐 */
function stubSeed(): void {
  vi.stubGlobal('crypto', {
    getRandomValues: (a: Uint32Array) => {
      a[0] = 12345
      return a
    },
  })
}

/** matchMedia 直出模式（reduced-motion = true；同 m54-pan-boards 写法） */
function stubReduced(): () => void {
  const original = window.matchMedia
  window.matchMedia = ((q: string) => ({
    matches: true,
    media: q,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
  return () => {
    window.matchMedia = original
  }
}

function btn(c: HTMLElement, text: string): HTMLButtonElement {
  const el = Array.from(c.querySelectorAll('button')).find((b) => b.textContent?.includes(text))
  expect(el, `按钮缺失：${text}`).toBeTruthy()
  return el as HTMLButtonElement
}

const POS = ['初', '二', '三', '四', '五', '上']

function renderToss(props: Partial<React.ComponentProps<typeof TsToss>> = {}) {
  const onDone = vi.fn()
  const onClose = vi.fn()
  const onThrow = vi.fn()
  const utils = render(<TsToss open onClose={onClose} onDone={onDone} onThrow={onThrow} {...props} />)
  // Portal 到 body（层级修复）：container 改用 baseElement 以覆盖 portal 内容
  return { ...utils, container: utils.baseElement, onDone, onClose, onThrow }
}

describe('TsToss 摇卦台', () => {
  it('六次点击成卦：与工具同种子逐位一致（12345 向量）→ 揭晓 + 请解草稿（模板 1）', () => {
    stubSeed()
    vi.useFakeTimers()
    const { container, onDone, onClose, onThrow } = renderToss()
    fireEvent.click(btn(container, '开始'))
    expect(container.querySelector('.pn-toss-seed')?.textContent).toContain('种子 12345')

    for (let i = 0; i < 6; i++) {
      fireEvent.click(btn(container, `摇${POS[i]}爻`))
      act(() => vi.advanceTimersByTime(600))
    }

    // 铭牌行：逐爻与 tossGua(12345) 一致（7/8/8/8/9/6）
    const rows = Array.from(container.querySelectorAll('.pn-toss-yao'))
    expect(rows).toHaveLength(6)
    expect(rows[0]!.textContent).toContain('少阳')
    expect(rows[3]!.textContent).toContain('少阴')
    expect(rows[4]!.textContent).toContain('老阳')
    expect(rows[4]!.classList.contains('is-dong')).toBe(true)
    expect(rows[5]!.textContent).toContain('老阴')
    expect(rows[5]!.classList.contains('is-dong')).toBe(true)
    // aria-live 播报最后一爻
    expect(container.querySelector('.pn-toss-live')?.textContent).toContain('上爻 老阴')

    // 揭晓：本卦 / 变卦 / 动爻（卦名取本地 64 卦表）
    expect(container.querySelector('.pn-toss-ben')?.textContent).toBe('本卦 水雷屯')
    expect(container.querySelector('.pn-toss-bian')?.textContent).toBe('变卦 山雷颐')
    expect(container.querySelector('.pn-toss-donglist')?.textContent).toContain('九五、上六')
    // 成卦通知一次（外壳记足迹）
    expect(onThrow).toHaveBeenCalledTimes(1)

    // 请解（模板 1）→ onDone + onClose（不自动发送）
    fireEvent.click(btn(container, '以此卦请解'))
    expect(onDone).toHaveBeenCalledWith(
      '我亲手摇了六爻（种子 12345，所问：「（未注明）」）。请用 gua_pan（method=coin，seed=12345）起卦，逐爻核对后解读。',
    )
    expect(onClose).toHaveBeenCalled()
  })

  it('所问与重摇全卦：question 入草稿；重摇回 idle（新种子，无单爻撤销）', () => {
    stubSeed()
    const restore = stubReduced()
    try {
      const { container } = renderToss()
      const input = container.querySelector<HTMLInputElement>('.pn-toss-q input')!
      fireEvent.change(input, { target: { value: '测试占问' } })
      fireEvent.click(btn(container, '开始'))
      expect(container.querySelector('.pn-toss-qline')?.textContent).toContain('测试占问')
      for (let i = 0; i < 6; i++) fireEvent.click(btn(container, `摇${POS[i]}爻`))
      // 重摇全卦 → idle（question 保留）
      fireEvent.click(btn(container, '重摇全卦'))
      expect(container.querySelector('.pn-toss-seed')).toBeNull()
      expect(btn(container, '开始')).toBeTruthy()
      expect(container.querySelector<HTMLInputElement>('.pn-toss-q input')!.value).toBe('测试占问')
    } finally {
      restore()
    }
  })

  it('报数起卦：两数校验 + 模板 2 草稿（不本地预测卦名）', () => {
    const { container, onDone, onClose } = renderToss()
    fireEvent.click(btn(container, '报数起卦'))
    fireEvent.click(btn(container, '以此两数起卦'))
    expect(container.querySelector('.pn-toss-err')?.textContent).toContain('1-99')
    expect(onDone).not.toHaveBeenCalled()

    const inputs = container.querySelectorAll<HTMLInputElement>('.pn-toss-num input')
    fireEvent.change(inputs[0]!, { target: { value: '17' } })
    fireEvent.change(inputs[1]!, { target: { value: '28' } })
    fireEvent.keyDown(inputs[1]!, { key: 'Enter' })
    expect(onDone).toHaveBeenCalledWith('报数起卦：17、28。请用 gua_pan（method=number，numbers=[17,28]）起卦并解读。')
    expect(onClose).toHaveBeenCalled()
  })

  it('恢复：ma:pn:toss {seed, done:3} → 回 tossing(3) 重放已完成爻（恢复不记成卦）', () => {
    stubSeed()
    sessionStorage.setItem(TOSS_KEY, JSON.stringify({ seed: 12345, question: '测试占问', done: 3, startedAt: 1 }))
    const { container, onThrow } = renderToss()
    expect(container.querySelectorAll('.pn-toss-yao')).toHaveLength(3)
    expect(container.querySelectorAll('.pn-toss-yao')[2]!.textContent).toContain('少阴')
    expect(btn(container, '摇四爻')).toBeTruthy()
    expect(container.querySelector('.pn-toss-qline')?.textContent).toContain('测试占问')
    expect(onThrow).not.toHaveBeenCalled()
  })

  it('存储只存种子与进度（不存逐爻结果）；关闭重开进度保留', () => {
    stubSeed()
    const restore = stubReduced()
    try {
      const first = renderToss()
      fireEvent.click(btn(first.container, '开始'))
      fireEvent.click(btn(first.container, '摇初爻'))
      const saved = JSON.parse(sessionStorage.getItem(TOSS_KEY)!) as Record<string, unknown>
      expect(saved.seed).toBe(12345)
      expect(saved.done).toBe(1)
      expect('yao' in saved).toBe(false)
      first.unmount()
      const second = renderToss()
      expect(second.container.querySelectorAll('.pn-toss-yao')).toHaveLength(1)
      expect(second.container.querySelector('.pn-toss-seed')?.textContent).toContain('种子 12345')
    } finally {
      restore()
    }
  })

  it('reduced-motion：点击直出（无 600ms 翻转等待）', () => {
    stubSeed()
    const restore = stubReduced()
    try {
      const { container } = renderToss()
      fireEvent.click(btn(container, '开始'))
      fireEvent.click(btn(container, '摇初爻'))
      expect(container.querySelectorAll('.pn-toss-yao')).toHaveLength(1)
      expect(container.querySelector('.pn-coins.is-flipping')).toBeNull()
    } finally {
      restore()
    }
  })

  it('对照模式：成卦后逐爻标点（不一致 is-diff / 一致 is-match）', () => {
    stubSeed()
    const restore = stubReduced()
    try {
      // 基线 = 12345 结果，仅初爻取反 → 其余一致
      const res = tossGua(12345)
      const base = res.yao.map((y) => ({ yin: y.yin }))
      base[0] = { yin: !res.yao[0]!.yin }
      const { container } = renderToss({ compare: { title: '水雷屯', yao: base } })
      fireEvent.click(btn(container, '开始'))
      for (let i = 0; i < 6; i++) fireEvent.click(btn(container, `摇${POS[i]}爻`))

      const rows = Array.from(container.querySelectorAll('.pn-toss-cmp-row'))
      expect(rows).toHaveLength(6)
      // 倒序显示：末行 = 初爻（不一致），其余一致
      expect(rows[5]!.classList.contains('is-diff')).toBe(true)
      expect(rows[5]!.textContent).toContain('不一致')
      expect(rows[0]!.classList.contains('is-match')).toBe(true)
      expect(rows[0]!.textContent).toContain('一致')
      expect(container.querySelector('.pn-toss-cmp-cap')?.textContent).toContain('水雷屯')
    } finally {
      restore()
    }
  })

  it('键盘：容器空格 = 开始 / 摇下一爻；Escape = 关闭', () => {
    stubSeed()
    const restore = stubReduced()
    try {
      const { container, onClose } = renderToss()
      const panel = container.querySelector<HTMLElement>('.pn-toss')!
      fireEvent.keyDown(panel, { key: ' ' })
      expect(container.querySelector('.pn-toss-seed')).not.toBeNull()
      fireEvent.keyDown(panel, { key: ' ' })
      expect(container.querySelectorAll('.pn-toss-yao')).toHaveLength(1)
      fireEvent.keyDown(panel, { key: 'Escape' })
      expect(onClose).toHaveBeenCalled()
    } finally {
      restore()
    }
  })

  it('焦点约束（模态性）：Tab 首尾环回 + 逃逸拉回；台内焦点不干预', () => {
    const { container } = renderToss()
    const panel = container.querySelector<HTMLElement>('.pn-toss')!
    // 打开即焦点入台（键盘路径：空格 / 回车）
    expect(document.activeElement).toBe(panel)
    // Tab 环回：尾（开始）→ 首（关闭）；首 Shift+Tab → 尾
    const first = panel.querySelector<HTMLElement>('.pn-toss-close')!
    const last = btn(container, '开始')
    last.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
    // 台外焦点：focusin 拉回；台外 + Tab 不逃逸
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    try {
      outside.focus()
      fireEvent.focusIn(outside)
      expect(document.activeElement).toBe(panel)
      outside.focus()
      fireEvent.keyDown(document, { key: 'Tab' })
      expect(panel.contains(document.activeElement)).toBe(true)
      // 台内元素获焦不受干预
      const input = container.querySelector<HTMLInputElement>('.pn-toss-q input')!
      input.focus()
      fireEvent.focusIn(input)
      expect(document.activeElement).toBe(input)
    } finally {
      outside.remove()
    }
  })
})

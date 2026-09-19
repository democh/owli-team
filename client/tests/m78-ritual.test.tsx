/**
 * M78：抽牌台 / 图鉴 / 手记测试（见 docs/tarot-ritual-design.md §12.2）。
 *
 * 覆盖：
 * - 状态机主路径（idle → shuffle → cut → draw → reveal → complete）与请解草稿（quiet 直出）；撤销；
 *   进度恢复（`ma:tc:ritual` 预置）；
 * - 手记纯函数（幂等记录 / 请解累加 / 足迹派生 / 删除）与 buildAskDraft 文案；
 * - 手记弹窗（条目 / 再请解回填）与图鉴弹窗（分组 / 遇见计数 / 问这张）；
 * - 视觉降级：逆位中性类名与角标；位图 onError → 程序化牌面 / SVG 牌背。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { CardBack } from '../src/components/chat/md-ext/tarot/CardBack'
import { CodexDialog } from '../src/components/chat/md-ext/tarot/CodexDialog'
import { JournalDialog } from '../src/components/chat/md-ext/tarot/JournalDialog'
import { TarotCardFace } from '../src/components/chat/md-ext/tarot/TarotCardFace'
import { buildAskDraft, TarotRitual } from '../src/components/chat/md-ext/tarot/TarotRitual'
import { formatStats, journalStats, readJournal, recordAsk, recordDraw, removeEntry } from '../src/components/chat/md-ext/tarot/journal'
import { useUiStore } from '../src/stores/ui-store'

beforeEach(() => {
  sessionStorage.clear()
  useUiStore.setState({ quietMode: true, composerInsert: undefined, tarotDraw: null, tarotCodex: false, tarotJournal: false })
})

const q = <T extends Element>(sel: string): T[] => Array.from(document.querySelectorAll<T>(sel))

/** 主路径：静心 → 洗牌 → 切牌（第 2 堆）→ 选 3 张（格位 0/1/2）→ 揭示 → 成阵 */
function walkToComplete(onDone: (d: string) => void): void {
  render(<TarotRitual open onClose={() => {}} onDone={onDone} sessionId="sa" />)
  fireEvent.click(document.querySelector('.tc-btn')!) // 开始洗牌
  fireEvent.click(document.querySelector('.tc-btn')!) // 洗牌（quiet 直出）→ 按钮变「切牌」
  fireEvent.click(document.querySelector('.tc-btn')!) // 切牌 → cut 态
  fireEvent.click(document.querySelector('[aria-label="第 2 堆放最上"]')!) // cut = 1
  const cells = q<HTMLButtonElement>('.tc-cell')
  expect(cells).toHaveLength(78)
  fireEvent.click(cells[0]!)
  fireEvent.click(cells[1]!)
  fireEvent.click(cells[2]!)
  fireEvent.click(document.querySelector('.tc-btn')!) // 揭示牌面
  fireEvent.click(document.querySelector('.tc-action-all, .tc-actions .tc-ghost')!) // 全部翻开
}

describe('M78：抽牌台状态机', () => {
  it('主路径 → 成阵（复现参数 + 构成事实）→ 请解读草稿（不自动发送）', () => {
    const onDone = vi.fn()
    walkToComplete(onDone)
    const params = document.querySelector('.tc-info-params')!.textContent ?? ''
    expect(params).toContain('切牌 1')
    expect(params).toContain('选牌 [0, 1, 2]')
    expect(params).toMatch(/种子 \d+/)
    expect(document.querySelector('.tc-info-comp')!.textContent).toContain('大阿卡纳')
    fireEvent.click(document.querySelector('.tc-btn')!) // 请观照解读
    expect(onDone).toHaveBeenCalledTimes(1)
    const draft = onDone.mock.calls[0]![0] as string
    expect(draft).toContain('我亲手抽了一组牌（三张牌阵')
    expect(draft).toContain('cut=1')
    expect(draft).toContain('picks=[0,1,2]')
    expect(draft).toContain('逐位核对后按四步解读')
  })

  it('撤销上一张：已选回退且槽位恢复空态', () => {
    render(<TarotRitual open onClose={() => {}} onDone={() => {}} sessionId="sb" />)
    fireEvent.click(document.querySelector('.tc-btn')!) // 开始洗牌
    fireEvent.click(document.querySelector('.tc-btn')!) // 洗牌
    fireEvent.click(document.querySelector('.tc-btn')!) // 切牌
    fireEvent.click(document.querySelector('[aria-label="第 1 堆放最上"]')!)
    const cells = q<HTMLButtonElement>('.tc-cell')
    fireEvent.click(cells[5]!)
    fireEvent.click(cells[6]!)
    expect(q('.tc-slot.is-filled')).toHaveLength(2)
    fireEvent.click(document.querySelector('.tc-actions .tc-ghost')!) // 撤销上一张
    expect(q('.tc-slot.is-filled')).toHaveLength(1)
    expect(document.querySelector('.tc-draw-cap')!.textContent).toContain('已选 1/3')
  })

  it('进度恢复：预置 draw 态快照 → 打开即续（已选 1/3 + 参数保留）', () => {
    sessionStorage.setItem(
      'ma:tc:ritual',
      JSON.stringify({ stage: 'draw', spread: 'three', question: '要不要换工作', seed: 456, shuffleCount: 1, cut: 1, picks: [7], revealed: 0 }),
    )
    render(<TarotRitual open onClose={() => {}} onDone={() => {}} sessionId="sc" />)
    expect(q('.tc-slot.is-filled')).toHaveLength(1)
    expect(document.querySelector('.tc-draw-cap')!.textContent).toContain('已选 1/3')
    expect(document.querySelector('.tc-seed')!.textContent).toContain('456')
  })

  it('请解草稿文案：单张 / 未注明所问 / 空格口径', () => {
    expect(buildAskDraft('single', 123, 0, [42], '')).toContain('我亲手抽了一张牌（单张牌阵，种子 123，切牌 0，选牌 [42]，所问：「（未注明）」')
    const d = buildAskDraft('three', 456, 2, [7, 23, 61], '最近要不要换工作')
    expect(d).toContain('我亲手抽了一组牌（三张牌阵，种子 456，切牌 2，选牌 [7, 23, 61]，所问：「最近要不要换工作」）')
    expect(d).toContain('请用 tarot_draw（spread=three，seed=456，cut=2，picks=[7,23,61]）复算牌面')
    expect(d).toContain('若复算牌面与我所见不一致，请指出并说明')
  })
})

describe('M78：手记纯函数', () => {
  it('幂等记录 / 请解累加 / 删除 / 足迹派生', () => {
    const e1 = recordDraw('sj', { question: '甲', spread: 'three', seed: 456, cut: 1, picks: [7, 23, 61] })
    const again = recordDraw('sj', { question: '甲', spread: 'three', seed: 456, cut: 1, picks: [7, 23, 61] })
    expect(again.id).toBe(e1.id)
    expect(readJournal('sj')).toHaveLength(1)
    recordDraw('sj', { question: '乙', spread: 'single', seed: 99, cut: 0, picks: [42] })
    expect(readJournal('sj')).toHaveLength(2)
    recordAsk('sj', e1.id)
    recordAsk('sj', e1.id)
    const st = journalStats('sj')
    expect(st.draws).toBe(2)
    expect(st.asked).toBe(2)
    expect(st.seen).toBe(4) // 三张阵 3 张 + 单张 1 张（无重复）
    expect(formatStats(st)).toBe('抽过 2 阵 · 遇见 4/78 张 · 请解 2 次')
    removeEntry('sj', e1.id)
    expect(readJournal('sj')).toHaveLength(1)
    expect(formatStats(journalStats('sj'))).toBe('抽过 1 阵 · 遇见 1/78 张 · 请解 0 次'.replace(' · 请解 0 次', ''))
  })
})

describe('M78：手记 / 图鉴弹窗', () => {
  it('手记弹窗：条目渲染 + 展开参数 + 再请解回填草稿', () => {
    recordDraw('sa', { question: '要不要换工作', spread: 'three', seed: 456, cut: 1, picks: [7, 23, 61] })
    const onClose = vi.fn()
    render(<JournalDialog open onClose={onClose} sessionId="sa" />)
    expect(document.body.textContent).toContain('要不要换工作')
    expect(document.body.textContent).toContain('三张牌阵')
    fireEvent.click(document.querySelector('.tc-journal-head')!)
    expect(document.body.textContent).toContain('复现参数：种子 456 · 切牌 1 · 选牌 [7, 23, 61]')
    fireEvent.click(q<HTMLButtonElement>('.tc-journal-ops .tc-ghost')[0]!) // 再请解
    expect(useUiStore.getState().composerInsert?.text).toContain('picks=[7,23,61]')
    expect(onClose).toHaveBeenCalled()
  })

  it('图鉴弹窗：大阿卡纳 22 → 权杖 14；点卡详情 + 问这张回填', () => {
    const onClose = vi.fn()
    render(<CodexDialog open onClose={onClose} sessionId="sa" />)
    expect(q('.tc-codex-cell')).toHaveLength(22)
    fireEvent.click(q<HTMLButtonElement>('.tc-codex-tab')[1]!) // 权杖
    expect(q('.tc-codex-cell')).toHaveLength(14)
    fireEvent.click(q<HTMLButtonElement>('.tc-codex-cell')[0]!)
    expect(document.querySelector('.tc-codex-detail')).toBeTruthy()
    fireEvent.click(document.querySelector('.tc-codex-detail .tc-ghost')!)
    expect(useUiStore.getState().composerInsert?.text).toContain('讲讲「权杖首牌」')
  })
})

describe('M78：牌面 / 牌背降级链', () => {
  it('逆位：虚线框 + 「逆位」角标（无凶兆色）；位图 onError → 程序化牌面', () => {
    render(<TarotCardFace card={{ name: '死神', orientation: '逆位', slug: 'major-13', position: '过去' }} variant="reveal" showPosition />)
    const face = document.querySelector('.tc-face')!
    expect(face.className).toContain('is-rev')
    expect(face.textContent).toContain('逆位')
    expect(face.textContent).toContain('过去')
    const img = document.querySelector('.tc-face-img')!
    expect(img.getAttribute('src')).toBe('/tarot/rws/major-13.jpg')
    fireEvent.error(img)
    const proc = document.querySelector('.tc-face-proc')!
    expect(proc).toBeTruthy()
    expect(proc.textContent).toContain('XIII')
    expect(proc.textContent).toContain('死神')
  })

  it('程序化小牌：花色符号 × 点数阵列（星币十 = 10 枚）', () => {
    render(<TarotCardFace card={{ name: '星币十', orientation: '正位', slug: '' }} variant="reveal" />)
    // slug 为空 → 直接程序化
    const pips = q('.tc-face-proc-pip')
    expect(pips).toHaveLength(10)
  })

  it('牌背：位图 onError → SVG 兜底绘制', () => {
    render(<CardBack />)
    const img = document.querySelector('.tc-back-img')!
    expect(img.getAttribute('src')).toBe('/tarot/back.jpg')
    fireEvent.error(img)
    expect(document.querySelector('.tc-back-svg')).toBeTruthy()
  })
})

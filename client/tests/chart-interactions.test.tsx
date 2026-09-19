/**
 * 图表交互增强（轻量内联口径）：博弈树 / 局势条 / 进度环 / 平面图——
 * 悬停淡化与对照锁定 / 双读数浮层 / 明细提示 / 尺寸提示；点击选择等既有行为零变化。
 */
import { describe, expect, it } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { SequenceView } from '../src/components/game/SequenceView'
import type { SequenceResult } from '../src/components/game/types'
import { MomentumBar, ProgressRing } from '../src/components/scene/parts'
import { addFurniture, emptyScene } from '../src/components/studio/design-scene-model'
import { StudioPlanView } from '../src/components/studio/StudioPlanView'

// ---------- 序贯博弈树 ----------

const SEQ: SequenceResult = {
  leader: 'long',
  follower: 'short',
  tree: {
    id: 'root',
    player: 'long',
    onPath: true,
    children: [
      {
        id: 'b1',
        player: 'long',
        action: 'aggressive',
        actionLabel: '进攻',
        onPath: true,
        children: [
          { id: 'l1', player: 'short', action: 'retreat', actionLabel: '撤退', onPath: true, optimal: true, payoffs: { long: 1.5, short: -0.5 } },
          { id: 'l2', player: 'short', action: 'hold', actionLabel: '观望', onPath: false, payoffs: { long: 0.8, short: 0.2 } },
        ],
      },
      {
        id: 'b2',
        player: 'long',
        action: 'hold',
        actionLabel: '观望',
        onPath: false,
        children: [{ id: 'l3', player: 'short', action: 'aggressive', actionLabel: '进攻', onPath: false, payoffs: { long: -0.3, short: 0.6 } }],
      },
    ],
  },
  equilibrium: {
    path: [
      { player: 'long', action: 'aggressive' },
      { player: 'short', action: 'retreat' },
    ],
    payoffs: { long: 1.5, short: -0.5 },
  },
  counterfactuals: [
    { action: 'hold', followerBest: 'aggressive', payoffs: { long: -0.3, short: 0.6 }, leaderDelta: -1.8 },
    { action: 'retreat', followerBest: 'aggressive', payoffs: { long: -1, short: 1 }, leaderDelta: -2.5 },
  ],
}

describe('SequenceView 博弈树（悬停淡化与对照锁定）', () => {
  it('悬停分支 → 其余分支淡化；点击分支与反事实条目双向联动锁定 / 解锁', () => {
    const { container } = render(<SequenceView result={SEQ} />)
    const svg = container.querySelector('.md-game-svg')!
    expect(svg).not.toBeNull()
    const branches = svg.querySelectorAll('.md-game-branch')
    expect(branches).toHaveLength(2)

    // 悬停第一分支 → 第二分支淡化；移出恢复
    fireEvent.mouseOver(branches[0]!)
    fireEvent.mouseEnter(branches[0]!)
    expect(branches[0]!.classList.contains('is-dim')).toBe(false)
    expect(branches[1]!.classList.contains('is-dim')).toBe(true)
    fireEvent.mouseOut(branches[0]!)
    fireEvent.mouseLeave(branches[0]!)
    expect(branches[1]!.classList.contains('is-dim')).toBe(false)

    // 点击第二分支（观望）→ 分支激活 + 对应反事实条目高亮；再点取消
    const boxes = svg.querySelectorAll('.md-game-nodebox')
    fireEvent.click(boxes[1]!)
    expect(boxes[1]!.classList.contains('is-active')).toBe(true)
    const items = container.querySelectorAll('.md-game-counterfactual-item')
    expect(items).toHaveLength(2)
    expect(items[0]!.classList.contains('is-active')).toBe(true)
    fireEvent.click(boxes[1]!)
    expect(boxes[1]!.classList.contains('is-active')).toBe(false)
    expect(items[0]!.classList.contains('is-active')).toBe(false)

    // 反事实条目反向联动
    fireEvent.click(items[1]!)
    expect(items[1]!.classList.contains('is-active')).toBe(true)
  })
})

// ---------- 局势条 ----------

describe('MomentumBar 局势条（悬停双读数）', () => {
  it('读数换算 50±v/2：浮层与 aria-label 同步', () => {
    const { container } = render(<MomentumBar value={60} leftLabel="多方" rightLabel="空方" />)
    const el = container.querySelector('[data-momentum]')!
    expect(el.getAttribute('aria-label')).toBe('局势条：多方 80 比 20 空方')
    expect(container.querySelector('.scene-mo-tip')!.textContent).toBe('多方 80 : 20 空方')
  })

  it('数值越界夹取（±100）与默认标签', () => {
    const { container } = render(<MomentumBar value={140} />)
    expect(container.querySelector('[data-momentum]')!.getAttribute('aria-label')).toBe('局势条：多方 100 比 0 空方')
  })
})

// ---------- 进度环 ----------

describe('ProgressRing 进度环（悬停明细）', () => {
  it('hint 注入浮层；aria-label 含标签与计数', () => {
    const { container } = render(<ProgressRing value={60} label="完成" sublabel="3/5" hint="已完成 3 / 5 项" />)
    expect(container.querySelector('.scene-ring')!.getAttribute('aria-label')).toBe('完成 60%（3/5）')
    expect(container.querySelector('.scene-ring-tip')!.textContent).toBe('已完成 3 / 5 项')
  })

  it('无 hint 回落「完成度 xx%」；数值夹取', () => {
    const { container } = render(<ProgressRing value={-5} />)
    expect(container.querySelector('.scene-ring-tip')!.textContent).toBe('完成度 0%')
  })
})

// ---------- 平面图 ----------

describe('StudioPlanView 平面图（悬停高亮与尺寸提示）', () => {
  it('悬停家具 → 高亮 + 尺寸浮层（类型 / 宽×深 m）；移出收回', () => {
    const scene = addFurniture(emptyScene('测试'), 'sofa')
    const { container } = render(<StudioPlanView scene={scene} size={320} />)
    const rect = container.querySelector('.studio-plan-furniture')!
    expect(rect).not.toBeNull()
    expect(container.querySelector('.studio-plan-tip')).toBeNull()

    fireEvent.mouseOver(rect)
    fireEvent.mouseEnter(rect)
    expect(rect.classList.contains('studio-plan-hot')).toBe(true)
    const tip = container.querySelector('.studio-plan-tip')!
    expect(tip.textContent).toContain('沙发')
    expect(tip.textContent).toContain('1.80 × 0.90 m')

    fireEvent.mouseOut(rect)
    fireEvent.mouseLeave(rect)
    expect(container.querySelector('.studio-plan-tip')).toBeNull()
  })
})

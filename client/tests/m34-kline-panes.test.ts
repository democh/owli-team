/**
 * M34 K 线渲染内核：副图面高度分配（纯函数；M83 迁移至 chart/layout）。
 *
 * 背景缺陷：klinecharts v10 布局语义为「副图面各取 layout.pane.height（缺省 100px）、
 * 主图蜡烛面只拿剩余高度」——聊天块矮容器（当时 320px）放 3 个副图（VOL/MACD/RSI）后
 * 主图剩余 ≤ 0，蜡烛整面不可见（表现为「没有展示 K 线」只有副图）。
 * 修复：创建指标后按容器高度显式分配副图面高度，优先保障主图。
 * 后续调优：聊天块容器 320px → 420px → 560px、全屏 640px → 720px → 860px（展示高度过小），
 * 主图保底占比 45% → 50%（图例浮层 + 蜡烛需主图占大头），断言随容器高度同步更新。
 *
 * 说明：实现已迁至 components/finance/chart/layout（不接触 klinecharts），本测试只覆盖纯函数。
 */
import { describe, expect, it } from 'vitest'

import { allocateSubPaneHeight } from '../src/components/finance/chart/layout'

describe('M34 K 线内核：副图面高度分配', () => {
  it('聊天块 560px + 3 副图：主图保底 ≥96px，副图可读 ≥30px', () => {
    const each = allocateSubPaneHeight(560, 3)
    expect(each).toBe(93)
    // 主图剩余 = 容器 - 副图合计（未计时间轴/分隔条，实际再少 ~25px）
    expect(560 - each * 3).toBeGreaterThanOrEqual(96)
    expect(each).toBeGreaterThanOrEqual(30)
  })

  it('全屏 860px + 3 副图：主图拿到大头（≥ 保底 430px），副图封顶 140px', () => {
    const each = allocateSubPaneHeight(860, 3)
    // floor(430/3)=143 触及 140 封顶
    expect(each).toBe(140)
    expect(each).toBeLessThanOrEqual(140)
    expect(860 - each * 3).toBe(440)
    expect(860 - each * 3).toBeGreaterThanOrEqual(430)
  })

  it('矮容器（画布节点 160px）：副图不小于 30px 下限（主图随剩余空间收缩）', () => {
    expect(allocateSubPaneHeight(160, 3)).toBe(30)
  })

  it('单副图（默认 MA+VOL）：副图不吞掉主图', () => {
    const each = allocateSubPaneHeight(560, 1)
    expect(each).toBeLessThanOrEqual(140)
    expect(560 - each).toBeGreaterThanOrEqual(144)
  })

  it('无副图 / 容器不可测量（隐藏面板）：返回 0 表示跳过分配', () => {
    expect(allocateSubPaneHeight(560, 0)).toBe(0)
    expect(allocateSubPaneHeight(0, 3)).toBe(0)
    expect(allocateSubPaneHeight(-10, 3)).toBe(0)
  })
})

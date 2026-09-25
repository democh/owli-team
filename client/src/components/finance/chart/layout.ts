/**
 * 副图面高度分配（M83 §5.1 迁移自 lib/kline.ts；数值断言由 m34-kline-panes 保留）。
 *
 * 背景缺陷：klinecharts v10 布局语义为「副图面各取 layout.pane.height（缺省 100px）、
 * 主图蜡烛面只拿剩余高度」——矮容器放 3 个副图后主图剩余 ≤ 0，蜡烛整面不可见。
 * 修复：创建指标后按容器高度显式分配副图面高度，优先保障主图（≥50% 且 ≥96px），
 * 每副图 30–140px；容器尺寸变化时重算。
 *
 * @returns 每个副图面的目标高度（px；容器高度不可用时返回 0 表示跳过）
 */
export function allocateSubPaneHeight(containerHeight: number, subPaneCount: number): number {
  if (subPaneCount <= 0 || containerHeight <= 0) return 0
  const candleFloor = Math.max(96, Math.round(containerHeight * 0.5))
  const each = Math.floor((containerHeight - candleFloor) / subPaneCount)
  return Math.max(30, Math.min(140, each))
}

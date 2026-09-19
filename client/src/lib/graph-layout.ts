/**
 * 协作图谱布局引擎（§28.4，M21）：纯函数，输出节点坐标表。
 * - 接力链（chain）：dagre 分层排序 → 单行长链 或 「蛇形赛道」自适应折行
 *   （容器窄时按 (rank, 层内序) 折行铺网格，填满视野；全屏 / 宽容器恢复单行）
 * - 圆桌（radial）：成员沿圆周均布 + 中心图腾（core），回答「谁和谁在互动」
 * - 入场延迟按列 / 折行顺序 / 角度编排；节点尺寸常量供布局、相机聚焦、命中检测共用
 * - M22：方向键几何导航（nextNodeInDirection）——按位置找「该方向最顺路」的节点
 * 说明：本模块随图谱懒加载 chunk 进入（GraphView 动态 import），不进首屏。
 */
import dagre from '@dagrejs/dagre'
import type { GraphModel } from './graph'

/** 节点卡片尺寸（与 AgentNode 渲染尺寸一致） */
export const NODE_W = 180
export const NODE_H = 60
/** 圆桌中心图腾节点 id（仅 radial 模式出现；不可拖动 / 不可选中） */
export const CORE_ID = '__core__'
/** 中心图腾直径 */
export const CORE_SIZE = 96
/** 折行赛道网格间距（画布坐标系） */
export const COL_GAP = 30
export const ROW_GAP = 46
/** 视野预留：图例（上）与 dock（下）占位，避免折行选档被覆盖层遮住内容 */
const VIEW_PAD_X = 76
const VIEW_PAD_Y = 128
/** 单行长链最低可读缩放：达到即保持「一行到底」的接力语义，低于则折行填满 */
const SINGLE_ROW_MIN_ZOOM = 0.7

export type LayoutMode = 'chain' | 'radial'

export interface LayoutResult {
  /** 节点左上角坐标 */
  positions: Map<string, { x: number; y: number }>
  /** 入场动画延迟（ms，按列 / 角度编排） */
  delays: Map<string, number>
  /** 中心图腾左上角坐标（仅 radial） */
  core?: { x: number; y: number }
  /** 接力链排名（dagre rank 序号，0 起；仅 chain）：回退接力判定——折行 / 拖动重排位置不改变语义 */
  ranks?: Map<string, number>
}

/** 圆桌半径：人数越多环越大（下限保证 1-2 人时不成点） */
export function radialRadius(count: number): number {
  return Math.max(150, count * 46)
}

/** 折行内容尺寸（perRow 列 × rows 行，含网格间距） */
function gridSize(count: number, perRow: number): { w: number; h: number } {
  const rows = Math.ceil(count / perRow)
  return {
    w: perRow * NODE_W + (perRow - 1) * COL_GAP,
    h: rows * NODE_H + (rows - 1) * ROW_GAP,
  }
}

/** 内容适配缩放（宽 / 高两向最小值；>1 表示还有放大余量） */
function fitZoom(count: number, perRow: number, width: number, height: number): number {
  const { w, h } = gridSize(count, perRow)
  return Math.min((width - VIEW_PAD_X) / w, (height - VIEW_PAD_Y) / h)
}

/**
 * 自适应选「每行节点数」（仅 chain 模式）：
 * 1) 单行能容纳（适配缩放 ≥ 1）→ 单行；
 * 2) 单行缩放仍达可读阈值（≥ SINGLE_ROW_MIN_ZOOM）→ 单行（全屏 / 宽容器保持长链语义）；
 * 3) 否则枚举 perRow，取适配缩放最大者（窄容器折行填满，节点尽量大）。
 */
export function pickChainPerRow(count: number, width: number, height: number): number {
  if (count <= 1) return Math.max(count, 1)
  if (width <= VIEW_PAD_X || height <= VIEW_PAD_Y) return count
  const single = fitZoom(count, count, width, height)
  if (single >= SINGLE_ROW_MIN_ZOOM) return count
  let best = count
  let bestZoom = -Infinity
  for (let k = 1; k <= count; k++) {
    const zoom = fitZoom(count, k, width, height)
    if (zoom > bestZoom + 1e-3) {
      bestZoom = zoom
      best = k
    }
  }
  return best
}

export interface LayoutOptions {
  /** chain 模式每行节点数（缺省 = 单行；由 pickChainPerRow 按容器尺寸给出） */
  chainPerRow?: number
}

export function layoutGraph(model: GraphModel, mode: LayoutMode, opts: LayoutOptions = {}): LayoutResult {
  const positions = new Map<string, { x: number; y: number }>()
  const delays = new Map<string, number>()

  if (mode === 'radial') {
    const n = model.nodes.length
    const radius = radialRadius(n)
    const start = -Math.PI / 2 // 12 点方向起排，顺时针
    model.nodes.forEach((node, i) => {
      const angle = start + (i / Math.max(n, 1)) * Math.PI * 2
      positions.set(node.id, {
        x: radius * Math.cos(angle) - NODE_W / 2,
        y: radius * Math.sin(angle) - NODE_H / 2,
      })
      delays.set(node.id, i * 40)
    })
    return { positions, delays, core: { x: -CORE_SIZE / 2, y: -CORE_SIZE / 2 } }
  }

  // ---- 接力链：dagre 分层排序（与 M17 口径一致）----
  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: 'LR', nodesep: 30, ranksep: 84, marginx: 24, marginy: 24 })
  for (const n of model.nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H })
  for (const e of model.edges) g.setEdge(e.source, e.target)
  dagre.layout(g)

  // 排名表：dagre x（LR 层级坐标）收敛为 0 起序号，供回退边判定（折行后位置重排但排名不变）
  const rankXs = [...new Set(model.nodes.map((n) => g.node(n.id)?.x ?? 0))].sort((a, b) => a - b)
  const ranks = new Map(model.nodes.map((n) => [n.id, rankXs.indexOf(g.node(n.id)?.x ?? 0)]))

  // 折行赛道：按 (rank, 层内序) 序列化 → 蛇形铺网格（偶数行左→右，奇数行右→左，折返处上下相邻保持连贯）
  const perRow = opts.chainPerRow ?? 0
  if (perRow >= 1 && perRow < model.nodes.length) {
    const order = [...model.nodes].sort((a, b) => {
      const na = g.node(a.id)
      const nb = g.node(b.id)
      return (na?.x ?? 0) - (nb?.x ?? 0) || (na?.y ?? 0) - (nb?.y ?? 0)
    })
    order.forEach((n, i) => {
      const row = Math.floor(i / perRow)
      const col = row % 2 === 0 ? i % perRow : perRow - 1 - (i % perRow)
      positions.set(n.id, { x: col * (NODE_W + COL_GAP), y: row * (NODE_H + ROW_GAP) })
      delays.set(n.id, i * 45)
    })
    return { positions, delays, ranks }
  }

  // 入场编排：同一列（x 相同）共享延迟
  const delayOf = new Map(rankXs.map((x, i) => [x, i * 70]))

  for (const n of model.nodes) {
    const pos = g.node(n.id)
    positions.set(n.id, {
      x: (pos?.x ?? 0) - NODE_W / 2,
      y: (pos?.y ?? 0) - NODE_H / 2,
    })
    delays.set(n.id, delayOf.get(pos?.x ?? 0) ?? 0)
  }
  return { positions, delays, ranks }
}

// ---------- M22：方向键几何导航 ----------

export type NavDirection = 'left' | 'right' | 'up' | 'down'

/**
 * 从 currentId 出发，沿 dir 找「最顺路」的下一个节点（键盘导航）。
 * 评分 = 主轴距离 + 2 × 垂直偏移（同行 / 同列优先）；仅取严格正方向的候选；
 * 无候选返回 undefined（焦点停在原地）。
 */
export function nextNodeInDirection(
  positions: ReadonlyMap<string, { x: number; y: number }>,
  currentId: string,
  dir: NavDirection,
): string | undefined {
  const cur = positions.get(currentId)
  if (!cur) return undefined
  const cx = cur.x + NODE_W / 2
  const cy = cur.y + NODE_H / 2
  let best: string | undefined
  let bestScore = Infinity
  for (const [id, p] of positions) {
    if (id === currentId) continue
    const dx = p.x + NODE_W / 2 - cx
    const dy = p.y + NODE_H / 2 - cy
    let primary: number
    let perp: number
    switch (dir) {
      case 'left':
        primary = -dx
        perp = Math.abs(dy)
        break
      case 'right':
        primary = dx
        perp = Math.abs(dy)
        break
      case 'up':
        primary = -dy
        perp = Math.abs(dx)
        break
      case 'down':
        primary = dy
        perp = Math.abs(dx)
        break
    }
    if (primary <= 0) continue
    const score = primary + perp * 2
    if (score < bestScore) {
      bestScore = score
      best = id
    }
  }
  return best
}

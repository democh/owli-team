/**
 * M31：画布纯函数层 —— 节点尺寸表 / 连线合法性矩阵 / 剪贴板 / 对齐与分布 / 网格整理 /
 * z 序 / 画框收纳（parent 归属与脱离）/ 对齐参考线吸附 / 脑图折叠隐藏集 / 摘要文案。
 *
 * 与 React Flow 解耦：输入输出均为 shared 的 CanvasNode / CanvasEdge 内容（可单测）。
 * 坐标约定：顶层节点为画布绝对坐标；子节点（parentId）为父画框内相对坐标。
 */
import type { CanvasDoc, CanvasEdge, CanvasEdgeKind, CanvasNode, CanvasNodeData, CanvasNodeType } from '@multi-agent/shared'
import { visualOfFile } from './attachments'

/** id 生成（与项目既有 `${prefix}_${uuid8}` 口径一致；jsdom 无 randomUUID 时回落） */
function uid8(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID().slice(0, 8)
  return Math.random().toString(16).slice(2, 10).padEnd(8, '0')
}

/** fitView 缩放上限与留白（画布口径：不对小内容做超原生尺寸的放大；缩放指示器 / 快捷键共用） */
export const FIT_MAX_ZOOM = 1
export const FIT_VIEW_PADDING = 0.2

export function newNodeId(): string {
  return `nd_${uid8()}`
}

export function newEdgeId(): string {
  return `ed_${uid8()}`
}

/** 各类节点默认尺寸（布局计算与渲染兜底；image / video 拖入后可按真实素材覆盖） */
export const NODE_SIZE: Record<CanvasNodeType, { width: number; height: number }> = {
  image: { width: 280, height: 200 },
  video: { width: 320, height: 212 },
  note: { width: 220, height: 140 },
  prompt: { width: 260, height: 150 },
  mind: { width: 180, height: 44 },
  artifact: { width: 240, height: 60 },
  group: { width: 380, height: 260 },
  game: { width: 480, height: 360 },
  kline: { width: 560, height: 380 },
}

export function sizeOf(node: Pick<CanvasNode, 'type' | 'width' | 'height'>): { width: number; height: number } {
  const def = NODE_SIZE[node.type]
  return { width: node.width ?? def.width, height: node.height ?? def.height }
}

/** 节点构造器（模板 / 创建菜单共用；id 自动生成） */
export function createNode(
  type: CanvasNodeType,
  position: { x: number; y: number },
  data: CanvasNodeData,
  opts?: { width?: number; height?: number; parentId?: string },
): CanvasNode {
  const node: CanvasNode = {
    id: newNodeId(),
    type,
    position: { x: Math.round(position.x), y: Math.round(position.y) },
    data,
  }
  if (opts?.width !== undefined) node.width = opts.width
  if (opts?.height !== undefined) node.height = opts.height
  if (opts?.parentId) node.parentId = opts.parentId
  return node
}

// ---------- 连线合法性矩阵 ----------

/**
 * 连线类型矩阵：生成数据流（prompt / image / artifact → image / video）为 flow；
 * 脑图节点之间为 mind；其余关联为 ref；画框不参与连线；自连由调用方拒绝。
 */
export function canConnect(source: CanvasNodeType, target: CanvasNodeType): CanvasEdgeKind | null {
  if (source === 'group' || target === 'group') return null
  if (source === 'mind' && target === 'mind') return 'mind'
  const flowSource = source === 'prompt' || source === 'image' || source === 'artifact'
  const flowTarget = target === 'image' || target === 'video'
  if (flowSource && flowTarget) return 'flow'
  return 'ref'
}

// ---------- 画布内查找（M31 修订） ----------

/** 查找命中（面板列表行） */
export interface CanvasSearchHit {
  id: string
  type: CanvasNodeType
  /** 主文案（节点标签截断） */
  label: string
  /** 副文案（类型 + 匹配片段） */
  snippet: string
}

/** 可搜索文本（按类型提取展示字段：文本 / 标题 / 提示词 / 路径 / 名称 / 标的 / 话题） */
function searchableText(node: CanvasNode): string {
  const d = node.data as Record<string, unknown>
  const parts: string[] = []
  for (const key of ['text', 'title', 'prompt', 'negative', 'path', 'artifact', 'name', 'symbol', 'topic'] as const) {
    const v = d[key]
    if (typeof v === 'string' && v) parts.push(v)
  }
  return parts.join(' ')
}

/** 画布内查找：按文本匹配全部节点类型，大小写不敏感；空查询返回空（limit 防大画布列表失控） */
export function searchNodes(doc: CanvasDoc, query: string, limit = 12): CanvasSearchHit[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const hits: CanvasSearchHit[] = []
  for (const n of doc.nodes) {
    const text = searchableText(n)
    const idx = text.toLowerCase().indexOf(q)
    if (idx < 0) continue
    const from = Math.max(0, idx - 16)
    const slice = text.slice(from, from + 56)
    const label = nodeLabel(n)
    hits.push({
      id: n.id,
      type: n.type,
      label: label.length > 42 ? `${label.slice(0, 42)}…` : label,
      snippet: `${NODE_TYPE_LABEL[n.type]} · ${from > 0 ? '…' : ''}${slice}${text.length > from + 56 ? '…' : ''}`,
    })
    if (hits.length >= limit) break
  }
  return hits
}

// ---------- 剪贴板 ----------

export interface CanvasClipboard {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
}

function cloneNode(n: CanvasNode): CanvasNode {
  return { ...n, position: { ...n.position }, data: { ...n.data } as CanvasNodeData }
}

/**
 * 提取选区子图：父不在选区的子节点转绝对坐标并脱离画框（复制到别处不产生孤儿）。
 */
export function extractClipboard(
  nodes: readonly CanvasNode[],
  edges: readonly CanvasEdge[],
  ids: ReadonlySet<string>,
): CanvasClipboard {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const picked = nodes.filter((n) => ids.has(n.id))
  const keep = new Set(picked.map((n) => n.id))
  const detached = picked.map((n) => {
    if (!n.parentId || keep.has(n.parentId)) return cloneNode(n)
    const parent = byId.get(n.parentId)
    const clone = cloneNode(n)
    delete clone.parentId
    if (parent) clone.position = { x: n.position.x + parent.position.x, y: n.position.y + parent.position.y }
    return clone
  })
  return { nodes: detached, edges: edges.filter((e) => keep.has(e.source) && keep.has(e.target)).map((e) => ({ ...e })) }
}

/** 剪贴板 → 新节点 / 新边（id 重映射，整体偏移偏移量） */
export function materializeClipboard(clip: CanvasClipboard, dx: number, dy: number): CanvasClipboard {
  const idMap = new Map<string, string>()
  const nodes = clip.nodes.map((n) => {
    const id = newNodeId()
    idMap.set(n.id, id)
    return {
      ...cloneNode(n),
      id,
      position: { x: Math.round(n.position.x + dx), y: Math.round(n.position.y + dy) },
    }
  })
  for (const n of nodes) {
    if (!n.parentId) continue
    const mapped = idMap.get(n.parentId)
    if (mapped) n.parentId = mapped
    else delete n.parentId
  }
  const edges: CanvasEdge[] = []
  for (const e of clip.edges) {
    const source = idMap.get(e.source)
    const target = idMap.get(e.target)
    if (source && target) edges.push({ id: newEdgeId(), source, target, kind: e.kind })
  }
  return { nodes, edges }
}

// ---------- 对齐 / 分布 / 网格整理 ----------

export type AlignMode = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom'

/** 选中集合对齐（基准 = 选中集合外接框；返回新数组，未选中 / 未移动节点保持引用） */
export function alignNodes(nodes: readonly CanvasNode[], ids: ReadonlySet<string>, mode: AlignMode): CanvasNode[] {
  const picked = nodes.filter((n) => ids.has(n.id))
  if (picked.length < 2) return [...nodes]
  const boxes = picked.map((n) => ({ node: n, ...sizeOf(n) }))
  const left = Math.min(...boxes.map((b) => b.node.position.x))
  const right = Math.max(...boxes.map((b) => b.node.position.x + b.width))
  const top = Math.min(...boxes.map((b) => b.node.position.y))
  const bottom = Math.max(...boxes.map((b) => b.node.position.y + b.height))
  return nodes.map((n) => {
    if (!ids.has(n.id)) return n
    const { width, height } = sizeOf(n)
    let { x, y } = n.position
    switch (mode) {
      case 'left':
        x = left
        break
      case 'hcenter':
        x = (left + right) / 2 - width / 2
        break
      case 'right':
        x = right - width
        break
      case 'top':
        y = top
        break
      case 'vcenter':
        y = (top + bottom) / 2 - height / 2
        break
      case 'bottom':
        y = bottom - height
        break
    }
    x = Math.round(x)
    y = Math.round(y)
    if (x === n.position.x && y === n.position.y) return n
    return { ...n, position: { x, y } }
  })
}

/** 等距分布（按中心距离均分；首尾节点固定；少于 3 个不动作） */
export function distributeNodes(nodes: readonly CanvasNode[], ids: ReadonlySet<string>, axis: 'h' | 'v'): CanvasNode[] {
  const picked = nodes.filter((n) => ids.has(n.id))
  if (picked.length < 3) return [...nodes]
  const horizontal = axis === 'h'
  const sorted = [...picked].sort((a, b) => (horizontal ? a.position.x - b.position.x : a.position.y - b.position.y))
  const centerOf = (n: CanvasNode): number => {
    const s = sizeOf(n)
    return horizontal ? n.position.x + s.width / 2 : n.position.y + s.height / 2
  }
  const first = centerOf(sorted[0]!)
  const last = centerOf(sorted[sorted.length - 1]!)
  const step = (last - first) / (sorted.length - 1)
  const targets = new Map<string, number>()
  sorted.forEach((n, i) => {
    const size = sizeOf(n)
    const center = first + step * i
    targets.set(n.id, Math.round(horizontal ? center - size.width / 2 : center - size.height / 2))
  })
  return nodes.map((n) => {
    const t = targets.get(n.id)
    if (t === undefined) return n
    const position = horizontal ? { x: t, y: n.position.y } : { x: n.position.x, y: t }
    if (position.x === n.position.x && position.y === n.position.y) return n
    return { ...n, position }
  })
}

/** 网格整理（选中集合按当前视觉顺序铺格；列宽 / 行高取集合最大值保证整齐） */
export function tidyGrid(
  nodes: readonly CanvasNode[],
  ids: ReadonlySet<string>,
  opts?: { columns?: number; gapX?: number; gapY?: number },
): CanvasNode[] {
  const picked = nodes.filter((n) => ids.has(n.id))
  if (picked.length < 2) return [...nodes]
  const gapX = opts?.gapX ?? 44
  const gapY = opts?.gapY ?? 44
  const columns = Math.max(1, opts?.columns ?? Math.ceil(Math.sqrt(picked.length)))
  const sorted = [...picked].sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x)
  const cellW = Math.max(...picked.map((n) => sizeOf(n).width))
  const cellH = Math.max(...picked.map((n) => sizeOf(n).height))
  const originX = Math.min(...picked.map((n) => n.position.x))
  const originY = Math.min(...picked.map((n) => n.position.y))
  const targets = new Map<string, { x: number; y: number }>()
  sorted.forEach((n, i) => {
    const col = i % columns
    const row = Math.floor(i / columns)
    targets.set(n.id, {
      x: Math.round(originX + col * (cellW + gapX)),
      y: Math.round(originY + row * (cellH + gapY)),
    })
  })
  return nodes.map((n) => {
    const t = targets.get(n.id)
    if (!t) return n
    if (t.x === n.position.x && t.y === n.position.y) return n
    return { ...n, position: t }
  })
}

// ---------- z 序（React Flow 以数组顺序渲染，越靠后越在上层） ----------

export type ZMode = 'forward' | 'backward' | 'front' | 'back'

export function reorderNodes(nodes: readonly CanvasNode[], ids: ReadonlySet<string>, mode: ZMode): CanvasNode[] {
  let result = [...nodes]
  if (mode === 'front' || mode === 'back') {
    const picked = result.filter((n) => ids.has(n.id))
    if (picked.length === 0 || picked.length === result.length) return result
    const rest = result.filter((n) => !ids.has(n.id))
    result = mode === 'front' ? [...rest, ...picked] : [...picked, ...rest]
  } else if (mode === 'forward') {
    for (let i = result.length - 2; i >= 0; i -= 1) {
      if (ids.has(result[i]!.id) && !ids.has(result[i + 1]!.id)) {
        const tmp = result[i]!
        result[i] = result[i + 1]!
        result[i + 1] = tmp
      }
    }
  } else {
    for (let i = 1; i < result.length; i += 1) {
      if (ids.has(result[i]!.id) && !ids.has(result[i - 1]!.id)) {
        const tmp = result[i]!
        result[i] = result[i - 1]!
        result[i - 1] = tmp
      }
    }
  }
  return ensureParentOrder(result)
}

/**
 * 画框收纳不变式：子节点必须排在其父之后（React Flow 渲染与拖拽跟随要求）。
 * 未破坏顺序时原样返回。
 */
export function ensureParentOrder(nodes: readonly CanvasNode[]): CanvasNode[] {
  if (nodes.length === 0) return [...nodes]
  const indexOf = new Map(nodes.map((n, i) => [n.id, i]))
  const ok = nodes.every((n) => {
    if (!n.parentId) return true
    const pi = indexOf.get(n.parentId)
    return pi === undefined || pi < indexOf.get(n.id)!
  })
  if (ok) return [...nodes]
  const result: CanvasNode[] = []
  const done = new Set<string>()
  const push = (n: CanvasNode): void => {
    if (done.has(n.id)) return
    done.add(n.id)
    if (n.parentId) {
      const parent = nodes.find((x) => x.id === n.parentId)
      if (parent) push(parent)
    }
    result.push(n)
  }
  for (const n of nodes) push(n)
  return result
}

// ---------- 画框收纳（parent 归属重算） ----------

/** 节点绝对坐标（parentId 链式回溯；缺父时按原坐标） */
export function absolutePosition(node: CanvasNode, byId: ReadonlyMap<string, CanvasNode>): { x: number; y: number } {
  if (!node.parentId) return node.position
  const parent = byId.get(node.parentId)
  if (!parent) return node.position
  const p = absolutePosition(parent, byId)
  return { x: p.x + node.position.x, y: p.y + node.position.y }
}

function centerInside(center: { x: number; y: number }, frame: CanvasNode): boolean {
  const s = sizeOf(frame)
  return (
    center.x >= frame.position.x &&
    center.x <= frame.position.x + s.width &&
    center.y >= frame.position.y &&
    center.y <= frame.position.y + s.height
  )
}

/**
 * 拖拽停止后重算画框归属：
 * - 顶层节点中心落入某个画框 → 收纳（转相对坐标，多个候选取面积最小者）；
 * - 子节点中心拖出父框 → 脱离（转绝对坐标）；
 * 返回新数组（无变化时元素引用保持）。
 */
export function reparentNodes(nodes: readonly CanvasNode[], movedIds: readonly string[]): CanvasNode[] {
  if (movedIds.length === 0) return [...nodes]
  const moved = new Set(movedIds)
  const byId = new Map(nodes.map((n) => [n.id, n]))
  let changed = false
  const result = nodes.map((n) => {
    if (!moved.has(n.id) || n.type === 'group') return n
    const size = sizeOf(n)
    if (n.parentId) {
      const parent = byId.get(n.parentId)
      if (!parent) return n
      const abs = absolutePosition(n, byId)
      const center = { x: abs.x + size.width / 2, y: abs.y + size.height / 2 }
      if (centerInside(center, parent)) return n
      changed = true
      const clone = { ...n, position: abs }
      delete clone.parentId
      return clone
    }
    const abs = n.position
    const center = { x: abs.x + size.width / 2, y: abs.y + size.height / 2 }
    let best: CanvasNode | undefined
    let bestArea = Infinity
    for (const g of nodes) {
      if (g.type !== 'group' || moved.has(g.id)) continue
      if (!centerInside(center, g)) continue
      const gs = sizeOf(g)
      const area = gs.width * gs.height
      if (area < bestArea) {
        best = g
        bestArea = area
      }
    }
    if (!best) return n
    changed = true
    return {
      ...n,
      parentId: best.id,
      position: { x: Math.round(abs.x - best.position.x), y: Math.round(abs.y - best.position.y) },
    }
  })
  return changed ? ensureParentOrder(result) : [...nodes]
}

/** 删除画框时的孤儿处理：被删节点的子节点转绝对坐标脱离（在过滤前调用） */
export function detachOrphans(nodes: readonly CanvasNode[], removedIds: ReadonlySet<string>): CanvasNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  return nodes.map((n) => {
    if (!n.parentId || !removedIds.has(n.parentId)) return n
    const parent = byId.get(n.parentId)
    const abs = parent ? { x: n.position.x + parent.position.x, y: n.position.y + parent.position.y } : n.position
    const clone = { ...n, position: abs }
    delete clone.parentId
    return clone
  })
}

// ---------- 对齐参考线（吸附） ----------

export interface SnapRect {
  x: number
  y: number
  width: number
  height: number
}

export interface SnapGuide {
  orientation: 'v' | 'h'
  /** 画布坐标（竖线为 x，横线为 y） */
  position: number
  /** 参考线覆盖区间的起点 / 终点（画布坐标） */
  from: number
  to: number
  /** M31 修订：对齐线（缺省）/ 等距标记（Figma 等距语义，渲染为独立颜色） */
  kind?: 'align' | 'dist'
}

export interface SnapResult {
  position: { x: number; y: number }
  guides: SnapGuide[]
}

export const SNAP_THRESHOLD = 6

/** 左 / 中 / 右（上 / 中 / 下）三个基准位 */
function landmarksX(r: SnapRect): number[] {
  return [r.x, r.x + r.width / 2, r.x + r.width]
}

function landmarksY(r: SnapRect): number[] {
  return [r.y, r.y + r.height / 2, r.y + r.height]
}

/** M31 修订：等距吸附——moving 被两节点水平/垂直夹击且两侧间隙近似相等时，吸附到等距中点（Figma 等距语义；优先于普通对齐） */
function distSnap(moving: SnapRect, others: readonly SnapRect[], threshold: number): { dx?: number; dy?: number; guides: SnapGuide[] } {
  const guides: SnapGuide[] = []
  let dx: number | undefined
  let dy: number | undefined

  // 水平：左邻（右缘 ≤ moving 左缘中最右）/ 右邻（左缘 ≥ moving 右缘中最左）
  let left: SnapRect | undefined
  let right: SnapRect | undefined
  let top: SnapRect | undefined
  let bottom: SnapRect | undefined
  for (const o of others) {
    if (o.x + o.width <= moving.x) {
      if (!left || o.x + o.width > left.x + left.width) left = o
    } else if (o.x >= moving.x + moving.width) {
      if (!right || o.x < right.x) right = o
    }
    if (o.y + o.height <= moving.y) {
      if (!top || o.y + o.height > top.y + top.height) top = o
    } else if (o.y >= moving.y + moving.height) {
      if (!bottom || o.y < bottom.y) bottom = o
    }
  }
  if (left && right) {
    const gap = (right.x - (left.x + left.width) - moving.width) / 2
    if (gap > 0.5) {
      const target = left.x + left.width + gap
      const d = target - moving.x
      if (Math.abs(d) <= threshold) {
        dx = d
        const from = Math.min(left.y, right.y, moving.y)
        const to = Math.max(left.y + left.height, right.y + right.height, moving.y + moving.height)
        // 两条标记线：两侧间隙的各中点
        guides.push({ orientation: 'v', position: left.x + left.width + gap / 2, from, to, kind: 'dist' })
        guides.push({ orientation: 'v', position: target + moving.width + gap / 2, from, to, kind: 'dist' })
      }
    }
  }
  if (top && bottom) {
    const gap = (bottom.y - (top.y + top.height) - moving.height) / 2
    if (gap > 0.5) {
      const target = top.y + top.height + gap
      const d = target - moving.y
      if (Math.abs(d) <= threshold) {
        dy = d
        const from = Math.min(top.x, bottom.x, moving.x)
        const to = Math.max(top.x + top.width, bottom.x + bottom.width, moving.x + moving.width)
        guides.push({ orientation: 'h', position: top.y + top.height + gap / 2, from, to, kind: 'dist' })
        guides.push({ orientation: 'h', position: target + moving.height + gap / 2, from, to, kind: 'dist' })
      }
    }
  }
  return { dx, dy, guides }
}

/**
 * 对齐吸附：moving 与 others 的三基准位比对，取最近的小于阈值的偏移量吸附；
 * 同时返回该位置上的参考线（覆盖 moving 与参与节点区间）；
 * M31 修订：叠加等距吸附（被两侧夹击且间距相等时优先吸附到等距位）。
 */
export function computeSnap(moving: SnapRect, others: readonly SnapRect[], threshold = SNAP_THRESHOLD): SnapResult {
  const mV = landmarksX(moving)
  const mH = landmarksY(moving)
  let dx: number | undefined
  let dy: number | undefined
  for (const o of others) {
    for (const a of mV) {
      for (const b of landmarksX(o)) {
        const d = b - a
        if (Math.abs(d) <= threshold && (dx === undefined || Math.abs(d) < Math.abs(dx))) dx = d
      }
    }
    for (const a of mH) {
      for (const b of landmarksY(o)) {
        const d = b - a
        if (Math.abs(d) <= threshold && (dy === undefined || Math.abs(d) < Math.abs(dy))) dy = d
      }
    }
  }
  // M31 修订：等距吸附（更强意图，命中时覆盖对齐位移）
  const dist = distSnap(moving, others, threshold)
  if (dist.dx !== undefined) dx = dist.dx
  if (dist.dy !== undefined) dy = dist.dy
  const position = { x: moving.x + (dx ?? 0), y: moving.y + (dy ?? 0) }
  const snapped: SnapRect = { ...moving, ...position }
  const guides: SnapGuide[] = []
  if (dx !== undefined) {
    const sV = landmarksX(snapped)
    const positions = new Set<number>()
    let from = snapped.y
    let to = snapped.y + snapped.height
    for (const o of others) {
      const oV = landmarksX(o)
      const hit = oV.filter((b) => sV.some((a) => Math.abs(a - b) < 0.5))
      if (hit.length === 0) continue
      for (const b of hit) positions.add(b)
      from = Math.min(from, o.y)
      to = Math.max(to, o.y + o.height)
    }
    for (const p of positions) guides.push({ orientation: 'v', position: p, from, to })
  }
  if (dy !== undefined) {
    const sH = landmarksY(snapped)
    const positions = new Set<number>()
    let from = snapped.x
    let to = snapped.x + snapped.width
    for (const o of others) {
      const oH = landmarksY(o)
      const hit = oH.filter((b) => sH.some((a) => Math.abs(a - b) < 0.5))
      if (hit.length === 0) continue
      for (const b of hit) positions.add(b)
      from = Math.min(from, o.x)
      to = Math.max(to, o.x + o.width)
    }
    for (const p of positions) guides.push({ orientation: 'h', position: p, from, to })
  }
  // M31 修订：等距标记随对齐线一同返回（kind='dist'，前端以独立颜色渲染）
  return { position, guides: dist.guides.length > 0 ? [...guides, ...dist.guides] : guides }
}

// ---------- 脑图折叠 ----------

/** collapsed 脑图节点的全部后代隐藏集（渲染过滤用；含 mind 边链逐层展开） */
export function collapsedHiddenIds(nodes: readonly CanvasNode[], edges: readonly CanvasEdge[]): Set<string> {
  const childrenOf = new Map<string, string[]>()
  for (const e of edges) {
    if (e.kind !== 'mind') continue
    const list = childrenOf.get(e.source)
    if (list) list.push(e.target)
    else childrenOf.set(e.source, [e.target])
  }
  const hidden = new Set<string>()
  const stack: string[] = []
  for (const n of nodes) {
    const data = n.data as { collapsed?: boolean }
    if (n.type === 'mind' && data.collapsed) stack.push(...(childrenOf.get(n.id) ?? []))
  }
  const byId = new Set(nodes.map((n) => n.id))
  while (stack.length > 0) {
    const id = stack.pop()!
    if (hidden.has(id) || !byId.has(id)) continue
    hidden.add(id)
    stack.push(...(childrenOf.get(id) ?? []))
  }
  return hidden
}

// ---------- 摘要 / 展示 ----------

/** 节点标题文案（画布内展示与引用兜底） */
export function nodeLabel(node: CanvasNode): string {
  const data = node.data as Record<string, unknown>
  if (typeof data.text === 'string' && data.text.trim()) return data.text
  if (typeof data.title === 'string' && data.title.trim()) return data.title
  if (typeof data.topic === 'string' && data.topic.trim()) return data.topic
  if (typeof data.prompt === 'string' && data.prompt.trim()) return data.prompt
  if (typeof data.artifact === 'string' && data.artifact) return data.artifact.split('/').pop() ?? data.artifact
  if (typeof data.path === 'string' && data.path) return data.path.split('/').pop() ?? data.path
  return node.type
}

const NODE_TYPE_LABEL: Record<CanvasNodeType, string> = {
  image: '图片',
  video: '视频',
  note: '便签',
  prompt: '提示词',
  mind: '脑图',
  artifact: '交付件',
  group: '画框',
  game: '博弈',
  kline: 'K 线',
}

/** 「引用到对话」文案（素材类带工作区路径，纯文本类带内容） */
export function quoteForComposer(node: CanvasNode): string {
  const data = node.data as Record<string, unknown>
  const artifact = typeof data.artifact === 'string' ? data.artifact : undefined
  if (artifact) return `[画布${NODE_TYPE_LABEL[node.type]}] ${artifact}\n`
  if (node.type === 'artifact' && typeof data.path === 'string') return `[画布交付件] ${data.path}\n`
  if (node.type === 'kline') {
    const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : undefined
    const symbol = typeof data.symbol === 'string' && data.symbol.trim() ? data.symbol.trim() : undefined
    return `[画布K线] ${name ?? symbol ?? 'K 线'}\n`
  }
  return `[画布${NODE_TYPE_LABEL[node.type]}] ${nodeLabel(node)}\n`
}

// ---------- 工作区文件 → 画布落位 ----------

/**
 * 工作区文件路径 → 画布节点类型：图片 / 视频走直出节点，其余按交付件引用节点。
 * 扩展名口径与附件视觉分类（lib/attachments.ts visualOfFile）一致。
 */
export function canvasNodeTypeOf(path: string): 'image' | 'video' | 'artifact' {
  const visual = visualOfFile(path.split('/').pop() ?? path, '')
  if (visual === 'image') return 'image'
  if (visual === 'video') return 'video'
  return 'artifact'
}

/**
 * 新节点落位坐标（「送上画布」/ 命令面板新建）：与 server canvas/store.ts autoPosition 同语义——
 * 现有内容右缘 +80 空位、纵向对齐最上方节点；空画布取原点。
 */
export function nextPlacement(nodes: readonly CanvasNode[]): { x: number; y: number } {
  if (nodes.length === 0) return { x: 0, y: 0 }
  let maxX = -Infinity
  let minY = Infinity
  for (const n of nodes) {
    maxX = Math.max(maxX, n.position.x + sizeOf(n).width)
    minY = Math.min(minY, n.position.y)
  }
  return { x: Math.round(maxX + 80), y: Math.round(minY) }
}

/** 外接框（工具条整理 / 校验用） */
export function boundingBox(nodes: readonly CanvasNode[]): SnapRect | null {
  if (nodes.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of nodes) {
    const s = sizeOf(n)
    minX = Math.min(minX, n.position.x)
    minY = Math.min(minY, n.position.y)
    maxX = Math.max(maxX, n.position.x + s.width)
    maxY = Math.max(maxY, n.position.y + s.height)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

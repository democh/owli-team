/**
 * M31：脑图纯函数层（P4）—— mind 边索引 / 树操作（加子 / 加兄弟 / 删除子树 / 重挂）/
 * dagre 树布局（根保持原位）/ LLM 树落画布 / Markdown 大纲解析与导出。
 *
 * 与 React Flow / store 解耦：输入输出均为 shared 的 CanvasNode / CanvasEdge 内容（可单测）。
 * 结构约定：mind 节点间用 kind='mind' 的边表达父子（父 → 子）；无入边的 mind 节点为根。
 * 本模块随画布懒加载 chunk 进入（CanvasView 动态 import）。
 */
import dagre from '@dagrejs/dagre'
import type { CanvasEdge, CanvasNode, MindTreeNode } from '@multi-agent/shared'
import { createNode, newEdgeId } from './canvas'

/** 父子列间距 / 兄弟行间距（与画布视觉节奏一致） */
export const MIND_H_GAP = 72
export const MIND_V_GAP = 18

// ---------- 索引 ----------

export interface MindIndex {
  childrenOf: Map<string, string[]>
  parentOf: Map<string, string>
}

/** 构建 mind 边邻接（仅收两端均为 mind 节点的 mind 边；防御 agent 写入异常边） */
export function indexMind(nodes: readonly CanvasNode[], edges: readonly CanvasEdge[]): MindIndex {
  const isMind = new Set(nodes.filter((n) => n.type === 'mind').map((n) => n.id))
  const childrenOf = new Map<string, string[]>()
  const parentOf = new Map<string, string>()
  for (const e of edges) {
    if (e.kind !== 'mind') continue
    if (!isMind.has(e.source) || !isMind.has(e.target)) continue
    if (parentOf.has(e.target)) continue // 每节点至多一个父（后写不入）
    parentOf.set(e.target, e.source)
    const list = childrenOf.get(e.source)
    if (list) list.push(e.target)
    else childrenOf.set(e.source, [e.target])
  }
  return { childrenOf, parentOf }
}

/** 全部根（无 mind 入边），按阅读序（先 y 后 x）排序 */
export function mindRoots(nodes: readonly CanvasNode[], index: MindIndex): string[] {
  return nodes
    .filter((n) => n.type === 'mind' && !index.parentOf.has(n.id))
    .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x)
    .map((n) => n.id)
}

/** 所在树的根（无父即自身） */
export function mindRootOf(index: MindIndex, id: string): string {
  let cur = id
  const seen = new Set<string>([cur])
  for (;;) {
    const parent = index.parentOf.get(cur)
    if (!parent || seen.has(parent)) return cur
    seen.add(parent)
    cur = parent
  }
}

/** 子树节点（DFS 前序，含自身；环防御） */
export function mindSubtreeIds(index: MindIndex, rootId: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const stack = [rootId]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
    const children = index.childrenOf.get(id)
    if (!children) continue
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]!)
  }
  return out
}

/** candidateId 是否位于 ancestorId 的子树内（含自身；重挂防环用） */
export function isMindDescendant(index: MindIndex, ancestorId: string, candidateId: string): boolean {
  return mindSubtreeIds(index, ancestorId).includes(candidateId)
}

// ---------- 尺寸估算（MindNode 为 w-fit 胶囊，长文本折行；布局按文本估宽估高） ----------

/** 单字符估算宽：CJK（含全角标点）≈ 12px / 其余 ≈ 6.8px */
function charWidth(ch: string): number {
  return (ch.codePointAt(0) ?? 0) > 0x2e7f ? 12 : 6.8
}

/** 胶囊文本区最大宽（= MindNode max-w-52）/ 行高（leading-5）/ 单行盒高（py-1.5 + 边框） */
const MIND_TEXT_MAX_W = 208
const MIND_LINE_H = 20
const MIND_BOX_BASE_H = 34

/**
 * 折行行数估算（与浏览器渲染规则近似）：
 * 全角 / CJK 逐字可断；拉丁数字按词不拆（词间断行）；超行宽单词硬拆（break-words）。
 */
function estimateMindLines(text: string): number {
  const tokens =
    (text || '主题').match(
      /[\p{Script=Han}\u3000-\u303f\uff00-\uffef]|[^\s\p{Script=Han}\u3000-\u303f\uff00-\uffef]+/gu,
    ) ?? []
  let lines = 1
  let width = 0
  for (const token of tokens) {
    let w = 0
    for (const ch of token) w += charWidth(ch)
    if (width > 0 && width + w > MIND_TEXT_MAX_W) {
      lines += 1
      width = 0
    }
    if (w > MIND_TEXT_MAX_W) {
      const extra = Math.ceil(w / MIND_TEXT_MAX_W) - 1
      lines += extra
      width = w - extra * MIND_TEXT_MAX_W
    } else {
      width += w
    }
  }
  return lines
}

/** 估算胶囊尺寸：CJK ≈ 12px / 拉丁 ≈ 6.8px；与 MindNode 渲染（min-w-28 / px-3 / 点与折叠区）对齐；长文本按行数展高 */
export function estimateMindSize(text: string): { width: number; height: number } {
  let textWidth = 0
  for (const ch of text || '主题') textWidth += charWidth(ch)
  const width = Math.min(248, Math.max(112, Math.round(24 + 12 + Math.min(textWidth, 208) + 24)))
  return { width, height: MIND_BOX_BASE_H + (estimateMindLines(text) - 1) * MIND_LINE_H }
}

export function mindNodeText(node: CanvasNode | undefined): string {
  if (!node) return ''
  const data = node.data as { text?: unknown }
  return typeof data.text === 'string' && data.text.trim() ? data.text : '主题'
}

function sizeOfMind(node: CanvasNode): { width: number; height: number } {
  const est = estimateMindSize(mindNodeText(node))
  return { width: node.width ?? est.width, height: node.height ?? est.height }
}

// ---------- 树操作 ----------

/** 新增子节点的落位：父右缘 + MIND_H_GAP；有子追加最下缘，无子与父垂直居中 */
function nextChildPosition(
  nodes: readonly CanvasNode[],
  index: MindIndex,
  parent: CanvasNode,
  childHeight: number,
): { x: number; y: number } {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const parentSize = sizeOfMind(parent)
  const x = Math.round(parent.position.x + parentSize.width + MIND_H_GAP)
  const children = (index.childrenOf.get(parent.id) ?? []).map((id) => byId.get(id)).filter((n): n is CanvasNode => !!n)
  if (children.length === 0) {
    return { x, y: Math.round(parent.position.y + (parentSize.height - childHeight) / 2) }
  }
  const bottom = Math.max(...children.map((c) => c.position.y + sizeOfMind(c).height))
  return { x, y: Math.round(bottom + MIND_V_GAP) }
}

export interface MindInsert {
  node: CanvasNode
  edge: CanvasEdge
}

/** 加子（Tab）：parent 下创建子节点 + mind 边（由调用方 addNodes 落地） */
export function planAddChild(
  nodes: readonly CanvasNode[],
  index: MindIndex,
  parentId: string,
  text = '新分支',
): MindInsert | undefined {
  const parent = nodes.find((n) => n.id === parentId && n.type === 'mind')
  if (!parent) return undefined
  const size = estimateMindSize(text)
  const position = nextChildPosition(nodes, index, parent, size.height)
  const node = createNode('mind', position, { text })
  return { node, edge: { id: newEdgeId(), source: parentId, target: node.id, kind: 'mind' } }
}

/** 加兄弟（Enter）：父下追加；根节点无兄弟语义（返回 undefined，由调用方回落加子） */
export function planAddSibling(
  nodes: readonly CanvasNode[],
  index: MindIndex,
  id: string,
  text = '新分支',
): MindInsert | undefined {
  const parentId = index.parentOf.get(id)
  if (!parentId) return undefined
  return planAddChild(nodes, index, parentId, text)
}

export interface MindReparent {
  /** 新父子边（target → moving） */
  edge: CanvasEdge
  /** 需移除的旧入边（无父时为空） */
  removeEdgeIds: string[]
  /** 重挂后落位（成为 target 的最后一个子） */
  position: { x: number; y: number }
}

/**
 * 重挂（拖拽重组）：把 moving 挂到 target 之下。
 * 拒绝：非 mind / 自身 / target 在 moving 子树内（防环）/ 已是 target 的子。
 */
export function planReparent(
  nodes: readonly CanvasNode[],
  edges: readonly CanvasEdge[],
  index: MindIndex,
  movingId: string,
  targetId: string,
): MindReparent | undefined {
  if (movingId === targetId) return undefined
  const moving = nodes.find((n) => n.id === movingId && n.type === 'mind')
  const target = nodes.find((n) => n.id === targetId && n.type === 'mind')
  if (!moving || !target) return undefined
  if (isMindDescendant(index, movingId, targetId)) return undefined
  if (index.parentOf.get(movingId) === targetId) return undefined
  const size = estimateMindSize(mindNodeText(moving))
  const position = nextChildPosition(nodes, index, target, size.height)
  const oldParent = index.parentOf.get(movingId)
  const oldEdge = edges.find((e) => e.kind === 'mind' && e.source === oldParent && e.target === movingId)
  return {
    edge: { id: newEdgeId(), source: targetId, target: movingId, kind: 'mind' },
    removeEdgeIds: oldEdge ? [oldEdge.id] : [],
    position,
  }
}

// ---------- 布局（dagre LR；根保持原位） ----------

/** 子树 dagre 布局（LR，返回左上角坐标表；不改变外部数据） */
export function layoutMindSubtree(
  nodes: readonly CanvasNode[],
  index: MindIndex,
  rootId: string,
): Map<string, { x: number; y: number }> {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const ids = mindSubtreeIds(index, rootId).filter((id) => byId.has(id))
  const included = new Set(ids)
  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: 'LR', nodesep: MIND_V_GAP, ranksep: MIND_H_GAP, marginx: 0, marginy: 0 })
  for (const id of ids) {
    const size = sizeOfMind(byId.get(id)!)
    g.setNode(id, { width: size.width, height: size.height })
  }
  for (const parent of ids) {
    for (const child of index.childrenOf.get(parent) ?? []) {
      if (included.has(child)) g.setEdge(parent, child)
    }
  }
  dagre.layout(g)
  const out = new Map<string, { x: number; y: number }>()
  for (const id of ids) {
    const gn = g.node(id) as { x: number; y: number; width: number; height: number } | undefined
    if (!gn) continue
    out.set(id, { x: Math.round(gn.x - gn.width / 2), y: Math.round(gn.y - gn.height / 2) })
  }
  return out
}

/**
 * 整理脑图：对每个根所在子树重排（根节点保持原位，整树平移归位）。
 * 返回新数组；无变化时元素引用保持。
 */
export function applyMindLayout(
  nodes: readonly CanvasNode[],
  index: MindIndex,
  rootIds: readonly string[],
): CanvasNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const targets = new Map<string, { x: number; y: number }>()
  for (const rootId of rootIds) {
    const root = byId.get(rootId)
    if (!root) continue
    const layout = layoutMindSubtree(nodes, index, rootId)
    const rootPos = layout.get(rootId)
    if (!rootPos) continue
    const dx = root.position.x - rootPos.x
    const dy = root.position.y - rootPos.y
    for (const [id, pos] of layout) {
      targets.set(id, { x: Math.round(pos.x + dx), y: Math.round(pos.y + dy) })
    }
  }
  if (targets.size === 0) return [...nodes]
  let changed = false
  const result = nodes.map((n) => {
    const t = targets.get(n.id)
    if (!t || (t.x === n.position.x && t.y === n.position.y)) return n
    changed = true
    return { ...n, position: t }
  })
  return changed ? result : [...nodes]
}

// ---------- LLM 树 → 画布 ----------

/** LLM 脑图树 → mind 节点 + mind 边（dagre 布局，根落在 origin） */
export function mindTreeInserts(tree: MindTreeNode, origin: { x: number; y: number }): {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
} {
  const nodes: CanvasNode[] = []
  const edges: CanvasEdge[] = []
  const walk = (t: MindTreeNode, parentId?: string): void => {
    const node = createNode('mind', { x: 0, y: 0 }, { text: t.title })
    nodes.push(node)
    if (parentId) edges.push({ id: newEdgeId(), source: parentId, target: node.id, kind: 'mind' })
    for (const child of t.children ?? []) walk(child, node.id)
  }
  walk(tree)
  const root = nodes[0]
  if (!root) return { nodes, edges }
  const index = indexMind(nodes, edges)
  const layout = layoutMindSubtree(nodes, index, root.id)
  const rootPos = layout.get(root.id)
  if (rootPos) {
    const dx = Math.round(origin.x - rootPos.x)
    const dy = Math.round(origin.y - rootPos.y)
    for (const n of nodes) {
      const pos = layout.get(n.id)
      if (pos) n.position = { x: pos.x + dx, y: pos.y + dy }
    }
  }
  return { nodes, edges }
}

// ---------- Markdown ----------

/** 画布子树 → MindTreeNode（文本取 data.text；供导出 Markdown / 摘要） */
export function extractMindTree(nodes: readonly CanvasNode[], index: MindIndex, rootId: string): MindTreeNode {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const build = (id: string): MindTreeNode => {
    const node: MindTreeNode = { title: mindNodeText(byId.get(id)) }
    const children = (index.childrenOf.get(id) ?? []).filter((cid) => byId.has(cid)).map(build)
    if (children.length > 0) node.children = children
    return node
  }
  return build(rootId)
}

/** 树 → Markdown 大纲（`- ` 列表，两空格缩进） */
export function treeToMarkdown(tree: MindTreeNode): string {
  const lines: string[] = []
  const walk = (t: MindTreeNode, depth: number): void => {
    lines.push(`${'  '.repeat(depth)}- ${t.title}`)
    for (const child of t.children ?? []) walk(child, depth + 1)
  }
  walk(tree, 0)
  return lines.join('\n')
}

interface OutlineLine {
  level: number
  text: string
  heading: boolean
}

function parseOutlineLine(raw: string): OutlineLine | undefined {
  const heading = /^(#{1,6})\s+(.*\S)\s*$/.exec(raw)
  if (heading) return { level: heading[1]!.length - 1, text: heading[2]!, heading: true }
  const list = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/.exec(raw)
  if (list) {
    const indent = list[1]!.replace(/\t/g, '  ').length
    return { level: Math.floor(indent / 2), text: list[2]!, heading: false }
  }
  const plain = /^(\s*)(.*\S)\s*$/.exec(raw)
  if (!plain) return undefined
  const indent = plain[1]!.replace(/\t/g, '  ').length
  return { level: Math.floor(indent / 2), text: plain[2]!, heading: false }
}

/**
 * Markdown 大纲 → 脑图树：支持 `- / * / + / 1.` 列表缩进与 `#` 标题；
 * 层级规则：标题层级相对首个标题；列表层级以「最近的标题」为基准（无标题则按缩进）；
 * 首行为根（层级归零）；跳层自动收敛（最多比父深一层）；无内容返回 undefined。
 */
export function parseMindOutline(text: string): MindTreeNode | undefined {
  const parsed: OutlineLine[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = parseOutlineLine(raw)
    if (line) parsed.push(line)
  }
  const first = parsed[0]
  if (!first) return undefined
  const headingBase = first.heading ? first.level : 0
  let recentHeading: number | undefined = first.heading ? 0 : undefined
  const root: MindTreeNode = { title: first.text }
  const stack: Array<{ node: MindTreeNode; level: number }> = [{ node: root, level: 0 }]
  for (const line of parsed.slice(1)) {
    let rawLevel: number
    if (line.heading) {
      rawLevel = line.level - headingBase
      recentHeading = rawLevel
    } else {
      // 列表 / 纯文本：以最近标题（相对层级）为父基准，再叠加缩进
      rawLevel = (recentHeading ?? headingBase - 1) + 1 + line.level
    }
    const level = Math.min(Math.max(rawLevel, 1), stack[stack.length - 1]!.level + 1)
    while (stack.length > 1 && stack[stack.length - 1]!.level >= level) stack.pop()
    const parent = stack[stack.length - 1]!.node
    const child: MindTreeNode = { title: line.text }
    if (parent.children) parent.children.push(child)
    else parent.children = [child]
    stack.push({ node: child, level })
  }
  return root
}

/**
 * M31 画布内核前端测试（P2）：
 * - lib/canvas.ts 纯函数：连线矩阵 / 剪贴板 / 对齐分布整理 / z 序 / 画框收纳与孤儿 / 吸附参考线 / 脑图折叠 / 引用文案；
 * - lib/canvas-templates：四模板结构与画框子节点相对坐标；
 * - canvas-store：编辑动作接线 / undo-redo 快照栈 / 剪贴板连续粘贴 / autosave 防抖与「保存完成不循环」回归；
 * - EmptyCanvas：四模板卡片渲染与回调；
 * - useInlineEdit：双击编辑提交 / Esc 取消 / ⌘Enter 提交 / autoEdit 一次性信令。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as React from 'react'
import type {
  CanvasDoc,
  CanvasEdge,
  CanvasEdgeKind,
  CanvasNode,
  CanvasNodeData,
  CanvasNodeType,
  MediaProviderInfo,
} from '@multi-agent/shared'
import {
  absolutePosition,
  alignNodes,
  boundingBox,
  canConnect,
  canvasNodeTypeOf,
  collapsedHiddenIds,
  computeSnap,
  createNode,
  detachOrphans,
  distributeNodes,
  ensureParentOrder,
  extractClipboard,
  materializeClipboard,
  NODE_SIZE,
  nextPlacement,
  nodeLabel,
  quoteForComposer,
  reorderNodes,
  reparentNodes,
  searchNodes,
  sizeOf,
  SNAP_THRESHOLD,
  tidyGrid,
  type CanvasClipboard,
  type SnapRect,
} from '../src/lib/canvas'
import { buildTemplate, CANVAS_TEMPLATES } from '../src/lib/canvas-templates'
import { useCanvasStore } from '../src/stores/canvas-store'
import { useMediaStore } from '../src/stores/media-store'
import { useSessionStore } from '../src/stores/session-store'
import { EmptyCanvas } from '../src/components/canvas/EmptyCanvas'
import { CanvasUiContext } from '../src/components/canvas/CanvasUiContext'
import { useInlineEdit } from '../src/components/canvas/nodes/useInlineEdit'

const T0 = '2026-06-01T08:00:00.000Z'

/** 固定 id 的节点构造（复用 createNode 保证字段口径一致） */
function mk(
  type: CanvasNodeType,
  id: string,
  x: number,
  y: number,
  data: CanvasNodeData,
  opts?: { width?: number; height?: number; parentId?: string },
): CanvasNode {
  return { ...createNode(type, { x, y }, data, opts), id }
}

function edge(id: string, source: string, target: string, kind: CanvasEdgeKind): CanvasEdge {
  return { id, source, target, kind }
}

// ---------- lib/canvas.ts：连线合法性矩阵 ----------

describe('canConnect 连线矩阵（M31）', () => {
  it('生成数据流（prompt/image/artifact → image/video）为 flow', () => {
    expect(canConnect('prompt', 'image')).toBe('flow')
    expect(canConnect('image', 'video')).toBe('flow')
    expect(canConnect('artifact', 'image')).toBe('flow')
  })

  it('脑图节点之间为 mind；其余关联为 ref', () => {
    expect(canConnect('mind', 'mind')).toBe('mind')
    expect(canConnect('note', 'image')).toBe('ref')
    expect(canConnect('image', 'note')).toBe('ref')
    expect(canConnect('mind', 'note')).toBe('ref')
  })

  it('画框不参与连线', () => {
    expect(canConnect('group', 'note')).toBeNull()
    expect(canConnect('note', 'group')).toBeNull()
    expect(canConnect('group', 'group')).toBeNull()
  })
})

// ---------- 尺寸与剪贴板 ----------

describe('尺寸与剪贴板（M31）', () => {
  it('sizeOf：缺省尺寸回落类型默认值；显式尺寸优先', () => {
    expect(NODE_SIZE.group).toEqual({ width: 380, height: 260 })
    expect(sizeOf({ type: 'image' })).toEqual({ width: 280, height: 200 })
    expect(sizeOf({ type: 'image', width: 100 })).toEqual({ width: 100, height: 200 })
  })

  it('extractClipboard：父不在选区的子节点转绝对坐标并脱离；边随选区；原对象不被修改', () => {
    const g = mk('group', 'g', 100, 100, { title: '框' }, { width: 380, height: 260 })
    const c = mk('note', 'c', 10, 10, { text: '子' }, { parentId: 'g' })
    const n = mk('note', 'n', 0, 0, { text: '甲' })
    const clip = extractClipboard([g, c, n], [edge('e1', 'c', 'n', 'ref')], new Set(['c', 'n']))
    expect(clip.nodes).toHaveLength(2)
    const detached = clip.nodes.find((x) => x.id === 'c')
    expect(detached?.parentId).toBeUndefined()
    expect(detached?.position).toEqual({ x: 110, y: 110 })
    expect(clip.edges).toHaveLength(1)
    expect(clip.nodes[0].data).not.toBe(c.data) // 浅拷贝快照
    expect(c.parentId).toBe('g') // 源数据不变
  })

  it('materializeClipboard：id 重映射（含 parentId 与边端点）并整体偏移', () => {
    const g = mk('group', 'g2', 0, 0, { title: '框' })
    const c = mk('note', 'c2', 5, 5, { text: '子' }, { parentId: 'g2' })
    const clip: CanvasClipboard = { nodes: [g, c], edges: [edge('e1', 'g2', 'c2', 'ref')] }
    const out = materializeClipboard(clip, 10, 20)
    const [og, oc] = out.nodes
    expect(og.id).not.toBe('g2')
    expect(oc.parentId).toBe(og.id)
    expect(oc.position).toEqual({ x: 15, y: 25 })
    expect(out.edges).toHaveLength(1)
    expect(out.edges[0].id).not.toBe('e1')
    expect(out.edges[0].source).toBe(og.id)
    expect(out.edges[0].target).toBe(oc.id)
  })
})

// ---------- 对齐 / 分布 / 网格整理 ----------

describe('对齐与整理（M31）', () => {
  const a = mk('note', 'a', 0, 0, { text: 'a' }) // 220x140
  const b = mk('image', 'b', 100, 50, {}) // 280x200
  const c = mk('note', 'c', 300, 200, { text: 'c' }) // right 520 / bottom 340

  it('alignNodes：基准为选区外接框；未选中节点保持引用', () => {
    const left = alignNodes([a, b, c], new Set(['a', 'b']), 'left')
    expect(left[0].position.x).toBe(0)
    expect(left[1].position.x).toBe(0)
    expect(left[2]).toBe(c)
    const hc = alignNodes([a, b, c], new Set(['a', 'b']), 'hcenter')
    // 选区外接框 left 0 / right 380（c 未选中）→ 中心 190
    expect(hc[0].position.x).toBe(80)
    expect(hc[1].position.x).toBe(50)
    const top = alignNodes([a, b, c], new Set(['a', 'b']), 'top')
    expect(top[1].position.y).toBe(0)
  })

  it('alignNodes：少于 2 个选中不动作（元素引用保持）', () => {
    const out = alignNodes([a], new Set(['a']), 'left')
    expect(out[0]).toBe(a)
  })

  it('distributeNodes：首尾固定、中心等距；少于 3 个不动作', () => {
    const x = mk('note', 'x', 0, 0, { text: 'x' }) // 中心 110
    const y = mk('note', 'y', 150, 10, { text: 'y' }) // 中心 260
    const z = mk('note', 'z', 500, 20, { text: 'z' }) // 中心 610
    const out = distributeNodes([x, y, z], new Set(['x', 'y', 'z']), 'h') // step (610-110)/2 = 250
    expect(out[0].position).toEqual({ x: 0, y: 0 })
    expect(out[1].position).toEqual({ x: 250, y: 10 })
    expect(out[2].position).toEqual({ x: 500, y: 20 })
    const two = distributeNodes([x, y], new Set(['x', 'y']), 'h')
    expect(two[0]).toBe(x)
  })

  it('tidyGrid：按视觉顺序铺格（列宽取集合最大值）', () => {
    const n1 = mk('note', 'n1', 0, 100, { text: 'a' })
    const n2 = mk('note', 'n2', 50, 0, { text: 'b' })
    const n3 = mk('note', 'n3', 10, 10, { text: 'c' })
    const n4 = mk('note', 'n4', 400, 300, { text: 'd' })
    const out = tidyGrid([n1, n2, n3, n4], new Set(['n1', 'n2', 'n3', 'n4']))
    const posOf = (id: string): { x: number; y: number } => out.find((n) => n.id === id)!.position
    // 排序（y,x）：n2 / n3 / n1 / n4；cellW 220 + gap 44 = 264，cellH 140 + gap 44 = 184
    expect(posOf('n2')).toEqual({ x: 0, y: 0 })
    expect(posOf('n3')).toEqual({ x: 264, y: 0 })
    expect(posOf('n1')).toEqual({ x: 0, y: 184 })
    expect(posOf('n4')).toEqual({ x: 264, y: 184 })
  })

  it('reorderNodes：forward/backward 相邻交换；front/back 置顶置底', () => {
    const a2 = mk('note', 'ra', 0, 0, { text: 'a' })
    const b2 = mk('note', 'rb', 0, 0, { text: 'b' })
    const c2 = mk('note', 'rc', 0, 0, { text: 'c' })
    const ids = (n: CanvasNode): Set<string> => new Set([n.id])
    expect(reorderNodes([a2, b2, c2], ids(a2), 'forward').map((n) => n.id)).toEqual(['rb', 'ra', 'rc'])
    expect(reorderNodes([a2, b2, c2], ids(c2), 'backward').map((n) => n.id)).toEqual(['ra', 'rc', 'rb'])
    expect(reorderNodes([a2, b2, c2], ids(a2), 'front').map((n) => n.id)).toEqual(['rb', 'rc', 'ra'])
    expect(reorderNodes([a2, b2, c2], ids(c2), 'back').map((n) => n.id)).toEqual(['rc', 'ra', 'rb'])
  })

  it('ensureParentOrder：子节点排到父之后；已满足顺序时引用保持', () => {
    const g = mk('group', 'g', 0, 0, { title: '框' })
    const ch = mk('note', 'ch', 10, 10, { text: '子' }, { parentId: 'g' })
    expect(ensureParentOrder([ch, g]).map((n) => n.id)).toEqual(['g', 'ch'])
    const ok = ensureParentOrder([g, ch])
    expect(ok[0]).toBe(g)
    expect(ok[1]).toBe(ch)
  })
})

// ---------- 画框收纳 / 孤儿 / 吸附 / 折叠 ----------

describe('画框收纳与吸附（M31）', () => {
  it('absolutePosition：parentId 链式回溯绝对坐标', () => {
    const g = mk('group', 'g', 100, 100, { title: '框' }, { width: 380, height: 260 })
    const c = mk('note', 'c', 10, 20, { text: '子' }, { parentId: 'g' })
    expect(absolutePosition(c, new Map([['g', g]]))).toEqual({ x: 110, y: 120 })
    expect(absolutePosition(g, new Map())).toEqual({ x: 100, y: 100 })
  })

  it('reparentNodes：中心落入画框 → 收纳转相对坐标且父排前', () => {
    const g = mk('group', 'g', 100, 100, { title: '框' }, { width: 380, height: 260 })
    const n = mk('note', 'n', 150, 150, { text: 'n' }) // 中心 (260,220) 在框内
    const out = reparentNodes([g, n], ['n'])
    const folded = out.find((x) => x.id === 'n')
    expect(folded?.parentId).toBe('g')
    expect(folded?.position).toEqual({ x: 50, y: 50 })
    expect(out.map((x) => x.id)).toEqual(['g', 'n'])
  })

  it('reparentNodes：子节点中心拖出父框 → 脱离转绝对坐标', () => {
    const g = mk('group', 'g', 100, 100, { title: '框' }, { width: 380, height: 260 })
    const c = mk('note', 'c', 500, 10, { text: 'c' }, { parentId: 'g' }) // 绝对位置 (600,110)，中心在框外
    const out = reparentNodes([g, c], ['c'])
    const detached = out.find((x) => x.id === 'c')
    expect(detached?.parentId).toBeUndefined()
    expect(detached?.position).toEqual({ x: 600, y: 110 })
    const same = reparentNodes([g], ['g'])
    expect(same[0]).toBe(g)
  })

  it('detachOrphans：删除画框时子节点转绝对坐标脱离', () => {
    const g = mk('group', 'g', 100, 100, { title: '框' }, { width: 380, height: 260 })
    const c = mk('note', 'c', 10, 10, { text: '子' }, { parentId: 'g' })
    const out = detachOrphans([g, c], new Set(['g']))
    expect(out[0]).toBe(g)
    expect(out[1].parentId).toBeUndefined()
    expect(out[1].position).toEqual({ x: 110, y: 110 })
  })

  it('computeSnap：阈值内吸附并产参考线；超阈值与无参照不吸附', () => {
    const moving: SnapRect = { x: 103, y: 200, width: 100, height: 50 }
    const other: SnapRect = { x: 100, y: 320, width: 100, height: 50 }
    const res = computeSnap(moving, [other])
    expect(res.position).toEqual({ x: 100, y: 200 })
    expect(res.guides.some((gd) => gd.orientation === 'v' && gd.position === 100)).toBe(true)
    expect(res.guides.every((gd) => gd.orientation === 'v')).toBe(true)
    // 阈值边界（dx = -SNAP_THRESHOLD 吸附）
    const onEdge = computeSnap({ x: 100 + SNAP_THRESHOLD, y: 0, width: 100, height: 50 }, [other])
    expect(onEdge.position.x).toBe(100)
    const beyond = computeSnap({ x: 100 + SNAP_THRESHOLD + 1, y: 0, width: 100, height: 50 }, [other])
    expect(beyond.position.x).toBe(107)
    expect(beyond.guides).toEqual([])
    const empty = computeSnap(moving, [])
    expect(empty.position).toEqual({ x: 103, y: 200 })
    expect(empty.guides).toEqual([])
  })

  it('collapsedHiddenIds：折叠脑图节点的全部后代隐藏（含逐层展开）；ref 边不算层级', () => {
    const root = mk('mind', 'root', 0, 0, { text: '根', collapsed: true })
    const c1 = mk('mind', 'c1', 100, 0, { text: 'c1' })
    const c2 = mk('mind', 'c2', 100, 100, { text: 'c2' })
    const gc = mk('mind', 'gc', 200, 0, { text: 'gc' })
    const edges = [
      edge('e1', 'root', 'c1', 'mind'),
      edge('e2', 'root', 'c2', 'mind'),
      edge('e3', 'c1', 'gc', 'mind'),
      edge('e4', 'gc', 'c2', 'ref'),
    ]
    const hidden = collapsedHiddenIds([root, c1, c2, gc], edges)
    expect([...hidden].sort()).toEqual(['c1', 'c2', 'gc'])
    const rootOpen = mk('mind', 'root2', 0, 0, { text: '根' })
    expect(collapsedHiddenIds([rootOpen, c1], [edge('e1', 'root2', 'c1', 'mind')]).size).toBe(0)
  })

  it('nodeLabel / quoteForComposer：文本优先、素材带工作区路径', () => {
    expect(nodeLabel(mk('note', 'n', 0, 0, { text: '写点东西' }))).toBe('写点东西')
    const img = mk('image', 'i', 0, 0, { artifact: 'workspace/s/canvas/media/a.png', source: 'upload' })
    expect(nodeLabel(img)).toBe('a.png')
    expect(quoteForComposer(img)).toBe('[画布图片] workspace/s/canvas/media/a.png\n')
    expect(quoteForComposer(mk('note', 'n', 0, 0, { text: '便签内容' }))).toBe('[画布便签] 便签内容\n')
    expect(quoteForComposer(mk('artifact', 'a', 0, 0, { path: 'docs/api.md' }))).toBe('[画布交付件] docs/api.md\n')
  })

  it('boundingBox：外接框含尺寸；空集合为 null', () => {
    const box = boundingBox([mk('note', 'a', 0, 0, { text: 'a' }), mk('image', 'b', 100, 100, {})])
    expect(box).toEqual({ x: 0, y: 0, width: 380, height: 300 })
    expect(boundingBox([])).toBeNull()
  })
})

// ---------- M31 修订：画布内查找 与 等距吸附 ----------

describe('searchNodes 画布内查找（M31 修订）', () => {
  const doc: CanvasDoc = {
    v: 1,
    sessionId: 's-search',
    version: 1,
    updatedAt: T0,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      mk('note', 'nd_note', 0, 0, { text: '登录页草图与路由' }),
      mk('prompt', 'nd_prompt', 300, 0, { text: 'Login Page', negative: '' }),
      mk('kline', 'nd_kline', 600, 0, { symbol: 'sh600519', name: '贵州茅台' }),
      mk('image', 'nd_img', 900, 0, { artifact: 'canvas/media/a.png', prompt: '一只猫' }),
    ],
    edges: [],
  }

  it('按文本 / 提示词 / 标的 / 路径匹配；大小写不敏感；空查询返回空', () => {
    expect(searchNodes(doc, '   ')).toEqual([])
    expect(searchNodes(doc, '登录').map((h) => h.id)).toEqual(['nd_note'])
    expect(searchNodes(doc, 'login').map((h) => h.id)).toEqual(['nd_prompt']) // 大小写不敏感
    expect(searchNodes(doc, '茅台').map((h) => h.id)).toEqual(['nd_kline'])
    expect(searchNodes(doc, 'media/a.png').map((h) => h.id)).toEqual(['nd_img'])
    expect(searchNodes(doc, '不存在的内容')).toEqual([])
  })

  it('snippet 含类型标签与匹配片段；label 取节点标签', () => {
    const hit = searchNodes(doc, '登录')[0]!
    expect(hit.snippet).toContain('便签')
    expect(hit.snippet).toContain('登录')
    expect(hit.label).toContain('登录')
  })

  it('limit：命中超上限时截断（默认 12 / 可指定）', () => {
    const many: CanvasDoc = {
      ...doc,
      nodes: Array.from({ length: 15 }, (_, i) => mk('note', `nd_${i}`, i * 10, 0, { text: `节点 x${i}` })),
    }
    expect(searchNodes(many, 'x')).toHaveLength(12)
    expect(searchNodes(many, 'x', 5)).toHaveLength(5)
  })
})

describe('computeSnap 等距吸附（M31 修订）', () => {
  const left: SnapRect = { x: 0, y: 0, width: 100, height: 50 }
  const right: SnapRect = { x: 300, y: 0, width: 100, height: 50 }

  it('水平夹击近似等距 → 吸附到等距中点 + 两条 dist 标记', () => {
    const res = computeSnap({ x: 146, y: 200, width: 100, height: 50 }, [left, right]) // 目标 150，差 4 ≤ 阈值
    expect(res.position.x).toBe(150)
    const dist = res.guides.filter((g) => g.kind === 'dist')
    expect(dist.map((g) => g.position).sort((a, b) => a - b)).toEqual([125, 275]) // 两侧间隙中点
    expect(dist.every((g) => g.orientation === 'v')).toBe(true)
  })

  it('差距超阈值不吸附（无 dist 标记，位置保持）', () => {
    const res = computeSnap({ x: 130, y: 200, width: 100, height: 50 }, [left, right])
    expect(res.position.x).toBe(130)
    expect(res.guides.filter((g) => g.kind === 'dist')).toHaveLength(0)
  })

  it('垂直夹击同理（上 / 下邻 → y 吸附；x 不受影响）', () => {
    const top: SnapRect = { x: 0, y: 0, width: 100, height: 100 }
    const bottom: SnapRect = { x: 0, y: 300, width: 100, height: 100 }
    const res = computeSnap({ x: 200, y: 146, width: 50, height: 100 }, [top, bottom])
    expect(res.position.y).toBe(150)
    expect(res.position.x).toBe(200)
    const dist = res.guides.filter((g) => g.kind === 'dist')
    expect(dist).toHaveLength(2)
    expect(dist.every((g) => g.orientation === 'h')).toBe(true)
  })
})

// ---------- 模板 ----------

describe('canvas-templates 模板（M31）', () => {
  it('studio：prompt→image flow 边；外接框中心落在指定 origin', () => {
    const { nodes, edges } = buildTemplate('studio', { x: 1000, y: 500 })
    expect(nodes).toHaveLength(3)
    expect(edges).toHaveLength(1)
    expect(edges[0].kind).toBe('flow')
    const byId = new Map(nodes.map((n) => [n.id, n.type]))
    expect(byId.get(edges[0].source)).toBe('prompt')
    expect(byId.get(edges[0].target)).toBe('image')
    const box = boundingBox(nodes)!
    expect(Math.abs(box.x + box.width / 2 - 1000)).toBeLessThanOrEqual(1)
    expect(Math.abs(box.y + box.height / 2 - 500)).toBeLessThanOrEqual(1)
  })

  it('mind：根 + 3 分支 + 3 条 mind 边', () => {
    const { nodes, edges } = buildTemplate('mind', { x: 0, y: 0 })
    expect(nodes).toHaveLength(4)
    expect(edges).toHaveLength(3)
    expect(edges.every((e) => e.kind === 'mind')).toBe(true)
  })

  it('storyboard：画框在前，分镜视频为相对坐标子节点', () => {
    const { nodes } = buildTemplate('storyboard', { x: 0, y: 0 })
    const g = nodes[0]
    expect(g.type).toBe('group')
    const shots = nodes.filter((n) => n.type === 'video')
    expect(shots).toHaveLength(3)
    expect(shots.every((s) => s.parentId === g.id)).toBe(true)
    expect(shots[0].position).toEqual({ x: 24, y: 64 })
  })

  it('wall：4 个图片位收进画框', () => {
    const { nodes } = buildTemplate('wall', { x: 0, y: 0 })
    const g = nodes.find((n) => n.type === 'group')
    const cells = nodes.filter((n) => n.type === 'image')
    expect(cells).toHaveLength(4)
    expect(cells.every((c) => c.parentId === g?.id)).toBe(true)
  })
})

// ---------- canvas-store ----------

describe('canvas-store 编辑动作与历史（M31）', () => {
  let docRef: CanvasDoc
  let seq = 0
  let fetchMock: ReturnType<typeof makeFetchMock>

  function makeFetchMock() {
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as {
          baseVersion: number
          nodes: CanvasNode[]
          edges: CanvasEdge[]
          viewport: CanvasDoc['viewport']
        }
        docRef = { ...docRef, version: body.baseVersion + 1, nodes: body.nodes, edges: body.edges, viewport: body.viewport }
        return { ok: true, status: 200, json: async () => ({ doc: docRef }) }
      }
      return { ok: true, status: 200, json: async () => ({ doc: docRef, mediaBound: false }) }
    })
  }

  /** 以全新会话 id 加载（load 内部重置历史栈；过期响应保护按 sessionId 判定） */
  async function loadFresh(nodes: CanvasNode[] = [], edges: CanvasEdge[] = []): Promise<void> {
    seq += 1
    docRef = {
      v: 1,
      sessionId: `s${seq}`,
      version: 1,
      updatedAt: T0,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes,
      edges,
    }
    await useCanvasStore.getState().load(docRef.sessionId)
  }

  const docOf = (): CanvasDoc => {
    const doc = useCanvasStore.getState().doc
    if (!doc) throw new Error('doc 未加载')
    return doc
  }

  const nodeOf = (id: string): CanvasNode => {
    const node = docOf().nodes.find((n) => n.id === id)
    if (!node) throw new Error(`节点不存在：${id}`)
    return node
  }

  const putCalls = (): Array<[input: RequestInfo | URL, init?: RequestInit]> =>
    fetchMock.mock.calls.filter((call) => call[1]?.method === 'PUT')

  beforeEach(() => {
    vi.useFakeTimers()
    docRef = { v: 1, sessionId: 's-pending', version: 1, updatedAt: T0, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [] }
    fetchMock = makeFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    useCanvasStore.setState({
      sessionId: undefined,
      doc: null,
      mediaBound: false,
      loading: false,
      saving: false,
      dirty: false,
      saveError: undefined,
      lastSavedAt: undefined,
      selectedIds: [],
      clipboard: null,
      undoDepth: 0,
      redoDepth: 0,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('addNodes 画框沉底且修复 parent 顺序；updateNodeData/updateNodes 合并更新', async () => {
    await loadFresh()
    const g = mk('group', 'g', 0, 0, { title: '框' }, { width: 380, height: 260 })
    const c = mk('note', 'c', 10, 10, { text: '子' }, { parentId: 'g' })
    useCanvasStore.getState().addNodes([c, g]) // 子先于父传入 → 画框沉底后父排前
    expect(docOf().nodes.map((n) => n.id)).toEqual(['g', 'c'])
    useCanvasStore.getState().updateNodeData('c', { text: '改过' })
    expect((nodeOf('c').data as { text: string }).text).toBe('改过')
    useCanvasStore.getState().updateNodes([{ id: 'c', position: { x: 1, y: 2 }, width: 200, data: { text: '再改' } }])
    const after = nodeOf('c')
    expect(after.position).toEqual({ x: 1, y: 2 })
    expect(after.width).toBe(200)
    expect((after.data as { text: string }).text).toBe('再改')
  })

  it('removeNodes：删除画框孤儿转绝对坐标；相关边清理；选中集裁剪', async () => {
    const g = mk('group', 'g', 100, 100, { title: '框' }, { width: 380, height: 260 })
    const c = mk('note', 'c', 10, 10, { text: '子' }, { parentId: 'g' })
    const n = mk('note', 'n', 0, 0, { text: '甲' })
    await loadFresh([g, c, n], [edge('e1', 'c', 'n', 'ref'), edge('e2', 'g', 'n', 'ref')])
    useCanvasStore.getState().setSelectedIds(['g', 'c', 'n'])
    useCanvasStore.getState().removeNodes(['g'])
    const doc = docOf()
    expect(doc.nodes.map((x) => x.id)).toEqual(['c', 'n'])
    expect(doc.nodes[0].parentId).toBeUndefined()
    expect(doc.nodes[0].position).toEqual({ x: 110, y: 110 })
    expect(doc.edges.map((e) => e.id)).toEqual(['e1']) // 触及被删画框的 e2 清除，e1 保留
    expect(useCanvasStore.getState().selectedIds).toEqual(['c', 'n'])
  })

  it('addEdge：自连拒绝、同向重复拒绝；kind 持久', async () => {
    await loadFresh([mk('prompt', 'p', 0, 0, { text: 'p' }), mk('image', 'i', 300, 0, {})])
    useCanvasStore.getState().addEdge('p', 'i', 'flow')
    useCanvasStore.getState().addEdge('p', 'i', 'ref')
    useCanvasStore.getState().addEdge('i', 'i', 'flow')
    const doc = docOf()
    expect(doc.edges).toHaveLength(1)
    expect(doc.edges[0].source).toBe('p')
    expect(doc.edges[0].kind).toBe('flow')
  })

  it('undo/redo：快照栈 / 同状态去重 / 新变更清空 redo / 视口不进历史', async () => {
    await loadFresh()
    const store = useCanvasStore.getState()
    store.pushHistory()
    store.pushHistory()
    expect(useCanvasStore.getState().undoDepth).toBe(1) // 同状态去重
    store.addNodes([mk('note', 'n1', 0, 0, { text: '一' })])
    expect(useCanvasStore.getState().undoDepth).toBe(1) // 空快照已在栈顶，不重复压
    store.addNodes([mk('note', 'n2', 200, 0, { text: '二' })])
    expect(useCanvasStore.getState().undoDepth).toBe(2)
    useCanvasStore.getState().undo()
    expect(docOf().nodes.map((n) => n.id)).toEqual(['n1'])
    expect(useCanvasStore.getState().redoDepth).toBe(1)
    useCanvasStore.getState().setViewport({ x: 10, y: 10, zoom: 2 })
    expect(useCanvasStore.getState().undoDepth).toBe(1) // 视口不进历史
    useCanvasStore.getState().addNodes([mk('note', 'n3', 400, 0, { text: '三' })])
    expect(useCanvasStore.getState().redoDepth).toBe(0) // 新变更清空 redo
    useCanvasStore.getState().undo()
    useCanvasStore.getState().undo()
    expect(docOf().nodes).toEqual([])
    expect(docOf().viewport).toEqual({ x: 10, y: 10, zoom: 2 })
  })

  it('flush：PUT 携带 baseVersion；成功后 version+1、dirty 清空且不重复调度（无限保存循环回归）', async () => {
    await loadFresh([mk('note', 'n', 0, 0, { text: 'n' })])
    useCanvasStore.getState().addNodes([mk('note', 'n2', 300, 0, { text: 'x' })])
    expect(useCanvasStore.getState().dirty).toBe(true)
    await useCanvasStore.getState().flush()
    const st = useCanvasStore.getState()
    expect(st.dirty).toBe(false)
    expect(st.saving).toBe(false)
    expect(st.doc?.version).toBe(2)
    expect(st.doc?.nodes).toHaveLength(2)
    const puts = putCalls()
    expect(puts).toHaveLength(1)
    const body = JSON.parse(String(puts[0][1]?.body)) as { baseVersion: number; nodes: CanvasNode[] }
    expect(body.baseVersion).toBe(1)
    expect(body.nodes).toHaveLength(2)
    // 保存成功后不得再触发自动保存（旧缺陷：dirty 未清 → 每 800ms 重复 PUT）
    await vi.advanceTimersByTimeAsync(3000)
    expect(putCalls()).toHaveLength(1)
  })

  it('copySelection + pasteClipboard：边随选区复制、连续粘贴递增偏移并选中新节点', async () => {
    const a = mk('prompt', 'a', 10, 20, { text: '词' })
    const b = mk('image', 'b', 310, 20, {})
    await loadFresh([a, b], [edge('e1', 'a', 'b', 'flow')])
    useCanvasStore.getState().copySelection(['a', 'b'])
    expect(useCanvasStore.getState().clipboard?.nodes).toHaveLength(2)
    useCanvasStore.getState().pasteClipboard()
    let doc = docOf()
    expect(doc.nodes).toHaveLength(4)
    const pasted = doc.nodes.slice(2)
    expect(pasted[0].position).toEqual({ x: 38, y: 48 })
    expect(pasted[1].position).toEqual({ x: 338, y: 48 })
    expect(doc.edges).toHaveLength(2)
    expect(doc.edges[1].source).toBe(pasted[0].id)
    expect(doc.edges[1].target).toBe(pasted[1].id)
    expect(useCanvasStore.getState().selectedIds).toEqual(pasted.map((n) => n.id))
    useCanvasStore.getState().pasteClipboard()
    doc = docOf()
    expect(doc.nodes).toHaveLength(6)
    expect(doc.nodes[4].position).toEqual({ x: 66, y: 76 })
    expect(doc.nodes[5].position).toEqual({ x: 366, y: 76 })
  })

  it('duplicateNodes：就地偏移复制并选中副本', async () => {
    await loadFresh([mk('note', 'n', 10, 20, { text: '单' })])
    useCanvasStore.getState().duplicateNodes(['n'])
    const doc = docOf()
    expect(doc.nodes).toHaveLength(2)
    expect(doc.nodes[1].position).toEqual({ x: 38, y: 48 })
    expect(useCanvasStore.getState().selectedIds).toEqual([doc.nodes[1].id])
  })

  it('zOrder / align / tidy 动作接线（未选中节点保持不动）', async () => {
    await loadFresh([
      mk('note', 'a', 0, 0, { text: 'a' }),
      mk('note', 'b', 100, 50, { text: 'b' }),
      mk('note', 'c', 300, 200, { text: 'c' }),
    ])
    useCanvasStore.getState().zOrder(['a'], 'forward')
    expect(docOf().nodes.map((n) => n.id)).toEqual(['b', 'a', 'c'])
    useCanvasStore.getState().align(['a', 'b'], 'left')
    expect(nodeOf('a').position.x).toBe(0)
    expect(nodeOf('b').position.x).toBe(0)
    expect(nodeOf('c').position).toEqual({ x: 300, y: 200 })
  })

  it('applyReparent：收纳进画框转相对坐标且父排前；不二次压历史', async () => {
    const g = mk('group', 'g', 100, 100, { title: '框' }, { width: 380, height: 260 })
    const n = mk('note', 'n', 150, 150, { text: 'n' })
    await loadFresh([g, n])
    useCanvasStore.getState().applyReparent(['n'])
    const doc = docOf()
    expect(doc.nodes.map((x) => x.id)).toEqual(['g', 'n'])
    expect(doc.nodes[1].parentId).toBe('g')
    expect(doc.nodes[1].position).toEqual({ x: 50, y: 50 })
    expect(useCanvasStore.getState().undoDepth).toBe(0) // 拖拽起点已压栈，此处不再压
  })
})

// ---------- EmptyCanvas ----------

/** 媒体能力门控夹具（M31 修订）：全能力的提供方 → 四模板齐备 */
const FULL_MEDIA_PROVIDER: MediaProviderInfo = {
  connectionId: 'conn_test',
  connectionName: '测试生图生视频',
  provider: 'comfyui',
  capabilities: ['text2image', 'image2image', 'text2video', 'image2video', 'firstlast2video'],
  models: [],
  workflows: [],
}

describe('EmptyCanvas 空态模板（M31）', () => {
  beforeEach(() => {
    // 能力门控夹具复位（避免跨用例泄漏；beforeEach 时上轮组件已卸载，无 act 警告）
    useMediaStore.setState({ providers: [], providersLoaded: false })
  })

  it('渲染四模板卡片与快捷提示（已配置生图 / 生视频）', () => {
    useMediaStore.setState({ providers: [FULL_MEDIA_PROVIDER], providersLoaded: true })
    render(<EmptyCanvas onApply={vi.fn()} />)
    expect(screen.getByText('空白画布')).toBeInTheDocument()
    for (const t of CANVAS_TEMPLATES) {
      expect(screen.getByText(t.name)).toBeInTheDocument()
    }
    expect(screen.getByText('双击新建便签')).toBeInTheDocument()
    expect(screen.getByText('拖入图片 / 视频')).toBeInTheDocument()
  })

  it('未配置媒体能力：创作台 / 分镜台不出现，脑图工坊 / 素材墙恒显（M31 修订）', () => {
    render(<EmptyCanvas onApply={vi.fn()} />)
    expect(screen.queryByText('创作台')).not.toBeInTheDocument()
    expect(screen.queryByText('分镜台')).not.toBeInTheDocument()
    expect(screen.getByText('脑图工坊')).toBeInTheDocument()
    expect(screen.getByText('素材墙')).toBeInTheDocument()
  })

  it('仅配置生图：创作台出现、分镜台仍隐藏（能力拆分粒度）', () => {
    useMediaStore.setState({
      providers: [{ ...FULL_MEDIA_PROVIDER, capabilities: ['text2image'] }],
      providersLoaded: true,
    })
    render(<EmptyCanvas onApply={vi.fn()} />)
    expect(screen.getByText('创作台')).toBeInTheDocument()
    expect(screen.queryByText('分镜台')).not.toBeInTheDocument()
  })

  it('点击模板卡片回调对应 id（已配置能力）', async () => {
    useMediaStore.setState({ providers: [FULL_MEDIA_PROVIDER], providersLoaded: true })
    const onApply = vi.fn()
    const user = userEvent.setup()
    render(<EmptyCanvas onApply={onApply} />)
    await user.click(screen.getByRole('button', { name: /创作台/ }))
    expect(onApply).toHaveBeenCalledWith('studio')
    await user.click(screen.getByRole('button', { name: /脑图工坊/ }))
    expect(onApply).toHaveBeenCalledWith('mind')
  })
})

// ---------- useInlineEdit ----------

function EditProbe({
  nodeId,
  value,
  onCommit,
}: {
  nodeId: string
  value: string
  onCommit: (text: string) => void
}): React.JSX.Element {
  const edit = useInlineEdit(nodeId, value, onCommit)
  return (
    <div>
      <span data-testid="editing">{edit.editing ? 'yes' : 'no'}</span>
      <textarea
        data-testid="draft"
        value={edit.draft}
        onChange={(e) => edit.setDraft(e.target.value)}
        onKeyDown={edit.onKeyDown}
      />
      <button type="button" onClick={edit.begin}>
        begin
      </button>
      <button type="button" onClick={edit.commit}>
        commit
      </button>
    </div>
  )
}

describe('useInlineEdit 内联编辑（M31）', () => {
  it('进入编辑回填当前值；修改后提交回调；未改动提交不回调', async () => {
    const onCommit = vi.fn()
    const user = userEvent.setup()
    render(<EditProbe nodeId="n1" value="原始" onCommit={onCommit} />)
    expect(screen.getByTestId('editing')).toHaveTextContent('no')
    await user.click(screen.getByRole('button', { name: 'begin' }))
    expect(screen.getByTestId('editing')).toHaveTextContent('yes')
    const box = screen.getByTestId('draft')
    expect(box).toHaveValue('原始')
    await user.clear(box)
    await user.type(box, '改好了')
    await user.click(screen.getByRole('button', { name: 'commit' }))
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith('改好了')
    expect(screen.getByTestId('editing')).toHaveTextContent('no')
    onCommit.mockClear()
    await user.click(screen.getByRole('button', { name: 'begin' }))
    await user.click(screen.getByRole('button', { name: 'commit' }))
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('Esc 取消不提交；⌘Enter 提交', async () => {
    const onCommit = vi.fn()
    const user = userEvent.setup()
    render(<EditProbe nodeId="n1" value="v" onCommit={onCommit} />)
    const box = screen.getByTestId('draft')
    await user.click(screen.getByRole('button', { name: 'begin' }))
    await user.clear(box)
    await user.type(box, 'x')
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(screen.getByTestId('editing')).toHaveTextContent('no')
    expect(onCommit).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'begin' }))
    await user.clear(box)
    await user.type(box, 'y')
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true })
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith('y')
    expect(screen.getByTestId('editing')).toHaveTextContent('no')
  })

  it('autoEditId 命中自动进入编辑并消费信令；不匹配则不进入', () => {
    const endAutoEdit = vi.fn()
    const { unmount } = render(
      <CanvasUiContext.Provider value={{ autoEditId: 'n1', beginAutoEdit: vi.fn(), endAutoEdit }}>
        <EditProbe nodeId="n1" value="新便签" onCommit={vi.fn()} />
      </CanvasUiContext.Provider>,
    )
    expect(screen.getByTestId('editing')).toHaveTextContent('yes')
    expect(screen.getByTestId('draft')).toHaveValue('新便签')
    expect(endAutoEdit).toHaveBeenCalledTimes(1)
    unmount()
    render(
      <CanvasUiContext.Provider value={{ autoEditId: 'other', beginAutoEdit: vi.fn(), endAutoEdit: vi.fn() }}>
        <EditProbe nodeId="n1" value="新便签" onCommit={vi.fn()} />
      </CanvasUiContext.Provider>,
    )
    expect(screen.getByTestId('editing')).toHaveTextContent('no')
  })
})

// ---------- 送上画布与画布动作通道（P5） ----------

describe('canvasNodeTypeOf / nextPlacement（M31 P5）', () => {
  it('扩展名 → 节点类型：图片 / 视频直出；其余按交付件引用（含不可播放容器）', () => {
    expect(canvasNodeTypeOf('canvas/media/gen-1.png')).toBe('image')
    expect(canvasNodeTypeOf('shots/frame.webp')).toBe('image')
    expect(canvasNodeTypeOf('canvas/media/clip.mp4')).toBe('video')
    expect(canvasNodeTypeOf('canvas/media/clip.mkv')).toBe('artifact')
    expect(canvasNodeTypeOf('docs/report.md')).toBe('artifact')
    expect(canvasNodeTypeOf('src/index.ts')).toBe('artifact')
  })

  it('nextPlacement：空画布取原点；否则右缘 +80、纵向对齐最上方节点（与服务端 autoPosition 同语义）', () => {
    expect(nextPlacement([])).toEqual({ x: 0, y: 0 })
    const a = mk('image', 'a', 100, 50, {})
    const b = mk('note', 'b', 0, 200, { text: 'x' })
    // a 右缘 = 100 + 280（image 默认宽）→ +80 = 460；y 取 min(50, 200) = 50
    expect(nextPlacement([a, b])).toEqual({ x: 460, y: 50 })
  })
})

describe('canvas-store「送上画布」与动作通道（M31 P5）', () => {
  let docRef: CanvasDoc
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    docRef = { v: 1, sessionId: 's-art', version: 1, updatedAt: T0, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [] }
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as {
          baseVersion: number
          nodes: CanvasNode[]
          edges: CanvasEdge[]
          viewport: CanvasDoc['viewport']
        }
        docRef = { ...docRef, version: body.baseVersion + 1, nodes: body.nodes, edges: body.edges, viewport: body.viewport }
        return { ok: true, status: 200, json: async () => ({ doc: docRef }) }
      }
      return { ok: true, status: 200, json: async () => ({ doc: docRef, mediaBound: false }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    useCanvasStore.setState({
      sessionId: undefined,
      doc: null,
      mediaBound: false,
      loading: false,
      saving: false,
      dirty: false,
      saveError: undefined,
      lastSavedAt: undefined,
      selectedIds: [],
      clipboard: null,
      pendingAction: null,
      undoDepth: 0,
      redoDepth: 0,
    })
    useSessionStore.setState({ currentId: docRef.sessionId })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    useSessionStore.setState({ currentId: undefined })
  })

  it('sendArtifact 未加载时自拉取并落位（图片 → image 节点带 source:ref，选中 + 入脏）', async () => {
    const id = await useCanvasStore.getState().sendArtifact('canvas/media/gen-1.png')
    expect(fetchMock).toHaveBeenCalledTimes(1) // 仅 GET 拉取一次（未触保存防抖）
    const doc = useCanvasStore.getState().doc
    expect(doc?.nodes).toHaveLength(1)
    const node = doc!.nodes[0]
    expect(node.id).toBe(id)
    expect(node.type).toBe('image')
    expect((node.data as { artifact?: string }).artifact).toBe('canvas/media/gen-1.png')
    expect((node.data as { source?: string }).source).toBe('ref')
    expect(node.position).toEqual({ x: 0, y: 0 })
    expect(useCanvasStore.getState().selectedIds).toEqual([id])
    expect(useCanvasStore.getState().dirty).toBe(true)
  })

  it('连续送上：第二个节点落在前一个右缘 +80；视频 → video 节点', async () => {
    await useCanvasStore.getState().sendArtifact('a.png')
    await useCanvasStore.getState().sendArtifact('b.mp4')
    const doc = useCanvasStore.getState().doc
    expect(doc?.nodes.map((n) => n.type)).toEqual(['image', 'video'])
    // image 默认宽 280 → 右缘 280 + 80 = 360
    expect(doc!.nodes[1].position.x).toBe(360)
  })

  it('非媒体文件 → artifact 引用节点（data.path）', async () => {
    await useCanvasStore.getState().sendArtifact('docs/report.md')
    const node = useCanvasStore.getState().doc!.nodes[0]
    expect(node.type).toBe('artifact')
    expect((node.data as { path?: string }).path).toBe('docs/report.md')
  })

  it('sendGame 未加载时自拉取并落位（game 结果态节点：model / topic / symbol / seed / params / stats / narrative / result 全量内联）', async () => {
    const id = await useCanvasStore.getState().sendGame({
      model: 'matrix',
      topic: '茅台多空对峙推演',
      symbol: 'sh600519',
      seed: 20260918,
      params: { priceImpact: 0.06, carryCost: 0.03 },
      stats: { gameType: 'chicken' },
      narrative: '先退让方损失最小',
      result: { actions: ['aggressive', 'hold', 'retreat'] },
    })
    expect(fetchMock).toHaveBeenCalledTimes(1) // 仅 GET 拉取一次（未触保存防抖）
    const doc = useCanvasStore.getState().doc
    expect(doc?.nodes).toHaveLength(1)
    const node = doc!.nodes[0]
    expect(node.id).toBe(id)
    expect(node.type).toBe('game')
    expect(node.data).toMatchObject({
      model: 'matrix',
      topic: '茅台多空对峙推演',
      symbol: 'sh600519',
      seed: 20260918,
      params: { priceImpact: 0.06, carryCost: 0.03 },
      stats: { gameType: 'chicken' },
      narrative: '先退让方损失最小',
    })
    expect((node.data as { result?: unknown }).result).toEqual({ actions: ['aggressive', 'hold', 'retreat'] })
    expect(node.position).toEqual({ x: 0, y: 0 })
    expect(useCanvasStore.getState().selectedIds).toEqual([id])
    expect(useCanvasStore.getState().dirty).toBe(true)
  })

  it('sendKline 落位 kline 节点（bars / 元信息内联，后续可切周期）', async () => {
    const id = await useCanvasStore.getState().sendKline({
      symbol: 'sh600519',
      name: '贵州茅台',
      period: 'day',
      adjust: 'qfq',
      bars: [{ timestamp: 1757952000000, open: 1450, high: 1468, low: 1442, close: 1461, volume: 28300 }],
      indicators: ['MA', 'VOL'],
    })
    const doc = useCanvasStore.getState().doc
    expect(doc?.nodes).toHaveLength(1)
    const node = doc!.nodes[0]
    expect(node.id).toBe(id)
    expect(node.type).toBe('kline')
    expect(node.data).toMatchObject({
      symbol: 'sh600519',
      name: '贵州茅台',
      period: 'day',
      adjust: 'qfq',
      indicators: ['MA', 'VOL'],
    })
    expect((node.data as { bars?: unknown[] }).bars).toHaveLength(1)
    expect(useCanvasStore.getState().selectedIds).toEqual([id])
    expect(useCanvasStore.getState().dirty).toBe(true)
  })

  it('无会话时不落节点（返回 undefined，文档保持未加载）', async () => {
    useSessionStore.setState({ currentId: undefined })
    expect(await useCanvasStore.getState().sendArtifact('x.png')).toBeUndefined()
    expect(await useCanvasStore.getState().sendGame({ model: 'evolve' })).toBeUndefined()
    expect(await useCanvasStore.getState().sendKline({ symbol: 'sh600519' })).toBeUndefined()
    expect(useCanvasStore.getState().doc).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('动作通道：requestAction 记录 kind 与 nonce；consumeAction 清空后再次触发', () => {
    useCanvasStore.getState().requestAction('mind')
    const pending = useCanvasStore.getState().pendingAction
    expect(pending?.kind).toBe('mind')
    expect(typeof pending?.nonce).toBe('number')
    useCanvasStore.getState().consumeAction()
    expect(useCanvasStore.getState().pendingAction).toBeNull()
    useCanvasStore.getState().requestAction('fit')
    expect(useCanvasStore.getState().pendingAction?.kind).toBe('fit')
  })
})

/**
 * M31 脑图前端测试（P4）：
 * - lib/mind.ts 纯函数：索引（邻接/根/子树/防环）/ 尺寸估算 / 加子加兄弟 / 重挂（防环与旧边移除）/
 *   dagre 布局（根保持原位、兄弟不重叠）/ LLM 树落画布 / Markdown 导出与大纲解析往返；
 * - canvas-store：脑图快捷编辑动作（mindAddChild / mindAddSibling / mindReparent / arrangeMind）；
 * - MindDialog：五来源渲染 / AI 生成请求契约与落画布 / 失败引导 / 大纲导入 / ⌘Enter。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import * as React from 'react'
import type {
  CanvasDoc,
  CanvasEdge,
  CanvasEdgeKind,
  CanvasNode,
  CanvasNodeData,
  CanvasNodeType,
  MindTreeNode,
} from '@multi-agent/shared'
import { createNode } from '../src/lib/canvas'
import { useCanvasStore } from '../src/stores/canvas-store'
import { MindDialog } from '../src/components/canvas/MindDialog'
import {
  applyMindLayout,
  estimateMindSize,
  extractMindTree,
  indexMind,
  isMindDescendant,
  layoutMindSubtree,
  MIND_H_GAP,
  MIND_V_GAP,
  mindRootOf,
  mindRoots,
  mindSubtreeIds,
  mindTreeInserts,
  parseMindOutline,
  planAddChild,
  planAddSibling,
  planReparent,
  treeToMarkdown,
} from '../src/lib/mind'

// sonner mock（模块级单例：调用记录跨用例累积，beforeEach 必须清理）
vi.mock('sonner', () => {
  const fn = vi.fn()
  return { toast: Object.assign(fn, { error: vi.fn(), success: vi.fn() }) }
})

function mk(
  type: CanvasNodeType,
  id: string,
  x: number,
  y: number,
  data: CanvasNodeData,
): CanvasNode {
  return { ...createNode(type, { x, y }, data), id }
}

function edge(id: string, source: string, target: string, kind: CanvasEdgeKind): CanvasEdge {
  return { id, source, target, kind }
}

function mind(id: string, x: number, y: number, text: string): CanvasNode {
  return mk('mind', id, x, y, { text })
}

/** 树 A：root → a / b；a → c */
function treeA(): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  return {
    nodes: [mind('root', 0, 0, '主题'), mind('a', 300, -60, '分支甲'), mind('b', 300, 60, '分支乙'), mind('c', 600, -60, '要点')],
    edges: [edge('e1', 'root', 'a', 'mind'), edge('e2', 'root', 'b', 'mind'), edge('e3', 'a', 'c', 'mind')],
  }
}

/** AI 生成返回的样例树（MindDialog 落画布契约） */
const SAMPLE_TREE: MindTreeNode = {
  title: '登录重构',
  children: [
    { title: '阶段一', children: [{ title: '抽离会话层' }] },
    { title: '阶段二', children: [{ title: '接入 OAuth' }] },
  ],
}

describe('indexMind / 根与子树（M31）', () => {
  it('只收两端均为 mind 节点的 mind 边；重复入边只取第一条', () => {
    const { nodes, edges } = treeA()
    const extra = [
      ...edges,
      edge('ef', 'root', 'note1', 'mind'), // 目标非 mind → 忽略
      edge('e_flow', 'root', 'a', 'flow'), // 非 mind 边 → 忽略
      edge('e_dup', 'b', 'c', 'mind'), // c 已有父 a → 忽略
    ]
    const index = indexMind([...nodes, mk('note', 'note1', 900, 0, { text: '旁注' })], extra)
    expect(index.parentOf.get('a')).toBe('root')
    expect(index.parentOf.get('c')).toBe('a')
    expect(index.childrenOf.get('root')).toEqual(['a', 'b'])
  })

  it('mindRoots 按阅读序（先 y 后 x）；mindRootOf 追溯；mindSubtreeIds 前序；环不死循环', () => {
    const { nodes, edges } = treeA()
    const second = mind('root2', -200, 400, '第二棵树')
    const all = [...nodes, second]
    const index = indexMind(all, edges)
    expect(mindRoots(all, index)).toEqual(['root', 'root2'])
    expect(mindRootOf(index, 'c')).toBe('root')
    expect(mindSubtreeIds(index, 'root')).toEqual(['root', 'a', 'c', 'b'])
    expect(isMindDescendant(index, 'root', 'c')).toBe(true)
    expect(isMindDescendant(index, 'a', 'b')).toBe(false)

    const cyclic = indexMind(nodes, [...edges, edge('e4', 'c', 'root', 'mind')])
    expect(mindSubtreeIds(cyclic, 'root')).toEqual(['root', 'a', 'c', 'b'])
  })
})

describe('estimateMindSize（M31）', () => {
  it('CJK 与拉丁估算差异；下限 112（min-w-28），上限 248；空文本按「主题」', () => {
    const cjk = estimateMindSize('十个汉字十个汉字')
    const latin = estimateMindSize('abcdefghij')
    expect(cjk.width).toBeGreaterThan(latin.width)
    expect(estimateMindSize('').width).toBe(estimateMindSize('主题').width)
    expect(estimateMindSize('超长'.repeat(80)).width).toBe(248)
    expect(latin.width).toBe(128) // 24 + 12 + 68(10×6.8) + 24
    expect(cjk.height).toBe(34)
  })
})

describe('planAddChild / planAddSibling（M31）', () => {
  it('无子节点：与父垂直居中、落在父右缘 + MIND_H_GAP', () => {
    const root = mind('root', 100, 200, '主题')
    const plan = planAddChild([root], indexMind([root], []), 'root')
    expect(plan).toBeDefined()
    const size = estimateMindSize('主题')
    expect(plan!.node.position.x).toBe(100 + size.width + MIND_H_GAP)
    expect(plan!.node.position.y).toBe(200)
    expect(plan!.edge.kind).toBe('mind')
    expect(plan!.edge.source).toBe('root')
    expect(plan!.edge.target).toBe(plan!.node.id)
  })

  it('有子节点：追加在最下缘 + MIND_V_GAP；非 mind / 不存在返回 undefined', () => {
    const { nodes, edges } = treeA()
    const plan = planAddChild(nodes, indexMind(nodes, edges), 'root', '新分支')
    const bottom = Math.max(-60 + 34, 60 + 34) // b 最下缘
    expect(plan!.node.position.y).toBe(bottom + MIND_V_GAP)
    expect(planAddChild(nodes, indexMind(nodes, edges), 'missing')).toBeUndefined()
    const note = mk('note', 'n1', 0, 0, { text: '便签' })
    expect(planAddChild([note], indexMind([note], []), 'n1')).toBeUndefined()
  })

  it('加兄弟：根返回 undefined（回落加子）；子节点追加到父下最后', () => {
    const { nodes, edges } = treeA()
    const index = indexMind(nodes, edges)
    expect(planAddSibling(nodes, index, 'root')).toBeUndefined()
    const plan = planAddSibling(nodes, index, 'b', '新分支')
    expect(plan!.edge.source).toBe('root')
    // 落位 = 父右缘 + MIND_H_GAP（与现有兄弟同列）
    expect(plan!.node.position.x).toBe(estimateMindSize('主题').width + MIND_H_GAP)
  })
})

describe('planReparent 重挂（M31）', () => {
  it('拒绝：自身 / 目标在后代内（防环）/ 已是目标的子', () => {
    const { nodes, edges } = treeA()
    const index = indexMind(nodes, edges)
    expect(planReparent(nodes, edges, index, 'root', 'root')).toBeUndefined()
    expect(planReparent(nodes, edges, index, 'root', 'c')).toBeUndefined() // c 在 root 子树内
    expect(planReparent(nodes, edges, index, 'c', 'a')).toBeUndefined() // a 已是 c 的父
  })

  it('成功：新父子边 + 移除旧入边 + 落位为目标的最后子', () => {
    const { nodes, edges } = treeA()
    const plan = planReparent(nodes, edges, indexMind(nodes, edges), 'a', 'b')!
    expect(plan.edge.source).toBe('b')
    expect(plan.edge.target).toBe('a')
    expect(plan.removeEdgeIds).toEqual(['e1'])
    expect(plan.position.x).toBe(300 + estimateMindSize('分支乙').width + MIND_H_GAP)
  })

  it('根重挂：无旧入边（removeEdgeIds 为空）', () => {
    const { nodes, edges } = treeA()
    const all = [...nodes, mind('root2', -400, 0, '孤树')]
    const plan = planReparent(all, edges, indexMind(all, edges), 'root2', 'b')!
    expect(plan.removeEdgeIds).toEqual([])
    expect(plan.edge.source).toBe('b')
  })
})

describe('applyMindLayout / layoutMindSubtree（M31）', () => {
  it('布局：根保持原位；子节点落在根右侧；兄弟纵向不重叠', () => {
    const { nodes, edges } = treeA()
    const index = indexMind(nodes, edges)
    const out = applyMindLayout(nodes, index, ['root'])
    const byId = new Map(out.map((n) => [n.id, n]))
    expect(byId.get('root')!.position).toEqual({ x: 0, y: 0 })
    expect(byId.get('a')!.position.x).toBeGreaterThan(0)
    expect(byId.get('c')!.position.x).toBeGreaterThan(byId.get('a')!.position.x)
    expect(Math.abs(byId.get('a')!.position.y - byId.get('b')!.position.y)).toBeGreaterThanOrEqual(34)
  })

  it('多根各自原位；非 mind 节点不动；未指向的树不参与', () => {
    const { nodes, edges } = treeA()
    const second = mind('root2', -600, 100, '第二棵树')
    const note = mk('note', 'n1', 9999, 9999, { text: '便签' })
    const all = [...nodes, second, note]
    const index = indexMind(all, edges)
    const out = applyMindLayout(all, index, ['root'])
    const byId = new Map(out.map((n) => [n.id, n]))
    expect(byId.get('root2')!.position).toEqual({ x: -600, y: 100 })
    expect(byId.get('n1')!.position).toEqual({ x: 9999, y: 9999 })
  })

  it('layoutMindSubtree：覆盖整棵子树且坐标唯一', () => {
    const { nodes, edges } = treeA()
    const layout = layoutMindSubtree(nodes, indexMind(nodes, edges), 'root')
    expect([...layout.keys()].sort()).toEqual(['a', 'b', 'c', 'root'])
    const seen = new Set([...layout.values()].map((p) => `${p.x},${p.y}`))
    expect(seen.size).toBe(4)
  })
})

describe('mindTreeInserts：LLM 树 → 画布（M31）', () => {
  it('节点与边数量正确；根落在 origin；子节点在根右侧', () => {
    const tree = {
      title: '主题',
      children: [
        { title: '分支甲', children: [{ title: '要点一' }, { title: '要点二' }] },
        { title: '分支乙' },
      ],
    }
    const { nodes, edges } = mindTreeInserts(tree, { x: 500, y: 300 })
    expect(nodes).toHaveLength(5)
    expect(edges).toHaveLength(4)
    const root = nodes.find((n) => (n.data as { text: string }).text === '主题')!
    expect(root.position).toEqual({ x: 500, y: 300 })
    const branch = nodes.find((n) => (n.data as { text: string }).text === '分支甲')!
    expect(branch.position.x).toBeGreaterThan(500)
  })
})

describe('Markdown 导出与解析（M31）', () => {
  it('extractMindTree：画布子树 → 树结构；treeToMarkdown：两空格缩进列表', () => {
    const { nodes, edges } = treeA()
    const tree = extractMindTree(nodes, indexMind(nodes, edges), 'root')
    expect(tree).toEqual({
      title: '主题',
      children: [
        { title: '分支甲', children: [{ title: '要点' }] },
        { title: '分支乙' },
      ],
    })
    expect(treeToMarkdown(tree)).toBe('- 主题\n  - 分支甲\n    - 要点\n  - 分支乙')
  })

  it('parseMindOutline：markdown → 树 → markdown 往返一致', () => {
    const md = '- 主题\n  - 分支甲\n    - 要点\n  - 分支乙'
    const tree = parseMindOutline(md)!
    expect(tree.title).toBe('主题')
    expect(tree.children).toHaveLength(2)
    expect(tree.children![0]!.children![0]!.title).toBe('要点')
    expect(treeToMarkdown(tree)).toBe(md)
  })

  it('parseMindOutline：标题与列表混合；跳层收敛为「父深一层」；空文本 undefined', () => {
    const mixed = parseMindOutline('# 根主题\n## 分支\n- 要点一\n- 要点二')!
    expect(mixed.title).toBe('根主题')
    expect(mixed.children).toHaveLength(1)
    expect(mixed.children![0]!.children!.map((c) => c.title)).toEqual(['要点一', '要点二'])

    const jump = parseMindOutline('- 根\n        - 一跳四层')!
    expect(jump.children![0]!.title).toBe('一跳四层')

    expect(parseMindOutline('   \n\n')).toBeUndefined()
  })
})

// ---------- canvas-store：脑图快捷编辑 / 重挂 / 整理 ----------

describe('canvas-store：脑图快捷编辑与整理（M31）', () => {
  let docRef: CanvasDoc
  let seq = 0
  let fetchMock: ReturnType<typeof vi.fn>

  const makeFetchMock = (): ReturnType<typeof vi.fn> =>
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
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

  const loadFresh = async (nodes: CanvasNode[] = [], edges: CanvasEdge[] = []): Promise<void> => {
    seq += 1
    docRef = { v: 1, sessionId: `sm${seq}`, version: 1, updatedAt: '', viewport: { x: 0, y: 0, zoom: 1 }, nodes, edges }
    await useCanvasStore.getState().load(docRef.sessionId)
  }

  const docOf = (): CanvasDoc => useCanvasStore.getState().doc!

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
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

  it('mindAddChild：加子节点 + mind 边 + 选中新节点；undo 可撤销', async () => {
    const { nodes, edges } = treeA()
    await loadFresh(nodes, edges)
    const newId = useCanvasStore.getState().mindAddChild('a')
    expect(newId).toBeDefined()
    const doc = docOf()
    expect(doc.nodes).toHaveLength(5)
    const added = doc.nodes.find((n) => n.id === newId)!
    expect(added.type).toBe('mind')
    expect((added.data as { text: string }).text).toBe('新分支')
    // 落位：父（分支甲）右缘 + MIND_H_GAP
    expect(added.position.x).toBe(300 + estimateMindSize('分支甲').width + MIND_H_GAP)
    expect(doc.edges.some((e) => e.kind === 'mind' && e.source === 'a' && e.target === newId)).toBe(true)
    expect(useCanvasStore.getState().selectedIds).toEqual([newId])
    expect(useCanvasStore.getState().dirty).toBe(true)
    useCanvasStore.getState().undo()
    expect(docOf().nodes).toHaveLength(4)
  })

  it('mindAddSibling：子节点加兄弟；根回落为加子；非 mind 返回 undefined', async () => {
    const { nodes, edges } = treeA()
    await loadFresh(nodes, edges)
    const sib = useCanvasStore.getState().mindAddSibling('b')!
    const sibNode = docOf().nodes.find((n) => n.id === sib)!
    expect(docOf().edges.some((e) => e.source === 'root' && e.target === sib)).toBe(true)
    expect(sibNode.position.x).toBe(estimateMindSize('主题').width + MIND_H_GAP)
    const rootChild = useCanvasStore.getState().mindAddSibling('root')!
    expect(docOf().edges.some((e) => e.source === 'root' && e.target === rootChild)).toBe(true)
    const note = mk('note', 'n1', 0, 0, { text: '旁注' })
    await loadFresh([...nodes, note], edges)
    expect(useCanvasStore.getState().mindAddSibling('n1')).toBeUndefined()
    expect(useCanvasStore.getState().mindAddChild('n1')).toBeUndefined()
    expect(useCanvasStore.getState().mindAddChild('missing')).toBeUndefined()
  })

  it('mindReparent：重挂替换旧入边并落位；防环 / 已父子 / 自身拒绝', async () => {
    const { nodes, edges } = treeA()
    await loadFresh(nodes, edges)
    expect(useCanvasStore.getState().mindReparent('root', 'c')).toBe(false) // 目标在后代内
    expect(useCanvasStore.getState().mindReparent('c', 'a')).toBe(false) // 已是其子
    expect(useCanvasStore.getState().mindReparent('a', 'a')).toBe(false)
    expect(useCanvasStore.getState().mindReparent('a', 'b')).toBe(true)
    const doc = docOf()
    expect(doc.edges.some((e) => e.source === 'root' && e.target === 'a')).toBe(false)
    expect(doc.edges.some((e) => e.source === 'b' && e.target === 'a')).toBe(true)
    const a = doc.nodes.find((n) => n.id === 'a')!
    expect(a.position.x).toBe(300 + estimateMindSize('分支乙').width + MIND_H_GAP)
  })

  it('arrangeMind：根保持原位重排子树；空选 / 无脑图选区不产生历史', async () => {
    const { nodes, edges } = treeA()
    await loadFresh(nodes, edges)
    const rootBefore = docOf().nodes.find((n) => n.id === 'root')!.position
    useCanvasStore.getState().arrangeMind(['c'])
    const doc = docOf()
    expect(doc.nodes.find((n) => n.id === 'root')!.position).toEqual(rootBefore)
    const a = doc.nodes.find((n) => n.id === 'a')!
    const c = doc.nodes.find((n) => n.id === 'c')!
    expect(c.position.x).toBeGreaterThan(a.position.x)
    const depthBefore = useCanvasStore.getState().undoDepth
    useCanvasStore.getState().arrangeMind([])
    useCanvasStore.getState().arrangeMind(['missing'])
    expect(useCanvasStore.getState().undoDepth).toBe(depthBefore)
  })
})

// ---------- MindDialog：脑图工坊 ----------

describe('MindDialog 脑图工坊（M31）', () => {
  let docRef: CanvasDoc
  let mindResponse: { status: number; body: unknown }
  let fetchMock: ReturnType<typeof vi.fn>

  const mindPostCalls = (): Array<[input: RequestInfo | URL, init?: RequestInit]> =>
    fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/canvas/mind')) as Array<
      [input: RequestInfo | URL, init?: RequestInit]
    >

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mindResponse = { status: 200, body: { tree: SAMPLE_TREE, source: 'conversation' } }
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/canvas/mind')) {
        return { ok: mindResponse.status === 200, status: mindResponse.status, json: async () => mindResponse.body }
      }
      if (init?.method === 'PUT') {
        return { ok: true, status: 200, json: async () => ({ doc: docRef }) }
      }
      return { ok: true, status: 200, json: async () => ({ doc: docRef, mediaBound: false }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    docRef = { v: 1, sessionId: 's-mind', version: 1, updatedAt: '', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [] }
    useCanvasStore.setState({
      sessionId: 's-mind',
      doc: docRef,
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

  it('渲染五来源；选择「主题」后出现输入框', () => {
    render(<MindDialog origin={{ x: 500, y: 300 }} onClose={vi.fn()} />)
    expect(screen.getByText('脑图工坊')).toBeInTheDocument()
    expect(screen.getAllByRole('radio')).toHaveLength(5)
    expect(screen.queryByPlaceholderText(/输入主题/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: /主题/ }))
    expect(screen.getByPlaceholderText(/输入主题/)).toBeInTheDocument()
  })

  it('AI 生成：POST 请求契约；树落画布（根在原点）并回调 onClose', async () => {
    const onClose = vi.fn()
    render(<MindDialog origin={{ x: 500, y: 300 }} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /AI 生成脑图/ }))
    await act(async () => {})
    const posts = mindPostCalls()
    expect(posts).toHaveLength(1)
    const body = JSON.parse(String(posts[0][1]?.body)) as { source: string; topic?: string }
    expect(body.source).toBe('conversation')
    expect(body.topic).toBeUndefined()
    expect(onClose).toHaveBeenCalledTimes(1)
    const doc = useCanvasStore.getState().doc!
    expect(doc.nodes).toHaveLength(5)
    expect(doc.edges).toHaveLength(4)
    expect(doc.nodes.some((n) => n.position.x === 500 && n.position.y === 300)).toBe(true)
  })

  it('主题来源：未填时禁用生成；提交携带主题文本', async () => {
    const onClose = vi.fn()
    render(<MindDialog origin={{ x: 0, y: 0 }} onClose={onClose} />)
    fireEvent.click(screen.getByRole('radio', { name: /主题/ }))
    const btn = screen.getByRole('button', { name: /AI 生成脑图/ })
    expect(btn).toBeDisabled()
    fireEvent.change(screen.getByPlaceholderText(/输入主题/), { target: { value: '微服务拆分' } })
    expect(btn).not.toBeDisabled()
    fireEvent.click(btn)
    await act(async () => {})
    const body = JSON.parse(String(mindPostCalls()[0][1]?.body)) as { source: string; topic?: string }
    expect(body.source).toBe('topic')
    expect(body.topic).toBe('微服务拆分')
  })

  it('失败：显示服务端引导错误且不落画布；⌘Enter 快速生成', async () => {
    mindResponse = { status: 422, body: { error: '本会话还没有对话内容：先聊几句，再从对话生成脑图' } }
    const onClose = vi.fn()
    render(<MindDialog origin={{ x: 0, y: 0 }} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /AI 生成脑图/ }))
    await act(async () => {})
    expect(screen.getByText(/本会话还没有对话内容/)).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    expect(useCanvasStore.getState().doc!.nodes).toHaveLength(0)
    // ⌘Enter（主键组合）再次触发生成
    expect(mindPostCalls()).toHaveLength(1)
    fireEvent.keyDown(screen.getByText('脑图工坊'), { key: 'Enter', metaKey: true })
    await act(async () => {})
    expect(mindPostCalls()).toHaveLength(2)
  })

  it('大纲导入：Markdown → 树落画布并关闭', async () => {
    const onClose = vi.fn()
    render(<MindDialog origin={{ x: 100, y: 100 }} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /Markdown 大纲/ }))
    fireEvent.change(screen.getByPlaceholderText(/中心主题/), { target: { value: '- 主题A\n  - 分支B' } })
    fireEvent.click(screen.getByRole('button', { name: '从大纲创建' }))
    await act(async () => {})
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(mindPostCalls()).toHaveLength(0)
    const doc = useCanvasStore.getState().doc!
    expect(doc.nodes).toHaveLength(2)
    expect(doc.edges).toHaveLength(1)
  })
})

/**
 * M31：无限画布（会话级空间化工作台，主区「画布」Tab）。P2 画布内核版。
 *
 * 交互全集：框选 / 多选拖动 / 连线（合法性矩阵 + 去重）/ 复制粘贴 / 撤销重做（⌘Z ⇧⌘Z /
 * ⌘C ⌘V / ⌘S）/ 节点右键菜单 / 双击空白创建 / 双击空白右键创建菜单 / 拖拽上传（含尺寸自适应）/
 * 对齐参考线吸附 / 对齐分布网格整理 / 适应视野 / 导出 JSON / 画框收纳（拖入包含，拖出脱离）；
 * P4 脑图：Tab 加子 / Enter 加兄弟（单选 mind 且进入编辑）、拖拽重挂（落上胶囊成为其子）、
 * 脑图工坊（AI 五来源 + Markdown 大纲）、脑图整理、导出脑图 Markdown。
 * M36：底部指令条（CanvasComposer）——画布与对话同级的输入能力，消息进入当前会话、
 * Agent 直接操作画布；右下小地图移除（画布即全景，适应视野/缩放已足够）。
 *
 * 受控模式风险（协作图谱经验）：重建节点列表必须复用未变化节点引用并保留 measured，
 * 否则 React Flow 会短暂隐藏节点（悬停闪烁 / 点击失效）—— mergeNodes 已内置该策略。
 * 尺寸提交：NodeResizer 经 onNodesChange dimensions（setAttributes=true）更新本地 nodes；
 * resizing === false 时写回文档（受控持久化），resizing === true 起点压一次撤销快照。
 */
import * as React from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  ViewportPortal,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeDimensionChange,
  type OnSelectionChangeParams,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { toast } from 'sonner'
import type { CanvasDoc } from '@multi-agent/shared'
import {
  absolutePosition,
  canConnect,
  collapsedHiddenIds,
  computeSnap,
  createNode,
  sizeOf,
  NODE_SIZE,
  type SnapGuide,
  type SnapRect,
} from '../../lib/canvas'
import { buildTemplate, type CanvasTemplateId } from '../../lib/canvas-templates'
import { estimateMindSize, extractMindTree, indexMind, mindNodeText, mindRoots, treeToMarkdown } from '../../lib/mind'
import { useCanvasStore } from '../../stores/canvas-store'
import { useMediaStore } from '../../stores/media-store'
import { useSessionStore } from '../../stores/session-store'
import { cn } from '../../lib/utils'
import { CanvasComposer } from './CanvasComposer'
import { CanvasCreateMenu, type CreateKind } from './CanvasCreateMenu'
import { CanvasToolbar } from './CanvasToolbar'
import { EmptyCanvas } from './EmptyCanvas'
import { GenerationPanel } from './GenerationPanel'
import { MindDialog } from './MindDialog'
import { NodeContextMenu } from './NodeContextMenu'
import { CanvasUiContext, type CanvasUiValue } from './CanvasUiContext'
import { CANVAS_NODE_TYPES } from './nodes'
import { CANVAS_EDGE_TYPES } from './edges/FlowEdge'

/** fitView 放大上限（不对小内容做超原生尺寸的放大；手动缩放不受限） */
const FIT_MAX_ZOOM = 1
const FIT_VIEW_PADDING = 0.2
/** 拖入素材节点尺寸上限（等比缩放） */
const UPLOAD_IMAGE_MAX = 320

// ---------- 文档 ↔ 受控渲染 ----------

function toFlowNodes(doc: CanvasDoc, hidden: ReadonlySet<string>): Node[] {
  const nodes: Node[] = []
  for (const n of doc.nodes) {
    if (hidden.has(n.id)) continue
    const node: Node = {
      id: n.id,
      type: n.type,
      position: n.position,
      data: n.data as Record<string, unknown>,
    }
    if (n.parentId) node.parentId = n.parentId
    if (n.width !== undefined) node.width = n.width
    if (n.height !== undefined) node.height = n.height
    nodes.push(node)
  }
  return nodes
}

function toFlowEdges(doc: CanvasDoc, hidden: ReadonlySet<string>): Edge[] {
  const edges: Edge[] = []
  for (const e of doc.edges) {
    if (hidden.has(e.source) || hidden.has(e.target)) continue
    edges.push({
      id: e.id,
      source: e.source,
      target: e.target,
      type: 'canvas',
      data: { kind: e.kind },
    })
  }
  return edges
}

function sameFlowNode(a: Node, b: Node): boolean {
  if (a.type !== b.type) return false
  if (a.position.x !== b.position.x || a.position.y !== b.position.y) return false
  if ((a.parentId ?? '') !== (b.parentId ?? '')) return false
  if ((a.width ?? 0) !== (b.width ?? 0) || (a.height ?? 0) !== (b.height ?? 0)) return false
  if (a.data !== b.data) return false
  return true
}

/** 受控重建：未变化节点复用旧引用；变化节点携带 measured（React Flow 内部初始化判定）与 selected（选中态不因文档回写丢失） */
function mergeNodes(prev: Node[], next: Node[]): Node[] {
  const prevById = new Map(prev.map((n) => [n.id, n]))
  const merged = next.map((n) => {
    const p = prevById.get(n.id)
    if (!p) return n
    if (sameFlowNode(p, n)) return p
    // selected 由 React Flow 内部交互维护（外部受控层不产出）：重建时必须从旧节点带回，
    // 否则拖动结束的回写重建会当场抹掉选中态（表现为松手后选中框消失）
    const keepSelected = p.selected !== undefined ? { selected: p.selected } : {}
    return p.measured ? { ...n, measured: p.measured, ...keepSelected } : { ...n, ...keepSelected }
  })
  return merged.length === prev.length && merged.every((n, i) => n === prev[i]) ? prev : merged
}

function sameFlowEdge(a: Edge, b: Edge): boolean {
  if (a.source !== b.source || a.target !== b.target) return false
  return (a.data as { kind?: string })?.kind === (b.data as { kind?: string })?.kind
}

function mergeEdges(prev: Edge[], next: Edge[]): Edge[] {
  const prevById = new Map(prev.map((e) => [e.id, e]))
  const merged = next.map((e) => {
    const p = prevById.get(e.id)
    if (p && sameFlowEdge(p, e)) return p
    return e
  })
  return merged.length === prev.length && merged.every((e, i) => e === prev[i]) ? prev : merged
}

/** 上传图片：读取自然尺寸 → 等比缩到上限（节点贴合素材比例） */
function imageNodeSize(file: File): Promise<{ width: number; height: number } | undefined> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      const scale = Math.min(UPLOAD_IMAGE_MAX / img.naturalWidth, UPLOAD_IMAGE_MAX / img.naturalHeight, 1)
      resolve({
        width: Math.max(120, Math.round(img.naturalWidth * scale)),
        height: Math.max(90, Math.round(img.naturalHeight * scale)),
      })
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(undefined)
    }
    img.src = url
  })
}

// ---------- 画布舞台 ----------

function CanvasStage(): React.JSX.Element {
  const currentId = useSessionStore((s) => s.currentId)
  const doc = useCanvasStore((s) => s.doc)
  const loading = useCanvasStore((s) => s.loading)
  const load = useCanvasStore((s) => s.load)
  const panelOpen = useMediaStore((s) => s.panelOpen)
  const { screenToFlowPosition, fitView } = useReactFlow()

  const [nodes, setNodes] = React.useState<Node[]>([])
  const [edges, setEdges] = React.useState<Edge[]>([])
  const [guides, setGuides] = React.useState<SnapGuide[]>([])
  const [dropActive, setDropActive] = React.useState(false)
  const [createMenu, setCreateMenu] = React.useState<{ x: number; y: number; flow: { x: number; y: number } } | null>(null)
  const [ctxMenu, setCtxMenu] = React.useState<{ nodeId: string; x: number; y: number } | null>(null)
  const [autoEditId, setAutoEditId] = React.useState<string>()
  const [mindOpen, setMindOpen] = React.useState(false)
  const mindOriginRef = React.useRef({ x: 0, y: 0 })

  const nodesRef = React.useRef<Node[]>([])
  const hiddenRef = React.useRef<Set<string>>(new Set())
  const dragIdRef = React.useRef<string | undefined>(undefined)
  const resizeHistoryRef = React.useRef(false)
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const pendingUploadPos = React.useRef<{ x: number; y: number } | null>(null)
  const wrapRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    nodesRef.current = nodes
  }, [nodes])

  const hidden = React.useMemo(() => (doc ? collapsedHiddenIds(doc.nodes, doc.edges) : new Set<string>()), [doc])
  hiddenRef.current = hidden

  const uiValue = React.useMemo<CanvasUiValue>(
    () => ({
      autoEditId,
      beginAutoEdit: (id: string) => setAutoEditId(id),
      endAutoEdit: () => setAutoEditId(undefined),
    }),
    [autoEditId],
  )

  // 会话切换 → 加载文档（store 内部丢弃过期响应）
  React.useEffect(() => {
    if (currentId) void load(currentId)
  }, [currentId, load])

  // 生成面板打开 → 拉取任务与可用媒体连接（幂等刷新；「设置 → 媒体生成」变更后重开即生效）
  React.useEffect(() => {
    if (panelOpen && currentId) void useMediaStore.getState().load(currentId)
  }, [panelOpen, currentId])

  // 文档 → 受控渲染（引用复用 + measured 保留）
  React.useEffect(() => {
    if (!doc) {
      setNodes([])
      setEdges([])
      return
    }
    setNodes((prev) => mergeNodes(prev, toFlowNodes(doc, hidden)))
    setEdges((prev) => mergeEdges(prev, toFlowEdges(doc, hidden)))
  }, [doc, hidden])

  /** 拖动结束：把节点位置回流文档（自动保存调度；多选拖动时一次 stop 全量回写为先） */
  const commitPositions = React.useCallback(() => {
    const posById = new Map(nodesRef.current.map((n) => [n.id, n.position]))
    useCanvasStore.getState().applyLocal((d) => {
      let changed = false
      const next = d.nodes.map((n) => {
        const p = posById.get(n.id)
        if (!p || (p.x === n.position.x && p.y === n.position.y)) return n
        changed = true
        return { ...n, position: p }
      })
      return changed ? { ...d, nodes: next } : d
    })
  }, [])

  const onNodesChange = React.useCallback(
    (changes: NodeChange[]) => {
      const store = useCanvasStore.getState()
      const d = store.doc

      // resize 起点：压一次撤销快照（resizing 由 true → false 结束）
      const dimChange = changes.find((c): c is NodeDimensionChange => c.type === 'dimensions')
      if (dimChange && dimChange.resizing === true && !resizeHistoryRef.current) {
        store.pushHistory()
        resizeHistoryRef.current = true
      }
      if (!changes.some((c) => c.type === 'dimensions' && c.resizing === true)) resizeHistoryRef.current = false

      // 拖动吸附（单选拖动；多选保持相对位移不吸附）
      let adjusted = changes
      const dragId = dragIdRef.current
      if (dragId && d && store.selectedIds.length <= 1) {
        const self = d.nodes.find((n) => n.id === dragId)
        if (self) {
          const byId = new Map(d.nodes.map((n) => [n.id, n]))
          const parentAbs = self.parentId ? absolutePosition(byId.get(self.parentId) ?? self, byId) : { x: 0, y: 0 }
          const size = sizeOf(self)
          const others: SnapRect[] = []
          for (const n of d.nodes) {
            if (n.id === dragId || hiddenRef.current.has(n.id)) continue
            const abs = absolutePosition(n, byId)
            const s = sizeOf(n)
            others.push({ x: abs.x, y: abs.y, width: s.width, height: s.height })
          }
          adjusted = changes.map((c) => {
            if (c.type !== 'position' || !c.dragging || c.id !== dragId || !c.position) return c
            const abs = { x: c.position.x + parentAbs.x, y: c.position.y + parentAbs.y }
            const snap = computeSnap({ x: abs.x, y: abs.y, width: size.width, height: size.height }, others)
            setGuides(snap.guides)
            return { ...c, position: { x: snap.position.x - parentAbs.x, y: snap.position.y - parentAbs.y } }
          })
        }
      }
      if (!changes.some((c) => c.type === 'position' && c.dragging)) {
        setGuides((g) => (g.length > 0 ? [] : g))
      }

      setNodes((nds) => applyNodeChanges(adjusted, nds))

      // resize 结束：尺寸写回文档（本地优先，不再压快照）
      const done = changes.filter(
        (c): c is NodeDimensionChange => c.type === 'dimensions' && c.resizing === false && c.dimensions != null,
      )
      if (done.length > 0) {
        store.updateNodes(
          done.map((c) => ({
            id: c.id,
            width: Math.round(c.dimensions!.width),
            height: Math.round(c.dimensions!.height),
          })),
          { history: false },
        )
      }

      // 删除（Delete / Backspace 由 React Flow 触发；快照与文档提交由 store 统一处理）
      const removed = changes.filter((c) => c.type === 'remove').map((c) => c.id)
      if (removed.length > 0) useCanvasStore.getState().removeNodes(removed)
    },
    [],
  )

  const onEdgesChange = React.useCallback((changes: EdgeChange[]) => {
    setEdges((eds) => applyEdgeChanges(changes, eds))
    const removed = changes.filter((c) => c.type === 'remove').map((c) => c.id)
    if (removed.length > 0) useCanvasStore.getState().removeEdges(removed)
  }, [])

  const isValidConnection = React.useCallback((conn: Connection | Edge) => {
    const { source, target } = conn
    if (!source || !target || source === target) return false
    const d = useCanvasStore.getState().doc
    if (!d) return false
    const s = d.nodes.find((n) => n.id === source)
    const t = d.nodes.find((n) => n.id === target)
    if (!s || !t) return false
    if (d.edges.some((e) => e.source === source && e.target === target)) return false
    return canConnect(s.type, t.type) !== null
  }, [])

  const onConnect = React.useCallback((conn: Connection) => {
    const { source, target } = conn
    if (!source || !target) return
    const d = useCanvasStore.getState().doc
    const s = d?.nodes.find((n) => n.id === source)
    const t = d?.nodes.find((n) => n.id === target)
    const kind = s && t ? canConnect(s.type, t.type) : null
    if (kind) useCanvasStore.getState().addEdge(source, target, kind)
  }, [])

  const onSelectionChange = React.useCallback(({ nodes: selected }: OnSelectionChangeParams) => {
    useCanvasStore.getState().setSelectedIds(selected.map((n) => n.id))
  }, [])

  const onNodeDragStart = React.useCallback(() => {
    useCanvasStore.getState().pushHistory()
  }, [])

  const onNodeDragStop = React.useCallback(
    (_event: MouseEvent | TouchEvent, node: Node) => {
      dragIdRef.current = undefined
      setGuides((g) => (g.length > 0 ? [] : g))
      commitPositions()
      const store = useCanvasStore.getState()
      const d = store.doc
      // 脑图重挂（xmind 式）：拖拽节点中心落入另一 mind 胶囊 → 成为其子
      if (d && node.type === 'mind') {
        const moved = d.nodes.find((n) => n.id === node.id && !n.parentId)
        if (moved) {
          const pos = nodesRef.current.find((n) => n.id === moved.id)?.position ?? moved.position
          const size = estimateMindSize(mindNodeText(moved))
          const center = { x: pos.x + size.width / 2, y: pos.y + size.height / 2 }
          let best: string | undefined
          let bestDist = Infinity
          for (const n of d.nodes) {
            if (n.id === moved.id || n.type !== 'mind' || n.parentId) continue
            const ns = estimateMindSize(mindNodeText(n))
            const dx = n.position.x + ns.width / 2 - center.x
            const dy = n.position.y + ns.height / 2 - center.y
            if (Math.abs(dx) > ns.width / 2 || Math.abs(dy) > ns.height / 2) continue
            const dist = dx * dx + dy * dy
            if (dist < bestDist) {
              bestDist = dist
              best = n.id
            }
          }
          if (best) store.mindReparent(moved.id, best)
        }
      }
      const ids = store.selectedIds.length > 0 ? store.selectedIds : [node.id]
      store.applyReparent(ids)
    },
    [commitPositions],
  )

  const centerFlow = React.useCallback((): { x: number; y: number } => {
    const rect = wrapRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
  }, [screenToFlowPosition])

  // M31：命令面板画布动作（新建便签 / 生成脑图 / 适应视野）——切 Tab 后文档异步就绪再消费（未就绪则保留等待）
  const pendingAction = useCanvasStore((s) => s.pendingAction)
  const consumeAction = useCanvasStore((s) => s.consumeAction)
  React.useEffect(() => {
    if (!pendingAction || !doc) return
    consumeAction()
    switch (pendingAction.kind) {
      case 'new-note': {
        const node = createNode('note', centerFlow(), { text: '', accent: 'amber' })
        useCanvasStore.getState().addNodes([node], [], { select: true })
        setAutoEditId(node.id)
        break
      }
      case 'mind':
        mindOriginRef.current = centerFlow()
        setMindOpen(true)
        break
      case 'fit':
        void fitView({ padding: FIT_VIEW_PADDING, maxZoom: FIT_MAX_ZOOM, duration: 300 })
        break
    }
  }, [pendingAction, doc, consumeAction, centerFlow, fitView])

  /** 上传素材 → 画布节点（图片按素材比例自适应尺寸；逐个错位摆放） */
  const uploadFiles = React.useCallback(
    async (files: File[], pos: { x: number; y: number }): Promise<void> => {
      const store = useCanvasStore.getState()
      let offset = 0
      for (const file of files) {
        const res = await store.upload(file)
        if (!res) continue
        const point = { x: Math.round(pos.x + offset), y: Math.round(pos.y + offset) }
        if (res.kind === 'video') {
          store.addNodes([createNode('video', point, { artifact: res.path, source: 'upload' })], [], { select: true })
        } else {
          const size = await imageNodeSize(file)
          store.addNodes([createNode('image', point, { artifact: res.path, source: 'upload' }, size)], [], { select: true })
        }
        offset += 36
      }
    },
    [],
  )

  const createAt = React.useCallback(
    (kind: CreateKind, pos: { x: number; y: number }): void => {
      setCreateMenu(null)
      const store = useCanvasStore.getState()
      switch (kind) {
        case 'note': {
          const node = createNode('note', pos, { text: '', accent: 'amber' })
          store.addNodes([node], [], { select: true })
          setAutoEditId(node.id)
          break
        }
        case 'prompt': {
          const node = createNode('prompt', pos, { text: '', negative: '' })
          store.addNodes([node], [], { select: true })
          setAutoEditId(node.id)
          break
        }
        case 'mind': {
          const node = createNode('mind', pos, { text: '中心主题' })
          store.addNodes([node], [], { select: true })
          setAutoEditId(node.id)
          break
        }
        case 'group': {
          const size = NODE_SIZE.group
          const node = createNode(
            'group',
            { x: pos.x - size.width / 2, y: pos.y - size.height / 2 },
            { title: '画框' },
            { width: size.width, height: size.height },
          )
          store.addNodes([node], [], { select: true })
          break
        }
        case 'game': {
          // M34：博弈推演节点（居中落位；配置态 → 节点内选模型 / 填标的与话题 → 运行推演）
          const size = NODE_SIZE.game
          const node = createNode(
            'game',
            { x: pos.x - size.width / 2, y: pos.y - size.height / 2 },
            { model: 'matrix' },
            { width: size.width, height: size.height },
          )
          store.addNodes([node], [], { select: true })
          break
        }
        case 'kline': {
          // M34：K 线行情节点（居中落位；空态 → 节点内输入标的直连网关拉取）
          const size = NODE_SIZE.kline
          const node = createNode(
            'kline',
            { x: pos.x - size.width / 2, y: pos.y - size.height / 2 },
            {},
            { width: size.width, height: size.height },
          )
          store.addNodes([node], [], { select: true })
          break
        }
        case 'upload': {
          pendingUploadPos.current = pos
          fileInputRef.current?.click()
          break
        }
      }
    },
    [],
  )

  const applyTemplate = React.useCallback(
    (id: CanvasTemplateId): void => {
      const { nodes: tNodes, edges: tEdges } = buildTemplate(id, centerFlow())
      useCanvasStore.getState().addNodes(tNodes, tEdges)
      toast('模板已落位，自由拖动摆弄吧')
    },
    [centerFlow],
  )

  const exportJson = React.useCallback((): void => {
    const d = useCanvasStore.getState().doc
    if (!d) return
    const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `canvas-${d.sessionId}.json`
    a.click()
    URL.revokeObjectURL(url)
    toast('已导出画布 JSON')
  }, [])

  /** 导出脑图 Markdown（每棵树一节；无脑图时给引导） */
  const exportMindMarkdown = React.useCallback((): void => {
    const d = useCanvasStore.getState().doc
    if (!d) return
    const index = indexMind(d.nodes, d.edges)
    const roots = mindRoots(d.nodes, index)
    if (roots.length === 0) {
      toast('画布上还没有脑图节点')
      return
    }
    const text = roots.map((root) => treeToMarkdown(extractMindTree(d.nodes, index, root))).join('\n\n')
    const blob = new Blob([text], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `mind-${d.sessionId}.md`
    a.click()
    URL.revokeObjectURL(url)
    toast(`已导出脑图 Markdown（${roots.length} 棵树）`)
  }, [])

  // 键盘：脑图快捷编辑（Tab 加子 / Enter 加兄弟）+ 撤销重做 / 复制粘贴 / 保存（输入控件聚焦时不拦截）
  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      if (target && (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      const store = useCanvasStore.getState()
      // 单选 mind 节点：Tab 加子 / Enter 加兄弟（根回落加子；xmind 式手感）
      if (!e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'Tab' || e.key === 'Enter')) {
        const ids = store.selectedIds
        if (ids.length !== 1) return
        const node = store.doc?.nodes.find((n) => n.id === ids[0])
        if (!node || node.type !== 'mind') return
        e.preventDefault()
        const newId = e.key === 'Tab' ? store.mindAddChild(node.id) : store.mindAddSibling(node.id)
        if (newId) setAutoEditId(newId)
        return
      }
      if (!(e.metaKey || e.ctrlKey)) return
      const key = e.key.toLowerCase()
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault()
        store.undo()
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault()
        store.redo()
      } else if (key === 'c') {
        if (window.getSelection()?.toString()) return // 有文本选择时交给浏览器
        store.copySelection(store.selectedIds)
      } else if (key === 'v') {
        store.pasteClipboard()
      } else if (key === 's') {
        e.preventDefault()
        void store.flush()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  if (!currentId) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-[12px] text-muted-foreground">
        先选择一个会话，每个会话都有一张自己的画布
      </div>
    )
  }

  if (!doc) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-[12px] text-muted-foreground">
        {loading ? '画布加载中…' : '画布暂不可用'}
      </div>
    )
  }

  const isDefaultViewport = doc.viewport.x === 0 && doc.viewport.y === 0 && doc.viewport.zoom === 1
  const shouldFit = doc.nodes.length > 0 && isDefaultViewport
  const zoom = doc.viewport.zoom || 1
  const guideWidth = Math.max(1 / zoom, 0.5)

  return (
    <CanvasUiContext.Provider value={uiValue}>
      <div
        ref={wrapRef}
        className={cn('relative flex min-h-0 flex-1 flex-col overflow-hidden', dropActive && 'canvas-drop-active')}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
            setDropActive(true)
          }
        }}
        onDragLeave={(e) => {
          const related = e.relatedTarget
          if (!(related instanceof HTMLElement) || !e.currentTarget.contains(related)) setDropActive(false)
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          setDropActive(false)
          const files = [...e.dataTransfer.files].filter(
            (f) => f.type.startsWith('image/') || f.type.startsWith('video/'),
          )
          if (files.length === 0) {
            toast('只支持图片 / 视频文件')
            return
          }
          void uploadFiles(files, screenToFlowPosition({ x: e.clientX, y: e.clientY }))
        }}
        onDoubleClick={(e) => {
          const target = e.target as HTMLElement
          if (!target.classList.contains('react-flow__pane')) return
          setCreateMenu({ x: e.clientX, y: e.clientY, flow: screenToFlowPosition({ x: e.clientX, y: e.clientY }) })
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,video/*"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = [...(e.target.files ?? [])]
            e.target.value = ''
            if (files.length > 0) void uploadFiles(files, pendingUploadPos.current ?? centerFlow())
          }}
        />
        <ReactFlow
          key={currentId}
          nodes={nodes}
          edges={edges}
          nodeTypes={CANVAS_NODE_TYPES}
          edgeTypes={CANVAS_EDGE_TYPES}
          defaultViewport={doc.viewport}
          fitView={shouldFit}
          fitViewOptions={{ padding: FIT_VIEW_PADDING, maxZoom: FIT_MAX_ZOOM }}
          minZoom={0.1}
          maxZoom={4}
          proOptions={{ hideAttribution: true }}
          defaultEdgeOptions={{
            type: 'canvas',
            markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: 'hsl(var(--primary))' },
          }}
          connectionLineStyle={{ stroke: 'hsl(var(--primary))', strokeWidth: 1.6, strokeDasharray: '4 4' }}
          panActivationKeyCode="Space"
          panOnDrag={[1]}
          // 双击保留给「双击空白创建节点」（d3-zoom 双击缩放会吞掉事件）；缩放走滚轮 / 缩放控件
          zoomOnDoubleClick={false}
          // 点击容差：触摸板 / 鼠标点按常带 1~3px 微移，默认 nodeClickDistance=0 会把这类点击判为拖动
          // 并在 mouseup 时吞掉 click（选中 / 双击 / 节点内容点击偶发失灵）。与拖动阈值同取 4px：
          // ≤4px 一律视为点击（click 正常派发），>4px 才进入节点拖动，点击与拖动之间不留死角。
          nodeClickDistance={4}
          nodeDragThreshold={4}
          selectionOnDrag
          deleteKeyCode={['Backspace', 'Delete']}
          isValidConnection={isValidConnection}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onSelectionChange={onSelectionChange}
          onNodeDragStart={(_event, node) => {
            dragIdRef.current = node.id
            onNodeDragStart()
          }}
          onNodeDragStop={onNodeDragStop}
          onMoveEnd={(_event, viewport) => {
            useCanvasStore.getState().setViewport({ x: viewport.x, y: viewport.y, zoom: viewport.zoom })
          }}
          onPaneClick={() => {
            setCreateMenu(null)
            setCtxMenu(null)
          }}
          onPaneContextMenu={(e) => {
            e.preventDefault()
            if (!(e.target as HTMLElement).classList.contains('react-flow__pane')) return
            setCtxMenu(null)
            setCreateMenu({ x: e.clientX, y: e.clientY, flow: screenToFlowPosition({ x: e.clientX, y: e.clientY }) })
          }}
          onNodeContextMenu={(e, node) => {
            e.preventDefault()
            setCreateMenu(null)
            setCtxMenu({ nodeId: node.id, x: e.clientX, y: e.clientY })
          }}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="hsl(var(--border))" />
          <Controls showInteractive={false} fitViewOptions={{ maxZoom: FIT_MAX_ZOOM }} />
          <ViewportPortal>
            {guides.map((g, i) =>
              g.orientation === 'v' ? (
                <div
                  key={`v${i}:${g.position}`}
                  className="canvas-guide-line absolute"
                  style={{
                    left: g.position,
                    top: g.from,
                    width: guideWidth,
                    height: Math.max(g.to - g.from, 1),
                  }}
                />
              ) : (
                <div
                  key={`h${i}:${g.position}`}
                  className="canvas-guide-line absolute"
                  style={{
                    left: g.from,
                    top: g.position,
                    width: Math.max(g.to - g.from, 1),
                    height: guideWidth,
                  }}
                />
              ),
            )}
          </ViewportPortal>
        </ReactFlow>

        <CanvasToolbar
          onAdd={() => {
            const rect = wrapRef.current?.getBoundingClientRect()
            setCreateMenu({
              x: (rect?.left ?? 0) + 76,
              y: (rect?.top ?? 0) + 52,
              flow: centerFlow(),
            })
          }}
          onUpload={() => {
            pendingUploadPos.current = centerFlow()
            fileInputRef.current?.click()
          }}
          onGenerate={() => useMediaStore.getState().openPanel()}
          onMind={() => {
            mindOriginRef.current = centerFlow()
            setMindOpen(true)
          }}
          onFit={() => void fitView({ padding: FIT_VIEW_PADDING, maxZoom: FIT_MAX_ZOOM, duration: 300 })}
          onExport={exportJson}
          onExportMind={exportMindMarkdown}
        />

        <GenerationPanel />

        <CanvasComposer />

        {mindOpen && (
          <MindDialog
            origin={mindOriginRef.current}
            onClose={() => setMindOpen(false)}
          />
        )}

        {doc.nodes.length === 0 && <EmptyCanvas onApply={applyTemplate} />}

        {createMenu && (
          <CanvasCreateMenu
            x={createMenu.x}
            y={createMenu.y}
            onPick={(kind) => createAt(kind, createMenu.flow)}
            onClose={() => setCreateMenu(null)}
          />
        )}
        {ctxMenu && (
          <NodeContextMenu
            nodeId={ctxMenu.nodeId}
            x={ctxMenu.x}
            y={ctxMenu.y}
            onClose={() => setCtxMenu(null)}
            onBeginEdit={(nodeId) => setAutoEditId(nodeId)}
          />
        )}
      </div>
    </CanvasUiContext.Provider>
  )
}

export function CanvasView(): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <CanvasStage />
    </ReactFlowProvider>
  )
}

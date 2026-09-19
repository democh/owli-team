/**
 * M31：无限画布（会话级空间化工作台，主区「画布」Tab）。P2 画布内核版。
 *
 * 交互全集：框选 / 多选拖动 / 连线（合法性矩阵 + 去重）/ 复制粘贴 / 撤销重做（⌘Z ⇧⌘Z /
 * ⌘C ⌘V / ⌘S）/ 节点右键菜单 / 双击空白创建 / 双击空白右键创建菜单 / 拖拽上传（含尺寸自适应）/
 * 对齐参考线吸附（可切 10px 网格吸附）/ 对齐分布网格整理 / 适应视野 / 导出 JSON / 画框收纳（拖入包含，拖出脱离）；
 * P4 脑图：Tab 加子 / Enter 加兄弟（单选 mind 且进入编辑）、拖拽重挂（落上胶囊成为其子）、
 * 脑图工坊（AI 五来源 + Markdown 大纲）、脑图整理、导出脑图 Markdown。
 * M36：底部指令条（CanvasComposer）——画布与对话同级的输入能力，消息进入当前会话、
 * Agent 直接操作画布；右下小地图移除（画布即全景，适应视野/缩放已足够）。
 * M31 修订（对标专业无限画布）：滚轮 / 双指平移 + ⌘滚轮缩放（Figma 范式）/ H·V 工具切换 /
 * 缩放指示器与 ⇧0·⇧1·⇧2 快捷键 / 选中节点关联边高亮 / 媒体能力门控（未配置即不出现）。
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
  extractClipboard,
  materializeClipboard,
  sizeOf,
  FIT_MAX_ZOOM,
  FIT_VIEW_PADDING,
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
import { CanvasSearch } from './CanvasSearch'
import { CanvasToolbar } from './CanvasToolbar'
import { CanvasZoomIndicator } from './CanvasZoomIndicator'
import { EmptyCanvas } from './EmptyCanvas'
import { GenerationPanel } from './GenerationPanel'
import { MindDialog } from './MindDialog'
import { NodeContextMenu } from './NodeContextMenu'
import { CanvasUiContext, type CanvasUiValue } from './CanvasUiContext'
import { CANVAS_NODE_TYPES } from './nodes'
import { CANVAS_EDGE_TYPES } from './edges/FlowEdge'

/** 拖入素材节点尺寸上限（等比缩放） */
const UPLOAD_IMAGE_MAX = 320
/** 网格吸附步长（对齐网格 10px；与智能参考线互斥） */
const SNAP_GRID: [number, number] = [10, 10]
/** 远端写入闪环时长（毫秒；与 index.css canvas-agent-flash 动画时长一致） */
const FLASH_MS = 1800
/** M31 修订：工具态会话记忆（手型 / 网格吸附；同 sessionStorage 先例 ma:pn:*） */
const TOOL_PREF_KEY = 'ma:canvas:tool'
const GRID_PREF_KEY = 'ma:canvas:grid'

function loadToolPref(): 'select' | 'hand' {
  try {
    return sessionStorage.getItem(TOOL_PREF_KEY) === 'hand' ? 'hand' : 'select'
  } catch {
    return 'select'
  }
}

function loadGridPref(): boolean {
  try {
    return sessionStorage.getItem(GRID_PREF_KEY) === '1'
  } catch {
    return false
  }
}

function savePref(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value)
  } catch {
    /* 隐私模式等场景静默降级 */
  }
}

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

function toFlowEdges(doc: CanvasDoc, hidden: ReadonlySet<string>, selected: ReadonlySet<string>): Edge[] {
  // M31 修订：生成中占位节点（任务创建即落位）→ 指向它的生成数据流边流动（接线 P3 能量流动）
  const pending = new Set(
    doc.nodes.filter((n) => (n.type === 'image' || n.type === 'video') && (n.data as { pending?: boolean }).pending === true).map((n) => n.id),
  )
  const edges: Edge[] = []
  for (const e of doc.edges) {
    if (hidden.has(e.source) || hidden.has(e.target)) continue
    edges.push({
      id: e.id,
      source: e.source,
      target: e.target,
      type: 'canvas',
      data: {
        kind: e.kind,
        // 关联边高亮：端点被选中时增强（视图层派生，不落文档）
        related: selected.size > 0 && (selected.has(e.source) || selected.has(e.target)),
        flowing: pending.has(e.target),
      },
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
  const da = a.data as { kind?: string; related?: boolean; flowing?: boolean } | undefined
  const db = b.data as { kind?: string; related?: boolean; flowing?: boolean } | undefined
  return (
    da?.kind === db?.kind &&
    (da?.related ?? false) === (db?.related ?? false) &&
    (da?.flowing ?? false) === (db?.flowing ?? false)
  )
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
  const selectedIds = useCanvasStore((s) => s.selectedIds)
  const panelOpen = useMediaStore((s) => s.panelOpen)
  const { screenToFlowPosition, fitView, zoomTo, setCenter, getViewport, getNodes, updateNode } = useReactFlow()

  const [nodes, setNodes] = React.useState<Node[]>([])
  const [edges, setEdges] = React.useState<Edge[]>([])
  const [guides, setGuides] = React.useState<SnapGuide[]>([])
  const [dropActive, setDropActive] = React.useState(false)
  const [createMenu, setCreateMenu] = React.useState<{ x: number; y: number; flow: { x: number; y: number } } | null>(null)
  const [ctxMenu, setCtxMenu] = React.useState<{ nodeId: string; x: number; y: number } | null>(null)
  const [autoEditId, setAutoEditId] = React.useState<string>()
  const [mindOpen, setMindOpen] = React.useState(false)
  /** M31 修订：工具态会话记忆（惰性读取；变更即写回） */
  const [tool, setTool] = React.useState<'select' | 'hand'>(loadToolPref)
  /** 拖动吸附：true = 10px 网格（snapToGrid）；false = 智能对齐参考线（默认，两者互斥） */
  const [gridSnap, setGridSnap] = React.useState(loadGridPref)
  /** Space 按住（临时平移；仅驱动 pane 光标反馈） */
  const [spacePan, setSpacePan] = React.useState(false)
  /** M31 修订：画布内查找面板开关（工具栏 / 「/」快捷键） */
  const [searchOpen, setSearchOpen] = React.useState(false)
  /** M31 修订：大画布性能档——视口裁剪自动启用（>150 开 / <120 关，回差防临界抖动；小画布保持全量渲染零风险） */
  const [viewportCulling, setViewportCulling] = React.useState(false)
  /** M31 修订：远端（agent）写入闪环矩形（合流后一次性高亮） */
  const [flashRects, setFlashRects] = React.useState<Array<{ id: string; x: number; y: number; width: number; height: number }> | null>(null)
  const mindOriginRef = React.useRef({ x: 0, y: 0 })

  React.useEffect(() => {
    savePref(TOOL_PREF_KEY, tool)
  }, [tool])
  React.useEffect(() => {
    savePref(GRID_PREF_KEY, gridSnap ? '1' : '0')
  }, [gridSnap])

  const nodesRef = React.useRef<Node[]>([])
  const hiddenRef = React.useRef<Set<string>>(new Set())
  const dragIdRef = React.useRef<string | undefined>(undefined)
  const gridSnapRef = React.useRef(false)
  const flashTimerRef = React.useRef<number>()
  const resizeHistoryRef = React.useRef(false)
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const pendingUploadPos = React.useRef<{ x: number; y: number } | null>(null)
  const wrapRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    nodesRef.current = nodes
  }, [nodes])

  gridSnapRef.current = gridSnap

  // M31 修订：大画布性能档（回差 hysteresis；切换时 CSS 关闭入场动画避免裁剪重挂载重播——见 .canvas-culling）
  const nodeCount = doc?.nodes.length ?? 0
  React.useEffect(() => {
    setViewportCulling((prev) => (prev ? nodeCount >= 120 : nodeCount > 150))
  }, [nodeCount])

  /** 选中集（关联边高亮判定；引用随 selectedIds 变化） */
  const selectedSet = React.useMemo(() => new Set(selectedIds), [selectedIds])

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

  // 媒体能力门控（providers）+ 任务快照（僵尸占位自愈判定源）：进入画布即拉取（load 同时置 providersLoaded，幂等语义由 store 保证）
  const docSession = useCanvasStore((s) => s.sessionId)
  const docLoaded = useCanvasStore((s) => s.doc !== null)
  React.useEffect(() => {
    if (!currentId || docSession !== currentId || !docLoaded) return
    let cancelled = false
    void (async () => {
      await useMediaStore.getState().load(currentId)
      if (cancelled) return
      const media = useMediaStore.getState()
      // M31 修订：僵尸占位自愈——仅在任务快照“成功拉取”时判定（拉取失败不得误标）
      if (media.sessionId !== currentId || !media.jobsLoaded) return
      useCanvasStore.getState().reconcileStalePending(new Set(media.jobs.map((j) => j.id)))
    })()
    return () => {
      cancelled = true
    }
  }, [currentId, docSession, docLoaded])

  // 生成面板打开 → 拉取任务与可用媒体连接（幂等刷新；「设置 → 媒体生成」变更后重开即生效）
  React.useEffect(() => {
    if (panelOpen && currentId) void useMediaStore.getState().load(currentId)
  }, [panelOpen, currentId])

  // 文档 → 受控渲染（引用复用 + measured 保留；边随选中集派生 related 高亮）
  React.useEffect(() => {
    if (!doc) {
      setNodes([])
      setEdges([])
      return
    }
    setNodes((prev) => mergeNodes(prev, toFlowNodes(doc, hidden)))
    setEdges((prev) => mergeEdges(prev, toFlowEdges(doc, hidden, selectedSet)))
  }, [doc, hidden, selectedSet])

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

      // 拖动吸附（单选拖动）：智能参考线（默认）与 10px 网格互斥——网格模式由 React Flow snapToGrid 取整
      let adjusted = changes
      const dragId = dragIdRef.current
      if (dragId && d && store.selectedIds.length <= 1 && !gridSnapRef.current) {
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

  /** M31 修订：起手按住 ⌥ 拖拽 = 复制留在原位（Figma 语义：拖走「原件」、原位留副本；仅起手判定） */
  const duplicateForAltDrag = React.useCallback((draggedId: string, altKey: boolean): void => {
    if (!altKey) return
    const store = useCanvasStore.getState()
    const d = store.doc
    if (!d) return
    // 拖动集合以 RF 内部选中为准（拖动主节点必在集内）；否则仅复制主节点
    const selected = getNodes()
      .filter((n) => n.selected)
      .map((n) => n.id)
    const ids = selected.includes(draggedId) ? selected : [draggedId]
    const clip = extractClipboard(d.nodes, d.edges, new Set(ids))
    if (clip.nodes.length === 0) return
    const materialized = materializeClipboard(clip, 0, 0) // 零偏移：副本落原位；原件随手指拖走
    store.addNodes(materialized.nodes, materialized.edges)
  }, [getNodes])

  /** M31 修订：边重连（拖动端点改接）——合法性矩阵复用 + 去重；保持原 edge id（重连=改端点） */
  const onReconnect = React.useCallback((oldEdge: Edge, conn: Connection) => {
    const { source, target } = conn
    if (!source || !target || source === target) return
    useCanvasStore.getState().applyLocal((doc) => {
      const s = doc.nodes.find((n) => n.id === source)
      const t = doc.nodes.find((n) => n.id === target)
      if (!s || !t) return doc
      if (doc.edges.some((e) => e.id !== oldEdge.id && e.source === source && e.target === target)) return doc
      const kind = canConnect(s.type, t.type)
      if (!kind) return doc
      return { ...doc, edges: doc.edges.map((e) => (e.id === oldEdge.id ? { ...e, source, target, kind } : e)) }
    }, { history: true })
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

  // M31：命令面板 / 消息侧画布动作（新建便签 / 生成脑图 / 适应视野 / 聚焦定位）——
  // 消费 effect 见下方 flashNodes / locateNode 定义之后（聚焦动作依赖二者；提前引用会触发 TDZ）。

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

  // 画布导航快捷键（M31 修订）：H / V 工具切换与 ⇧0 / ⇧1 / ⇧2 缩放（Figma 范式；
  // ⌘0 / ⌘1 为浏览器保留键不可拦截，故走 Shift 组合，与项目「Alt+1..9」同一避让纪律）
  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      if (target && (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return
      if (e.shiftKey) {
        // 按物理键判定（不受 ⇧1 = '!' 符号映射影响）
        if (e.code === 'Digit0') {
          e.preventDefault()
          void zoomTo(1, { duration: 300 })
        } else if (e.code === 'Digit1') {
          e.preventDefault()
          void fitView({ padding: FIT_VIEW_PADDING, maxZoom: FIT_MAX_ZOOM, duration: 300 })
        } else if (e.code === 'Digit2') {
          e.preventDefault()
          const { doc: d, selectedIds: sel } = useCanvasStore.getState()
          const picked = d ? d.nodes.filter((n) => sel.includes(n.id)).map((n) => ({ id: n.id })) : []
          if (picked.length > 0) void fitView({ nodes: picked, padding: FIT_VIEW_PADDING, maxZoom: FIT_MAX_ZOOM, duration: 300 })
        }
        return
      }
      if (e.key === 'h' || e.key === 'H') setTool('hand')
      else if (e.key === 'v' || e.key === 'V') setTool('select')
      else if (e.key === '/') {
        e.preventDefault()
        setSearchOpen(true)
      } else if (e.key === 'Escape') {
        setTool((t) => (t === 'hand' ? 'select' : t))
        setSearchOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [fitView, zoomTo])

  // Space 按住（临时平移）：仅驱动 pane 光标反馈（grab / grabbing）；失焦时重置防光标卡住
  React.useEffect(() => {
    const down = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      if (target && (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      if (e.code === 'Space' && !e.repeat) setSpacePan(true)
    }
    const up = (e: KeyboardEvent): void => {
      if (e.code === 'Space') setSpacePan(false)
    }
    const blur = (): void => setSpacePan(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [])

  // M31 修订：远端写入闪环——合流后按 touched 节点几何渲染一次性高亮（ViewportPortal 覆盖层，不碰节点数据）
  /** 泛化闪环：查找定位 / 远端写入共用（同屏互斥，后触发者重置计时） */
  const flashNodes = React.useCallback((ids: readonly string[]) => {
    const d = useCanvasStore.getState().doc
    const rects = (d?.nodes ?? [])
      .filter((n) => ids.includes(n.id))
      .map((n) => {
        const s = sizeOf(n)
        return { id: n.id, x: n.position.x - 6, y: n.position.y - 6, width: s.width + 12, height: s.height + 12 }
      })
    if (rects.length === 0) return
    setFlashRects(rects)
    window.clearTimeout(flashTimerRef.current)
    flashTimerRef.current = window.setTimeout(() => setFlashRects(null), FLASH_MS)
  }, [])

  const remoteFlashNonce = useCanvasStore((s) => s.remoteFlash?.nonce)
  React.useEffect(() => {
    const flash = useCanvasStore.getState().remoteFlash
    if (!flash) return
    flashNodes(flash.ids)
    useCanvasStore.getState().clearRemoteFlash()
  }, [remoteFlashNonce, flashNodes])

  // M31 修订：通用节点闪环请求（生成面板任务行 hover 等非画布侧入口）
  const nodeFlashNonce = useCanvasStore((s) => s.nodeFlash?.nonce)
  React.useEffect(() => {
    const req = useCanvasStore.getState().nodeFlash
    if (!req) return
    flashNodes(req.ids)
    useCanvasStore.getState().consumeNodeFlash()
  }, [nodeFlashNonce, flashNodes])

  /** M31 修订：查找定位——居中 + 程序化选中 + 闪环（连续定位不关面板，Esc 关闭） */
  const locateNode = React.useCallback(
    (id: string) => {
      const d = useCanvasStore.getState().doc
      const n = d?.nodes.find((x) => x.id === id)
      if (!n) return
      const s = sizeOf(n)
      const z = Math.max(getViewport().zoom, 1)
      void setCenter(n.position.x + s.width / 2, n.position.y + s.height / 2, { zoom: z, duration: 300 })
      for (const other of getNodes()) {
        if (other.selected && other.id !== id) updateNode(other.id, { selected: false })
      }
      updateNode(id, { selected: true })
      useCanvasStore.getState().setSelectedIds([id])
      flashNodes([id])
    },
    [flashNodes, getNodes, getViewport, setCenter, updateNode],
  )

  // M31：命令面板 / 消息侧画布动作消费——切 Tab 后文档异步就绪再消费（未就绪则保留等待；在 flashNodes / locateNode 之后定义）
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
      // M31 修订：消息侧「在画布查看」——定位到写入的节点（单节点居中；多节点取景 + 闪环）
      case 'focus': {
        const ids = (pendingAction.nodeIds ?? []).filter((id) => doc.nodes.some((n) => n.id === id))
        if (ids.length === 0) break
        if (ids.length === 1) locateNode(ids[0]!)
        else {
          void fitView({ nodes: ids.map((id) => ({ id })), padding: 0.3, maxZoom: FIT_MAX_ZOOM, duration: 300 })
          useCanvasStore.getState().setSelectedIds(ids)
          flashNodes(ids)
        }
        break
      }
    }
  }, [pendingAction, doc, consumeAction, centerFlow, fitView, locateNode, flashNodes])

  if (!currentId) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-[12px] text-muted-foreground">
        先选择一个会话
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
        className={cn(
          'canvas-stage relative flex min-h-0 flex-1 flex-col overflow-hidden',
          dropActive && 'canvas-drop-active',
          tool === 'hand' && 'canvas-hand-mode',
          spacePan && 'canvas-space-pan',
          viewportCulling && 'canvas-culling',
        )}
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
          // 滚轮 / 双指 = 平移，⌘/Ctrl + 滚轮 = 缩放（Figma / tldraw / Excalidraw 范式；平台自适应）
          panOnScroll
          panOnScrollSpeed={0.8}
          // 手型模式左键拖拽平移；选择模式保留中键平移 + 左键框选
          panOnDrag={tool === 'hand' ? true : [1]}
          selectionOnDrag={tool === 'select'}
          // 网格吸附（10px）：开启时智能参考线与它互斥（见 onNodesChange）
          snapToGrid={gridSnap}
          snapGrid={SNAP_GRID}
          // M31 修订：大画布性能档（>150 节点自动裁剪视口外节点；回差见 viewportCulling）
          onlyRenderVisibleElements={viewportCulling}
          // 双击保留给「双击空白创建节点」（d3-zoom 双击缩放会吞掉事件）；缩放走滚轮 / 缩放控件
          zoomOnDoubleClick={false}
          // 点击容差：触摸板 / 鼠标点按常带 1~3px 微移，默认 nodeClickDistance=0 会把这类点击判为拖动
          // 并在 mouseup 时吞掉 click（选中 / 双击 / 节点内容点击偶发失灵）。与拖动阈值同取 4px：
          // ≤4px 一律视为点击（click 正常派发），>4px 才进入节点拖动，点击与拖动之间不留死角。
          nodeClickDistance={4}
          nodeDragThreshold={4}
          deleteKeyCode={['Backspace', 'Delete']}
          isValidConnection={isValidConnection}
          onReconnect={onReconnect}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onSelectionChange={onSelectionChange}
          onNodeDragStart={(_event, node) => {
            dragIdRef.current = node.id
            onNodeDragStart()
            // M31 修订：⌥ 起手拖拽 = 复制留在原位（副本先落位，原件随手指拖走）
            duplicateForAltDrag(node.id, 'altKey' in _event && Boolean((_event as MouseEvent).altKey))
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
          {/* 缩放控件组（左下）：内置 ± / fitView + 自定义缩放指示器（百分比 + 菜单，向上展开） */}
          <Controls showInteractive={false} fitViewOptions={{ maxZoom: FIT_MAX_ZOOM }}>
            <CanvasZoomIndicator />
          </Controls>
          <ViewportPortal>
            {flashRects?.map((r) => (
              <div
                key={`flash-${r.id}`}
                className="canvas-agent-flash"
                style={{ left: r.x, top: r.y, width: r.width, height: r.height }}
              />
            ))}
            {guides.map((g, i) =>
              g.orientation === 'v' ? (
                <div
                  key={`v${i}:${g.position}`}
                  className={cn('canvas-guide-line absolute', g.kind === 'dist' && 'canvas-guide-line-dist')}
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
                  className={cn('canvas-guide-line absolute', g.kind === 'dist' && 'canvas-guide-line-dist')}
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
          onSearch={() => setSearchOpen(true)}
          onMind={() => {
            mindOriginRef.current = centerFlow()
            setMindOpen(true)
          }}
          onFit={() => void fitView({ padding: FIT_VIEW_PADDING, maxZoom: FIT_MAX_ZOOM, duration: 300 })}
          onExport={exportJson}
          onExportMind={exportMindMarkdown}
          tool={tool}
          onToolChange={setTool}
          gridSnap={gridSnap}
          onGridSnapChange={setGridSnap}
        />

        {searchOpen && <CanvasSearch onClose={() => setSearchOpen(false)} onLocate={locateNode} />}

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

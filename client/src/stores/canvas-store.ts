/**
 * M31：画布状态（会话级文档）—— 加载 / 受控本地变更 / 乐观锁自动保存 / 远端合流 / 素材上传 /
 * undo-redo 快照栈 / 剪贴板 / 节点与边的编辑动作（对齐、分布、网格、z 序、画框收纳）。
 *
 * 保存协议：PUT 携带 baseVersion（服务端 version 乐观锁）。
 * - 冲突（409）策略「合流重放」（M79-AG）：以「上次同步快照」为三方合并 base，将本地变更重放到
 *   服务端最新文档之上——远端新增（如 agent 落位/写入）不再被本地保存静默清掉；本地编辑优先，
 *   双方都改同一节点时「位置/尺寸取本地、其余字段取远端」（保 agent 状态机更新不丢）。
 *   （原「本地优先覆盖」在 agent 并发写画布时会把服务端新写入整体覆盖——该缺陷由 m31 E2E trace 定性。）
 * - 自动保存：本地变更后 debounce 800ms；saving / saveError / lastSavedAt 供 UI 状态徽标。
 * - 远端变更（notify:canvas-changed, by=agent）：本地空闲 → 立即拉取合流；本地脏 → 标记待拉取，
 *   保存完成后自动补拉（不打断正在进行的编辑，也不丢失 agent 产物）。
 * - undo/redo：快照持不可变引用（所有变更均返回新数组 / 新对象，无需深拷贝）；深度 50；
 *   视口变更与拖拽位移不进历史（拖拽在起点 pushHistory 一次）。
 */
import { create } from 'zustand'
import { toast } from 'sonner'
import type {
  CanvasDoc,
  CanvasEdge,
  CanvasEdgeKind,
  CanvasGameData,
  CanvasKlineData,
  CanvasNode,
  CanvasNodeData,
  CanvasUploadResponse,
} from '@multi-agent/shared'
import {
  alignNodes as alignNodesPure,
  canvasNodeTypeOf,
  createNode,
  detachOrphans,
  distributeNodes as distributeNodesPure,
  ensureParentOrder,
  extractClipboard,
  materializeClipboard,
  newEdgeId,
  nextPlacement,
  reorderNodes as reorderNodesPure,
  reparentNodes,
  tidyGrid,
  type AlignMode,
  type CanvasClipboard,
  type ZMode,
} from '../lib/canvas'
import { applyMindLayout, indexMind, mindRootOf, planAddChild, planAddSibling, planReparent } from '../lib/mind'
import { useSessionStore } from './session-store'

/** 自动保存防抖（连续拖动 / 多选操作的合并窗口） */
const AUTOSAVE_DEBOUNCE_MS = 800
/** 撤销栈深度上限 */
const HISTORY_LIMIT = 50
/** 粘贴偏移（连续粘贴逐级递增） */
const PASTE_OFFSET = 28

/**
 * M79-AG：上次与服务端同步的文档快照（409 三方合并的 base）——
 * load / pullRemote / save 成功时更新；配合 mergeCanvasDocs 防止本地保存覆盖远端并发写入。
 */
let lastSyncedDoc: CanvasDoc | null = null

/** 结构等价（节点/边为不可变对象；409 冲突低频，字符串比较换取确定性） */
function sameShape(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b)
}

/**
 * M79-AG：409 冲突的三方合并（base = 上次同步快照；mine = 本地待保存；theirs = 服务端最新）。
 * 规则（节点；边同构无字段级）：
 * - 远端新增（base 无 + theirs 有）→ 保留（agent 落位/写入不丢——本修复核心）；
 * - 本地新增（base 无 + mine 有）→ 保留；
 * - 一方存在另一方无且 base 有：未改方缺席 = 该方删除生效；改过方缺席 = 远端删除/本地删除按「已改优先」保留在场方；
 * - 双方都有：远端未改 → 本地；本地未改 → 远端；双方都改 → 位置/尺寸/选中取本地、其余取远端。
 * 顺序：本地节点顺序优先，远端新增追加尾部。
 */
function mergeCanvasDocs(
  base: CanvasDoc | null,
  mine: CanvasDoc,
  theirs: CanvasDoc,
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const byId = <T extends { id: string }>(list: T[]): Map<string, T> => new Map(list.map((n) => [n.id, n]))
  const baseNodes = byId(base?.nodes ?? [])
  const mineNodes = byId(mine.nodes)
  const theirNodes = byId(theirs.nodes)
  const nodes: CanvasNode[] = []
  for (const n of mine.nodes) {
    const t = theirNodes.get(n.id)
    if (!t) {
      const b = baseNodes.get(n.id)
      if (b && sameShape(n, b)) continue // 本地未碰且远端已删 → 删除生效
      nodes.push(n) // 本地新增 / 本地改过的保留
      continue
    }
    const b = baseNodes.get(n.id)
    const mineChanged = !b || !sameShape(n, b)
    const theirsChanged = !b || !sameShape(t, b)
    if (!theirsChanged) nodes.push(n)
    else if (!mineChanged) nodes.push(t)
    else nodes.push({ ...t, position: n.position, width: n.width, height: n.height })
  }
  for (const t of theirs.nodes) {
    if (mineNodes.has(t.id)) continue
    const b = baseNodes.get(t.id)
    if (b && sameShape(t, b)) continue // 本地删除且远端未改 → 删除生效
    nodes.push(t) // 远端新增（agent 占位/写入）→ 保留
  }
  const baseEdges = byId(base?.edges ?? [])
  const mineEdges = byId(mine.edges)
  const theirEdges = byId(theirs.edges)
  const edges: CanvasEdge[] = []
  for (const e of mine.edges) {
    const t = theirEdges.get(e.id)
    if (!t) {
      const b = baseEdges.get(e.id)
      if (b && sameShape(e, b)) continue
      edges.push(e)
      continue
    }
    const b = baseEdges.get(e.id)
    edges.push(b && sameShape(t, b) ? e : t)
  }
  for (const t of theirs.edges) {
    if (mineEdges.has(t.id)) continue
    const b = baseEdges.get(t.id)
    if (b && sameShape(t, b)) continue
    edges.push(t)
  }
  return { nodes, edges }
}

interface CanvasSnapshot {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
}

export interface NodePatch {
  id: string
  position?: { x: number; y: number }
  width?: number
  height?: number
  data?: Partial<CanvasNodeData>
}

/** M31 修订：远端写入触及的元素 id（notify:canvas-changed meta；前端过滤为仍存在的节点做闪环高亮） */
export interface RemoteCanvasTouch {
  added: string[]
  updated: string[]
  removed: string[]
}

/** 远端写入高亮（一次性闪环；nonce 驱动重触发） */
export interface RemoteCanvasFlash {
  ids: string[]
  actor?: string
  nonce: number
}

/** M31 修订：通用节点闪环请求（查找定位 / 生成面板互链；CanvasView 消费渲染） */
export interface NodeFlashRequest {
  ids: string[]
  nonce: number
}

/** M31：画布外部动作（命令面板 / 消息侧 → 画布视图；CanvasView 挂载后消费） */
export type CanvasActionKind = 'new-note' | 'mind' | 'fit' | 'focus'

export interface CanvasPendingAction {
  kind: CanvasActionKind
  /** 同类动作可重复触发（nonce 变化驱动消费 effect 重跑） */
  nonce: number
  /** M31 修订：focus 专用——待定位的节点 id（消息侧「在画布查看」精确定位） */
  nodeIds?: string[]
}

interface CanvasState {
  sessionId?: string
  doc: CanvasDoc | null
  /** 全局是否存在启用中的媒体连接（生成面板引导 / 工具栏状态；M56：全局配置，不随会话切换） */
  mediaBound: boolean
  loading: boolean
  saving: boolean
  /** 有未保存的本地变更 */
  dirty: boolean
  saveError?: string
  lastSavedAt?: string
  /** 选中集镜像（React Flow onSelectionChange 回流；供工具栏 / 键盘动作使用） */
  selectedIds: string[]
  /** M31 修订：远端（agent）写入高亮闪环（consume 前有效；画布未打开时无消费者，随下次合流覆盖） */
  remoteFlash?: RemoteCanvasFlash
  /** M31 修订：通用节点闪环请求（生成面板任务行 hover → 画布节点高亮；CanvasView 消费） */
  nodeFlash?: NodeFlashRequest
  clipboard: CanvasClipboard | null
  undoDepth: number
  redoDepth: number
  /** 加载会话画布（切换会话时重入；过期响应丢弃） */
  load(sessionId: string): Promise<void>
  /** 本地变更入口（React Flow 受控更新回流）：更新文档并调度自动保存 */
  applyLocal(mutator: (doc: CanvasDoc) => CanvasDoc, opts?: { history?: boolean }): void
  /** 立即保存（离开画布 / ⌘S；幂等） */
  flush(): Promise<void>
  /** WS 通知入口（notify:canvas-changed）：远端写入合流；meta 携带 touched/actor（写入高亮与作者） */
  handleRemoteChange(
    sessionId: string,
    version: number,
    by: 'agent' | 'user',
    meta?: { actor?: string; touched?: RemoteCanvasTouch },
  ): void
  /** M31 修订：消费远端写入高亮（闪环展示后清除） */
  clearRemoteFlash(): void
  /** M31 修订：请求节点闪环（生成面板互链等非画布侧入口；CanvasView 消费渲染） */
  pulseNodes(ids: string[]): void
  /** M31 修订：消费节点闪环请求 */
  consumeNodeFlash(): void
  /** M31 修订：僵尸占位自愈——pending 节点但来源任务已不在任务快照（服务端重启 / 历史清理）→ 转中断态；返回修复数 */
  reconcileStalePending(existingJobIds: ReadonlySet<string>): number
  /** 拖拽 / 选择上传素材（图片 / 视频 → 交付件；返回落盘路径） */
  upload(file: File): Promise<CanvasUploadResponse | undefined>
  setSelectedIds(ids: string[]): void
  /** 历史快照：内容变更前调用（拖拽起点 / 删除批前；同一状态重复压栈自动去重） */
  pushHistory(): void
  undo(): void
  redo(): void
  /** 添加节点 / 边（画框自动沉底；parent 顺序修复） */
  addNodes(nodes: CanvasNode[], edges?: CanvasEdge[], opts?: { select?: boolean }): void
  updateNodeData(id: string, patch: Partial<CanvasNodeData>): void
  updateNodes(patches: NodePatch[], opts?: { history?: boolean }): void
  removeNodes(ids: string[]): void
  addEdge(source: string, target: string, kind: CanvasEdgeKind): void
  removeEdges(ids: string[]): void
  zOrder(ids: string[], mode: ZMode): void
  align(ids: string[], mode: AlignMode): void
  distribute(ids: string[], axis: 'h' | 'v'): void
  tidy(ids: string[]): void
  /** 拖拽停止后重算画框归属（收纳 / 脱离） */
  applyReparent(ids: string[]): void
  /** 脑图快捷编辑（Tab）：加子节点，返回新 id（供自动进入编辑） */
  mindAddChild(id: string, text?: string): string | undefined
  /** 脑图快捷编辑（Enter）：加兄弟；根节点回落为加子 */
  mindAddSibling(id: string, text?: string): string | undefined
  /** 拖拽重挂（xmind 式）：moving 挂到 target 之下；返回是否发生 */
  mindReparent(movingId: string, targetId: string): boolean
  /** 整理脑图：选中节点所在树的 dagre 重排（根保持原位） */
  arrangeMind(ids: string[]): void
  copySelection(ids: string[]): void
  /** 创建副本（复制 + 就地偏移一次，比走剪贴板更直觉） */
  duplicateNodes(ids: string[]): void
  pasteClipboard(): void
  setViewport(viewport: CanvasDoc['viewport']): void
  /** 命令面板等外部入口的待执行动作（CanvasView 消费；null = 空闲）；M31 修订：focus 可携带待定位节点 id */
  pendingAction: CanvasPendingAction | null
  requestAction(kind: CanvasActionKind, opts?: { nodeIds?: string[] }): void
  /** 消费待执行动作（CanvasView 拿到后立即清除，避免重复执行） */
  consumeAction(): void
  /** 「送上画布」：工作区文件落为新节点（图片 / 视频直出，其余按交付件引用）；返回节点 id（无会话 / 加载失败时 undefined） */
  sendArtifact(path: string): Promise<string | undefined>
  /** 「送上画布」：博弈数据集（含结果）落为 game 结果态节点，节点内可回配置态调参重跑；返回节点 id（无会话 / 加载失败时 undefined） */
  sendGame(data: CanvasGameData): Promise<string | undefined>
  /** 「送上画布」：K 线数据集（bars 内联）落为 kline 节点，节点内可切换周期 / 复权；返回节点 id（无会话 / 加载失败时 undefined） */
  sendKline(data: CanvasKlineData): Promise<string | undefined>
}

let saveTimer: number | undefined
let remotePending = false
/** 同一错误只提示一次（避免自动保存失败时反复弹 toast） */
let lastToastMessage: string | undefined
let undoStack: CanvasSnapshot[] = []
let redoStack: CanvasSnapshot[] = []

async function fetchDoc(sessionId: string): Promise<{ doc: CanvasDoc; mediaBound: boolean }> {
  const res = await fetch(`/api/sessions/${sessionId}/canvas`)
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error ?? `画布加载失败（HTTP ${res.status}）`)
  }
  return (await res.json()) as { doc: CanvasDoc; mediaBound: boolean }
}

function notifyError(message: string): void {
  if (message === lastToastMessage) return
  lastToastMessage = message
  toast.error(message)
}

export const useCanvasStore = create<CanvasState>((set, get) => {
  const scheduleFlush = (): void => {
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => void get().flush(), AUTOSAVE_DEBOUNCE_MS)
  }

  const resetHistory = (): void => {
    undoStack = []
    redoStack = []
    set({ undoDepth: 0, redoDepth: 0 })
  }

  /** 保存一次（M79-AG：409 冲突按三方合并「合流重放」；成功后若远端有积压变更则补拉） */
  const save = async (): Promise<void> => {
    const { sessionId, doc, dirty, saving } = get()
    if (!sessionId || !doc || !dirty || saving) return
    // M79-AH：viewer 防御——即便因异常路径标脏也不发 PUT（清脏静默收口）
    if (viewerReadOnly()) {
      set({ dirty: false })
      return
    }
    // 入口先清 dirty：保存期间若又有编辑会再次置位 → 结束后据此判断「保存中是否又脏」
    set({ saving: true, dirty: false })
    const put = async (
      baseVersion: number,
      body: { viewport: CanvasDoc['viewport']; nodes: CanvasNode[]; edges: CanvasEdge[] },
    ): Promise<Response> =>
      fetch(`/api/sessions/${sessionId}/canvas`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseVersion, ...body }),
      })
    try {
      let res = await put(doc.version, { viewport: doc.viewport, nodes: doc.nodes, edges: doc.edges })
      if (res.status === 409) {
        // M79-AG：冲突合流——以远端最新为基底重放本地变更（替代「本地优先覆盖」：
        //   agent 落位/写入等远端新增不再被本地保存静默清掉；base = 上次同步快照）
        const conflict = (await res.json().catch(() => ({}))) as { doc?: CanvasDoc }
        if (conflict.doc) {
          const merged = mergeCanvasDocs(lastSyncedDoc, doc, conflict.doc)
          res = await put(conflict.doc.version, { viewport: doc.viewport, nodes: merged.nodes, edges: merged.edges })
        }
      }
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string; doc?: CanvasDoc }
        // 二次冲突也带 doc：仍不丢本地内容，等下次编辑重试
        throw new Error(data.error ?? `画布保存失败（HTTP ${res.status}）`)
      }
      const body = (await res.json()) as { doc: CanvasDoc }
      const savedDoc = body.doc
      lastSyncedDoc = savedDoc // M79-AG：同步锚点（下次 409 合并的 base）
      // 保存期间又有新编辑（dirty 已再次置位）→ 保持 dirty，继续调度
      const stillDirty = get().dirty
      set({
        doc: stillDirty && get().doc ? { ...get().doc!, version: savedDoc.version } : savedDoc,
        saving: false,
        dirty: stillDirty,
        saveError: undefined,
        lastSavedAt: savedDoc.updatedAt,
      })
      lastToastMessage = undefined
      if (stillDirty) scheduleFlush()
      if (remotePending && !get().dirty) void pullRemote()
    } catch (err) {
      // 恢复 dirty 供重试（成功路径由 stillDirty 接收口接管）
      set({ saving: false, dirty: true, saveError: (err as Error).message })
      notifyError((err as Error).message)
    }
  }

  /** 拉取服务端最新文档（远端变更合流；本地脏时不覆盖）；M31 修订：合流后标记写入高亮 */
  const pullRemote = async (meta?: { actor?: string; touched?: RemoteCanvasTouch }): Promise<void> => {
    const { sessionId } = get()
    if (!sessionId) return
    if (get().dirty || get().saving) {
      remotePending = true
      return
    }
    try {
      const fresh = await fetchDoc(sessionId)
      if (get().sessionId !== sessionId) return
      remotePending = false
      lastSyncedDoc = fresh.doc // M79-AG：同步锚点（本次拉取即最新共识）
      resetHistory() // 远端替换文档：旧快照坐标语义可能失联，清栈防「撤销跨端」
      set({ doc: fresh.doc, mediaBound: fresh.mediaBound })
      // M31 修订：远端写入高亮（过滤为合流后仍存在的节点；边 id 自然被过滤掉）
      if (meta?.touched) {
        const ids = [...meta.touched.added, ...meta.touched.updated].filter((id) =>
          fresh.doc.nodes.some((n) => n.id === id),
        )
        if (ids.length > 0) set({ remoteFlash: { ids, actor: meta.actor, nonce: Date.now() } })
      }
    } catch {
      /* 瞬时失败：留待下次通知 / 重开画布 */
    }
  }

  /**
   * M79-AH：只读共享（viewer）判定——画布编辑入口的统一闸门（服务端 PUT 写守卫兜底）。
   * 编辑被拒时 2s 节流提示一次；浏览（视口平移/缩放/选中/查找）不受限。
   */
  const viewerReadOnly = (): boolean => {
    const st = useSessionStore.getState()
    return st.sessions.find((s) => s.id === st.currentId)?.role === 'viewer'
  }
  let readOnlyToastAt = 0
  const denyEdit = (): void => {
    const now = Date.now()
    if (now - readOnlyToastAt < 2_000) return
    readOnlyToastAt = now
    toast.info('只读共享（viewer）：无画布编辑权限')
  }

  /** 内容变更的统一入口（history 快照 → 不可变更新 → 调度保存） */
  const mutate = (mutator: (doc: CanvasDoc) => CanvasDoc, history = true): void => {
    const { doc } = get()
    if (!doc) return
    if (viewerReadOnly()) {
      denyEdit()
      return
    }
    if (history) get().pushHistory()
    const next = mutator(doc)
    if (next === doc) return
    set({ doc: next, dirty: true })
    scheduleFlush()
  }

  return {
    doc: null,
    mediaBound: false,
    loading: false,
    saving: false,
    dirty: false,
    selectedIds: [],
    clipboard: null,
    pendingAction: null,
    undoDepth: 0,
    redoDepth: 0,

    load: async (sessionId) => {
      if (get().sessionId === sessionId && get().doc) return
      window.clearTimeout(saveTimer)
      remotePending = false
      lastSyncedDoc = null // M79-AG：跨会话切换——同步锚点作废（防串会话合并）
      lastToastMessage = undefined
      resetHistory()
      set({ sessionId, doc: null, loading: true, dirty: false, saving: false, saveError: undefined, selectedIds: [] })
      try {
        const fresh = await fetchDoc(sessionId)
        if (get().sessionId !== sessionId) return // 已切走：丢弃过期响应
        lastSyncedDoc = fresh.doc // M79-AG：同步锚点（加载即最新共识）
        set({ doc: fresh.doc, mediaBound: fresh.mediaBound, loading: false })
      } catch (err) {
        if (get().sessionId !== sessionId) return
        set({ loading: false, saveError: (err as Error).message })
        notifyError((err as Error).message)
      }
    },

    applyLocal: (mutator, opts) => {
      const { doc } = get()
      if (!doc) return
      if (viewerReadOnly()) {
        denyEdit()
        return
      }
      if (opts?.history) get().pushHistory()
      const next = mutator(doc)
      if (next === doc) return
      set({ doc: next, dirty: true })
      scheduleFlush()
    },

    flush: async () => {
      window.clearTimeout(saveTimer)
      await save()
    },

    handleRemoteChange: (sessionId, version, by, meta) => {
      if (get().sessionId !== sessionId) return
      if (by === 'user') return // 自身保存的回声
      const doc = get().doc
      if (doc && version <= doc.version && !remotePending) return // 已是最新
      void pullRemote(meta)
    },

    clearRemoteFlash: () => set({ remoteFlash: undefined }),

    pulseNodes: (ids) => {
      if (ids.length === 0) return
      set({ nodeFlash: { ids: [...ids], nonce: Date.now() } })
    },

    consumeNodeFlash: () => set({ nodeFlash: undefined }),

    reconcileStalePending: (existingJobIds) => {
      const doc = get().doc
      if (!doc) return 0
      const patches: NodePatch[] = []
      for (const n of doc.nodes) {
        if (n.type !== 'image' && n.type !== 'video') continue
        const d = n.data as { pending?: boolean; jobId?: string }
        if (d.pending !== true) continue
        if (d.jobId && existingJobIds.has(d.jobId)) continue // 任务仍在快照（含活跃与终态）→ 等合流，不误标
        patches.push({
          id: n.id,
          data: { pending: false, error: '生成中断（任务已丢失，可重新生成）' } as Partial<CanvasNodeData>,
        })
      }
      if (patches.length === 0) return 0
      get().updateNodes(patches, { history: false }) // 自愈不进撤销栈
      return patches.length
    },

    upload: async (file) => {
      const { sessionId } = get()
      if (!sessionId) return undefined
      try {
        const res = await fetch(`/api/sessions/${sessionId}/media/upload`, {
          method: 'POST',
          headers: {
            'x-file-name': encodeURIComponent(file.name),
            'content-type': file.type || 'application/octet-stream',
          },
          body: file,
        })
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(data.error ?? `上传失败（HTTP ${res.status}）`)
        }
        return (await res.json()) as CanvasUploadResponse
      } catch (err) {
        notifyError((err as Error).message)
        return undefined
      }
    },

    setSelectedIds: (ids) => {
      const prev = get().selectedIds
      if (prev.length === ids.length && prev.every((id, i) => id === ids[i])) return
      set({ selectedIds: ids })
    },

    pushHistory: () => {
      const doc = get().doc
      if (!doc) return
      const top = undoStack[undoStack.length - 1]
      if (top && top.nodes === doc.nodes && top.edges === doc.edges) return // 同状态去重
      undoStack.push({ nodes: doc.nodes, edges: doc.edges })
      if (undoStack.length > HISTORY_LIMIT) undoStack.shift()
      redoStack = []
      set({ undoDepth: undoStack.length, redoDepth: 0 })
    },

    undo: () => {
      const doc = get().doc
      const prev = undoStack.pop()
      if (!doc || !prev) return
      if (viewerReadOnly()) {
        denyEdit()
        return
      }
      redoStack.push({ nodes: doc.nodes, edges: doc.edges })
      const aliveIds = new Set(prev.nodes.map((n) => n.id))
      set({
        doc: { ...doc, nodes: prev.nodes, edges: prev.edges },
        dirty: true,
        undoDepth: undoStack.length,
        redoDepth: redoStack.length,
        selectedIds: get().selectedIds.filter((id) => aliveIds.has(id)),
      })
      scheduleFlush()
    },

    redo: () => {
      const doc = get().doc
      const next = redoStack.pop()
      if (!doc || !next) return
      if (viewerReadOnly()) {
        denyEdit()
        return
      }
      undoStack.push({ nodes: doc.nodes, edges: doc.edges })
      const aliveIds = new Set(next.nodes.map((n) => n.id))
      set({
        doc: { ...doc, nodes: next.nodes, edges: next.edges },
        dirty: true,
        undoDepth: undoStack.length,
        redoDepth: redoStack.length,
        selectedIds: get().selectedIds.filter((id) => aliveIds.has(id)),
      })
      scheduleFlush()
    },

    addNodes: (nodes, edges = [], opts) => {
      if (nodes.length === 0 && edges.length === 0) return
      // 画框沉底（先渲染 = 垫在所有内容之下）
      const groups = nodes.filter((n) => n.type === 'group')
      const rest = nodes.filter((n) => n.type !== 'group')
      mutate((doc) => ({
        ...doc,
        nodes: ensureParentOrder([...groups, ...doc.nodes, ...rest]),
        edges: edges.length > 0 ? [...doc.edges, ...edges] : doc.edges,
      }))
      if (opts?.select && nodes.length > 0) set({ selectedIds: nodes.map((n) => n.id) })
    },

    updateNodeData: (id, patch) => {
      mutate((doc) => {
        let changed = false
        const nodes = doc.nodes.map((n) => {
          if (n.id !== id) return n
          changed = true
          return { ...n, data: { ...n.data, ...patch } as CanvasNodeData }
        })
        return changed ? { ...doc, nodes } : doc
      })
    },

    updateNodes: (patches, opts) => {
      if (patches.length === 0) return
      const byId = new Map(patches.map((p) => [p.id, p]))
      mutate((doc) => {
        let changed = false
        const nodes = doc.nodes.map((n) => {
          const p = byId.get(n.id)
          if (!p) return n
          const next: CanvasNode = {
            ...n,
            ...(p.position ? { position: p.position } : {}),
            ...(p.width !== undefined ? { width: p.width } : {}),
            ...(p.height !== undefined ? { height: p.height } : {}),
            ...(p.data ? { data: { ...n.data, ...p.data } as CanvasNodeData } : {}),
          }
          if (
            next.position === n.position &&
            next.width === n.width &&
            next.height === n.height &&
            next.data === n.data
          ) {
            return n
          }
          changed = true
          return next
        })
        return changed ? { ...doc, nodes: ensureParentOrder(nodes) } : doc
      }, opts?.history ?? true)
    },

    removeNodes: (ids) => {
      if (ids.length === 0) return
      const gone = new Set(ids)
      mutate((doc) => {
        const detached = detachOrphans(doc.nodes, gone)
        return {
          ...doc,
          nodes: detached.filter((n) => !gone.has(n.id)),
          edges: doc.edges.filter((e) => !gone.has(e.source) && !gone.has(e.target)),
        }
      })
      set({ selectedIds: get().selectedIds.filter((id) => !gone.has(id)) })
    },

    addEdge: (source, target, kind) => {
      if (source === target) return
      mutate((doc) => {
        const exists = doc.edges.some((e) => e.source === source && e.target === target)
        if (exists) return doc
        const edge: CanvasEdge = { id: newEdgeId(), source, target, kind }
        return { ...doc, edges: [...doc.edges, edge] }
      })
    },

    removeEdges: (ids) => {
      if (ids.length === 0) return
      const gone = new Set(ids)
      mutate((doc) => ({ ...doc, edges: doc.edges.filter((e) => !gone.has(e.id)) }))
    },

    zOrder: (ids, mode) => {
      if (ids.length === 0) return
      const idSet = new Set(ids)
      mutate((doc) => ({ ...doc, nodes: reorderNodesPure(doc.nodes, idSet, mode) }))
    },

    align: (ids, mode) => {
      if (ids.length < 2) return
      const idSet = new Set(ids)
      mutate((doc) => ({ ...doc, nodes: alignNodesPure(doc.nodes, idSet, mode) }))
    },

    distribute: (ids, axis) => {
      if (ids.length < 3) return
      const idSet = new Set(ids)
      mutate((doc) => ({ ...doc, nodes: distributeNodesPure(doc.nodes, idSet, axis) }))
    },

    tidy: (ids) => {
      if (ids.length < 2) return
      const idSet = new Set(ids)
      mutate((doc) => ({ ...doc, nodes: tidyGrid(doc.nodes, idSet) }))
    },

    applyReparent: (ids) => {
      if (ids.length === 0) return
      mutate((doc) => {
        const nodes = reparentNodes(doc.nodes, ids)
        const changed = nodes.some((n, i) => n !== doc.nodes[i])
        return changed ? { ...doc, nodes } : doc
      }, false) // 拖拽起点已压栈，避免二次快照
    },

    mindAddChild: (id, text) => {
      const doc = get().doc
      if (!doc) return undefined
      const insert = planAddChild(doc.nodes, indexMind(doc.nodes, doc.edges), id, text)
      if (!insert) return undefined
      get().addNodes([insert.node], [insert.edge], { select: true })
      return insert.node.id
    },

    mindAddSibling: (id, text) => {
      const doc = get().doc
      if (!doc) return undefined
      const index = indexMind(doc.nodes, doc.edges)
      const insert = planAddSibling(doc.nodes, index, id, text) ?? planAddChild(doc.nodes, index, id, text)
      if (!insert) return undefined
      get().addNodes([insert.node], [insert.edge], { select: true })
      return insert.node.id
    },

    mindReparent: (movingId, targetId) => {
      const doc = get().doc
      if (!doc) return false
      const plan = planReparent(doc.nodes, doc.edges, indexMind(doc.nodes, doc.edges), movingId, targetId)
      if (!plan) return false
      mutate((d) => {
        const gone = new Set(plan.removeEdgeIds)
        return {
          ...d,
          nodes: d.nodes.map((n) => (n.id === movingId ? { ...n, position: plan.position } : n)),
          edges: [...d.edges.filter((e) => !gone.has(e.id)), plan.edge],
        }
      }, false) // 拖拽起点已压栈（onNodeDragStart），避免二次快照
      return true
    },

    arrangeMind: (ids) => {
      const current = get().doc
      if (!current || ids.length === 0) return
      const hasMind = current.nodes.some((n) => n.type === 'mind' && ids.includes(n.id))
      if (!hasMind) return // 选区无脑图：不进入历史（避免压无效快照）
      mutate((doc) => {
        const index = indexMind(doc.nodes, doc.edges)
        const mindIds = new Set(doc.nodes.filter((n) => n.type === 'mind').map((n) => n.id))
        const roots = [...new Set(ids.filter((id) => mindIds.has(id)).map((id) => mindRootOf(index, id)))]
        if (roots.length === 0) return doc
        const nodes = applyMindLayout(doc.nodes, index, roots)
        return nodes.some((n, i) => n !== doc.nodes[i]) ? { ...doc, nodes } : doc
      })
    },

    copySelection: (ids) => {
      const doc = get().doc
      if (!doc || ids.length === 0) return
      const clip = extractClipboard(doc.nodes, doc.edges, new Set(ids))
      if (clip.nodes.length > 0) set({ clipboard: clip })
    },

    duplicateNodes: (ids) => {
      const doc = get().doc
      if (!doc || ids.length === 0) return
      const clip = extractClipboard(doc.nodes, doc.edges, new Set(ids))
      if (clip.nodes.length === 0) return
      const { nodes, edges } = materializeClipboard(clip, PASTE_OFFSET, PASTE_OFFSET)
      get().addNodes(nodes, edges, { select: true })
    },

    pasteClipboard: () => {
      const clip = get().clipboard
      if (!clip || clip.nodes.length === 0) return
      const { nodes, edges } = materializeClipboard(clip, PASTE_OFFSET, PASTE_OFFSET)
      get().addNodes(nodes, edges, { select: true })
      set({ clipboard: { nodes, edges } }) // 连续粘贴逐级偏移
    },

    setViewport: (viewport) => {
      const doc = get().doc
      if (!doc) return
      if (doc.viewport.x === viewport.x && doc.viewport.y === viewport.y && doc.viewport.zoom === viewport.zoom) return
      // M79-AH：viewer 允许自由浏览（本地视口不落盘、不标脏——服务端写守卫兜底，避免 403 噪音）
      if (viewerReadOnly()) {
        set({ doc: { ...doc, viewport } })
        return
      }
      set({ doc: { ...doc, viewport }, dirty: true })
      scheduleFlush()
    },

    requestAction: (kind, opts) => {
      set({ pendingAction: { kind, nonce: Date.now(), ...(opts?.nodeIds ? { nodeIds: opts.nodeIds } : {}) } })
    },

    consumeAction: () => {
      if (get().pendingAction) set({ pendingAction: null })
    },

    sendArtifact: async (path) => {
      const currentId = useSessionStore.getState().currentId
      if (!currentId) return undefined
      // 画布未加载 / 还停在别的会话 → 先拉取当前会话文档
      if (get().sessionId !== currentId || !get().doc) await get().load(currentId)
      const doc = get().doc
      if (!doc || get().sessionId !== currentId) return undefined
      const type = canvasNodeTypeOf(path)
      const position = nextPlacement(doc.nodes)
      const node =
        type === 'artifact'
          ? createNode('artifact', position, { path })
          : createNode(type, position, { artifact: path, source: 'ref' })
      get().addNodes([node], [], { select: true })
      return node.id
    },

    sendGame: async (data) => {
      const currentId = useSessionStore.getState().currentId
      if (!currentId) return undefined
      // 画布未加载 / 还停在别的会话 → 先拉取当前会话文档
      if (get().sessionId !== currentId || !get().doc) await get().load(currentId)
      const doc = get().doc
      if (!doc || get().sessionId !== currentId) return undefined
      const position = nextPlacement(doc.nodes)
      const node = createNode('game', position, data)
      get().addNodes([node], [], { select: true })
      return node.id
    },

    sendKline: async (data) => {
      const currentId = useSessionStore.getState().currentId
      if (!currentId) return undefined
      // 画布未加载 / 还停在别的会话 → 先拉取当前会话文档
      if (get().sessionId !== currentId || !get().doc) await get().load(currentId)
      const doc = get().doc
      if (!doc || get().sessionId !== currentId) return undefined
      const position = nextPlacement(doc.nodes)
      const node = createNode('kline', position, data)
      get().addNodes([node], [], { select: true })
      return node.id
    },
  }
})

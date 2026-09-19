/**
 * 右栏「实况」面板跟随引擎（M49 / ADR 0100）：Agent 操作到达 → 自动聚焦实况面（带护栏）。
 *
 * 与 ui-store 的关系（单向，不引入 store 环）：
 * - 本 store import ui-store（不反向）；右栏视图切换统一走 ui-store.setRightView；
 * - 程序性切换用模块级 applying 标志标记（applyRightView）→ 订阅回调忽略，不视为手动导航；
 * - 右栏收起（ui-store.rightPanelOpen）：自动聚焦只切视图状态、不抢展开（applyRightView 默认
 *   reveal:false，尊重用户收起意图）；chip 跳转等用户显式意图传 reveal:true 强制展开；
 * - 其余 rightView 变化（TeamPanel 一级 / 二级点击、命令面板等）视为「用户手动导航」：
 *   切走 → 锁本 Run 自动聚焦；切到「实况」→ 恢复跟随。
 *
 * 决策核心抽为纯函数 resolveFollow（live-follow 单测直击，规则可读）：
 * - 实况操作（browser / db / ssh）→ 切视图到实况 + 对应面；例外 = 暂停跟随 / 本 Run 已手动
 *   切走 / 60s 内刚手动切过视图；60s 面锁期间仅保视图、不抢面；
 * - 交付件更新 = 软跟随：面板停在交付件面且未钉住 → 选最新文件；否则不抢视图、不抢页签；
 * - beginRun（notify:run-started）重置 Run 级护栏（新 Run 重新允许自动聚焦）。
 */
import { create } from 'zustand'
import type { OpEvent } from '@multi-agent/shared'
import { useRunStore } from './run-store'
import { useSessionStore } from './session-store'
import { useUiStore, type RightView } from './ui-store'

/** 实况面板四面（浏览器 / 交付件 / 数据库 / 终端；浏览器面的 BrowserPanel 亦承载展开能力） */
export type LiveFace = 'browser' | 'artifacts' | 'db' | 'ssh'

/** 实况操作面（op 事件可驱动切换的面） */
export type OpLiveFace = 'browser' | 'db' | 'ssh'

/** 手动面锁 / 视图锁时长（60s 内自动聚焦不抢切） */
export const FOLLOW_LOCK_MS = 60_000

/** op.kind → 实况面（连接管理等返回 undefined，不驱动聚焦） */
export function faceOfOpKind(kind: OpEvent['kind']): OpLiveFace | undefined {
  if (kind === 'browser' || kind === 'browser-input' || kind === 'takeover') return 'browser'
  if (kind === 'db') return 'db'
  if (kind === 'ssh') return 'ssh'
  return undefined
}

/** resolveFollow 的状态快照（纯数据，便于单测构造） */
export interface FollowSnapshot {
  /** 当前右栏视图（ui-store.rightView） */
  rightView: RightView
  face: LiveFace
  /** 手动切面时间（60s 面锁） */
  faceLockedAt?: number
  /** 本 Run 手动切走视图（自动聚焦不再拉回；beginRun 重置） */
  viewLockedRunId?: string
  /** 手动切视图时间（60s 内不抢视图） */
  lastManualViewAt?: number
  /** 暂停跟随（本次运行不再自动聚焦；beginRun 重置） */
  followPaused: boolean
  /** 交付件面是否钉住（钉住时软跟随不选最新） */
  artifactPinned: boolean
  /** 当前活动 Run（判断 viewLockedRunId 是否仍属本次运行） */
  currentRunId?: string
}

export type FollowEvent =
  | { type: 'op'; face: OpLiveFace; runId?: string }
  | { type: 'artifact'; path: string }

/** 决策输出：需要应用的改动（空对象 = 不打扰） */
export interface FollowPatch {
  /** 程序性切到实况视图 */
  toLive?: boolean
  /** 切换面 */
  face?: LiveFace
  /** 交付件面软跟随：选中最新文件 */
  followPath?: string
}

/**
 * 跟随决策纯函数（无副作用，单测直击）。
 *
 * - op 事件：护栏（暂停 / 本 Run 锁 / 60s 视图锁）→ 全跳过；
 *   否则必要时切视图到实况；面锁 60s 外才跟切对应面；
 * - artifact 事件：软跟随 —— 面板停在交付件面且未钉住 → 选最新；否则不打扰。
 */
export function resolveFollow(state: FollowSnapshot, event: FollowEvent, now: number): FollowPatch {
  if (event.type === 'op') {
    if (state.followPaused) return {}
    // 本 Run 已手动切走（锁定 Run 仍在跑或与事件 Run 一致）
    if (
      state.viewLockedRunId &&
      (state.viewLockedRunId === state.currentRunId || (event.runId !== undefined && state.viewLockedRunId === event.runId))
    ) {
      return {}
    }
    if (state.lastManualViewAt !== undefined && now - state.lastManualViewAt < FOLLOW_LOCK_MS) return {}
    const patch: FollowPatch = {}
    if (state.rightView !== 'live') patch.toLive = true
    const faceLocked = state.faceLockedAt !== undefined && now - state.faceLockedAt < FOLLOW_LOCK_MS
    if (!faceLocked && state.face !== event.face) patch.face = event.face
    return patch
  }

  // 交付件更新 = 软跟随：只服务「正停在交付件面」的观看者
  if (state.rightView === 'live' && state.face === 'artifacts' && !state.artifactPinned) {
    return { followPath: event.path }
  }
  return {}
}

interface LivePanelState {
  /** 当前面（面内二级） */
  face: LiveFace
  /** 手动切面时间（60s 面锁） */
  faceLockedAt?: number
  /** 本 Run 手动切走视图（自动聚焦不再拉回；beginRun 重置） */
  viewLockedRunId?: string
  /** 手动切视图时间（60s 内不抢视图） */
  lastManualViewAt?: number
  /** 暂停跟随（本次运行不再自动聚焦；beginRun 重置） */
  followPaused: boolean
  /** 交付件面钉住路径（undefined = 跟最新） */
  pinnedArtifactPath?: string
  /** 交付件面软跟随的最新路径（未钉住时采用） */
  followArtifactPath?: string
  /** 手动切面（60s 面锁；用户显式意图优先于自动聚焦） */
  setFace: (face: LiveFace) => void
  /** 钉住 / 取消钉住交付件面（undefined = 回跟随最新） */
  pinArtifact: (path?: string) => void
  /** 交付件 chip 跳转：切实况 + 交付件面 + 钉住 + 锁本 Run（用户正在看该文件） */
  openArtifact: (path: string) => void
  /** 恢复跟随（点「实况」一级 / 展开按钮） */
  resumeFollow: () => void
  /** 暂停 / 恢复跟随（本次运行） */
  toggleFollowPaused: () => void
  /** 手动切走视图（内部订阅调用：右栏离开实况） */
  noteManualView: () => void
  /** 操作事件入口（ws-store 转发；先于直播窗 noteOp 执行） */
  noteOp: (op: OpEvent) => void
  /** 交付件更新入口（ws-store 转发，仅当前会话） */
  noteArtifact: (path: string) => void
  /** Run 开始：重置 Run 级护栏 */
  beginRun: () => void
}

/** 程序性切换右栏视图（订阅侧忽略，不视为手动导航）：
 *  默认不展开被用户收起的右栏（自动聚焦只改视图状态，重新展开时停在实况）；
 *  用户显式意图（chip 跳转等）传 `reveal: true` 强制展开。 */
let applying = false
export function applyRightView(view: RightView, opts?: { reveal?: boolean }): void {
  applying = true
  try {
    useUiStore.getState().setRightView(view, { reveal: opts?.reveal ?? false })
  } finally {
    applying = false
  }
}

function snapshot(): FollowSnapshot {
  const s = useLivePanelStore.getState()
  return {
    rightView: useUiStore.getState().rightView,
    face: s.face,
    faceLockedAt: s.faceLockedAt,
    viewLockedRunId: s.viewLockedRunId,
    lastManualViewAt: s.lastManualViewAt,
    followPaused: s.followPaused,
    artifactPinned: !!s.pinnedArtifactPath,
    currentRunId: useRunStore.getState().runId,
  }
}

export const useLivePanelStore = create<LivePanelState>((set) => ({
  face: 'browser',
  followPaused: false,

  setFace: (face) => set({ face, faceLockedAt: Date.now() }),

  pinArtifact: (path) => set({ pinnedArtifactPath: path }),

  openArtifact: (path) => {
    set({
      face: 'artifacts',
      pinnedArtifactPath: path,
      followArtifactPath: path,
      // 用户正在看该文件：本 Run 不再被自动聚焦抢走（点「实况」/ 展开可恢复）
      viewLockedRunId: useRunStore.getState().runId,
    })
    // chip 点击 = 用户显式意图：右栏收起时也展开（否则跳转无可见结果）
    applyRightView('live', { reveal: true })
  },

  resumeFollow: () => set({ viewLockedRunId: undefined, lastManualViewAt: undefined, followPaused: false }),

  toggleFollowPaused: () => set((s) => ({ followPaused: !s.followPaused })),

  noteManualView: () => set({ viewLockedRunId: useRunStore.getState().runId, lastManualViewAt: Date.now() }),

  noteOp: (op) => {
    const currentId = useSessionStore.getState().currentId
    if (op.sessionId && currentId && op.sessionId !== currentId) return // 非当前会话不干扰
    const face = faceOfOpKind(op.kind)
    if (!face) return
    const patch = resolveFollow(snapshot(), { type: 'op', face, runId: op.runId }, Date.now())
    if (patch.toLive) applyRightView('live') // 收起态 = 用户显式意图：自动聚焦不抢展开
    if (patch.face) set({ face: patch.face })
  },

  noteArtifact: (path) => {
    const patch = resolveFollow(snapshot(), { type: 'artifact', path }, Date.now())
    if (patch.followPath) set({ followArtifactPath: patch.followPath })
  },

  beginRun: () => set({ viewLockedRunId: undefined, faceLockedAt: undefined, followPaused: false }),
}))

// ---- 模块级订阅（ui-store → 本 store 的手动导航感知；ui-store 不依赖本 store，无环） ----

useUiStore.subscribe((s, prev) => {
  if (s.rightView === prev.rightView) return
  if (applying) return // 程序性切换（自动聚焦 / chip 跳转）不视为手动
  if (s.rightView === 'live') useLivePanelStore.getState().resumeFollow() // 点「实况」= 恢复跟随
  else useLivePanelStore.getState().noteManualView() // 手动切走 → 本 Run 不再自动拉回
})

useUiStore.subscribe((s, prev) => {
  if (!s.requestedArtifactPath || s.requestedArtifactPath === prev.requestedArtifactPath) return
  // 交付件 chip / 消息附件点击：切实况 + 交付件面 + 钉住
  useLivePanelStore.getState().openArtifact(s.requestedArtifactPath)
})

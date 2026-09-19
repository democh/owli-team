/**
 * 会话与消息：列表 CRUD + 当前会话消息（服务端为真相；运行中由 run-store 打增量补丁）。
 *
 * M8 性能架构：
 * - 消息存 `byId: Map<id, ChatMessage>` + `order: string[]`（O(1) 按 id 更新、渲染层项级订阅）；
 * - 单条消息变更只替换该条对象引用 → `useSessionStore(s => s.byId.get(id))` 的组件才重渲染；
 * - 所有消息写操作都带「当前会话」守卫，跨会话的流式事件不会污染其他会话的视图；
 * - 非响应式读取（测试 / 存储层）统一走 `messagesOf(state)` 派生函数。
 */
import { create } from 'zustand'
import { sanitizeModelText } from '@multi-agent/shared'
import type { ChatMessage, RunSnapshot, Session, SessionSummary } from '@multi-agent/shared'
import { apiDelete, apiGet, apiPatch, apiPost } from '../lib/api'

export interface SessionDetailResponse {
  session: Session
  messages: ChatMessage[]
  /** M3：最近一次运行快照（interrupted 时前端展示「从断点继续」） */
  latestRun?: RunSnapshot | null
  /** M57 P2：共享会话人类署名表（userId → 昵称；兼容模式为空） */
  humanNames?: Record<string, string>
}

export interface SessionState {
  sessions: SessionSummary[]
  currentId?: string
  /** M8：消息 Map（O(1) 更新与项级订阅） */
  byId: Map<string, ChatMessage>
  /** M8：消息 id 顺序（仅结构变化时替换引用） */
  order: string[]
  /** M3：当前会话最近一次运行快照 */
  latestRun: RunSnapshot | null
  /** M57 P2：当前会话人类署名表（userId → 昵称；共享会话消息气泡用；兼容模式为空对象） */
  humanNames: Record<string, string>
  loadingSessions: boolean
  loadingMessages: boolean
  /** 交付件刷新版本号：artifact:updated 递增，交付件浏览器据此重拉列表 */
  artifactVersion: number
  loadSessions: () => Promise<void>
  createSession: (participantIds: string[], title?: string, souls?: Record<string, string>) => Promise<Session>
  /** M16：动态邀请成员（运行中允许；可选邀请时即选灵魂） */
  addMembers: (sessionId: string, agentIds: string[], souls?: Record<string, string>) => Promise<Session>
  /** M16：移出成员（正在发言时服务端拒绝，错误直通 toast） */
  removeMember: (sessionId: string, agentId: string) => Promise<Session>
  /** M16：切换成员灵魂（null = 恢复角色默认） */
  setMemberSoul: (sessionId: string, agentId: string, soul: string | null) => Promise<Session>
  /** M16：应用服务端会话补丁（members API / notify:members-changed 共用） */
  applySession: (session: Session) => void
  selectSession: (id?: string) => Promise<void>
  refreshMessages: () => Promise<void>
  renameSession: (id: string, title: string) => Promise<void>
  removeSession: (id: string) => Promise<void>
  upsertMessage: (message: ChatMessage) => void
  patchMessage: (id: string, patch: Partial<ChatMessage>) => void
  appendDelta: (id: string, delta: string) => void
  /** 思考模式（V4）：追加思维链增量 */
  appendReasoning: (id: string, delta: string) => void
  /** M8：删除单条消息（本地移除；服务端由调用方先行删除） */
  removeMessage: (id: string) => void
  bumpArtifacts: () => void
  /** M3：同步最近一次运行快照（继续/恢复后置空） */
  setLatestRun: (run: RunSnapshot | null) => void
}

/** 非响应式派生：order + byId → 消息数组（测试 / 一次性读取用） */
export function messagesOf(state: Pick<SessionState, 'byId' | 'order'>): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const id of state.order) {
    const message = state.byId.get(id)
    if (message) out.push(message)
  }
  return out
}

/**
 * M55（§77 / ADR 0125）：agent 正文展示净化。
 * 服务端已在回合收尾净化新消息；此处兜底「流式过程」与「存量消息（历史回看）」。
 * 净化规则需在全文上求值（仿写块以 [工具调用] 标题行锚定），若对已净化文本增量拼接，
 * 块内后续日志行会失去锚点成为孤行 → 为流式消息保留原始累积缓冲（appendDelta 对
 * 「原始全文」求净化写回 content；upsertMessage 视为权威全文重置缓冲）。
 */
const rawStreams = new Map<string, string>()

/** 净化 agent 正文（未变化时保持原对象引用，避免无谓重渲染） */
function withCleanContent(message: ChatMessage): ChatMessage {
  if (message.role !== 'agent' || !message.content) return message
  const cleaned = sanitizeModelText(message.content)
  return cleaned === message.content ? message : { ...message, content: cleaned }
}

function toStores(messages: ChatMessage[]): { byId: Map<string, ChatMessage>; order: string[] } {
  const byId = new Map<string, ChatMessage>()
  const order: string[] = []
  for (const m of messages) {
    const clean = withCleanContent(m)
    byId.set(clean.id, clean)
    order.push(clean.id)
  }
  return { byId, order }
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  byId: new Map(),
  order: [],
  latestRun: null,
  humanNames: {},
  loadingSessions: false,
  loadingMessages: false,
  artifactVersion: 0,

  loadSessions: async () => {
    set({ loadingSessions: true })
    try {
      const res = await apiGet<{ sessions: SessionSummary[] }>('/api/sessions')
      set({ sessions: res.sessions })
    } finally {
      set({ loadingSessions: false })
    }
  },

  createSession: async (participantIds, title, souls) => {
    const res = await apiPost<{ session: Session }>('/api/sessions', {
      participantIds,
      title,
      // M16：创建时可选指定灵魂覆盖（校验归属在服务端）
      ...(souls && Object.keys(souls).length > 0 ? { souls } : {}),
    })
    await get().loadSessions()
    return res.session
  },

  /**
   * M16：应用服务端会话补丁（members API / notify:members-changed 共用）。
   * M46-2：缺省语义字段显式覆盖——服务端以「键缺失」表示关闭 / 无覆盖（serial / planFirst /
   * memberSouls），浅合并会残留旧值（真实缺陷：串行芯片关闭后仍显示「已开」；保留 summary 字段不整替）。
   */
  applySession: (session: Session) =>
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === session.id
          ? { ...x, ...session, planFirst: session.planFirst, serial: session.serial, memberSouls: session.memberSouls }
          : x,
      ),
    })),

  addMembers: async (sessionId, agentIds, souls) => {
    const res = await apiPost<{ session: Session; message: ChatMessage }>(`/api/sessions/${sessionId}/members`, {
      agentIds,
      ...(souls && Object.keys(souls).length > 0 ? { souls } : {}),
    })
    get().applySession(res.session)
    get().upsertMessage(res.message)
    return res.session
  },

  removeMember: async (sessionId, agentId) => {
    const res = await apiDelete<{ session: Session; message: ChatMessage }>(
      `/api/sessions/${sessionId}/members/${agentId}`,
    )
    get().applySession(res.session)
    get().upsertMessage(res.message)
    return res.session
  },

  setMemberSoul: async (sessionId, agentId, soul) => {
    const res = await apiPatch<{ session: Session; message: ChatMessage }>(
      `/api/sessions/${sessionId}/members/${agentId}`,
      { soul },
    )
    get().applySession(res.session)
    get().upsertMessage(res.message)
    return res.session
  },

  selectSession: async (id) => {
    // M55：切换会话后旧缓冲失去意义（消息将整体重拉），随视图一并清空
    rawStreams.clear()
    set({ currentId: id, byId: new Map(), order: [], latestRun: null, humanNames: {} })
    if (!id) return
    set({ loadingMessages: true })
    try {
      const res = await apiGet<SessionDetailResponse>(`/api/sessions/${id}`)
      if (get().currentId !== id) return // 切换竞态守卫
      set({ ...toStores(res.messages), latestRun: res.latestRun ?? null, humanNames: res.humanNames ?? {} })
    } finally {
      if (get().currentId === id) set({ loadingMessages: false })
    }
  },

  refreshMessages: async () => {
    const id = get().currentId
    if (!id) return
    const res = await apiGet<SessionDetailResponse>(`/api/sessions/${id}`)
    if (get().currentId !== id) return
    set({ ...toStores(res.messages), latestRun: res.latestRun ?? null, humanNames: res.humanNames ?? {} })
  },

  renameSession: async (id, title) => {
    const res = await apiPatch<{ session: Session }>(`/api/sessions/${id}`, { title })
    set((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? { ...x, ...res.session } : x)) }))
  },

  removeSession: async (id) => {
    await apiDelete(`/api/sessions/${id}`)
    set((s) => ({
      sessions: s.sessions.filter((x) => x.id !== id),
      ...(s.currentId === id ? { currentId: undefined, byId: new Map(), order: [] } : {}),
    }))
  },

  upsertMessage: (message) =>
    set((s) => {
      if (message.sessionId !== s.currentId) return s // 跨会话流式事件守卫
      const clean = withCleanContent(message)
      // M55：生成开始（turn:start 复用消息 id，如续写 / 重生成）时重置流式原始缓冲
      if (clean.role === 'agent' && clean.status === 'streaming') rawStreams.set(clean.id, clean.content)
      const existing = s.byId.get(message.id)
      const byId = new Map(s.byId)
      byId.set(clean.id, existing ? { ...existing, ...clean } : clean)
      if (existing) return { byId }
      return { byId, order: [...s.order, message.id] }
    }),

  patchMessage: (id, patch) =>
    set((s) => {
      const existing = s.byId.get(id)
      if (!existing) return s
      // M55：回合收尾（置为非 streaming）后释放该消息的流式原始缓冲
      if (patch.status && patch.status !== 'streaming') rawStreams.delete(id)
      const byId = new Map(s.byId)
      byId.set(id, { ...existing, ...patch })
      return { byId }
    }),

  appendDelta: (id, delta) =>
    set((s) => {
      const existing = s.byId.get(id)
      if (!existing) return s
      const byId = new Map(s.byId)
      if (existing.role !== 'agent') {
        byId.set(id, { ...existing, content: existing.content + delta })
        return { byId }
      }
      // M55：对原始累积全文求净化（幂等；已净化文本不可作为缓冲续接——块锚点会丢失）
      const raw = (rawStreams.get(id) ?? existing.content) + delta
      rawStreams.set(id, raw)
      byId.set(id, { ...existing, content: sanitizeModelText(raw) })
      return { byId }
    }),

  appendReasoning: (id, delta) =>
    set((s) => {
      const existing = s.byId.get(id)
      if (!existing) return s
      const byId = new Map(s.byId)
      byId.set(id, { ...existing, reasoning: (existing.reasoning ?? '') + delta })
      return { byId }
    }),

  removeMessage: (id) =>
    set((s) => {
      if (!s.byId.has(id)) return s
      const byId = new Map(s.byId)
      byId.delete(id)
      return { byId, order: s.order.filter((x) => x !== id) }
    }),

  bumpArtifacts: () => set((s) => ({ artifactVersion: s.artifactVersion + 1 })),

  setLatestRun: (run) => set({ latestRun: run }),
}))

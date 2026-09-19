/**
 * 连接中心（M22）：连接清单 / 会话绑定 / 操作事件流。
 *
 * 数据源：
 * - `GET /api/connections`（清单，secret 只回 secretSet 标记）；
 * - `GET /api/sessions/:id/connections`（当前会话的绑定，最小权限面）；
 * - 实时 `notify:op`（ws-store 转发，浏览器/数据库动作的即时可视化）；
 * - 历史 `/api/audit`（刷新/重连后的操作回放，与实时事件按 id 去重）。
 *
 * 约定：ops 新事件在前，滚动上限 200 条；绑定状态按会话隔离（切换竞态守卫）。
 */
import { create } from 'zustand'
import type {
  ConnectionDefinition,
  ConnectionInput,
  ConnectionTestResult,
  OpEvent,
  OpKind,
  SessionConnectionInfo,
} from '@multi-agent/shared'
import { apiDelete, apiGet, apiPost, apiPut } from '../lib/api'

interface AuditRow {
  id: number
  ts: string
  actor: string
  action: string
  resourceType?: string
  resourceId?: string
  sessionId?: string
  runId?: string
  ok: boolean
  detail?: Record<string, unknown>
  error?: string
}

interface ConnectionsState {
  connections: ConnectionDefinition[]
  sessionId?: string
  bindings: SessionConnectionInfo[]
  ops: OpEvent[]
  loading: boolean
  /** 正在测试 / 保存 / 绑定 的连接 id（按钮 loading 态） */
  busyId?: string
  load: () => Promise<void>
  /** 面板进入会话：连接清单 + 绑定 + 操作回放（三路并发，互不阻塞） */
  loadForSession: (sessionId: string) => Promise<void>
  create: (input: ConnectionInput) => Promise<ConnectionDefinition>
  update: (id: string, input: Partial<ConnectionInput>) => Promise<ConnectionDefinition>
  remove: (id: string) => Promise<void>
  test: (id: string) => Promise<ConnectionTestResult>
  bind: (connectionId: string) => Promise<void>
  unbind: (connectionId: string) => Promise<void>
  /** 实时操作事件入口（ws-store / SSE 转发；按 id 去重） */
  pushOp: (op: OpEvent) => void
  /** M36：外部入口（画布生成面板等）的「直达编辑」请求；连接管理视图消费 */
  pendingEditId?: string
  requestEdit: (id: string) => void
  consumePendingEdit: () => string | undefined
  reset: () => void
}

const OP_CAP = 200

function kindOfAction(action: string): OpKind {
  if (action.startsWith('browser')) return action.includes('takeover') ? 'takeover' : 'browser'
  if (action.startsWith('db')) return 'db'
  if (action.startsWith('ssh')) return 'ssh'
  return 'connection'
}

/** 审计行 → 操作事件（详情压平成一行摘要，供时间轴直接展示） */
function auditToOp(row: AuditRow): OpEvent {
  const detail = row.detail ?? {}
  const pick = (key: string): string | undefined => {
    const value = detail[key]
    return typeof value === 'string' ? value : undefined
  }
  const summary =
    pick('summary') ??
    pick('action') ??
    pick('name') ??
    pick('url') ??
    (typeof detail.sql === 'string' ? detail.sql.split('\n')[0]?.slice(0, 120) : undefined)
  return {
    id: `audit:${row.id}`,
    ts: row.ts,
    sessionId: row.sessionId ?? '',
    runId: row.runId,
    actor: row.actor,
    kind: kindOfAction(row.action),
    action: row.action,
    target: row.resourceType ? `${row.resourceType}${row.resourceId ? `:${row.resourceId}` : ''}` : undefined,
    status: row.ok ? 'ok' : 'error',
    summary: summary ?? row.error,
    detail: row.error,
  }
}

export const useConnectionsStore = create<ConnectionsState>((set, get) => ({
  connections: [],
  bindings: [],
  ops: [],
  loading: false,

  load: async () => {
    set({ loading: true })
    try {
      const res = await apiGet<{ connections: ConnectionDefinition[] }>('/api/connections')
      set({ connections: res.connections })
    } catch {
      // 服务不可达时保留旧清单（面板展示降级）
    } finally {
      set({ loading: false })
    }
  },

  loadForSession: async (sessionId) => {
    set({ sessionId, loading: true })
    const guard = (): boolean => get().sessionId === sessionId
    const [list, binds, audit] = await Promise.allSettled([
      apiGet<{ connections: ConnectionDefinition[] }>('/api/connections'),
      apiGet<{ bindings: SessionConnectionInfo[] }>(`/api/sessions/${sessionId}/connections`),
      apiGet<{ entries: AuditRow[] }>(`/api/audit?sessionId=${encodeURIComponent(sessionId)}&limit=120`),
    ])
    if (!guard()) return
    const patch: Partial<ConnectionsState> = { loading: false }
    if (list.status === 'fulfilled') patch.connections = list.value.connections
    if (binds.status === 'fulfilled') patch.bindings = binds.value.bindings
    if (audit.status === 'fulfilled') {
      const historical = audit.value.entries
        .filter(
          (row) =>
            row.action.startsWith('connection.') ||
            row.action.startsWith('db.') ||
            row.action.startsWith('ssh.') ||
            row.action.startsWith('browser.'),
        )
        .map(auditToOp)
      // 历史（旧→新）与实时（新→旧）合并：以 ts 降序，同 id 去重
      const live = get().ops.filter((op) => !op.id.startsWith('audit:'))
      const merged = [...live, ...historical].sort((a, b) => (a.ts < b.ts ? 1 : -1))
      patch.ops = merged.slice(0, OP_CAP)
    }
    set(patch)
  },

  create: async (input) => {
    const res = await apiPost<{ connection: ConnectionDefinition }>('/api/connections', input)
    set((s) => ({
      connections: [...s.connections.filter((c) => c.id !== res.connection.id), res.connection].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    }))
    return res.connection
  },

  update: async (id, input) => {
    set({ busyId: id })
    try {
      const res = await apiPut<{ connection: ConnectionDefinition }>(`/api/connections/${id}`, input)
      set((s) => ({ connections: s.connections.map((c) => (c.id === id ? res.connection : c)) }))
      return res.connection
    } finally {
      set({ busyId: undefined })
    }
  },

  remove: async (id) => {
    set({ busyId: id })
    try {
      await apiDelete(`/api/connections/${id}`)
      set((s) => ({
        connections: s.connections.filter((c) => c.id !== id),
        bindings: s.bindings.filter((b) => b.connection.id !== id),
      }))
    } finally {
      set({ busyId: undefined })
    }
  },

  test: async (id) => {
    set({ busyId: id })
    try {
      const res = await apiPost<{ result: ConnectionTestResult; connection?: ConnectionDefinition }>(
        `/api/connections/${id}/test`,
      )
      if (res.connection) {
        set((s) => ({ connections: s.connections.map((c) => (c.id === id ? res.connection! : c)) }))
      }
      return res.result
    } finally {
      set({ busyId: undefined })
    }
  },

  bind: async (connectionId) => {
    const sessionId = get().sessionId
    if (!sessionId) throw new Error('请先选择会话')
    set({ busyId: connectionId })
    try {
      const res = await apiPost<{ bindings: SessionConnectionInfo[] }>(`/api/sessions/${sessionId}/connections`, {
        connectionId,
      })
      set({ bindings: res.bindings })
    } finally {
      set({ busyId: undefined })
    }
  },

  unbind: async (connectionId) => {
    const sessionId = get().sessionId
    if (!sessionId) throw new Error('请先选择会话')
    set({ busyId: connectionId })
    try {
      const res = await apiDelete<{ bindings: SessionConnectionInfo[] }>(
        `/api/sessions/${sessionId}/connections/${connectionId}`,
      )
      set({ bindings: res.bindings })
    } finally {
      set({ busyId: undefined })
    }
  },

  pushOp: (op) =>
    set((s) => {
      if (s.ops.some((x) => x.id === op.id)) return {}
      return { ops: [op, ...s.ops].slice(0, OP_CAP) }
    }),

  requestEdit: (id) => set({ pendingEditId: id }),

  consumePendingEdit: () => {
    const id = get().pendingEditId
    if (id) set({ pendingEditId: undefined })
    return id
  },

  reset: () => set({ sessionId: undefined, bindings: [], ops: [], busyId: undefined, pendingEditId: undefined }),
}))

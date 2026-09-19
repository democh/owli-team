/**
 * MCP 管理（M27 / M28）：服务器清单 / 工具目录（含授权矩阵）/ 当前会话绑定 / mcp.json 直配状态。
 *
 * 数据源：
 * - `GET /api/mcp/servers`（清单，secret 明文永不回传）；
 * - `GET /api/mcp/tools`（工具目录 + 角色可达性矩阵：零可达服务器的警示徽章数据源）；
 * - `GET /api/sessions/:id/mcp-servers`（当前会话绑定，最小权限面）；
 * - `GET /api/mcp/json-config`（M28：mcp.json 文件权威状态：路径 / 同步时间 / 错误 / 条目名）；
 * - 实时 `notify:mcp-changed`（ws-store 转发 → refreshAll，多标签同步）。
 *
 * 约定：绑定状态按会话隔离（切换竞态守卫）；busyId 标记正在测试 / 重连 / 刷新的服务器。
 */
import { create } from 'zustand'
import { useAuthStore } from './auth-store'
import type {
  McpJsonImportOutcome,
  McpJsonStatus,
  McpJsonSyncResult,
  McpServerDefinition,
  McpServerInput,
  McpServerTestResult,
  McpToolDirectoryEntry,
  SessionMcpBinding,
} from '@multi-agent/shared'
import { apiDelete, apiGet, apiPost, apiPut } from '../lib/api'

interface McpState {
  servers: McpServerDefinition[]
  /** 工具目录（跨全部服务器；授权矩阵用于「零角色可达」警示） */
  tools: McpToolDirectoryEntry[]
  sessionId?: string
  bindings: SessionMcpBinding[]
  loading: boolean
  /** 正在操作（测试 / 重连 / 刷新 / 启停）的服务器 id（按钮 loading 态） */
  busyId?: string
  /** M28：mcp.json 直配状态（未装配 / 加载失败时缺省，卡片隐藏） */
  jsonConfig?: McpJsonStatus
  /** M28：JSON 同步 / 导入进行中（按钮 loading 态） */
  jsonSyncing: boolean
  /** 全量刷新（进入视图 / notify:mcp-changed 触发；已绑定会话时联动绑定面） */
  refreshAll: () => Promise<void>
  /** 面板进入 / 切回会话：服务器 + 工具目录 + 绑定（三路并发，互不阻塞） */
  loadForSession: (sessionId: string) => Promise<void>
  create: (input: McpServerInput) => Promise<McpServerDefinition>
  update: (id: string, input: McpServerInput) => Promise<McpServerDefinition>
  remove: (id: string) => Promise<void>
  test: (id: string) => Promise<McpServerTestResult>
  reconnect: (id: string) => Promise<void>
  refreshTools: (id: string) => Promise<void>
  /** M28：手动同步 mcp.json（文件权威；解析失败 = 跳过，绝不删库） */
  syncJsonConfig: () => Promise<McpJsonSyncResult>
  /** M28：粘贴导入 JSON（创建为 ui 源；同名冲突跳过并报告） */
  importJson: (json: string) => Promise<McpJsonImportOutcome>
  bind: (serverId: string) => Promise<void>
  unbind: (serverId: string) => Promise<void>
  reset: () => void
}

export const useMcpStore = create<McpState>((set, get) => ({
  servers: [],
  tools: [],
  bindings: [],
  loading: false,
  jsonSyncing: false,

  refreshAll: async () => {
    set({ loading: true })
    try {
      const sessionId = get().sessionId
      const [list, directory, binds, json] = await Promise.allSettled([
        apiGet<{ servers: McpServerDefinition[] }>('/api/mcp/servers'),
        apiGet<{ tools: McpToolDirectoryEntry[] }>('/api/mcp/tools'),
        sessionId
          ? apiGet<{ bindings: SessionMcpBinding[] }>(`/api/sessions/${sessionId}/mcp-servers`)
          : Promise.resolve(undefined),
        apiGet<{ config: McpJsonStatus }>('/api/mcp/json-config'),
      ])
      // 会话可能在等待期间被切换：绑定面按 current 再校验（切换竞态守卫）
      const current = get().sessionId
      const patch: Partial<McpState> = { loading: false }
      // 契约防御：响应缺数组字段时不把 undefined 写入状态（否则渲染侧 .map / .filter 崩溃）
      if (list.status === 'fulfilled') patch.servers = list.value.servers ?? []
      if (directory.status === 'fulfilled') patch.tools = directory.value.tools ?? []
      if (binds.status === 'fulfilled' && binds.value && current === sessionId) patch.bindings = binds.value.bindings ?? []
      // json-config 未装配（503）时保持原值：卡片隐藏 / 不闪断
      if (json.status === 'fulfilled') patch.jsonConfig = json.value.config
      set(patch)
    } catch {
      set({ loading: false })
    }
  },

  loadForSession: async (sessionId) => {
    set({ sessionId, loading: true })
    const guard = (): boolean => get().sessionId === sessionId
    // M57 P3：members 不访问管理面（工具目录 / json 配置为 adminOnly）——避免 403 噪声
    const authState = useAuthStore.getState()
    const isAdmin = !authState.status.multiUser || authState.user?.role === 'admin'
    const tasks: Array<Promise<unknown>> = [
      apiGet<{ servers: McpServerDefinition[] }>('/api/mcp/servers'),
      apiGet<{ bindings: SessionMcpBinding[] }>(`/api/sessions/${sessionId}/mcp-servers`),
    ]
    if (isAdmin) {
      tasks.push(apiGet<{ tools: McpToolDirectoryEntry[] }>('/api/mcp/tools'))
      tasks.push(apiGet<{ config: McpJsonStatus }>('/api/mcp/json-config'))
    }
    const [list, binds, toolsRes, jsonRes] = await Promise.allSettled(tasks)
    if (!guard()) return
    const patch: Partial<McpState> = { loading: false }
    // 契约防御：响应缺数组字段时不把 undefined 写入状态（否则渲染侧 .map / .filter 崩溃）
    if (list.status === 'fulfilled') patch.servers = (list.value as { servers: McpServerDefinition[] }).servers ?? []
    if (binds.status === 'fulfilled') patch.bindings = (binds.value as { bindings: SessionMcpBinding[] }).bindings ?? []
    if (toolsRes?.status === 'fulfilled') patch.tools = (toolsRes.value as { tools: McpToolDirectoryEntry[] }).tools ?? []
    if (jsonRes?.status === 'fulfilled') patch.jsonConfig = (jsonRes.value as { config: McpJsonStatus }).config
    set(patch)
  },

  create: async (input) => {
    const res = await apiPost<{ server: McpServerDefinition }>('/api/mcp/servers', input)
    set((s) => ({
      servers: [...s.servers.filter((x) => x.id !== res.server.id), res.server].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    }))
    return res.server
  },

  update: async (id, input) => {
    set({ busyId: id })
    try {
      const res = await apiPut<{ server: McpServerDefinition }>(`/api/mcp/servers/${id}`, input)
      set((s) => ({ servers: s.servers.map((x) => (x.id === id ? res.server : x)) }))
      return res.server
    } finally {
      set({ busyId: undefined })
    }
  },

  remove: async (id) => {
    set({ busyId: id })
    try {
      await apiDelete(`/api/mcp/servers/${id}`)
      set((s) => ({
        servers: s.servers.filter((x) => x.id !== id),
        bindings: s.bindings.filter((b) => b.server.id !== id),
      }))
    } finally {
      set({ busyId: undefined })
    }
  },

  test: async (id) => {
    set({ busyId: id })
    try {
      const res = await apiPost<{ result: McpServerTestResult; server?: McpServerDefinition }>(
        `/api/mcp/servers/${id}/test`,
      )
      if (res.server) {
        set((s) => ({ servers: s.servers.map((x) => (x.id === id ? res.server! : x)) }))
      }
      return res.result
    } finally {
      set({ busyId: undefined })
    }
  },

  reconnect: async (id) => {
    set({ busyId: id })
    try {
      const res = await apiPost<{ server?: McpServerDefinition }>(`/api/mcp/servers/${id}/reconnect`)
      if (res.server) {
        set((s) => ({ servers: s.servers.map((x) => (x.id === id ? res.server! : x)) }))
      }
    } finally {
      set({ busyId: undefined })
    }
  },

  refreshTools: async (id) => {
    set({ busyId: id })
    try {
      const res = await apiPost<{ server?: McpServerDefinition }>(`/api/mcp/servers/${id}/refresh`)
      if (res.server) {
        set((s) => ({ servers: s.servers.map((x) => (x.id === id ? res.server! : x)) }))
      }
    } finally {
      set({ busyId: undefined })
    }
  },

  syncJsonConfig: async () => {
    set({ jsonSyncing: true })
    try {
      const res = await apiPost<{ result: McpJsonSyncResult; status: McpJsonStatus; servers: McpServerDefinition[] }>(
        '/api/mcp/json-config/sync',
      )
      set({ servers: res.servers ?? [], jsonConfig: res.status })
      return res.result
    } finally {
      set({ jsonSyncing: false })
    }
  },

  importJson: async (json) => {
    set({ jsonSyncing: true })
    try {
      const res = await apiPost<{ outcome: McpJsonImportOutcome; servers: McpServerDefinition[] }>(
        '/api/mcp/json-config/import',
        { json },
      )
      set({ servers: res.servers ?? [] })
      return res.outcome
    } finally {
      set({ jsonSyncing: false })
    }
  },

  bind: async (serverId) => {
    const sessionId = get().sessionId
    if (!sessionId) throw new Error('请先选择会话')
    set({ busyId: serverId })
    try {
      const res = await apiPost<{ bindings: SessionMcpBinding[] }>(`/api/sessions/${sessionId}/mcp-servers`, {
        serverId,
      })
      set({ bindings: res.bindings ?? [] })
    } finally {
      set({ busyId: undefined })
    }
  },

  unbind: async (serverId) => {
    const sessionId = get().sessionId
    if (!sessionId) throw new Error('请先选择会话')
    set({ busyId: serverId })
    try {
      const res = await apiDelete<{ bindings: SessionMcpBinding[] }>(
        `/api/sessions/${sessionId}/mcp-servers/${serverId}`,
      )
      set({ bindings: res.bindings ?? [] })
    } finally {
      set({ busyId: undefined })
    }
  },

  reset: () => set({ sessionId: undefined, bindings: [], busyId: undefined }),
}))

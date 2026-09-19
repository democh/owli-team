/**
 * 数据库工作台（M23，Navicat 式交互）：对象树 / 表数据分页 / SQL 编辑器 的状态中枢。
 *
 * 数据源：
 * - GET /api/connections（连接清单：工作台只关心 postgres / mysql / sqlite）；
 * - GET /api/connections/:id/schema（对象树：表 + 列快照）；
 * - GET /api/connections/:id/tables/:table/rows（分页浏览：limit+1 探测 hasMore，排序白名单在服务端）；
 * - POST /api/connections/:id/sql（统一 SQL 入口：服务端护栏判定 mode=query/execute）。
 *
 * 交互约定（对齐 Navicat 习惯）：
 * - 左侧对象树双击表 → 右区开「数据」tab；重复打开已存在的 tab 直接激活；
 * - 列头点击排序循环：同列 ASC → DESC → 取消，跨列直接 ASC（回第 1 页）；
 * - SQL 写语句两步流：先 dryRun 分类 → 写语句弹确认框 → 确认后真正执行（只读语句单次往返后直接执行）；
 * - 运行历史（⌘/Ctrl+Enter 记录，上限 30 条，最新在前）。
 */
import { create } from 'zustand'
import type {
  ConnectionDefinition,
  DbPanelColumn,
  DbPanelTable,
  DbSchemaResponse,
  DbSqlClassifyResponse,
  DbSqlResponse,
  DbTableRowsResponse,
} from '@multi-agent/shared'
import { apiGet, apiPost } from '../lib/api'

/** 工作台可用的数据库连接类型（浏览器 / SSH 不在此面板） */
export const DB_KINDS = ['postgres', 'mysql', 'sqlite'] as const

export const PAGE_SIZES = [50, 100, 200, 500] as const

export interface DbTableTab {
  id: string
  kind: 'table'
  connectionId: string
  table: string
  schema?: string
  columns: string[]
  rows: Array<Record<string, unknown>>
  offset: number
  limit: number
  hasMore: boolean
  orderBy?: string
  desc: boolean
  loading: boolean
  error?: string
  durationMs?: number
  /** 列类型 / 可空信息（对象树快照，仅展示用） */
  columnsMeta?: DbPanelColumn[]
}

export interface DbQueryRun {
  mode: 'query' | 'execute'
  columns: string[]
  rows: Array<Record<string, unknown>>
  rowCount: number
  truncated?: boolean
  durationMs: number
  affectedRows?: number
  /** 运行时的 SQL 快照（结果区标题展示用） */
  sql: string
  ts: number
}

export interface DbQueryTab {
  connectionId: string
  sql: string
  running: boolean
  result?: DbQueryRun
  error?: string
  history: string[]
}

interface SchemaEntry {
  loading: boolean
  error?: string
  tables: DbPanelTable[]
  truncated: boolean
  loadedAt?: number
}

interface DatabaseState {
  connections: ConnectionDefinition[]
  loadingConnections: boolean
  /** 当前选中的连接（对象树根） */
  selectedId?: string
  /** 对象树缓存（按连接；切回连接不重拉） */
  schemas: Record<string, SchemaEntry>
  /** 对象树过滤词 */
  filter: string
  /** 表数据 tabs（一个连接可开多张表） */
  tabs: DbTableTab[]
  activeTabId?: string
  /** SQL 查询页（按连接隔离：切连接保留各自 SQL 文本与结果） */
  queries: Record<string, DbQueryTab>

  load: () => Promise<void>
  select: (connectionId?: string) => void
  setFilter: (text: string) => void
  reloadSchema: (connectionId?: string) => Promise<void>
  openTable: (connectionId: string, table: string, schema?: string) => Promise<void>
  closeTab: (id: string) => void
  setActiveTab: (id: string) => void
  loadRows: (
    id: string,
    opts?: { offset?: number; limit?: number; orderBy?: string; desc?: boolean; clearSort?: boolean },
  ) => Promise<void>
  setSort: (id: string, column: string) => Promise<void>
  setPageSize: (id: string, limit: number) => Promise<void>
  setSql: (connectionId: string, sql: string) => void
  /** 运行 SQL：默认两步流（分类 → 写确认）；confirmed=true 时单步直发 */
  runSql: (connectionId: string, opts?: { confirmed?: boolean }) => Promise<{ mode?: 'query' | 'execute'; needsConfirm: boolean }>
}

export function tableTabId(connectionId: string, schema: string | undefined, table: string): string {
  return `t:${connectionId}:${schema ?? ''}.${table}`
}

const QUERY_HISTORY_CAP = 30

function emptyQuery(connectionId: string): DbQueryTab {
  return { connectionId, sql: '', running: false, history: [] }
}

function rowsUrl(tab: Pick<DbTableTab, 'connectionId' | 'table' | 'schema'>, q: { offset: number; limit: number; orderBy?: string; desc: boolean }): string {
  const params = new URLSearchParams({ offset: String(q.offset), limit: String(q.limit) })
  if (q.orderBy) {
    params.set('orderBy', q.orderBy)
    params.set('desc', q.desc ? 'true' : 'false')
  }
  if (tab.schema) params.set('schema', tab.schema)
  return `/api/connections/${tab.connectionId}/tables/${encodeURIComponent(tab.table)}/rows?${params.toString()}`
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export const useDatabaseStore = create<DatabaseState>((set, get) => ({
  connections: [],
  loadingConnections: false,
  schemas: {},
  filter: '',
  tabs: [],
  queries: {},

  load: async () => {
    set({ loadingConnections: true })
    try {
      const res = await apiGet<{ connections: ConnectionDefinition[] }>('/api/connections')
      const connections = res.connections.filter((c) => (DB_KINDS as readonly string[]).includes(c.kind))
      set({ connections })
      // 已选连接被删除：回落到第一个可用连接
      const current = get().selectedId
      if (current && !connections.some((c) => c.id === current)) {
        set({ selectedId: undefined, activeTabId: undefined, tabs: [] })
      }
      const fallback = get().selectedId ?? connections[0]?.id
      if (fallback) get().select(fallback)
    } catch {
      // 服务不可达：保留旧清单（面板降级展示）
    } finally {
      set({ loadingConnections: false })
    }
  },

  select: (connectionId) => {
    set({ selectedId: connectionId })
    if (!connectionId) return
    const entry = get().schemas[connectionId]
    if (!entry || (!entry.loadedAt && !entry.loading)) void get().reloadSchema(connectionId)
  },

  setFilter: (text) => set({ filter: text }),

  reloadSchema: async (connectionId) => {
    const id = connectionId ?? get().selectedId
    if (!id) return
    set((s) => ({
      schemas: { ...s.schemas, [id]: { ...(s.schemas[id] ?? { tables: [], truncated: false }), loading: true, error: undefined } },
    }))
    try {
      const res = await apiGet<DbSchemaResponse>(`/api/connections/${id}/schema`)
      const tables = [...res.tables].sort((a, b) => (a.schema ?? '').localeCompare(b.schema ?? '') || a.name.localeCompare(b.name))
      set((s) => ({ schemas: { ...s.schemas, [id]: { loading: false, tables, truncated: res.truncated, loadedAt: Date.now() } } }))
    } catch (err) {
      set((s) => ({
        schemas: { ...s.schemas, [id]: { ...(s.schemas[id] ?? { tables: [], truncated: false }), loading: false, error: errorMessage(err) } },
      }))
    }
  },

  openTable: async (connectionId, table, schema) => {
    const id = tableTabId(connectionId, schema, table)
    const existing = get().tabs.find((t) => t.id === id)
    if (existing) {
      set({ activeTabId: id })
      return
    }
    const meta = get().schemas[connectionId]?.tables.find((t) => t.name === table && (schema ? t.schema === schema : true))
    const tab: DbTableTab = {
      id,
      kind: 'table',
      connectionId,
      table,
      schema,
      columns: [],
      rows: [],
      offset: 0,
      limit: 100,
      hasMore: false,
      desc: false,
      loading: true,
      columnsMeta: meta?.columns,
    }
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: id }))
    await get().loadRows(id, { offset: 0, limit: tab.limit })
  },

  closeTab: (id) =>
    set((s) => {
      const index = s.tabs.findIndex((t) => t.id === id)
      const tabs = s.tabs.filter((t) => t.id !== id)
      let activeTabId = s.activeTabId
      if (activeTabId === id) {
        const next = tabs[index] ?? tabs[index - 1] ?? tabs[0]
        activeTabId = next?.id
      }
      return { tabs, activeTabId }
    }),

  setActiveTab: (id) => set({ activeTabId: id }),

  loadRows: async (id, opts) => {
    const tab = get().tabs.find((t) => t.id === id)
    if (!tab) return
    const next = {
      offset: opts?.offset ?? tab.offset,
      limit: opts?.limit ?? tab.limit,
      // clearSort：显式清除（undefined 表示「不改动」，与三态循环的终止态区分）
      orderBy: opts?.clearSort ? undefined : opts?.orderBy !== undefined ? opts.orderBy : tab.orderBy,
      desc: opts?.clearSort ? false : opts?.desc ?? tab.desc,
    }
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...next, loading: true, error: undefined } : t)),
    }))
    try {
      const res = await apiGet<DbTableRowsResponse>(rowsUrl(tab, next))
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === id
            ? {
                ...t,
                columns: res.columns,
                rows: res.rows,
                offset: res.offset,
                limit: res.limit,
                hasMore: res.hasMore,
                durationMs: res.durationMs,
                loading: false,
              }
            : t,
        ),
      }))
    } catch (err) {
      set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, loading: false, error: errorMessage(err) } : t)) }))
    }
  },

  /** 列头点击：同列 ASC → DESC → 取消排序（均回第 1 页） */
  setSort: async (id, column) => {
    const tab = get().tabs.find((t) => t.id === id)
    if (!tab) return
    if (tab.orderBy === column && tab.desc) {
      // 第三态：取消排序（clearSort 显式清除，与「不改动」区分）
      await get().loadRows(id, { offset: 0, clearSort: true })
      return
    }
    await get().loadRows(id, { offset: 0, orderBy: column, desc: tab.orderBy === column })
  },

  setPageSize: async (id, limit) => {
    await get().loadRows(id, { offset: 0, limit })
  },

  setSql: (connectionId, sql) =>
    set((s) => ({
      queries: { ...s.queries, [connectionId]: { ...(s.queries[connectionId] ?? emptyQuery(connectionId)), sql } },
    })),

  runSql: async (connectionId, opts) => {
    const query = get().queries[connectionId] ?? emptyQuery(connectionId)
    const sql = query.sql.trim()
    if (!sql) {
      set((s) => ({ queries: { ...s.queries, [connectionId]: { ...query, error: '请输入 SQL 语句' } } }))
      return { needsConfirm: false }
    }
    const patch = (next: Partial<DbQueryTab>): void =>
      set((s) => ({ queries: { ...s.queries, [connectionId]: { ...(s.queries[connectionId] ?? query), ...next } } }))
    const remember = (): string[] => [sql, ...query.history.filter((h) => h !== sql)].slice(0, QUERY_HISTORY_CAP)
    patch({ running: true, error: undefined })
    try {
      // 两步流：先分类（dryRun）；写语句待用户确认后再发
      if (!opts?.confirmed) {
        const classified = await apiPost<DbSqlClassifyResponse>(`/api/connections/${connectionId}/sql`, { sql, dryRun: true })
        if (classified.mode === 'execute') {
          patch({ running: false })
          return { mode: 'execute', needsConfirm: true }
        }
      }
      const res = await apiPost<DbSqlResponse>(`/api/connections/${connectionId}/sql`, { sql })
      patch({
        running: false,
        sql,
        history: remember(),
        result: {
          mode: res.mode,
          columns: res.result.columns,
          rows: res.result.rows,
          rowCount: res.result.rowCount,
          truncated: res.result.truncated,
          durationMs: res.result.durationMs,
          affectedRows: res.result.affectedRows,
          sql,
          ts: Date.now(),
        },
      })
      return { mode: res.mode, needsConfirm: false }
    } catch (err) {
      patch({ running: false, error: errorMessage(err) })
      return { needsConfirm: false }
    }
  },
}))

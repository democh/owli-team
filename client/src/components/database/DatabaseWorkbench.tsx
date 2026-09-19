/**
 * 数据库工作台（M23，Navicat 式主区）：
 * 左侧对象树（连接 → 模式分组 → 表 → 列）+ 右侧数据 / 查询页签。
 *
 * 交互（对齐 Navicat / DataGrip 习惯）：
 * - 对象树：单击表选中、单击箭头展开列、双击表打开「数据」页签（重复打开直接激活）；
 * - 数据页签：列头点击三态排序（ASC → DESC → 取消），工具栏翻页 / 每页行数 / 刷新 / 清除排序；
 * - 查询页签（常驻，按连接隔离）：编辑器 + ⌘/Ctrl+Enter 运行；写语句弹确认框（dryRun 分类）；
 * - 空态引导：无连接 → 前往「连接管理」控制台；无页签 → 提示双击表或切到查询。
 */
import * as React from 'react'
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Database,
  Loader2,
  RefreshCw,
  Search,
  Table2,
  Terminal,
  X,
} from 'lucide-react'
import type { DbPanelTable } from '@multi-agent/shared'
import { PAGE_SIZES, useDatabaseStore, type DbTableTab } from '../../stores/database-store'
import { useUiStore } from '../../stores/ui-store'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { DataGrid } from './DataGrid'
import { SqlEditor } from './SqlEditor'
import { WriteConfirmDialog } from './WriteConfirmDialog'

/** 常驻「查询」页签（不属于表 tabs 列表） */
export const QUERY_TAB_ID = '__query__'

const KIND_LABEL: Record<string, string> = { postgres: 'PostgreSQL', mysql: 'MySQL', sqlite: 'SQLite' }

/** 表过滤：匹配表名或模式名（大小写不敏感） */
export function filterTables(tables: DbPanelTable[], filter: string): DbPanelTable[] {
  const keyword = filter.trim().toLowerCase()
  if (!keyword) return tables
  return tables.filter((t) => t.name.toLowerCase().includes(keyword) || (t.schema ?? '').toLowerCase().includes(keyword))
}

/** 按模式分组（空模式归入「(默认)」，与 Navicat 的库/模式分组一致） */
export function groupBySchema(tables: DbPanelTable[]): Array<{ schema: string; tables: DbPanelTable[] }> {
  const groups = new Map<string, DbPanelTable[]>()
  for (const table of tables) {
    const key = table.schema ?? ''
    const list = groups.get(key)
    if (list) list.push(table)
    else groups.set(key, [table])
  }
  return [...groups.entries()].map(([schema, list]) => ({ schema, tables: list }))
}

function rangeText(tab: DbTableTab): string {
  if (tab.rows.length === 0) return tab.loading ? '加载中…' : '0 行'
  const to = tab.offset + tab.rows.length
  return `第 ${tab.offset + 1}-${to} 行${tab.hasMore ? ' +' : ''}`
}

function tableKey(tab: DbTableTab): string {
  return `${tab.schema ?? ''}.${tab.table}`
}

/** 数据页签：工具栏 + 网格 */
function TableTabView({ tab }: { tab: DbTableTab }): React.JSX.Element {
  const loadRows = useDatabaseStore((s) => s.loadRows)
  const setPageSize = useDatabaseStore((s) => s.setPageSize)
  const setSort = useDatabaseStore((s) => s.setSort)
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="db-table-view">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b px-2 py-1.5">
        <span className="font-mono text-[11.5px] font-medium">{tableKey(tab)}</span>
        <span className="text-[10.5px] text-muted-foreground">{rangeText(tab)}</span>
        {tab.orderBy && (
          <button
            type="button"
            className="rounded-full border px-1.5 py-px text-[10px] text-muted-foreground hover:bg-accent"
            title="点击清除排序"
            onClick={() => void loadRows(tab.id, { offset: 0, clearSort: true })}
          >
            排序 {tab.orderBy} {tab.desc ? '↓' : '↑'} ×
          </button>
        )}
        <div className="ml-auto flex items-center gap-1">
          {tab.durationMs !== undefined && (
            <span className="tabular-nums text-[10px] text-muted-foreground">
              {tab.durationMs >= 1000 ? `${(tab.durationMs / 1000).toFixed(2)}s` : `${tab.durationMs}ms`}
            </span>
          )}
          <label className="flex items-center gap-1 text-[10.5px] text-muted-foreground">
            每页
            <select
              className="rounded-md border border-input bg-card px-1 py-0.5 text-[11px]"
              value={tab.limit}
              onChange={(e) => void setPageSize(tab.id, Number(e.target.value))}
            >
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
          <Button
            size="icon-sm"
            variant="ghost"
            title="上一页"
            disabled={tab.offset === 0 || tab.loading}
            onClick={() => void loadRows(tab.id, { offset: Math.max(0, tab.offset - tab.limit) })}
          >
            <ChevronLeft className="size-3.5" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            title="下一页"
            disabled={!tab.hasMore || tab.loading}
            onClick={() => void loadRows(tab.id, { offset: tab.offset + tab.limit })}
          >
            <ChevronRight className="size-3.5" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            title="刷新（回到当前页）"
            disabled={tab.loading}
            onClick={() => void loadRows(tab.id, { offset: tab.offset })}
          >
            <RefreshCw className={cn('size-3.5', tab.loading && 'animate-spin')} />
          </Button>
        </div>
      </div>
      <DataGrid
        columns={tab.columns}
        rows={tab.rows}
        columnsMeta={tab.columnsMeta}
        orderBy={tab.orderBy}
        desc={tab.desc}
        onSort={(column) => void setSort(tab.id, column)}
        loading={tab.loading}
        error={tab.error}
        emptyText="该表暂无数据"
        rowOffset={tab.offset}
      />
    </div>
  )
}

/** 查询页签（SqlEditor + 写确认） */
function QueryTabView({ connectionId }: { connectionId: string }): React.JSX.Element {
  const connection = useDatabaseStore((s) => s.connections.find((c) => c.id === connectionId))
  const query = useDatabaseStore((s) => s.queries[connectionId])
  const setSql = useDatabaseStore((s) => s.setSql)
  const runSql = useDatabaseStore((s) => s.runSql)
  const [confirm, setConfirm] = React.useState<{ sql: string } | undefined>()

  const handleRun = async (): Promise<void> => {
    const result = await runSql(connectionId)
    if (result.needsConfirm) {
      const sql = useDatabaseStore.getState().queries[connectionId]?.sql ?? ''
      setConfirm({ sql })
    }
  }
  const handleConfirm = async (): Promise<void> => {
    await runSql(connectionId, { confirmed: true })
    setConfirm(undefined)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="db-query-view">
      <SqlEditor
        value={query?.sql ?? ''}
        onChange={(value) => setSql(connectionId, value)}
        onRun={() => void handleRun()}
        running={query?.running ?? false}
        error={query?.error}
        result={query?.result}
        history={query?.history ?? []}
        writesAllowed={connection?.config.allowWrites === true}
      />
      <WriteConfirmDialog
        open={!!confirm}
        onOpenChange={(open) => (!open ? setConfirm(undefined) : undefined)}
        sql={confirm?.sql ?? ''}
        connectionName={connection?.name ?? ''}
        writesAllowed={connection?.config.allowWrites === true}
        running={query?.running ?? false}
        onConfirm={() => void handleConfirm()}
      />
    </div>
  )
}

/** 对象树面板 */
function ObjectTree({ connectionId }: { connectionId: string }): React.JSX.Element {
  const entry = useDatabaseStore((s) => s.schemas[connectionId])
  const filter = useDatabaseStore((s) => s.filter)
  const reloadSchema = useDatabaseStore((s) => s.reloadSchema)
  const openTable = useDatabaseStore((s) => s.openTable)
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set())
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set())
  const [selected, setSelected] = React.useState<string>()

  const groups = React.useMemo(() => groupBySchema(filterTables(entry?.tables ?? [], filter)), [entry?.tables, filter])
  const toggle = (setter: React.Dispatch<React.SetStateAction<Set<string>>>, key: string): void =>
    setter((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  if (entry?.loading && !entry.loadedAt) {
    return (
      <p className="flex items-center gap-1.5 px-3 py-6 text-[11.5px] text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        正在读取结构…
      </p>
    )
  }
  if (entry?.error) {
    return (
      <div className="px-3 py-4 text-[11.5px]">
        <p className="text-rose-600">{entry.error}</p>
        <Button size="xs" variant="outline" className="mt-2" onClick={() => void reloadSchema(connectionId)}>
          重试
        </Button>
      </div>
    )
  }
  if (!entry || entry.tables.length === 0) {
    return <p className="px-3 py-6 text-[11.5px] text-muted-foreground">未发现表</p>
  }
  if (groups.length === 0) {
    return <p className="px-3 py-6 text-[11.5px] text-muted-foreground">无匹配「{filter}」的表</p>
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto py-1">
      {groups.map((group) => {
        const groupKey = group.schema || '(默认)'
        const isCollapsed = collapsed.has(groupKey)
        return (
          <div key={groupKey}>
            <button
              type="button"
              className="flex w-full items-center gap-1 px-2 py-1 text-left text-[10.5px] font-medium text-muted-foreground hover:bg-accent/60"
              onClick={() => toggle(setCollapsed, groupKey)}
            >
              {isCollapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
              <span className="truncate">{group.schema || '(默认模式)'}</span>
              <span className="ml-auto tabular-nums">{group.tables.length}</span>
            </button>
            {!isCollapsed &&
              group.tables.map((table) => {
                const key = `${group.schema ?? ''}.${table.name}`
                const isOpen = expanded.has(key)
                const isSelected = selected === key
                return (
                  <div key={key}>
                    <div
                      className={cn(
                        'flex cursor-pointer items-center gap-1 rounded-sm py-0.5 pr-2 pl-1 text-[11.5px]',
                        isSelected ? 'bg-primary/10 text-foreground' : 'hover:bg-accent/50',
                      )}
                      title={`${key}（双击打开数据）`}
                      onClick={() => setSelected(key)}
                      onDoubleClick={() => void openTable(connectionId, table.name, table.schema)}
                    >
                      <button
                        type="button"
                        className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent"
                        title={isOpen ? '收起列' : '展开列'}
                        onClick={(e) => {
                          e.stopPropagation()
                          toggle(setExpanded, key)
                        }}
                      >
                        {isOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                      </button>
                      <Table2 className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{table.name}</span>
                      <span className="ml-auto shrink-0 text-[9.5px] text-muted-foreground/70">{table.columns.length} 列</span>
                    </div>
                    {isOpen && (
                      <ul className="mb-1 ml-6 border-l pl-2">
                        {table.columns.map((column) => (
                          <li key={column.name} className="flex items-baseline gap-1.5 py-0.5 text-[11px]">
                            <span className="truncate font-mono">{column.name}</span>
                            {column.type && <span className="shrink-0 text-[9.5px] text-muted-foreground">{column.type}</span>}
                            {column.nullable === false && (
                              <span className="shrink-0 text-[9.5px] text-amber-600" title="NOT NULL">
                                *
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )
              })}
          </div>
        )
      })}
      {entry.truncated && <p className="px-3 py-2 text-[10.5px] text-amber-600">仅显示部分表</p>}
    </div>
  )
}

export function DatabaseWorkbench(): React.JSX.Element {
  const connections = useDatabaseStore((s) => s.connections)
  const loadingConnections = useDatabaseStore((s) => s.loadingConnections)
  const selectedId = useDatabaseStore((s) => s.selectedId)
  const schemas = useDatabaseStore((s) => s.schemas)
  const filter = useDatabaseStore((s) => s.filter)
  const tabs = useDatabaseStore((s) => s.tabs)
  const activeTabId = useDatabaseStore((s) => s.activeTabId)
  const load = useDatabaseStore((s) => s.load)
  const select = useDatabaseStore((s) => s.select)
  const setFilter = useDatabaseStore((s) => s.setFilter)
  const reloadSchema = useDatabaseStore((s) => s.reloadSchema)
  const closeTab = useDatabaseStore((s) => s.closeTab)
  const setActiveTab = useDatabaseStore((s) => s.setActiveTab)
  const setAppView = useUiStore((s) => s.setAppView)

  React.useEffect(() => {
    void load()
  }, [load])

  const schemaEntry = selectedId ? schemas[selectedId] : undefined
  const effectiveTabId = activeTabId ?? QUERY_TAB_ID
  const activeTableTab = tabs.find((t) => t.id === effectiveTabId)

  if (connections.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center" data-testid="database-workbench">
        <Database className="size-8 text-muted-foreground/60" />
        <div>
          <p className="text-[13px] font-medium">{loadingConnections ? '正在加载连接…' : '尚未创建数据库连接'}</p>
        </div>
        {!loadingConnections && (
          <Button size="sm" variant="outline" onClick={() => setAppView('connections')}>
            前往「连接管理」创建
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0" data-testid="database-workbench">
      {/* 左侧：对象树 */}
      <aside className="flex w-60 shrink-0 flex-col border-r bg-muted/20" data-testid="db-object-tree">
        <div className="flex shrink-0 items-center gap-1 border-b p-1.5">
          <select
            className="h-7 min-w-0 flex-1 rounded-md border border-input bg-card px-1.5 text-[11.5px]"
            value={selectedId ?? ''}
            onChange={(e) => select(e.target.value || undefined)}
            title="切换连接"
          >
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}（{KIND_LABEL[c.kind] ?? c.kind}）
              </option>
            ))}
          </select>
          <Button
            size="icon-sm"
            variant="ghost"
            title="刷新结构"
            disabled={!selectedId || schemaEntry?.loading}
            onClick={() => void reloadSchema()}
          >
            <RefreshCw className={cn('size-3.5', schemaEntry?.loading && 'animate-spin')} />
          </Button>
        </div>
        <div className="relative shrink-0 border-b p-1.5">
          <Search className="pointer-events-none absolute top-1/2 left-3.5 size-3 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-7 pl-6 text-[11.5px]"
            placeholder="过滤表 / 模式"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        {selectedId ? (
          <ObjectTree connectionId={selectedId} />
        ) : (
          <p className="px-3 py-6 text-[11.5px] text-muted-foreground">请选择连接</p>
        )}
        <p className="shrink-0 border-t px-2 py-1 text-[10px] text-muted-foreground/80">双击表打开数据 · 单击箭头展开列</p>
      </aside>

      {/* 右侧：页签 + 内容 */}
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-stretch gap-px overflow-x-auto border-b bg-muted/30" data-testid="db-tabbar">
          <button
            type="button"
            className={cn(
              'flex shrink-0 items-center gap-1.5 px-3 py-1.5 text-[11.5px]',
              !activeTableTab ? 'border-b-2 border-primary bg-card font-medium' : 'text-muted-foreground hover:bg-accent/50',
            )}
            onClick={() => setActiveTab(QUERY_TAB_ID)}
          >
            <Terminal className="size-3.5" />
            查询
          </button>
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={cn(
                'group flex shrink-0 cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-[11.5px]',
                activeTableTab?.id === tab.id ? 'border-b-2 border-primary bg-card font-medium' : 'text-muted-foreground hover:bg-accent/50',
              )}
              onClick={() => setActiveTab(tab.id)}
            >
              <Table2 className="size-3.5" />
              <span className="max-w-[160px] truncate" title={tableKey(tab)}>
                {tab.schema ? `${tab.schema}.${tab.table}` : tab.table}
              </span>
              <button
                type="button"
                className="rounded p-0.5 opacity-40 hover:bg-accent hover:opacity-100"
                title="关闭"
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(tab.id)
                }}
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>

        {activeTableTab ? (
          <TableTabView tab={activeTableTab} />
        ) : selectedId ? (
          <QueryTabView connectionId={selectedId} />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-[11.5px] text-muted-foreground">
            <Table2 className="size-6 text-muted-foreground/50" />
            <p>请选择连接</p>
          </div>
        )}
      </section>
    </div>
  )
}

/**
 * M27：MCP 管理台（ActivityRail 第四入口，独立主区视图）。
 * - 服务器清单：状态灯（idle/ok/error）+ 传输 / 来源徽章 + 工具数 + 零可达警示；
 * - 操作：测试（含真实连接）/ 重连 / 刷新工具 / 启停 / 编辑 / 删除 / 绑定当前会话；
 * - 会话绑定：最小权限模型（未绑定的会话看不到 MCP 工具），对齐连接中心交互；
 * - 展开：McpToolList 工具清单 + 角色可达性矩阵（防「工具注册后零角色可达」）。
 * - M28：JSON 配置卡片（mcp.json 文件权威：状态 / 立即同步 / 粘贴导入；json 源服务器只读）。
 * 数据源 mcp-store（挂载 / 切会话时加载；notify:mcp-changed 多标签实时同步）。
 */
import * as React from 'react'
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  ClipboardPaste,
  FileJson,
  Link2,
  Loader2,
  Lock,
  Pencil,
  Play,
  Plug,
  Plus,
  RefreshCw,
  RotateCw,
  Trash2,
  Unlink,
} from 'lucide-react'
import { toast } from 'sonner'
import type { McpJsonImportOutcome, McpServerDefinition, McpServerStatus } from '@multi-agent/shared'
import { formatClock } from '../../lib/time'
import { cn } from '../../lib/utils'
import { useAgentStore } from '../../stores/agent-store'
import { useMcpStore } from '../../stores/mcp-store'
import { useSessionStore } from '../../stores/session-store'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { Switch } from '../console/fields'
import { McpServerEditor } from './McpServerEditor'
import { McpToolList } from './McpToolList'

/** 文件不存在时展示的示例片段（生态标准 mcpServers 格式） */
const SAMPLE_JSON = `{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/notes"]
    },
    "remote": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer \${REMOTE_TOKEN}" }
    }
  }
}`

const STATUS_DOT: Record<McpServerStatus, string> = {
  idle: 'bg-slate-300',
  ok: 'bg-emerald-500',
  error: 'bg-rose-500',
}

const STATUS_LABEL: Record<McpServerStatus, string> = {
  idle: '未连接',
  ok: '已连接',
  error: '连接失败',
}

/** 服务器配置一行摘要（command / url + 策略） */
function configSummary(server: McpServerDefinition): string {
  const cfg = server.config
  if (server.transport === 'stdio') {
    const args = (cfg.args ?? []).join(' ')
    return `${cfg.command ?? '?'}${args ? ` ${args}` : ''}`
  }
  return cfg.url ?? '?'
}

/**
 * M28：JSON 配置卡片 —— mcp.json 文件权威（状态 / 立即同步 / 粘贴导入）。
 * 文件缺失时展示示例片段供拷贝；json-config 未装配（503）时卡片整体隐藏。
 */
function JsonConfigCard(): React.JSX.Element | null {
  const jsonConfig = useMcpStore((s) => s.jsonConfig)
  const jsonSyncing = useMcpStore((s) => s.jsonSyncing)
  const [importOpen, setImportOpen] = React.useState(false)
  const [importText, setImportText] = React.useState('')
  const [importing, setImporting] = React.useState(false)
  const [importResult, setImportResult] = React.useState<McpJsonImportOutcome | null>(null)

  if (!jsonConfig) return null

  const doSync = async (): Promise<void> => {
    try {
      const result = await useMcpStore.getState().syncJsonConfig()
      if (!result.ok) {
        toast.error(
          result.missing
            ? 'mcp.json 不存在：请先创建文件（或用「粘贴导入」创建手动服务器）'
            : `同步失败：${result.errors[0] ?? '未知错误'}`,
        )
        return
      }
      const parts = [`创建 ${result.summary.created}`, `更新 ${result.summary.updated}`, `删除 ${result.summary.removed}`]
      if (result.summary.skipped > 0) parts.push(`冲突跳过 ${result.summary.skipped}`)
      if (result.errors.length > 0) parts.push(`${result.errors.length} 条异常`)
      toast(`mcp.json 同步完成：${parts.join(' · ')}`)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const doImport = async (): Promise<void> => {
    const text = importText.trim()
    if (!text) return
    setImporting(true)
    try {
      const outcome = await useMcpStore.getState().importJson(text)
      setImportResult(outcome)
      if (outcome.created.length === 0 && outcome.errors.length > 0) {
        toast.error(`导入失败：${outcome.errors[0]}`)
      } else {
        toast(
          `已导入 ${outcome.created.length} 个服务器${outcome.skipped.length > 0 ? `，跳过 ${outcome.skipped.length} 个（同名冲突或非法）` : ''}`,
        )
      }
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setImporting(false)
    }
  }

  return (
    <article className="rounded-lg border bg-card p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <FileJson className="size-3.5 text-muted-foreground" />
        <span className="text-[13px] font-semibold">JSON 配置</span>
        <Badge variant="outline" className="font-mono text-[10.5px]">
          mcp.json
        </Badge>
        {jsonConfig.exists ? <Badge variant="outline">文件已就绪</Badge> : <Badge variant="warning">文件不存在</Badge>}
        <Badge variant="outline" title="mtime 轮询（MCP_CONFIG_POLL_MS）">
          {jsonConfig.pollMs > 0 ? `每 ${jsonConfig.pollMs / 1000}s 自动同步` : '自动同步已关闭'}
        </Badge>
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            size="xs"
            variant="outline"
            disabled={jsonSyncing}
            title="立即同步文件（解析失败 = 跳过，绝不删除服务器）"
            onClick={() => void doSync()}
          >
            {jsonSyncing ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
            立即同步
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={jsonSyncing}
            title="粘贴生态标准 mcpServers JSON，创建为「手动」源服务器"
            onClick={() => {
              setImportResult(null)
              setImportText('')
              setImportOpen(true)
            }}
          >
            <ClipboardPaste className="size-3" />
            粘贴导入
          </Button>
        </div>
      </div>
      <div className="mt-1 truncate font-mono text-[10.5px] text-muted-foreground" title={jsonConfig.file}>
        {jsonConfig.file}
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground">
        {jsonConfig.lastSyncAt ? `最后同步 ${formatClock(jsonConfig.lastSyncAt)}` : '尚未同步'}
        {jsonConfig.lastResult === 'skipped' && (
          <span className="ml-1 text-amber-700">（上次已跳过：文件缺失或解析失败，未改动任何服务器）</span>
        )}
        {jsonConfig.entries.length > 0 && <span className="ml-1">· 条目：{jsonConfig.entries.join('、')}</span>}
      </div>
      {jsonConfig.lastError && (
        <div className="mt-1 line-clamp-2 text-[11px] text-rose-600" title={jsonConfig.lastError}>
          {jsonConfig.lastError}
        </div>
      )}
      {jsonConfig.lastWarnings.slice(0, 2).map((warning) => (
        <div key={warning} className="mt-1 line-clamp-1 text-[11px] text-amber-700" title={warning}>
          {warning}
        </div>
      ))}
      {!jsonConfig.exists && (
        <div className="mt-2 rounded-md border border-dashed bg-muted/20 p-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground">
              {`文件不存在：可将以下示例写入 ${jsonConfig.file}（支持 \${VAR} / \${VAR:-默认值} 变量展开）`}
            </span>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                void (navigator.clipboard?.writeText(SAMPLE_JSON) ?? Promise.reject(new Error('当前环境不支持剪贴板')))
                  .then(() => toast('示例已复制到剪贴板'))
                  .catch(() => toast.error('复制失败：请手动选择复制'))
              }}
            >
              复制示例
            </Button>
          </div>
          <pre className="mt-1 overflow-x-auto whitespace-pre font-mono text-[10.5px] leading-4 text-muted-foreground">
            {SAMPLE_JSON}
          </pre>
        </div>
      )}

      <Dialog open={importOpen} onOpenChange={(open) => (!open ? setImportOpen(false) : undefined)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>粘贴导入 MCP JSON</DialogTitle>
            <DialogDescription>创建为「手动」源服务器，同名冲突跳过。</DialogDescription>
          </DialogHeader>
          <textarea
            value={importText}
            rows={10}
            aria-label="MCP JSON"
            placeholder='{ "mcpServers": { "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem"] } } }'
            onChange={(e) => setImportText(e.target.value)}
            className="mt-3 block w-full resize-y rounded-md border border-input bg-card px-3 py-2 font-mono text-[12px] leading-5 outline-none placeholder:text-muted-foreground/70 focus-visible:border-primary/40 focus-visible:ring-[3px] focus-visible:ring-primary/15"
          />
          {importResult && (
            <div className="mt-2 space-y-1 rounded-md border bg-muted/20 px-3 py-2 text-[11.5px]">
              {importResult.created.length > 0 && <div>已创建：{importResult.created.join('、')}</div>}
              {importResult.skipped.map((entry) => (
                <div key={entry.name} className="text-amber-700">
                  跳过「{entry.name}」：{entry.reason}
                </div>
              ))}
              {importResult.errors.map((message) => (
                <div key={message} className="text-rose-600">
                  {message}
                </div>
              ))}
            </div>
          )}
          <div className="mt-4 flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setImportOpen(false)}>
              取消
            </Button>
            <Button size="sm" disabled={importing || !importText.trim()} onClick={() => void doImport()}>
              {importing && <Loader2 className="size-3.5 animate-spin" />}
              导入
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </article>
  )
}

function ServerCard({
  server,
  bound,
  hasSession,
  busy,
  expanded,
  onToggleExpand,
  onEdit,
}: {
  server: McpServerDefinition
  bound: boolean
  hasSession: boolean
  busy: boolean
  expanded: boolean
  onToggleExpand: () => void
  onEdit: () => void
}): React.JSX.Element {
  const tools = useMcpStore((s) => s.tools)
  const agents = useAgentStore((s) => s.agents)
  const agentNames = React.useMemo(() => new Map(agents.map((a) => [a.id, a.name])), [agents])
  const serverTools = React.useMemo(() => tools.filter((t) => t.serverId === server.id), [tools, server.id])
  const unreachable = serverTools.filter((t) => !t.reachable).length

  const doTest = async (): Promise<void> => {
    try {
      const result = await useMcpStore.getState().test(server.id)
      if (result.ok) toast(`「${server.name}」连接成功：${result.detail ?? 'ok'}${result.toolCount !== undefined ? `（${result.toolCount} 个工具）` : ''}`)
      else toast.error(`「${server.name}」连接失败：${result.error ?? '未知原因'}`)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const doReconnect = async (): Promise<void> => {
    try {
      await useMcpStore.getState().reconnect(server.id)
      const after = useMcpStore.getState().servers.find((s) => s.id === server.id)
      if (after?.status === 'ok') toast(`「${server.name}」已重连（${after.tools.length} 个工具）`)
      else toast.error(`「${server.name}」重连失败：${after?.lastError ?? '未知原因'}`)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const doRefresh = async (): Promise<void> => {
    try {
      await useMcpStore.getState().refreshTools(server.id)
      const after = useMcpStore.getState().servers.find((s) => s.id === server.id)
      toast(`「${server.name}」工具清单已刷新（${after?.tools.length ?? 0} 个）`)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const doToggle = async (enabled: boolean): Promise<void> => {
    try {
      await useMcpStore.getState().update(server.id, { enabled })
      toast(enabled ? `「${server.name}」已启用，正在连接` : `「${server.name}」已禁用（工具已注销）`)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const doBind = async (): Promise<void> => {
    try {
      if (bound) await useMcpStore.getState().unbind(server.id)
      else await useMcpStore.getState().bind(server.id)
      toast(bound ? `已从当前会话解绑「${server.name}」` : `已绑定「${server.name}」到当前会话`)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  return (
    <article className="rounded-lg border bg-card p-3 transition-colors hover:border-primary/30">
      <div className="flex items-start gap-2.5">
        <span
          className={cn('mt-1.5 size-2 shrink-0 rounded-full', STATUS_DOT[server.status])}
          title={`${STATUS_LABEL[server.status]}${server.lastCheckedAt ? ` · ${formatClock(server.lastCheckedAt)}` : ''}`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[13px] font-semibold">{server.displayName || server.name}</span>
            <span className="font-mono text-[10.5px] text-muted-foreground">{server.name}</span>
            <Badge variant="outline">{server.transport === 'stdio' ? 'stdio' : 'HTTP'}</Badge>
            {server.source === 'env' && <Badge variant="outline">env 种子</Badge>}
            {server.source === 'json' && (
              <Badge variant="outline" title="由 mcp.json 管理（只读）：编辑配置文件后点「立即同步」">
                由 mcp.json 管理
              </Badge>
            )}
            {server.source === 'ui' && (
              <Badge variant="outline" title="管理台手动创建（可编辑 / 删除）">
                手动
              </Badge>
            )}
            {server.config.eagerLoad === true && (
              <Badge variant="secondary" title="M28：全部工具常驻模型工具清单（跳过延迟发现）">
                全部常驻
              </Badge>
            )}
            {server.secretSet && (
              <Badge variant="outline" title="env / headers 已加密存储（明文永不回显）">
                <Lock className="mr-0.5 size-2.5" />
                凭据
              </Badge>
            )}
            <Badge variant="outline">工具 · {server.tools.length}</Badge>
            {unreachable > 0 && (
              <Badge
                variant="warning"
                title="存在零角色可达的工具：请在 Agent 编辑器中添加精确名或 mcp__<slug>__* 通配"
              >
                <AlertTriangle className="mr-0.5 size-3" />
                {unreachable} 个工具零可达
              </Badge>
            )}
          </div>
          <div className="mt-1 truncate font-mono text-[10.5px] text-muted-foreground" title={configSummary(server)}>
            {configSummary(server)}
            <span className="ml-2 font-sans">
              审批 · {server.config.approvalPolicy ?? 'risky'} / 只读 · {server.config.readOnlyOverride ?? 'auto'}
              {server.config.timeoutMs ? ` / 超时 · ${server.config.timeoutMs}ms` : ''}
            </span>
          </div>
          {server.status === 'error' && server.lastError && (
            <div className="mt-1 line-clamp-2 text-[11px] text-rose-600" title={server.lastError}>
              {server.lastError}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <span title={server.source === 'json' ? '由 mcp.json 管理（只读）' : undefined}>
            <Switch
              checked={server.enabled}
              onChange={(v) => void doToggle(v)}
              label={`启用 ${server.name}`}
              disabled={server.source === 'json'}
            />
          </span>
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <Button size="xs" variant="outline" disabled={busy || !server.enabled} title="测试连接（未连接时建立连接并注入工具）" onClick={() => void doTest()}>
          {busy ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
          测试
        </Button>
        <Button size="xs" variant="outline" disabled={busy || !server.enabled} title="重连（重新初始化 + 刷新工具）" onClick={() => void doReconnect()}>
          <RotateCw className="size-3" />
          重连
        </Button>
        <Button size="xs" variant="outline" disabled={busy || !server.enabled} title="刷新工具清单（tools/list）" onClick={() => void doRefresh()}>
          <RefreshCw className="size-3" />
          刷新工具
        </Button>
        {hasSession && (
          <Button
            size="xs"
            variant={bound ? 'secondary' : 'outline'}
            disabled={busy}
            title={bound ? '解绑：当前会话将不可见该服务器的工具' : '绑定到当前会话（最小权限：未绑定不可见）'}
            onClick={() => void doBind()}
          >
            {bound ? <Unlink className="size-3" /> : <Link2 className="size-3" />}
            {bound ? '解绑' : '绑定'}
          </Button>
        )}
        <Button size="xs" variant="ghost" disabled={busy} title="展开工具清单与可达性" onClick={onToggleExpand}>
          {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
          工具清单
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={busy || server.source === 'json'}
          title={server.source === 'json' ? '由 mcp.json 管理（只读）：请编辑配置文件后同步' : '编辑'}
          onClick={onEdit}
        >
          <Pencil className="size-3" />
        </Button>
        <Button
          size="xs"
          variant="ghost"
          className="ml-auto text-rose-600 hover:text-rose-700"
          disabled={busy || server.source === 'json'}
          title={
            server.source === 'json'
              ? '由 mcp.json 管理（只读）：删除 = 从配置文件移除后同步'
              : '删除服务器（断开连接 + 注销工具 + 解绑全部会话）'
          }
          onClick={() => {
            if (!window.confirm(`删除 MCP 服务器「${server.name}」？将断开连接、注销其工具并解除全部会话绑定，凭据一并清除。`)) return
            void useMcpStore
              .getState()
              .remove(server.id)
              .then(() => toast('服务器已删除'))
              .catch((err: Error) => toast.error(err.message))
          }}
        >
          <Trash2 className="size-3" />
        </Button>
      </div>

      {expanded && (
        <div className="mt-2.5">
          <McpToolList tools={serverTools} agentNames={agentNames} />
        </div>
      )}
    </article>
  )
}

export function McpConsole(): React.JSX.Element {
  const servers = useMcpStore((s) => s.servers)
  const bindings = useMcpStore((s) => s.bindings)
  const loading = useMcpStore((s) => s.loading)
  const busyId = useMcpStore((s) => s.busyId)
  const currentId = useSessionStore((s) => s.currentId)
  const [editorTarget, setEditorTarget] = React.useState<McpServerDefinition | null | undefined>(undefined)
  const [expandedId, setExpandedId] = React.useState<string>()

  React.useEffect(() => {
    const store = useMcpStore.getState()
    if (currentId) void store.loadForSession(currentId)
    else void store.refreshAll()
  }, [currentId])

  const boundIds = React.useMemo(() => new Set(bindings.map((b) => b.server.id)), [bindings])
  const sorted = React.useMemo(() => [...servers].sort((a, b) => a.name.localeCompare(b.name)), [servers])
  const totalTools = React.useMemo(() => servers.reduce((sum, s) => sum + s.tools.length, 0), [servers])

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 页头 */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <Plug className="size-4 text-muted-foreground" />
        <span className="text-[13px] font-semibold">MCP 管理</span>
        <span className="text-[11px] text-muted-foreground">
          {servers.length} 个服务器 · {totalTools} 个工具
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            title="刷新清单"
            disabled={loading}
            onClick={() => void useMcpStore.getState().refreshAll()}
          >
            {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            刷新
          </Button>
          <Button size="sm" onClick={() => setEditorTarget(null)}>
            <Plus className="size-3.5" />
            新建服务器
          </Button>
        </div>
      </div>

      {/* 服务器清单 */}
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-3">
        <JsonConfigCard />
        {loading && servers.length === 0 && (
          <div className="flex items-center justify-center py-16 text-[12px] text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            正在加载 MCP 服务器…
          </div>
        )}
        {!loading && servers.length === 0 && (
          <div className="rounded-lg border border-dashed px-4 py-16 text-center">
            <div className="text-[13px] font-medium">还没有 MCP 服务器</div>
          </div>
        )}
        {sorted.map((server) => (
          <ServerCard
            key={server.id}
            server={server}
            bound={boundIds.has(server.id)}
            hasSession={!!currentId}
            busy={busyId === server.id}
            expanded={expandedId === server.id}
            onToggleExpand={() => setExpandedId((id) => (id === server.id ? undefined : server.id))}
            onEdit={() => setEditorTarget(server)}
          />
        ))}
      </div>

      {editorTarget !== undefined && (
        <McpServerEditor server={editorTarget ?? undefined} onClose={() => setEditorTarget(undefined)} />
      )}
    </div>
  )
}

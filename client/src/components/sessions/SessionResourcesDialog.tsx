/**
 * M57 P3：会话资源弹窗（头部「资源」入口）——连接 / MCP 的**成员自助绑定**面。
 *
 * 背景：连接中心 / MCP 管理台为 admin-only；成员自建的 personal 资源（P3-2 / P3-4）
 * 与成员可用的 system 资源（连接 member_use=1 / MCP system）此前缺少会话侧绑定入口。
 * 本弹窗补齐：已绑定（解绑）+ 可绑定（绑定）；viewer 只读（服务端 403 的前置提示）。
 */
import * as React from 'react'
import { Database, Loader2, Plug, PlugZap, Server, Unplug } from 'lucide-react'
import { toast } from 'sonner'
import { useConnectionsStore } from '../../stores/connections-store'
import { useMcpStore } from '../../stores/mcp-store'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs'

export interface SessionResourcesDialogProps {
  sessionId?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** viewer（只读共享）隐藏绑定 / 解绑操作（服务端写闸门 403 的前置提示） */
  canWrite: boolean
}

const CONN_STATUS: Record<string, string> = { ok: '已连接', error: '连接失败', idle: '未连接' }
const MCP_STATUS: Record<string, string> = { ok: '已连接', error: '连接失败', idle: '未连接' }

export function SessionResourcesDialog({
  sessionId,
  open,
  onOpenChange,
  canWrite,
}: SessionResourcesDialogProps): React.JSX.Element {
  const connections = useConnectionsStore((s) => s.connections)
  const connectionBindings = useConnectionsStore((s) => s.bindings)
  const servers = useMcpStore((s) => s.servers)
  const mcpBindings = useMcpStore((s) => s.bindings)
  const [busy, setBusy] = React.useState<string | undefined>()
  const [loading, setLoading] = React.useState(false)

  React.useEffect(() => {
    if (!open || !sessionId) return
    setLoading(true)
    void Promise.allSettled([
      useConnectionsStore.getState().loadForSession(sessionId),
      useMcpStore.getState().loadForSession(sessionId),
    ]).finally(() => setLoading(false))
  }, [open, sessionId])

  const boundConnectionIds = new Set(connectionBindings.map((b) => b.connection.id))
  const boundMcpIds = new Set(mcpBindings.map((b) => b.server.id))

  const run = async (key: string, fn: () => Promise<void>, done: string): Promise<void> => {
    setBusy(key)
    try {
      await fn()
      toast(done)
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(undefined)
    }
  }

  /** 资源徽标：personal = 我的（ownerId 视觉锚点）；system = 团队 */
  const scopeBadge = (scope?: 'system' | 'personal'): React.JSX.Element =>
    scope === 'personal' ? (
      <Badge variant="secondary" className="h-4 px-1 text-[10px]">
        我的
      </Badge>
    ) : (
      <Badge variant="outline" className="h-4 px-1 text-[10px] text-muted-foreground">
        团队
      </Badge>
    )

  const rowClass = 'flex items-center gap-2 rounded-lg border px-3 py-2 text-[12.5px]'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-[14px]">会话资源</DialogTitle>
          <DialogDescription className="text-[12px]">
            绑定到当前会话后，Agent 工具即可使用（连接随会话解绑 / 删除自动清理）。
            {!canWrite && '（只读共享：可查看绑定，不能修改）'}
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="connections">
          <TabsList>
            <TabsTrigger value="connections" className="gap-1 text-[12px]">
              <Database className="size-3.5" />
              连接（{connectionBindings.length}）
            </TabsTrigger>
            <TabsTrigger value="mcp" className="gap-1 text-[12px]">
              <Server className="size-3.5" />
              MCP（{mcpBindings.length}）
            </TabsTrigger>
          </TabsList>

          <TabsContent value="connections" className="mt-2 space-y-1.5">
            {loading && (
              <div className="flex items-center gap-2 py-2 text-[12px] text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                加载中…
              </div>
            )}
            {!loading && connectionBindings.length === 0 && (
              <p className="text-[12px] text-muted-foreground">尚未绑定连接。</p>
            )}
            {connectionBindings.map(({ connection }) => (
              <div key={connection.id} className={rowClass}>
                {scopeBadge(connection.scope)}
                <span className="font-medium">{connection.name}</span>
                <span className="text-[11px] text-muted-foreground">
                  {connection.kind} · {CONN_STATUS[connection.status] ?? connection.status}
                </span>
                {canWrite && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="ml-auto h-6 px-2 text-[11px]"
                    disabled={busy !== undefined}
                    onClick={() =>
                      void run(
                        connection.id,
                        () => useConnectionsStore.getState().unbind(connection.id),
                        `已解绑「${connection.name}」`,
                      )
                    }
                  >
                    <Unplug className="size-3" />
                    解绑
                  </Button>
                )}
              </div>
            ))}
            {!loading &&
              connections
                .filter((c) => !boundConnectionIds.has(c.id))
                .map((candidate) => (
                  <div key={candidate.id} className={rowClass}>
                    {scopeBadge(candidate.scope)}
                    <span className="font-medium">{candidate.name}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {candidate.kind} · {CONN_STATUS[candidate.status] ?? candidate.status}
                    </span>
                    {canWrite && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="ml-auto h-6 px-2 text-[11px]"
                        disabled={busy !== undefined}
                        onClick={() =>
                          void run(
                            candidate.id,
                            () => useConnectionsStore.getState().bind(candidate.id),
                            `已绑定「${candidate.name}」到当前会话`,
                          )
                        }
                      >
                        <Plug className="size-3" />
                        绑定
                      </Button>
                    )}
                  </div>
                ))}
            {!loading && connections.length === 0 && (
              <p className="text-[11px] text-muted-foreground">
                没有可用连接：团队连接需管理员开启「允许成员使用」；也可在「设置 → 我的连接」自建个人连接。
              </p>
            )}
          </TabsContent>

          <TabsContent value="mcp" className="mt-2 space-y-1.5">
            {loading && (
              <div className="flex items-center gap-2 py-2 text-[12px] text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                加载中…
              </div>
            )}
            {!loading && mcpBindings.length === 0 && <p className="text-[12px] text-muted-foreground">尚未绑定 MCP 服务器。</p>}
            {mcpBindings.map(({ server }) => (
              <div key={server.id} className={rowClass}>
                {scopeBadge(server.scope)}
                <span className="font-medium">{server.displayName ?? server.name}</span>
                <span className="text-[11px] text-muted-foreground">
                  {server.name} · {server.transport} · {MCP_STATUS[server.status] ?? server.status}
                </span>
                {canWrite && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="ml-auto h-6 px-2 text-[11px]"
                    disabled={busy !== undefined}
                    onClick={() =>
                      void run(
                        server.id,
                        () => useMcpStore.getState().unbind(server.id),
                        `已解绑「${server.displayName ?? server.name}」`,
                      )
                    }
                  >
                    <Unplug className="size-3" />
                    解绑
                  </Button>
                )}
              </div>
            ))}
            {!loading &&
              servers
                .filter((s) => !boundMcpIds.has(s.id))
                .map((candidate) => (
                  <div key={candidate.id} className={rowClass}>
                    {scopeBadge(candidate.scope)}
                    <span className="font-medium">{candidate.displayName ?? candidate.name}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {candidate.name} · {candidate.transport} · {MCP_STATUS[candidate.status] ?? candidate.status}
                    </span>
                    {canWrite && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="ml-auto h-6 px-2 text-[11px]"
                        disabled={busy !== undefined}
                        onClick={() =>
                          void run(
                            candidate.id,
                            () => useMcpStore.getState().bind(candidate.id),
                            `已绑定「${candidate.displayName ?? candidate.name}」到当前会话`,
                          )
                        }
                      >
                        <PlugZap className="size-3" />
                        绑定
                      </Button>
                    )}
                  </div>
                ))}
            {!loading && servers.length === 0 && (
              <p className="text-[11px] text-muted-foreground">
                没有可用 MCP 服务器：团队服务器由管理员在 MCP 管理台维护；也可在「设置 → 我的 MCP」自建个人服务器。
              </p>
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

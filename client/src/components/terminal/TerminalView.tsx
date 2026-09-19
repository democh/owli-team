/**
 * SSH 终端视图（M23，主区，对齐 Termius / VS Code 终端习惯）：
 * - 多会话标签：状态点（连接中脉冲 / 已连接绿 / 断开灰 / 失败红），关闭不误伤其他会话；
 * - 会话画面：xterm 运行时按需挂载（切标签搬移 DOM，不重建），激活即 fit + 聚焦；
 * - 断线处理：标签保留画面并提示，工具栏「重连」重新握手（不静默重连，状态可见）；
 * - 入口：工具栏「+」列出现有 SSH 连接；空态列出连接卡片一键打开。
 */
import * as React from 'react'
import { Loader2, Plus, RefreshCw, RotateCcw, Terminal, X } from 'lucide-react'
import { toast } from 'sonner'
import type { ConnectionDefinition } from '@multi-agent/shared'
import { apiGet } from '../../lib/api'
import { cn } from '../../lib/utils'
import type { TerminalRuntime } from '../../lib/terminal-runtime'
import { useTerminalStore, type TerminalStatus } from '../../stores/terminal-store'
import { useUiStore } from '../../stores/ui-store'
import { Button } from '../ui/button'

const STATUS_META: Record<TerminalStatus, { dot: string; label: string }> = {
  connecting: { dot: 'animate-pulse bg-amber-400', label: '连接中…' },
  open: { dot: 'bg-emerald-500', label: '已连接' },
  closed: { dot: 'bg-slate-400', label: '已断开' },
  error: { dot: 'bg-rose-500', label: '连接失败' },
}

function targetOf(connection: ConnectionDefinition): string {
  const host = String(connection.config.host ?? '')
  const port = connection.config.port !== undefined ? String(connection.config.port) : '22'
  const user = String(connection.config.username ?? '')
  return user ? `${user}@${host}:${port}` : `${host}:${port}`
}

/** 单个会话画布：runtime.element 挂载点（非激活时 hidden 保留状态） */
function SessionPane({ id, active }: { id: string; active: boolean }): React.JSX.Element {
  const runtime = React.useMemo<TerminalRuntime | undefined>(() => useTerminalStore.getState().runtimeOf(id), [id])
  const hostRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const host = hostRef.current
    if (!host || !runtime) return
    host.appendChild(runtime.element)
    return () => {
      if (host.contains(runtime.element)) host.removeChild(runtime.element)
    }
  }, [runtime])

  React.useEffect(() => {
    if (!active || !runtime) return
    const raf = requestAnimationFrame(() => {
      runtime.fit()
      runtime.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [active, runtime])

  return (
    <div
      className={cn('min-h-0 flex-1 bg-[#0b1220]', !active && 'hidden')}
      onMouseDown={() => runtime?.focus()}
      data-testid={`terminal-pane-${id}`}
    >
      <div ref={hostRef} className="h-full w-full p-1.5" />
      {!runtime && <p className="p-4 text-[11.5px] text-muted-foreground">终端未初始化</p>}
    </div>
  )
}

export function TerminalView(): React.JSX.Element {
  const sessions = useTerminalStore((s) => s.sessions)
  const activeId = useTerminalStore((s) => s.activeId)
  const close = useTerminalStore((s) => s.close)
  const activate = useTerminalStore((s) => s.activate)
  const reconnect = useTerminalStore((s) => s.reconnect)
  const open = useTerminalStore((s) => s.open)
  const setAppView = useUiStore((s) => s.setAppView)

  const [sshConnections, setSshConnections] = React.useState<ConnectionDefinition[]>([])
  const [loadingConns, setLoadingConns] = React.useState(false)
  const [menuOpen, setMenuOpen] = React.useState(false)

  const refreshConnections = React.useCallback(async (): Promise<void> => {
    setLoadingConns(true)
    try {
      const res = await apiGet<{ connections: ConnectionDefinition[] }>('/api/connections')
      setSshConnections(res.connections.filter((c) => c.kind === 'ssh'))
    } catch {
      // 服务不可达：保留旧清单
    } finally {
      setLoadingConns(false)
    }
  }, [])

  React.useEffect(() => {
    void refreshConnections()
  }, [refreshConnections])

  const openSession = async (connection: ConnectionDefinition): Promise<void> => {
    setMenuOpen(false)
    const id = await open(connection)
    if (!id) toast.error('终端建立失败，请检查连接配置')
  }

  const active = sessions.find((s) => s.id === activeId)
  const statusMeta = active ? STATUS_META[active.status] : undefined

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="terminal-view">
      {/* 标签栏 */}
      <div className="flex shrink-0 items-stretch gap-px border-b bg-muted/30">
        <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto" data-testid="terminal-tabs">
          {sessions.map((session) => {
            const meta = STATUS_META[session.status]
            const isActive = session.id === activeId
            return (
              <div
                key={session.id}
                className={cn(
                  'flex shrink-0 cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-[11.5px]',
                  isActive ? 'border-b-2 border-primary bg-card font-medium' : 'text-muted-foreground hover:bg-accent/50',
                )}
                onClick={() => activate(session.id)}
                title={session.message ?? meta.label}
              >
                <span className={cn('size-2 shrink-0 rounded-full', meta.dot)} />
                <span className="max-w-[160px] truncate">{session.title}</span>
                <button
                  type="button"
                  className="rounded p-0.5 opacity-40 hover:bg-accent hover:opacity-100"
                  title="关闭会话"
                  onClick={(e) => {
                    e.stopPropagation()
                    close(session.id)
                  }}
                >
                  <X className="size-3" />
                </button>
              </div>
            )
          })}
          {sessions.length === 0 && <div className="flex items-center px-3 py-1.5 text-[11.5px] text-muted-foreground">会话</div>}
        </div>

        {/* 会话操作区 */}
        <div className="flex shrink-0 items-center gap-1 border-l px-1.5">
          {active && statusMeta && (
            <span className="flex items-center gap-1 text-[10.5px] text-muted-foreground" title={active.message ?? statusMeta.label}>
              <span className={cn('size-1.5 rounded-full', statusMeta.dot)} />
              <span className="max-w-[140px] truncate">{active.message ?? statusMeta.label}</span>
              <span className="tabular-nums">
                {active.size.cols}×{active.size.rows}
              </span>
            </span>
          )}
          {active && (active.status === 'closed' || active.status === 'error') && (
            <Button size="xs" variant="outline" title="重新建立连接（保留画面内容）" onClick={() => void reconnect(active.id)}>
              <RotateCcw className="mr-1 size-3" />
              重连
            </Button>
          )}
          <div className="relative">
            <Button size="xs" variant="ghost" title="新建会话" onClick={() => setMenuOpen((v) => !v)}>
              <Plus className="size-3.5" />
            </Button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setMenuOpen(false)} />
                <div className="absolute top-full right-0 z-30 mt-1 w-60 rounded-lg border bg-card p-1 shadow-lg">
                  {sshConnections.length === 0 ? (
                    <div className="px-2 py-2 text-[11.5px] text-muted-foreground">
                      暂无 SSH 连接
                      <Button
                        size="xs"
                        variant="link"
                        className="px-1"
                        onClick={() => {
                          setMenuOpen(false)
                          setAppView('connections')
                        }}
                      >
                        前往连接管理创建
                      </Button>
                    </div>
                  ) : (
                    sshConnections.map((connection) => (
                      <button
                        key={connection.id}
                        type="button"
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
                        onClick={() => void openSession(connection)}
                      >
                        <Terminal className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[11.5px]">{connection.name}</span>
                          <span className="block truncate font-mono text-[10px] text-muted-foreground">{targetOf(connection)}</span>
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </>
            )}
          </div>
          <Button size="xs" variant="ghost" title="刷新连接清单" onClick={() => void refreshConnections()}>
            <RefreshCw className={cn('size-3.5', loadingConns && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {/* 会话画面 / 空态 */}
      {sessions.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-8" data-testid="terminal-empty">
          <Terminal className="size-8 text-muted-foreground/60" />
          <div className="text-center">
            <p className="text-[13px] font-medium">{loadingConns ? '正在加载连接…' : 'SSH 终端'}</p>
            <p className="mt-1 text-[11.5px] text-muted-foreground">
              {sshConnections.length > 0 ? '选择一台主机开始会话：' : '尚未创建 SSH 连接。'}
            </p>
          </div>
          {sshConnections.length > 0 ? (
            <div className="grid w-full max-w-md grid-cols-1 gap-2 sm:grid-cols-2">
              {sshConnections.map((connection) => (
                <button
                  key={connection.id}
                  type="button"
                  className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-left transition-colors hover:border-primary/40 hover:bg-accent"
                  onClick={() => void openSession(connection)}
                >
                  <Terminal className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] font-medium">{connection.name}</span>
                    <span className="block truncate font-mono text-[10.5px] text-muted-foreground">{targetOf(connection)}</span>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            !loadingConns && (
              <Button size="sm" variant="outline" onClick={() => setAppView('connections')}>
                前往「连接管理」创建
              </Button>
            )
          )}
          {loadingConns && sshConnections.length === 0 && (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {sessions.map((session) => (
            <SessionPane key={session.id} id={session.id} active={session.id === activeId} />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * 直播窗 · SSH tab（M23+）：审批等待 + 命令流 + 终端只读镜像 + 最近操作。
 *
 * 数据源（与「连接管理」控制台 / 主区终端共用，零同步成本）：
 * - 命令流 / 最近操作：connections-store 的 ssh 操作事件（实时 notify:op + 审计回放）；
 * - 审批等待：run-store.approvals 中 pending 且 action 含「远程主机」的项（ssh_exec 审批；
 *   直播窗只提示 + 一键跳转，批准 / 拒绝仍在主区审批卡完成）；
 * - 终端镜像：terminal-store 输出字节旁路（subscribeMirror「通知 + 拉取」不进 zustand，
 *   避免高吞吐终端流触发全局重渲染）。
 *
 * 交互约定：镜像只读（完整交互去主区「终端」页签）；点击历史条目钉住查看，再点取消跟随。
 *
 * M49：surface="panel" 时并入右栏「实况」面板（不触悬浮直播窗；
 * 底栏提供「展开终端 + 连接管理」）；dock 面（默认）行为不变。
 */
import * as React from 'react'
import { ChevronDown, ChevronUp, Loader2, PanelRight, ShieldAlert, SquareTerminal, Terminal } from 'lucide-react'
import type { OpEvent } from '@multi-agent/shared'
import { cn } from '../../lib/utils'
import { useBusyOpFaces } from '../../lib/use-busy-ops'
import { useConnectionsStore } from '../../stores/connections-store'
import { useLiveDockStore } from '../../stores/live-dock-store'
import { useRunStore } from '../../stores/run-store'
import { useSessionStore } from '../../stores/session-store'
import { mirrorOf, subscribeMirror, useTerminalStore, type TerminalStatus } from '../../stores/terminal-store'
import { useUiStore } from '../../stores/ui-store'
import { Button } from '../ui/button'

/** 镜像可见行数（卡片高度有限，仅显示尾部；完整历史在主区终端） */
const MIRROR_VIEW_LINES = 14

function durationText(ms?: number): string {
  if (ms === undefined) return ''
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

/** 动作徽标：ssh.exec → 执行（失败红 / 成功绿） */
function actionBadge(op: OpEvent): { label: string; className: string } {
  if (op.status === 'error') return { label: '失败', className: 'border-red-500/30 text-red-700' }
  return { label: '执行', className: 'border-emerald-500/30 text-emerald-700' }
}

/** 终端会话状态 → 文案 + 状态点（镜像区 header） */
function statusStyle(status: TerminalStatus): { label: string; dot: string } {
  if (status === 'open') return { label: '已连接', dot: 'bg-emerald-500' }
  if (status === 'connecting') return { label: '连接中…', dot: 'bg-sky-500 animate-pulse' }
  if (status === 'error') return { label: '异常', dot: 'bg-red-500' }
  return { label: '已断开', dot: 'bg-slate-500' }
}

export function DockSshView({ surface = 'dock' }: { surface?: 'dock' | 'panel' } = {}): React.JSX.Element {
  const currentId = useSessionStore((s) => s.currentId)
  const ops = useConnectionsStore((s) => s.ops)
  const loadedFor = useConnectionsStore((s) => s.sessionId)
  const approvals = useRunStore((s) => s.approvals)
  const sessions = useTerminalStore((s) => s.sessions)
  const activeTermId = useTerminalStore((s) => s.activeId)
  const busyFaces = useBusyOpFaces()
  const [pinnedId, setPinnedId] = React.useState<string | undefined>(undefined)
  const [cmdOpen, setCmdOpen] = React.useState(false)
  const [, bumpMirror] = React.useReducer((x: number) => x + 1, 0)

  /** 折叠浮窗（仅 dock surface；panel 面内嵌右栏，不触悬浮窗） */
  const leave = (): void => {
    if (surface === 'dock') useLiveDockStore.getState().minimize()
  }

  // 懒加载：直播窗独立打开时也能就位（与右栏共用的数据源）
  React.useEffect(() => {
    if (currentId && loadedFor !== currentId) void useConnectionsStore.getState().loadForSession(currentId)
  }, [currentId, loadedFor])

  // 终端镜像「通知」：字节到达 → 本组件重渲染，渲染时经 mirrorOf 拉取（不进 zustand）
  React.useEffect(() => subscribeMirror(() => bumpMirror()), [])

  const sshOps = React.useMemo(
    () => ops.filter((o) => o.kind === 'ssh' && (!currentId || o.sessionId === currentId)),
    [ops, currentId],
  )
  const pinned = pinnedId ? sshOps.find((o) => o.id === pinnedId) : undefined
  const focus = pinned ?? sshOps[0]

  /** ssh_exec 审批（pending）：本窗只提示 + 跳转，处置走主区审批卡 */
  const pendingApproval = React.useMemo(
    () => approvals.find((a) => a.status === 'pending' && a.action.includes('远程主机')),
    [approvals],
  )

  /** 镜像会话：活动终端优先，否则最近一个（覆盖已关闭会话的最后画面） */
  const mirrorSession =
    sessions.find((s) => s.id === activeTermId) ?? (sessions.length > 0 ? sessions[sessions.length - 1] : undefined)
  const mirrorLines = mirrorSession ? mirrorOf(mirrorSession.id).slice(-MIRROR_VIEW_LINES) : []

  // 镜像尾部跟随：同底则自动滚动；用户上滚查看历史时不抢
  const mirrorRef = React.useRef<HTMLPreElement>(null)
  const tailRef = React.useRef(true)
  React.useLayoutEffect(() => {
    const el = mirrorRef.current
    if (el && tailRef.current) el.scrollTop = el.scrollHeight
  })

  const sshRunning = busyFaces.has('ssh')

  if (!focus && !pendingApproval && !mirrorSession && !sshRunning) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
        <Terminal className="size-4 text-muted-foreground/60" />
        <p className="text-[11.5px] leading-relaxed text-muted-foreground">暂无 SSH 操作</p>
        {surface === 'panel' && (
          <Button size="xs" variant="outline" onClick={() => useUiStore.getState().expandWorkspace('terminal')}>
            <SquareTerminal className="mr-1 size-3" />
            展开终端
          </Button>
        )}
        <Button
          size="xs"
          variant="outline"
          onClick={() => {
            useUiStore.getState().setAppView('connections')
            leave()
          }}
        >
          打开连接管理
        </Button>
      </div>
    )
  }

  const badge = focus ? actionBadge(focus) : undefined
  const mStatus = mirrorSession ? statusStyle(mirrorSession.status) : undefined

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
        {/* ① 审批等待（ssh_exec） */}
        {pendingApproval && (
          <div className="rounded-md border border-amber-300/70 bg-amber-50/80 px-2 py-1.5">
            <div className="flex items-center gap-1.5">
              <ShieldAlert className="size-3 shrink-0 text-amber-600" />
              <span
                className="min-w-0 flex-1 truncate text-[10.5px] font-medium text-amber-900"
                title={pendingApproval.action}
              >
                {pendingApproval.action}
              </span>
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  useUiStore.getState().setMainTab('chat')
                  leave()
                }}
              >
                去处理
              </Button>
            </div>
            {pendingApproval.detail && (
              <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-all rounded border border-amber-200/70 bg-amber-100/40 px-1.5 py-1 font-mono text-[10px] leading-relaxed text-amber-900">
                {pendingApproval.detail}
              </pre>
            )}
          </div>
        )}

        {/* ② 执行中（审批已过、命令未返回；op 事件到达后由命令卡接管） */}
        {sshRunning && !pendingApproval && (
          <div className="flex items-center gap-1.5 rounded-md border border-sky-500/25 bg-sky-500/5 px-2 py-1 text-[10.5px] text-sky-800">
            <Loader2 className="size-3 shrink-0 animate-spin" />
            Agent 正在远程主机执行命令…
          </div>
        )}

        {/* ③ 命令卡（最新 / 钉住） */}
        {focus && badge && (
          <>
            <div className="flex items-center gap-1.5">
              <span className={cn('shrink-0 rounded-full border px-1.5 text-[9.5px]', badge.className)}>
                {badge.label}
              </span>
              <span className="min-w-0 flex-1 truncate text-[10.5px]" title={focus.target ?? focus.summary}>
                {focus.summary ?? focus.target ?? focus.action}
              </span>
              {focus.status === 'running' && <span className="size-1.5 animate-pulse rounded-full bg-sky-500" />}
              {focus.durationMs !== undefined && (
                <span className="shrink-0 text-[9.5px] text-muted-foreground">{durationText(focus.durationMs)}</span>
              )}
            </div>

            {focus.detail && (
              <div className="rounded-md border bg-muted/40">
                <pre
                  className={cn(
                    'overflow-x-auto whitespace-pre-wrap break-all px-2 py-1.5 font-mono text-[10.5px] leading-relaxed',
                    !cmdOpen && 'line-clamp-4',
                  )}
                >
                  {focus.detail}
                </pre>
                {focus.detail.length > 160 && (
                  <button
                    type="button"
                    className="flex w-full items-center justify-center gap-0.5 border-t py-0.5 text-[9.5px] text-muted-foreground hover:text-foreground"
                    onClick={() => setCmdOpen((v) => !v)}
                  >
                    {cmdOpen ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
                    {cmdOpen ? '收起' : '展开全文'}
                  </button>
                )}
              </div>
            )}
          </>
        )}

        {/* ④ 终端镜像（只读） */}
        {mirrorSession && mStatus && (
          <div className="overflow-hidden rounded-md border border-slate-700/60 bg-slate-950/95">
            <div className="flex items-center justify-between border-b border-slate-700/60 bg-slate-900/80 px-2 py-0.5 text-[9.5px] text-slate-400">
              <span className="flex min-w-0 items-center gap-1">
                <Terminal className="size-2.5 shrink-0" />
                <span className="truncate" title={mirrorSession.title}>
                  {mirrorSession.title}
                </span>
                <span className="shrink-0">· 只读镜像</span>
              </span>
              <span className="flex shrink-0 items-center gap-1">
                <span className={cn('size-1.5 rounded-full', mStatus.dot)} />
                {mStatus.label}
              </span>
            </div>
            <pre
              ref={mirrorRef}
              onScroll={() => {
                const el = mirrorRef.current
                if (el) tailRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
              }}
              className="max-h-44 overflow-auto whitespace-pre-wrap break-all px-2 py-1 font-mono text-[10px] leading-relaxed text-slate-200"
            >
              {mirrorLines.length > 0 ? mirrorLines.join('\n') : '（等待远程输出…）'}
            </pre>
          </div>
        )}

        {/* ⑤ 最近操作（点击钉住查看） */}
        {sshOps.length > 1 && (
          <div className="space-y-0.5 pt-0.5">
            <p className="px-0.5 text-[9.5px] font-medium text-muted-foreground">最近操作</p>
            {sshOps.slice(0, 4).map((op) => {
              const b = actionBadge(op)
              const active = focus?.id === op.id
              return (
                <button
                  key={op.id}
                  type="button"
                  className={cn(
                    'flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left transition-colors',
                    active ? 'bg-accent' : 'hover:bg-accent/50',
                  )}
                  title={op.detail ?? op.summary}
                  onClick={() => setPinnedId((v) => (v === op.id ? undefined : op.id))}
                >
                  <span className={cn('shrink-0 rounded-full border px-1 text-[9px]', b.className)}>{b.label}</span>
                  <span className="min-w-0 flex-1 truncate text-[10px]">
                    {(op.detail ?? op.summary ?? op.action).split('\n')[0]}
                  </span>
                  <span className="shrink-0 text-[9px] text-muted-foreground">{durationText(op.durationMs)}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* 底栏：跟随状态 + 跳转入口（完整交互去主区终端） */}
      <div className="flex shrink-0 items-center justify-between border-t px-2 py-1">
        <span className="truncate text-[9.5px] text-muted-foreground">
          {pinned ? '已钉住查看' : sshRunning ? 'Agent 执行中…' : '实时跟随最新操作'}
        </span>
        <div className="flex items-center gap-0.5">
          <Button
            size="xs"
            variant="ghost"
            title="在主区展开 SSH 终端（完整交互）"
            onClick={() => {
              useUiStore.getState().expandWorkspace('terminal')
              leave()
            }}
          >
            <SquareTerminal className="size-3" />
            {surface === 'panel' ? '展开终端' : '终端'}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            title="在「连接管理」中查看完整审计"
            onClick={() => {
              useUiStore.getState().setAppView('connections')
              leave()
            }}
          >
            <PanelRight className="size-3" />
          </Button>
        </div>
      </div>
    </div>
  )
}

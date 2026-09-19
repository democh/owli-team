/**
 * 直播窗 · 数据库视图（M22+）：SQL 卡 + 结果预览 + 最近操作流。
 * 与「连接管理」控制台共用 connections-store：事件流与绑定状态零同步成本。
 * 交互：默认跟随最新操作；点击历史条目可钉住查看，再点取消回到跟随。
 *
 * M49：surface="panel" 时并入右栏「实况」面板（不触悬浮直播窗；
 * 底栏提供「展开工作台 + 连接管理」）；dock 面（默认）行为不变。
 */
import * as React from 'react'
import { ChevronDown, ChevronUp, Database, Maximize2, PanelRight } from 'lucide-react'
import type { OpEvent } from '@multi-agent/shared'
import { cn } from '../../lib/utils'
import { useConnectionsStore } from '../../stores/connections-store'
import { useLiveDockStore } from '../../stores/live-dock-store'
import { useSessionStore } from '../../stores/session-store'
import { useUiStore } from '../../stores/ui-store'
import { Button } from '../ui/button'

function durationText(ms?: number): string {
  if (ms === undefined) return ''
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

/** 动作徽标：db.query → 查询 / db.execute → 写入 / db.schema → 结构 */
function actionBadge(op: OpEvent): { label: string; className: string } {
  if (op.status === 'error') return { label: '失败', className: 'border-red-500/30 text-red-700' }
  if (op.action.includes('execute')) return { label: '写入', className: 'border-amber-500/30 text-amber-700' }
  if (op.action.includes('schema')) return { label: '结构', className: 'border-slate-500/30 text-slate-600' }
  return { label: '查询', className: 'border-sky-500/25 text-sky-700' }
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

export function DockDbView({ surface = 'dock' }: { surface?: 'dock' | 'panel' } = {}): React.JSX.Element {
  const currentId = useSessionStore((s) => s.currentId)
  const ops = useConnectionsStore((s) => s.ops)
  const loadedFor = useConnectionsStore((s) => s.sessionId)
  const [pinnedId, setPinnedId] = React.useState<string | undefined>(undefined)
  const [sqlOpen, setSqlOpen] = React.useState(false)

  /** 折叠浮窗（仅 dock surface；panel 面内嵌右栏，不触悬浮窗） */
  const leave = (): void => {
    if (surface === 'dock') useLiveDockStore.getState().minimize()
  }

  // 懒加载：直播窗独立打开时也能就位（与右栏共用的数据源）
  React.useEffect(() => {
    if (currentId && loadedFor !== currentId) void useConnectionsStore.getState().loadForSession(currentId)
  }, [currentId, loadedFor])

  const dbOps = React.useMemo(
    () => ops.filter((o) => o.kind === 'db' && (!currentId || o.sessionId === currentId)),
    [ops, currentId],
  )
  const pinned = pinnedId ? dbOps.find((o) => o.id === pinnedId) : undefined
  const focus = pinned ?? dbOps[0]

  if (!focus) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
        <Database className="size-4 text-muted-foreground/60" />
        <p className="text-[11.5px] leading-relaxed text-muted-foreground">暂无数据库操作</p>
        {surface === 'panel' && (
          <Button size="xs" variant="outline" onClick={() => useUiStore.getState().expandWorkspace('database')}>
            <Maximize2 className="mr-1 size-3" />
            展开工作台
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

  const badge = actionBadge(focus)
  const running = focus.status === 'running'

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
        {/* 概要条 */}
        <div className="flex items-center gap-1.5">
          <span className={cn('shrink-0 rounded-full border px-1.5 text-[9.5px]', badge.className)}>{badge.label}</span>
          <span className="min-w-0 flex-1 truncate text-[10.5px]" title={focus.target ?? focus.summary}>
            {focus.summary ?? focus.target ?? focus.action}
          </span>
          {running && <span className="size-1.5 animate-pulse rounded-full bg-sky-500" />}
          {focus.durationMs !== undefined && (
            <span className="shrink-0 text-[9.5px] text-muted-foreground">{durationText(focus.durationMs)}</span>
          )}
        </div>

        {/* SQL 卡 */}
        {focus.detail && (
          <div className="rounded-md border bg-muted/40">
            <pre className={cn('overflow-x-auto whitespace-pre-wrap break-all px-2 py-1.5 font-mono text-[10.5px] leading-relaxed', !sqlOpen && 'line-clamp-4')}>
              {focus.detail}
            </pre>
            {focus.detail.length > 160 && (
              <button
                type="button"
                className="flex w-full items-center justify-center gap-0.5 border-t py-0.5 text-[9.5px] text-muted-foreground hover:text-foreground"
                onClick={() => setSqlOpen((v) => !v)}
              >
                {sqlOpen ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
                {sqlOpen ? '收起' : '展开全文'}
              </button>
            )}
          </div>
        )}

        {/* 错误条 */}
        {focus.status === 'error' && (
          <div className="rounded-md border border-red-500/25 bg-red-500/5 px-2 py-1 text-[10.5px] text-red-700">
            {focus.summary ?? '执行失败'}
          </div>
        )}

        {/* 结果预览（仅 db.query 附带） */}
        {focus.preview && focus.preview.rows.length > 0 && (
          <div className="overflow-hidden rounded-md border">
            <div className="flex items-center justify-between border-b bg-muted/40 px-2 py-0.5 text-[9.5px] text-muted-foreground">
              <span>结果预览</span>
              <span>{focus.preview.rows.length} 行</span>
            </div>
            <div className="max-h-40 overflow-auto">
              <table className="w-full border-collapse text-[10px]">
                <thead className="sticky top-0 bg-muted/80 backdrop-blur">
                  <tr>
                    {focus.preview.columns.map((col) => (
                      <th key={col} className="max-w-32 truncate border-b px-1.5 py-0.5 text-left font-medium">
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {focus.preview.rows.map((row, i) => (
                    <tr key={i} className="border-b last:border-0">
                      {focus.preview!.columns.map((col) => (
                        <td key={col} className="max-w-32 truncate px-1.5 py-0.5 font-mono" title={cellText(row[col])}>
                          {cellText(row[col])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* 最近操作（点击钉住查看） */}
        {dbOps.length > 1 && (
          <div className="space-y-0.5 pt-0.5">
            <p className="px-0.5 text-[9.5px] font-medium text-muted-foreground">最近操作</p>
            {dbOps.slice(0, 4).map((op) => {
              const b = actionBadge(op)
              const active = focus.id === op.id
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

      {/* 底栏 */}
      <div className="flex shrink-0 items-center justify-between border-t px-2 py-1">
        <span className="truncate text-[9.5px] text-muted-foreground">
          {pinned ? '已钉住查看' : '实时跟随最新操作'}
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          {surface === 'panel' && (
            <Button
              size="xs"
              variant="ghost"
              title="在主区展开数据库工作台（对象树 / SQL 编辑 / 完整交互）"
              onClick={() => useUiStore.getState().expandWorkspace('database')}
            >
              <Maximize2 className="size-3" />
              工作台
            </Button>
          )}
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

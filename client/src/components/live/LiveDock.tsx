/**
 * 操作直播浮窗（M22+ LiveDock）：Agent 操作浏览器 / 数据库 / SSH 时的页面级实时视图。
 *
 * 三态生命周期：
 * - 卡片：三合一直播（浏览器帧流 / SQL 预览 / SSH 命令流），header 可拖、右下角可缩放；
 * - 胶囊：类型图标 + 状态点 + 摘要（整颗可拖），点击展开；
 * - 隐藏：本次运行静音（命令面板 / 入口按钮可重开）。
 *
 * 自适应：卡片宽 < 380px 时 tab 图标化（防 header 折行）；胶囊在运行中操作面 ≥2 时显示计数。
 * 不遮挡策略：默认锚定右下并避让右栏（>900px 时右栏约占 26% 视口宽）与底部 composer；
 * 拖动 / 缩放全程 clamp 在视口内，松手 14px 内吸附边缘；位置尺寸持久化（刷新还原）。
 */
import * as React from 'react'
import { Activity, ChevronUp, Database, Globe, GripVertical, Minus, Terminal, X } from 'lucide-react'
import type { OpEvent } from '@multi-agent/shared'
import { cn } from '../../lib/utils'
import { useBusyOpFaces } from '../../lib/use-busy-ops'
import { clampPos, clampSize, defaultPos, snapPos, usePointerGesture, type DockSize } from '../../lib/use-drag'
import { useBrowserStore } from '../../stores/browser-store'
import {
  DOCK_BOTTOM_CLEARANCE,
  DOCK_MAX_SIZE,
  DOCK_MIN_SIZE,
  useLiveDockStore,
} from '../../stores/live-dock-store'
import { DockBrowserView } from './DockBrowserView'
import { DockDbView } from './DockDbView'
import { DockSshView } from './DockSshView'

/** 胶囊尺寸（折叠态） */
const PILL_W = 280
const PILL_H = 36
/** 拖拽位移阈值：超过视为拖动，抑制尾随 click（防误触展开） */
const DRAG_SLOP = 4
/** 窄卡阈值：卡片宽度小于此值时 tab 图标化（窄于最小宽度的一半仍可读） */
const NARROW_W = 380

/** 胶囊摘要文案：数据库操作 · 影响 2 行 / 浏览器操作 · navigate / SSH 操作 · exit 0 */
function pillLabel(op?: OpEvent): string {
  if (!op) return '操作直播'
  const tail = op.summary ?? op.action.replace(/^(db|browser|ssh)\./, '')
  if (op.kind === 'db') return `数据库操作 · ${tail}`
  if (op.kind === 'ssh') return `SSH 操作 · ${tail}`
  return `浏览器操作 · ${tail}`
}

/** 胶囊类型图标：按最近操作类型（无操作 → 通用活动图标） */
function pillIcon(op?: OpEvent): React.ReactNode {
  if (op?.kind === 'db') return <Database className="size-3 shrink-0 text-muted-foreground" />
  if (op?.kind === 'ssh') return <Terminal className="size-3 shrink-0 text-muted-foreground" />
  if (op?.kind === 'browser') return <Globe className="size-3 shrink-0 text-muted-foreground" />
  return <Activity className="size-3 shrink-0 text-muted-foreground" />
}

function TabButton({
  active,
  icon,
  label,
  dot,
  iconOnly,
  onClick,
}: {
  active: boolean
  icon: React.ReactNode
  label: string
  dot?: boolean
  /** 窄卡自适应：仅图标（label 转 title 提示） */
  iconOnly?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={cn(
        'flex items-center gap-1 rounded py-0.5 text-[10.5px] transition-colors',
        iconOnly ? 'px-1' : 'px-1.5',
        active ? 'bg-accent font-medium' : 'text-muted-foreground hover:text-foreground',
      )}
      title={iconOnly ? label : undefined}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onClick}
    >
      {icon}
      {!iconOnly && label}
      {dot && <span className="size-1 animate-pulse rounded-full bg-emerald-500" />}
    </button>
  )
}

export function LiveDock(): React.JSX.Element | null {
  const visible = useLiveDockStore((s) => s.visible)
  const mode = useLiveDockStore((s) => s.mode)
  const tab = useLiveDockStore((s) => s.tab)
  const pos = useLiveDockStore((s) => s.pos)
  const size = useLiveDockStore((s) => s.size)
  const lastOp = useLiveDockStore((s) => s.lastOp)
  const streamStatus = useBrowserStore((s) => s.streamStatus)
  /** 运行中操作面（tool:call 实时推导，零服务端改动）：tab 状态点 / 胶囊计数共用 */
  const busyFaces = useBusyOpFaces()
  const busyCount = busyFaces.size

  /** 视口尺寸（clamp / 默认锚定 / resize 重定位用） */
  const [viewport, setViewport] = React.useState(() => ({
    vw: typeof window !== 'undefined' ? window.innerWidth : 1440,
    vh: typeof window !== 'undefined' ? window.innerHeight : 900,
  }))
  React.useEffect(() => {
    const onResize = (): void => setViewport({ vw: window.innerWidth, vh: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // 流所有权：直播窗可见即持有帧流引用（与右栏互补，归零才断流）
  React.useEffect(() => {
    if (!visible) return
    useBrowserStore.getState().retainView()
    return () => useBrowserStore.getState().releaseView()
  }, [visible])

  // Esc 折叠为胶囊（输入框 / 内容可编辑区内不响应，避免抢走输入中的按键）
  React.useEffect(() => {
    if (!visible || mode !== 'dock') return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const target = e.target as HTMLElement | null
      if (target?.closest('input, textarea, [contenteditable="true"]')) return
      useLiveDockStore.getState().minimize()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, mode])

  const es: DockSize = mode === 'pill' ? { w: PILL_W, h: PILL_H } : size
  // 默认锚点避让右栏；拖动过（pos 非 null）则完全尊重用户位置
  const rightPanel = viewport.vw > 900 ? Math.round(viewport.vw * 0.26) : 0
  const auto = defaultPos(es.w, es.h, viewport.vw - rightPanel, viewport.vh, 16, DOCK_BOTTOM_CLEARANCE)
  const actual = pos ? clampPos(pos.x, pos.y, es.w, es.h, viewport.vw, viewport.vh) : auto

  const movedRef = React.useRef(false)
  const dragOrigin = React.useRef<{ x: number; y: number } | null>(null)
  const resizeOrigin = React.useRef<DockSize | null>(null)

  const { onPointerDown: startDrag } = usePointerGesture({
    onStart: () => {
      movedRef.current = false
      dragOrigin.current = { x: actual.x, y: actual.y }
    },
    onDelta: (dx, dy) => {
      if (Math.abs(dx) + Math.abs(dy) > DRAG_SLOP) movedRef.current = true
      const origin = dragOrigin.current
      if (!origin) return
      const next = clampPos(origin.x + dx, origin.y + dy, es.w, es.h, viewport.vw, viewport.vh)
      useLiveDockStore.getState().move(next.x, next.y)
    },
    onEnd: () => {
      dragOrigin.current = null
      const p = useLiveDockStore.getState().pos
      if (!p) return
      const snapped = snapPos(p.x, p.y, es.w, es.h, viewport.vw, viewport.vh)
      useLiveDockStore.getState().move(snapped.x, snapped.y)
    },
  })

  const { onPointerDown: startResize } = usePointerGesture({
    onStart: () => {
      resizeOrigin.current = { w: es.w, h: es.h }
    },
    onDelta: (dx, dy) => {
      const origin = resizeOrigin.current
      if (!origin) return
      const next = clampSize(origin.w + dx, origin.h + dy, DOCK_MIN_SIZE, DOCK_MAX_SIZE, viewport.vw, viewport.vh)
      useLiveDockStore.getState().resize(next.w, next.h)
    },
    onEnd: () => {
      resizeOrigin.current = null
    },
  })

  if (!visible) return null
  const isPill = mode === 'pill'
  /** 窄卡自适应：卡片模式且宽 < 380px（胶囊宽度固定 280 不触发） */
  const narrow = !isPill && es.w < NARROW_W
  /** 胶囊活跃度：有操作面在跑或浏览器帧流已连接 */
  const pillLive = busyCount > 0 || streamStatus === 'open'

  return (
    <div
      role="dialog"
      aria-label="操作直播"
      className={cn(
        'fixed z-40 animate-fade-in-up',
        isPill
          ? 'rounded-full border bg-card/95 shadow-lg backdrop-blur-md'
          : 'flex flex-col overflow-hidden rounded-lg border bg-card/95 shadow-2xl backdrop-blur-md',
      )}
      style={{ left: actual.x, top: actual.y, width: es.w, height: es.h }}
    >
      {isPill ? (
        <div
          className="flex h-full cursor-grab select-none items-center gap-1.5 px-2.5 active:cursor-grabbing"
          title="点击展开操作直播（可拖动）"
          onPointerDown={startDrag}
          onClick={() => {
            if (movedRef.current) {
              movedRef.current = false
              return
            }
            useLiveDockStore.getState().openDock()
          }}
        >
          {pillIcon(lastOp)}
          <span
            className={cn(
              'size-1.5 shrink-0 rounded-full',
              pillLive ? 'animate-pulse bg-emerald-500' : 'bg-muted-foreground/40',
            )}
          />
          <span className="min-w-0 flex-1 truncate text-[11px]">{pillLabel(lastOp)}</span>
          {busyCount > 1 && (
            <span
              className="shrink-0 rounded-full bg-sky-500/15 px-1 text-[9.5px] font-medium text-sky-700"
              title={`${busyCount} 个操作面进行中`}
            >
              {busyCount}
            </span>
          )}
          <ChevronUp className="size-3.5 shrink-0 text-muted-foreground" />
          <button
            type="button"
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            title="关闭（本次运行不再自动弹出）"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              useLiveDockStore.getState().close()
            }}
          >
            <X className="size-3" />
          </button>
        </div>
      ) : (
        <div className="relative flex h-full min-h-0 flex-col">
          {/* header：拖动把手 + 标题 + tabs + 折叠 / 关闭 */}
          <div
            className="flex shrink-0 cursor-grab select-none items-center gap-1 border-b px-1.5 py-1 active:cursor-grabbing"
            onPointerDown={startDrag}
          >
            <GripVertical className="size-3 shrink-0 text-muted-foreground/50" />
            <span className="shrink-0 text-[11px] font-medium">操作直播</span>
            <div className="flex min-w-0 flex-1 items-center justify-center gap-0.5">
              <TabButton
                active={tab === 'browser'}
                icon={<Globe className="size-3" />}
                label="浏览器"
                dot={streamStatus === 'open' || busyFaces.has('browser')}
                iconOnly={narrow}
                onClick={() => useLiveDockStore.getState().setTab('browser')}
              />
              <TabButton
                active={tab === 'db'}
                icon={<Database className="size-3" />}
                label="数据库"
                dot={busyFaces.has('db')}
                iconOnly={narrow}
                onClick={() => useLiveDockStore.getState().setTab('db')}
              />
              <TabButton
                active={tab === 'ssh'}
                icon={<Terminal className="size-3" />}
                label="SSH"
                dot={busyFaces.has('ssh')}
                iconOnly={narrow}
                onClick={() => useLiveDockStore.getState().setTab('ssh')}
              />
            </div>
            <button
              type="button"
              className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              title="折叠为胶囊（Esc）"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => useLiveDockStore.getState().minimize()}
            >
              <Minus className="size-3.5" />
            </button>
            <button
              type="button"
              className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              title="关闭（本次运行不再自动弹出）"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => useLiveDockStore.getState().close()}
            >
              <X className="size-3.5" />
            </button>
          </div>

          <div className="min-h-0 flex-1">
            {tab === 'browser' ? <DockBrowserView /> : tab === 'db' ? <DockDbView /> : <DockSshView />}
          </div>

          {/* 缩放手柄（右下角） */}
          <div
            className="absolute bottom-0 right-0 size-3.5 cursor-nwse-resize"
            title="拖动调整大小"
            onPointerDown={(e) => {
              e.stopPropagation()
              startResize(e)
            }}
          />
        </div>
      )}
    </div>
  )
}

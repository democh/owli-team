/**
 * M52-A：dock 形态——左对话 + 右工作区（默认 360px，可拖宽 / 双击复位 / 折叠 / 关闭，localStorage 记忆；§7.2）。
 * 窄屏（<900px）：右区收起为底部抽屉（默认收起，§7.3-4）。
 * M58：折叠 / 关闭钮收口进面板标题行（PanelChrome 注入，不再占独立操作条）；拖拽零 React 渲染
 * （ref 直改宽度，抬手一次落态 + 落盘）、双击复位、键盘左右键（Shift 加速）调宽。
 */
import * as React from 'react'
import { ChevronLeft, ChevronRight, PanelRight, X } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useSceneCtx } from './context'
import { PanelChromeProvider, type PanelChrome } from './panels/chrome'
import { DOCK_DEFAULT, DOCK_MAX_W, DOCK_MIN_W, loadDockPref, saveDockPref, type DockPref } from './persist'
import { SceneDrawer } from './SceneDrawer'

/** 键盘调宽步长（px） */
const KEY_STEP = 16
const KEY_STEP_FAST = 48

export function DockStage({
  children,
  panel,
}: {
  children: React.ReactNode
  panel?: React.ReactNode
}): React.JSX.Element {
  const ctx = useSceneCtx()
  const narrow = ctx?.narrow ?? false
  const [pref, setPref] = React.useState<DockPref>(() => loadDockPref())
  const [resizing, setResizing] = React.useState(false)
  const asideRef = React.useRef<HTMLElement | null>(null)
  /** 拖拽中实时宽度（与 state 解耦：ref 直改 DOM，抬手才落态） */
  const widthRef = React.useRef(pref.width)

  const update = React.useCallback((patch: Partial<DockPref>): void => {
    setPref((p) => {
      const next = { ...p, ...patch }
      saveDockPref(next)
      return next
    })
  }, [])

  /** 落宽（拖拽抬手 / 键盘 / 双击复位共用）：同步 ref + 落态 + 落盘 */
  const commitWidth = React.useCallback((w: number): void => {
    widthRef.current = w
    setPref((p) => {
      const next = { ...p, width: w }
      saveDockPref(next)
      return next
    })
  }, [])

  // 拖拽异常中断（组件卸载）时恢复 body 光标与选择态
  React.useEffect(
    () => () => {
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    },
    [],
  )

  /**
   * 拖宽：左缘把手水平拖动（clamp 280–640）。拖拽中只改 ref + DOM（零 React 渲染），
   * 抬手一次落态 + 落盘；pointercancel 回滚到起始宽度。
   */
  const onGripDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    const startX = e.clientX
    const startW = widthRef.current
    let moved = false
    const move = (ev: PointerEvent): void => {
      const next = Math.min(Math.max(startW - (ev.clientX - startX), DOCK_MIN_W), DOCK_MAX_W)
      if (next === widthRef.current) return
      widthRef.current = next
      moved = true
      if (asideRef.current) asideRef.current.style.width = `${next}px`
    }
    const onUp = (): void => finish(true)
    const onCancel = (): void => finish(false)
    const finish = (commit: boolean): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      setResizing(false)
      if (commit) {
        if (moved) commitWidth(widthRef.current)
      } else {
        // 取消：回滚到起始宽度（不落盘）
        widthRef.current = startW
        if (asideRef.current) asideRef.current.style.width = `${startW}px`
      }
    }
    setResizing(true)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
  }

  /** 双击把手：复位默认宽度 */
  const onGripDoubleClick = (): void => {
    if (widthRef.current === DOCK_DEFAULT.width) return
    commitWidth(DOCK_DEFAULT.width)
  }

  /** 键盘左右键调宽（把手可聚焦；Shift 加速） */
  const onGripKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const step = e.shiftKey ? KEY_STEP_FAST : KEY_STEP
    // 左键 = 把手左移 = 工作区变宽（右缘固定）
    const delta = e.key === 'ArrowLeft' ? step : -step
    const next = Math.min(Math.max(widthRef.current + delta, DOCK_MIN_W), DOCK_MAX_W)
    if (next === widthRef.current) return
    commitWidth(next)
  }

  // M58：折叠 / 关闭钮注入面板标题行（与标题同行，替代旧版独立操作条）
  const chrome = React.useMemo<PanelChrome>(
    () => ({
      actions: (
        <>
          <button type="button" className="scene-dock-act" title="折叠工作区" onClick={() => update({ collapsed: true })}>
            <ChevronRight size={14} />
          </button>
          <button type="button" className="scene-dock-act" title="关闭工作区" onClick={() => update({ closed: true })}>
            <X size={13} />
          </button>
        </>
      ),
    }),
    [update],
  )

  // 无面板：退回纯对话流（不渲染工作区骨架）
  if (!panel) return <>{children}</>

  return (
    <PanelChromeProvider value={chrome}>
      <div className={cn('scene-dock', narrow && 'scene-dock-narrow', resizing && 'scene-dock-resizing')}>
        <div className="scene-dock-main">
          {children}
          {!narrow && pref.closed ? (
            <button type="button" className="scene-dock-reopen" title="显示工作区" onClick={() => update({ closed: false })}>
              <PanelRight size={14} />
              工作区
            </button>
          ) : null}
        </div>
        {narrow ? (
          <SceneDrawer>{panel}</SceneDrawer>
        ) : pref.closed ? null : pref.collapsed ? (
          <aside className="scene-dock-aside scene-dock-collapsed">
            <button type="button" className="scene-dock-expand" title="展开工作区" onClick={() => update({ collapsed: false })}>
              <ChevronLeft size={14} />
            </button>
            <span className="scene-dock-side-label">工作区</span>
          </aside>
        ) : (
          <aside ref={asideRef} className="scene-dock-aside" style={{ width: pref.width }}>
            <div
              className="scene-dock-grip"
              role="separator"
              aria-orientation="vertical"
              aria-label="拖动调整工作区宽度（双击复位，方向键微调）"
              aria-valuenow={pref.width}
              aria-valuemin={DOCK_MIN_W}
              aria-valuemax={DOCK_MAX_W}
              tabIndex={0}
              onPointerDown={onGripDown}
              onDoubleClick={onGripDoubleClick}
              onKeyDown={onGripKey}
            />
            <div className="scene-dock-panel">{panel}</div>
          </aside>
        )}
      </div>
    </PanelChromeProvider>
  )
}

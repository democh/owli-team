/**
 * 悬浮窗手势库（M22+ LiveDock）：窗口拖拽 / 缩放 / 边缘吸附。
 *
 * 设计要点：
 * - 纯函数（clampPos / snapPos / clampSize / defaultPos）与 UI 解耦，可独立单测；
 * - 指针手势走 Pointer Events + setPointerCapture，rAF 节流合并 move，拖出元素边界也不丢事件；
 * - 以「增量（delta）」为接口：调用方记录手势起始布局，每帧应用 origin + delta 后再 clamp。
 */
import * as React from 'react'

/** 视口边距（窗口距屏幕边缘的最小间隙） */
export const DOCK_MARGIN = 8
/** 松手吸附阈值（距边缘 ≤ 该值即吸附） */
export const DOCK_SNAP_THRESHOLD = 14

export interface DockPos {
  x: number
  y: number
}

export interface DockSize {
  w: number
  h: number
}

function viewportSize(): { vw: number; vh: number } {
  if (typeof window === 'undefined') return { vw: 1440, vh: 900 }
  return { vw: window.innerWidth, vh: window.innerHeight }
}

/** 位置钳制：窗口必须完整留在视口内（margin 为边距） */
export function clampPos(x: number, y: number, w: number, h: number, vw?: number, vh?: number, margin = DOCK_MARGIN): DockPos {
  const view = vw !== undefined && vh !== undefined ? { vw, vh } : viewportSize()
  const maxX = Math.max(margin, view.vw - w - margin)
  const maxY = Math.max(margin, view.vh - h - margin)
  return { x: Math.min(Math.max(Math.round(x), margin), maxX), y: Math.min(Math.max(Math.round(y), margin), maxY) }
}

/** 松手吸附：贴近任一边缘（阈值内）时贴合该边 */
export function snapPos(
  x: number,
  y: number,
  w: number,
  h: number,
  vw?: number,
  vh?: number,
  threshold = DOCK_SNAP_THRESHOLD,
  margin = DOCK_MARGIN,
): DockPos {
  const view = vw !== undefined && vh !== undefined ? { vw, vh } : viewportSize()
  let nx = x
  let ny = y
  if (Math.abs(x - margin) <= threshold) nx = margin
  else if (Math.abs(view.vw - (x + w) - margin) <= threshold) nx = view.vw - w - margin
  if (Math.abs(y - margin) <= threshold) ny = margin
  else if (Math.abs(view.vh - (y + h) - margin) <= threshold) ny = view.vh - h - margin
  return clampPos(nx, ny, w, h, view.vw, view.vh, margin)
}

/** 尺寸钳制：min–max 区间，且不超过视口可用范围 */
export function clampSize(w: number, h: number, min: DockSize, max: DockSize, vw?: number, vh?: number): DockSize {
  const view = vw !== undefined && vh !== undefined ? { vw, vh } : viewportSize()
  const limitW = Math.min(max.w, view.vw - DOCK_MARGIN * 2)
  const limitH = Math.min(max.h, view.vh - DOCK_MARGIN * 2)
  return {
    w: Math.min(Math.max(Math.round(w), Math.min(min.w, limitW)), limitW),
    h: Math.min(Math.max(Math.round(h), Math.min(min.h, limitH)), limitH),
  }
}

/** 默认位置：右下角锚定（避让底部 composer 区） */
export function defaultPos(w: number, h: number, vw?: number, vh?: number, anchor = 16, bottomClearance = 88): DockPos {
  const view = vw !== undefined && vh !== undefined ? { vw, vh } : viewportSize()
  return clampPos(view.vw - w - anchor, view.vh - h - bottomClearance, w, h, view.vw, view.vh)
}

export interface PointerGestureOptions {
  /** 手势开始（记录起始布局） */
  onStart?: () => void
  /** 相对起点的位移增量（已按 rAF 节流合并） */
  onDelta: (dx: number, dy: number) => void
  /** 手势结束（吸附 / 持久化） */
  onEnd?: () => void
}

/**
 * 指针拖拽手势：返回可直接挂到拖拽把手上的 onPointerDown。
 * move/up 监听挂在 window 上：指针移出元素 / 出窗后仍持续跟随。
 */
export function usePointerGesture({ onStart, onDelta, onEnd }: PointerGestureOptions): {
  onPointerDown: (e: React.PointerEvent) => void
} {
  const startRef = React.useRef<{ x: number; y: number } | null>(null)
  const frameRef = React.useRef<number | undefined>(undefined)
  const latestRef = React.useRef<{ dx: number; dy: number } | null>(null)
  const cleanupRef = React.useRef<(() => void) | undefined>(undefined)
  const cbRef = React.useRef({ onStart, onDelta, onEnd })
  cbRef.current = { onStart, onDelta, onEnd }

  const flush = React.useCallback((): void => {
    frameRef.current = undefined
    const latest = latestRef.current
    if (!latest) return
    latestRef.current = null
    cbRef.current.onDelta(latest.dx, latest.dy)
  }, [])

  const onPointerDown = React.useCallback(
    (e: React.PointerEvent): void => {
      if (e.button !== 0) return
      e.preventDefault()
      startRef.current = { x: e.clientX, y: e.clientY }
      cbRef.current.onStart?.()

      const onMove = (ev: PointerEvent): void => {
        const start = startRef.current
        if (!start) return
        latestRef.current = { dx: ev.clientX - start.x, dy: ev.clientY - start.y }
        if (frameRef.current === undefined) frameRef.current = requestAnimationFrame(flush)
      }
      const cleanup = (): void => {
        startRef.current = null
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        if (frameRef.current !== undefined) {
          cancelAnimationFrame(frameRef.current)
          frameRef.current = undefined
        }
        flush()
        cleanupRef.current = undefined
      }
      const onUp = (): void => {
        cleanup()
        cbRef.current.onEnd?.()
      }
      cleanupRef.current = cleanup
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [flush],
  )

  // 卸载保护：手势进行中被卸载时移除监听
  React.useEffect(() => () => cleanupRef.current?.(), [])

  return { onPointerDown }
}

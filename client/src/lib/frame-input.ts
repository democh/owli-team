/**
 * 浏览器帧画面输入桥（M22 · 右栏面板与直播窗共用）：
 * - 坐标换算：面板像素 → 页面视口坐标（按帧/视口尺寸缩放）；
 * - 鼠标 / 键盘 / 滚轮直通 CDP（HumanInput 语义），懒接管由 store 负责；
 * - 滚轮走原生 non-passive 监听：React 的 onWheel 为 passive，无法在接管态 preventDefault。
 */
import * as React from 'react'
import { useBrowserStore } from '../stores/browser-store'

/** CDP 修饰键位掩码（Alt=1 / Ctrl=2 / Meta=4 / Shift=8） */
export function modifiersOf(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0)
}

/** 直通键盘：特殊键白名单（其余走文本插入路径） */
const SPECIAL_KEYS = [
  'Tab',
  'Enter',
  'Escape',
  'Backspace',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  ' ',
]

export interface FrameInputHandlers {
  onMouseDown: (e: React.MouseEvent) => void
  onMouseUp: (e: React.MouseEvent) => void
  onMouseMove: (e: React.MouseEvent) => void
  onKeyDown: (e: React.KeyboardEvent) => void
  onContextMenu: (e: React.MouseEvent) => void
}

export function useBrowserFrameInput(
  wrapRef: React.RefObject<HTMLElement | null>,
  imgRef: React.RefObject<HTMLImageElement | null>,
): FrameInputHandlers {
  const session = useBrowserStore((s) => s.session)
  const frame = useBrowserStore((s) => s.frame)
  const mode = useBrowserStore((s) => s.mode)
  const streamStatus = useBrowserStore((s) => s.streamStatus)
  const lastMoveAt = React.useRef(0)

  /** 面板坐标 → 页面视口坐标（按帧/视口尺寸缩放） */
  const coordsOf = React.useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | undefined => {
      const img = imgRef.current
      if (!img) return undefined
      const rect = img.getBoundingClientRect()
      const viewportW = frame?.width ?? session?.viewport?.width ?? rect.width
      const viewportH = frame?.height ?? session?.viewport?.height ?? rect.height
      if (rect.width <= 0 || rect.height <= 0) return undefined
      return {
        x: Math.round(((clientX - rect.left) / rect.width) * viewportW),
        y: Math.round(((clientY - rect.top) / rect.height) * viewportH),
      }
    },
    [frame?.width, frame?.height, session?.viewport?.width, session?.viewport?.height, imgRef],
  )

  // 滚轮：原生监听（接管态 preventDefault；坐标换算实时读取）
  React.useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (useBrowserStore.getState().mode !== 'takeover') return
      const point = coordsOf(e.clientX, e.clientY)
      if (!point) return
      e.preventDefault()
      void useBrowserStore.getState().sendInput({
        kind: 'wheel',
        x: point.x,
        y: point.y,
        deltaX: Math.round(e.deltaX),
        deltaY: Math.round(e.deltaY),
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [session, frame, coordsOf, wrapRef])

  const sendAt = React.useCallback(
    async (
      e: React.MouseEvent,
      kind: 'mouse',
      type: 'down' | 'up' | 'move',
      button?: 'left' | 'right' | 'middle',
    ): Promise<void> => {
      const point = coordsOf(e.clientX, e.clientY)
      if (!point) return
      await useBrowserStore.getState().sendInput({
        kind,
        type,
        x: point.x,
        y: point.y,
        button: button ?? 'left',
        modifiers: modifiersOf(e),
      })
    },
    [coordsOf],
  )

  const buttonOf = (b: number): 'left' | 'right' | 'middle' => (b === 2 ? 'right' : b === 1 ? 'middle' : 'left')

  return {
    onMouseDown: (e) => void sendAt(e, 'mouse', 'down', buttonOf(e.button)),
    onMouseUp: (e) => void sendAt(e, 'mouse', 'up', buttonOf(e.button)),
    onMouseMove: (e) => {
      if (mode !== 'takeover' || streamStatus !== 'open') return
      const now = Date.now()
      if (now - lastMoveAt.current < 40) return // 移动节流：40ms
      lastMoveAt.current = now
      void sendAt(e, 'mouse', 'move')
    },
    onKeyDown: (e) => {
      if (useBrowserStore.getState().mode !== 'takeover') return
      const modifiers = modifiersOf(e)
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        void useBrowserStore.getState().sendInput({ kind: 'key', type: 'char', key: e.key, modifiers })
        return
      }
      if (SPECIAL_KEYS.includes(e.key)) {
        e.preventDefault()
        void useBrowserStore.getState().sendInput({ kind: 'key', type: 'down', key: e.key === ' ' ? 'Space' : e.key, modifiers })
      }
    },
    onContextMenu: (e) => {
      if (mode === 'takeover') e.preventDefault()
    },
  }
}

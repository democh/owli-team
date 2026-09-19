/**
 * xterm 运行时（M23）：把 xterm Terminal + FitAddon 封装为可替换的运行时对象。
 *
 * 设计：
 * - 与 store 解耦：store 只依赖 TerminalRuntime 接口（测试注入替身，不依赖真实终端渲染）；
 * - 尺寸自适配：ResizeObserver + FitAddon，尺寸变化经 onResize 回调转发（WS resize 帧）；
 * - 主题对齐暗色工作台（近黑底 + 柔和彩），滚动回看 5000 行。
 */
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

export interface TerminalRuntime {
  /** 终端 DOM 容器（视图挂载 / 切换 tab 时搬移，不销毁） */
  readonly element: HTMLElement
  /** 远程字节 → 终端（二进制帧路径） */
  writeBytes(bytes: Uint8Array): void
  /** 程序化提示行（重连 / 退出 / 错误提示；灰字不加噪） */
  writeNotice(text: string): void
  /** 键盘输入订阅（返回退订函数） */
  onData(cb: (data: string) => void): () => void
  /** 尺寸变化订阅（返回退订函数） */
  onResize(cb: (cols: number, rows: number) => void): () => void
  size(): { cols: number; rows: number }
  fit(): void
  focus(): void
  dispose(): void
}

/** 生产实现：xterm + fit；测试通过 __setRuntimeFactory 注入替身 */
export function createXtermRuntime(): TerminalRuntime {
  const term = new Terminal({
    cursorBlink: true,
    fontSize: 12,
    lineHeight: 1.25,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
    scrollback: 5_000,
    theme: {
      background: '#0b1220',
      foreground: '#dbe4f0',
      cursor: '#7dd3fc',
      selectionBackground: '#33415580',
      black: '#0f172a',
      red: '#f87171',
      green: '#4ade80',
      yellow: '#fbbf24',
      blue: '#60a5fa',
      magenta: '#c084fc',
      cyan: '#22d3ee',
      white: '#dbe4f0',
      brightBlack: '#475569',
      brightRed: '#fca5a5',
      brightGreen: '#86efac',
      brightYellow: '#fde68a',
      brightBlue: '#93c5fd',
      brightMagenta: '#d8b4fe',
      brightCyan: '#67e8f9',
      brightWhite: '#f8fafc',
    },
  })
  const fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  const element = document.createElement('div')
  element.className = 'h-full w-full'
  term.open(element)

  const fit = (): void => {
    try {
      fitAddon.fit()
    } catch {
      // 容器不可见（tab 未激活）时忽略：激活后视图会再调 fit
    }
  }
  const observer = new ResizeObserver(fit)
  observer.observe(element)

  const resizeListeners = new Set<(cols: number, rows: number) => void>()
  term.onResize(({ cols, rows }) => {
    for (const cb of resizeListeners) cb(cols, rows)
  })

  return {
    element,
    writeBytes: (bytes) => term.write(bytes),
    writeNotice: (text) => term.write(`\r\n\x1b[38;5;245m${text}\x1b[0m\r\n`),
    onData: (cb) => {
      const disposable = term.onData(cb)
      return () => disposable.dispose()
    },
    onResize: (cb) => {
      resizeListeners.add(cb)
      return () => resizeListeners.delete(cb)
    },
    size: () => ({ cols: term.cols, rows: term.rows }),
    fit,
    focus: () => term.focus(),
    dispose: () => {
      observer.disconnect()
      resizeListeners.clear()
      term.dispose()
    },
  }
}

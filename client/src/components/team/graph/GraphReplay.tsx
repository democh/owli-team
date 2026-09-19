/**
 * 时间轴回放条（§28.5，M22）：以「消息条数」为粒度重放会话如何长大。
 * - 拖动滑块 = 定格任意进度（自动暂停）；播放到末尾由调用方自动退出回实时
 * - 纯展示组件：进度 / 播放状态由调用方（GraphView）持有，图数据在 buildGraph 切片上推导
 * - 定位用 inset-x-0 + mx-auto + w-fit（不依赖 transform，安静模式禁用入场动画后不偏移）
 */
import * as React from 'react'
import { History, Pause, Play, X } from 'lucide-react'

export interface GraphReplayProps {
  /** 当前进度（已展示的消息条数，0..total） */
  index: number
  /** 消息总条数 */
  total: number
  playing: boolean
  /** 定格到指定进度（调用方负责暂停） */
  onSeek: (index: number) => void
  /** 播放 / 暂停 */
  onToggle: () => void
  /** 回到实时 */
  onExit: () => void
}

export function GraphReplay({ index, total, playing, onSeek, onToggle, onExit }: GraphReplayProps): React.JSX.Element {
  const pct = total > 0 ? Math.round((index / total) * 100) : 0
  return (
    <div
      role="group"
      aria-label="时间轴回放"
      className="graph-pop-in pointer-events-auto absolute inset-x-0 bottom-14 z-20 mx-auto flex w-fit max-w-[calc(100%-24px)] items-center gap-2 rounded-xl border bg-card/95 px-2.5 py-1.5 shadow-lg backdrop-blur-sm"
    >
      <span className="flex items-center gap-1 whitespace-nowrap text-[10.5px] text-muted-foreground">
        <History className="size-3" aria-hidden />
        回放
      </span>
      <button
        type="button"
        onClick={onToggle}
        title={playing ? '暂停' : '播放'}
        aria-label={playing ? '暂停回放' : '播放回放'}
        className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90"
      >
        {playing ? <Pause className="size-3" aria-hidden /> : <Play className="size-3" aria-hidden />}
      </button>
      <input
        type="range"
        min={0}
        max={total}
        value={index}
        aria-label="回放进度"
        onChange={(e) => onSeek(Number(e.target.value))}
        className="h-1 w-36 cursor-pointer accent-primary sm:w-44"
      />
      <span
        className="whitespace-nowrap tabular-nums text-[10.5px] text-muted-foreground"
        title={`已展示 ${index} / ${total} 条（${pct}%）`}
      >
        {index}/{total}
      </span>
      <span className="mx-0.5 h-4 w-px bg-border" aria-hidden />
      <button
        type="button"
        onClick={onExit}
        title="回到实时（Esc）"
        className="flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[10.5px] text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
      >
        <X className="size-3" aria-hidden />
        回到实时
      </button>
    </div>
  )
}

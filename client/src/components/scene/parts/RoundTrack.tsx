/**
 * M52-A 元件 1/12：回合轴（RoundTrack）——arena 中轴 / 多轮推进（§7.6）。
 * 数据源：消息波次（derive.wavesOf）或显式回合数；当前轮高亮，点击 onSeek 回填 / 定位。
 */
import * as React from 'react'
import { cn } from '../../../lib/utils'

export function RoundTrack({
  total,
  current,
  labels,
  onSeek,
}: {
  /** 回合总数（含未来轮） */
  total: number
  /** 当前回合（0 基） */
  current: number
  /** 每轮标签（缺省「第 N 轮」） */
  labels?: Record<number, string>
  onSeek?: (turn: number) => void
}): React.JSX.Element {
  const n = Math.max(total, current + 1, 1)
  return (
    <div className="scene-round-track" role="list" aria-label="回合轴">
      {Array.from({ length: n }, (_, i) => {
        const state = i < current ? 'done' : i === current ? 'active' : 'todo'
        return (
          <React.Fragment key={i}>
            {i > 0 ? <span className="scene-rt-line" aria-hidden /> : null}
            <button
              type="button"
              role="listitem"
              className={cn('scene-rt-node', `scene-rt-${state}`)}
              title={labels?.[i] ?? `第 ${i + 1} 轮`}
              onClick={() => onSeek?.(i)}
            >
              <span className="scene-rt-dot">{i + 1}</span>
              <span className="scene-rt-label">{labels?.[i] ?? `第 ${i + 1} 轮`}</span>
            </button>
          </React.Fragment>
        )
      })}
    </div>
  )
}

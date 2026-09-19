/**
 * M52-A 元件 1/12：回合轴（RoundTrack）——arena 中轴 / 多轮推进（§7.6）。
 * 数据源：消息波次（derive.wavesOf）或显式回合数；当前轮高亮，点击 onSeek 回填 / 定位。
 * M63（A4）：轮次判定徽标（`::: ruling` 派生）——节点附胜方色点，tooltip 带判定文案。
 */
import * as React from 'react'
import { cn } from '../../../lib/utils'

export function RoundTrack({
  total,
  current,
  labels,
  marks,
  markTitles,
  onSeek,
}: {
  /** 回合总数（含未来轮） */
  total: number
  /** 当前回合（0 基） */
  current: number
  /** 每轮标签（缺省「第 N 轮」） */
  labels?: Record<number, string>
  /** M63：轮次判定色点（side 语义键：long / short / draw） */
  marks?: Record<number, 'long' | 'short' | 'draw'>
  /** M63：判定 tooltip 文案（如「判定：正方」；缺省只展示轮次） */
  markTitles?: Record<number, string>
  onSeek?: (turn: number) => void
}): React.JSX.Element {
  const n = Math.max(total, current + 1, 1)
  return (
    <div className="scene-round-track" role="list" aria-label="回合轴">
      {Array.from({ length: n }, (_, i) => {
        const state = i < current ? 'done' : i === current ? 'active' : 'todo'
        const mark = marks?.[i]
        const title = labels?.[i] ?? (markTitles?.[i] ? `第 ${i + 1} 轮 · ${markTitles[i]}` : `第 ${i + 1} 轮`)
        return (
          <React.Fragment key={i}>
            {i > 0 ? <span className="scene-rt-line" aria-hidden /> : null}
            <button
              type="button"
              role="listitem"
              className={cn('scene-rt-node', `scene-rt-${state}`)}
              title={title}
              onClick={() => onSeek?.(i)}
            >
              <span className="scene-rt-dot">{i + 1}</span>
              <span className="scene-rt-label">{labels?.[i] ?? `第 ${i + 1} 轮`}</span>
              {mark ? <span className={cn('scene-rt-mark', `is-${mark}`)} aria-hidden /> : null}
            </button>
          </React.Fragment>
        )
      })}
    </div>
  )
}

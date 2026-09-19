/**
 * M52-A 元件 2/12：计分板（Scoreboard）——arena 顶部（§7.6）。
 * 数据源：判定累计 / 裁决状态（derive.verdictsOf）；纯展示件。
 */
import * as React from 'react'

export interface ScoreSide {
  label: string
  score: number
  color?: string
}

export function Scoreboard({
  left,
  right,
  note,
}: {
  left: ScoreSide
  right: ScoreSide
  /** 备注（如「第 2 轮进行中」） */
  note?: string
}): React.JSX.Element {
  return (
    <div className="scene-scoreboard" aria-label="计分板">
      <div className="scene-sb-side" style={left.color ? { color: left.color } : undefined}>
        <span className="scene-sb-label">{left.label}</span>
        <span className="scene-sb-score">{left.score}</span>
      </div>
      <div className="scene-sb-mid">
        <span className="scene-sb-vs">VS</span>
        {note ? <span className="scene-sb-note">{note}</span> : null}
      </div>
      <div className="scene-sb-side scene-sb-right" style={right.color ? { color: right.color } : undefined}>
        <span className="scene-sb-score">{right.score}</span>
        <span className="scene-sb-label">{right.label}</span>
      </div>
    </div>
  )
}

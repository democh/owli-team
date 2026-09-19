/**
 * M52-A 元件 2/12：计分板（Scoreboard）——arena 顶部（§7.6）。
 * M63（A1 交锋计量板）：三层读数（发言 / 主张 / 交锋 x/y）+ 轮次读数 + 终局徽标——
 * 读数由宿主注入（duelTally 派生）；交锋读数与终局徽标可点（回调缺省时保持静态展示）。
 * 无读数数据（speaks 缺省）时保持 v1 外观（标签 + 比分 + 备注）。
 */
import * as React from 'react'

export interface ScoreSide {
  label: string
  /** 裁决计数（终局胜负场次；v1 口径保留） */
  score: number
  color?: string
  /** M63 交锋计量（缺省不渲染读数行）：发言条数 / 主张数 / 提缺数 / 已响应数 */
  speaks?: number
  claims?: number
  findings?: number
  responded?: number
}

export function Scoreboard({
  left,
  right,
  note,
  verdictLabel,
  onSeekVerdict,
  onSeekCross,
}: {
  left: ScoreSide
  right: ScoreSide
  /** 备注（如「第 2 轮进行中 / 共 3 轮 / 未开赛」） */
  note?: string
  /** M63：终局徽标（如「正方胜 · 置信度 高」；缺省不渲染） */
  verdictLabel?: string
  /** M63：终局徽标点击（定位裁决消息） */
  onSeekVerdict?: () => void
  /** M63：交锋读数点击（定位该侧首个未响应缺陷） */
  onSeekCross?: (side: 'left' | 'right') => void
}): React.JSX.Element {
  const metrics = (s: ScoreSide, side: 'left' | 'right'): React.JSX.Element | null =>
    s.speaks !== undefined ? (
      <div className="scene-sb-metrics">
        <span className="scene-sb-metric">
          <b>{s.speaks}</b>发言
        </span>
        <span className="scene-sb-metric">
          <b>{s.claims ?? 0}</b>主张
        </span>
        <button
          type="button"
          className="scene-sb-metric scene-sb-cross"
          title="交锋：提缺 / 已响应；点击定位首个未响应缺陷"
          onClick={() => onSeekCross?.(side)}
        >
          <b>
            {s.findings ?? 0}
            <i>/{s.responded ?? 0}</i>
          </b>
          交锋
        </button>
      </div>
    ) : null

  return (
    <div className="scene-scoreboard" aria-label="计分板">
      <div className="scene-sb-side" style={left.color ? { color: left.color } : undefined}>
        <div className="scene-sb-top">
          <span className="scene-sb-label">{left.label}</span>
          <span className="scene-sb-score">{left.score}</span>
        </div>
        {metrics(left, 'left')}
      </div>
      <div className="scene-sb-mid">
        <span className="scene-sb-vs">VS</span>
        {note ? <span className="scene-sb-note">{note}</span> : null}
        {verdictLabel ? (
          <button type="button" className="scene-sb-verdict" title="查看终局裁决" onClick={onSeekVerdict}>
            {verdictLabel}
          </button>
        ) : null}
      </div>
      <div className="scene-sb-side scene-sb-right" style={right.color ? { color: right.color } : undefined}>
        <div className="scene-sb-top">
          <span className="scene-sb-score">{right.score}</span>
          <span className="scene-sb-label">{right.label}</span>
        </div>
        {metrics(right, 'right')}
      </div>
    </div>
  )
}

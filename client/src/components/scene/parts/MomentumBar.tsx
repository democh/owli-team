/**
 * M52-A 元件 5/12：局势条（MomentumBar）——arena / roundtable / versus（§7.6）。
 * 数据源：置信度 / 让步幅度聚合（-100..100）；中点向两侧生长。
 * 交互（轻量内联口径）：悬停 / 聚焦显示双读数浮层（左 50+v/2 : 右 50−v/2）；
 * aria-label 同步读数（键盘可达）。
 */
import * as React from 'react'

export function MomentumBar({
  value,
  leftLabel = '多方',
  rightLabel = '空方',
}: {
  /** -100（右满）.. 0（均势）.. 100（左满） */
  value: number
  leftLabel?: string
  rightLabel?: string
}): React.JSX.Element {
  const v = Math.max(-100, Math.min(100, Number.isFinite(value) ? value : 0))
  const left = Math.max(0, v)
  const right = Math.max(0, -v)
  const leftScore = Math.round(50 + v / 2)
  const rightScore = 100 - leftScore
  return (
    <div
      className="scene-momentum"
      tabIndex={0}
      data-momentum
      aria-label={`局势条：${leftLabel} ${leftScore} 比 ${rightScore} ${rightLabel}`}
    >
      <div className="scene-mo-labels">
        <span>{leftLabel}</span>
        <span>{rightLabel}</span>
      </div>
      <div className="scene-mo-track">
        <span className="scene-mo-fill scene-mo-left" style={{ width: `${left / 2}%` }} />
        <span className="scene-mo-mid" aria-hidden />
        <span className="scene-mo-fill scene-mo-right" style={{ width: `${right / 2}%` }} />
      </div>
      <span className="scene-mo-tip" aria-hidden>
        <b>{leftLabel}</b> {leftScore} : {rightScore} <b>{rightLabel}</b>
      </span>
    </div>
  )
}

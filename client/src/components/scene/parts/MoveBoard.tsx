/**
 * M63（批一 G4）：博弈走子板（invest versus 面板）——```game 围栏派生走子条目：
 * 轮次 / 模型 / 标题 / 快照文件名 / 随机种子（可复制）。
 * - 点条目 → 定位走子消息（GameBlock 全图在消息内查看）；点种子 → 复制；
 * - 段尾固定合规声明「模型推演，非预测」；无走子 → 宿主不渲染本段。
 */
import * as React from 'react'
import { Check, Copy, Dices } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { GAME_MODEL_LABELS } from '../../../lib/game-spec'
import type { SceneGameMove } from '../derive'
import { copyText } from '../../chat/md-ext/CopyButton'

function srcBase(src: string): string {
  const parts = src.split(/[\\/]/)
  return parts[parts.length - 1] ?? src
}

export function MoveBoard({
  moves,
  onFocus,
}: {
  moves: SceneGameMove[]
  onFocus?: (messageId: string) => void
}): React.JSX.Element | null {
  const [copied, setCopied] = React.useState<number | null>(null)
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  React.useEffect(() => () => clearTimeout(timer.current), [])
  if (moves.length === 0) return null

  const onCopySeed = (seed: number, index: number): void => {
    void copyText(String(seed)).then((ok) => {
      if (!ok) return
      setCopied(index)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(null), 1600)
    })
  }

  return (
    <div className="scene-moves" data-move-board="" role="list" aria-label="博弈走子">
      {moves.map((m, i) => (
        <div
          key={`${m.messageId}-${i}`}
          className="scene-move"
          role="listitem"
          data-model={m.model ?? 'none'}
        >
          <button type="button" className="scene-move-main" title="定位走子消息" onClick={() => onFocus?.(m.messageId)}>
            {m.turnIndex !== undefined ? <span className="scene-move-round">R{m.turnIndex + 1}</span> : null}
            <span className="scene-move-model">{m.model ? GAME_MODEL_LABELS[m.model] : '推演'}</span>
            <span className="scene-move-title">{m.title || '（未命名推演）'}</span>
            {m.src ? <span className="scene-move-src">{srcBase(m.src)}</span> : null}
          </button>
          {m.seed !== undefined ? (
            <button
              type="button"
              className={cn('scene-move-seed', copied === i && 'is-copied')}
              title={`随机种子 ${m.seed}（点击复制，可复现）`}
              onClick={() => onCopySeed(m.seed!, i)}
            >
              {copied === i ? <Check size={11} /> : <Copy size={11} />}
              {m.seed}
            </button>
          ) : null}
        </div>
      ))}
      <div className="scene-moves-note">
        <Dices className="size-3" aria-hidden />
        模型推演，非预测（参数与种子随快照可复现）
      </div>
    </div>
  )
}

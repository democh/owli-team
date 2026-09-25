/**
 * M63（批一 A5）：对抗参与条——arena 中轴（裁决流之下）五枚药丸按钮：
 * 加一轮 / 叫停并裁决 / 倾向·左 / 倾向·右 / 倾向·僵持。
 * 一切点击只回填 Composer 草稿（TEMPLATES 统一模板库，ADR 0064 / 0118）；
 * 未决点引用源 = 最新 ruling 的「未决点」条目（缺省走通用文案）。
 * 元素级：宿主在「左右席均非空且已开赛」时渲染；点击后按钮短暂显示「已填入草稿」。
 */
import * as React from 'react'
import { cn } from '../../../lib/utils'
import { TEMPLATES } from '../../../lib/pk'

type ActionKey = 'extra' | 'swap' | 'stop' | 'lean-left' | 'lean-right' | 'lean-draw'

export function ArenaActions({
  leftLabel,
  rightLabel,
  center,
  point,
  onInsert,
}: {
  leftLabel: string
  rightLabel: string
  /** 中轴席成员名（裁判 / 教练；@ 对象） */
  center: string
  /** 最新未决点（加一轮模板引用；缺省走通用文案） */
  point?: string
  onInsert: (text: string) => void
}): React.JSX.Element {
  const [flashed, setFlashed] = React.useState<ActionKey | null>(null)
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  React.useEffect(() => () => clearTimeout(timer.current), [])

  const fire = (key: ActionKey, text: string): void => {
    onInsert(text)
    setFlashed(key)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setFlashed(null), 1400)
  }

  const items: Array<{ key: ActionKey; label: string; title: string; text: () => string }> = [
    {
      key: 'extra',
      label: '加一轮',
      title: '要求双方再交锋一轮',
      text: () => TEMPLATES.extraRound(center, point),
    },
    {
      key: 'swap',
      label: '互换立场',
      title: '两队全员对调重赛至少一轮（检验同证据异结论）',
      text: () => TEMPLATES.swapSides(center),
    },
    {
      key: 'stop',
      label: '叫停并裁决',
      title: '要求中轴席收束并给出终局裁决',
      text: () => TEMPLATES.stopAndVerdict(center),
    },
    { key: 'lean-left', label: `倾向·${leftLabel}`, title: `表态倾向「${leftLabel}」`, text: () => TEMPLATES.leanSide(center, leftLabel) },
    { key: 'lean-right', label: `倾向·${rightLabel}`, title: `表态倾向「${rightLabel}」`, text: () => TEMPLATES.leanSide(center, rightLabel) },
    { key: 'lean-draw', label: '倾向·僵持', title: '表态倾向「僵持」', text: () => TEMPLATES.leanSide(center, '僵持') },
  ]

  return (
    <div className="scene-arena-actions" data-arena-actions="" role="toolbar" aria-label="对抗操作">
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          className={cn('scene-aa-btn', flashed === it.key && 'is-flashed')}
          data-aa={it.key}
          title={it.title}
          onClick={() => fire(it.key, it.text())}
        >
          {flashed === it.key ? '已填入草稿' : it.label}
        </button>
      ))}
    </div>
  )
}

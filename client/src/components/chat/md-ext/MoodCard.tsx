/**
 * M40（§104，HL-4）：情绪签到卡（`::: mood`）——1–5 档点选（本地）+ 「提交签到」回填。
 * 回填草稿「今日状态：N/5（档位词）。请据此调整今日建议。」（只写草稿不直发，ADR 0064）；
 * 无档位词命中不阻塞（1–5 固定档）；流式期间禁点。
 */
import * as React from 'react'
import { Smile, Send } from 'lucide-react'
import { useUiStore } from '../../../stores/ui-store'
import { cn } from '../../../lib/utils'
import { useStreaming } from './streaming'

/** 档位词（1–5；展示与回填共用） */
export const MOOD_LABELS = ['低落', '疲惫', '一般', '不错', '很好'] as const

export function moodDraft(level: number): string {
  const label = MOOD_LABELS[level - 1] ?? ''
  return `今日状态：${level}/5（${label}）。请据此调整今日建议。`
}

export function MoodCard({
  title,
  children,
}: {
  title?: string
  children?: React.ReactNode
}): React.JSX.Element {
  const insertToComposer = useUiStore((s) => s.insertToComposer)
  const streaming = useStreaming()
  const [level, setLevel] = React.useState<number | undefined>(undefined)

  return (
    <div className="md-mood" data-mood-card="">
      <div className="md-mood-head">
        <Smile className="size-3.5" aria-hidden />
        <span className="md-mood-title">{title || '情绪签到'}</span>
        <span className="md-mood-hint">1–5 档</span>
      </div>
      <div className="md-mood-levels" role="group" aria-label="今日状态 1-5 档">
        {MOOD_LABELS.map((label, i) => {
          const n = i + 1
          return (
            <button
              type="button"
              key={n}
              className={cn('md-mood-level', level === n && 'is-picked')}
              disabled={streaming}
              aria-pressed={level === n}
              title={`${n}/5 · ${label}`}
              data-mood-level={n}
              onClick={() => setLevel(n)}
            >
              <span className="md-mood-num">{n}</span>
              <span className="md-mood-label">{label}</span>
            </button>
          )
        })}
      </div>
      {children}
      <div className="md-mood-foot">
        <button
          type="button"
          className="md-mood-submit"
          disabled={streaming || level === undefined}
          title={level === undefined ? '先选一个档位' : '写入输入框（可编辑后发送）'}
          data-mood-submit=""
          onClick={() => insertToComposer(moodDraft(level!))}
        >
          <Send className="size-3" />
          提交签到
        </button>
      </div>
    </div>
  )
}

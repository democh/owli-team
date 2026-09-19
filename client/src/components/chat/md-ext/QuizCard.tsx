/**
 * M40（§104，HL-3）：每日一练卡（`::: quiz`）——题目（arg）+ 选项点选（本地单选）+ 「提交给成员」回填。
 * 数据：条目 `- A | 选项文本`（data-rows）；回填草稿「我的答案：X。请批改并讲解。」（只写草稿不直发，ADR 0064）；
 * 流式期间禁点；fail-safe → raw 兜底。
 */
import * as React from 'react'
import { GraduationCap, Send } from 'lucide-react'
import { useUiStore } from '../../../stores/ui-store'
import { cn } from '../../../lib/utils'
import { useStreaming } from './streaming'
import type { QuizOption } from './remark-ext'

/** data-rows JSON → 选项（非法 JSON / 形状不符 → 空数组，走 raw 回退） */
export function parseQuiz(json: string | undefined): QuizOption[] {
  if (!json) return []
  try {
    const arr: unknown = JSON.parse(json)
    if (!Array.isArray(arr)) return []
    const out: QuizOption[] = []
    for (const v of arr) {
      if (!v || typeof v !== 'object') continue
      const o = v as { key?: unknown; text?: unknown }
      if (typeof o.key !== 'string' || o.key === '') continue
      out.push({ key: o.key, text: typeof o.text === 'string' ? o.text : '' })
    }
    return out
  } catch {
    return []
  }
}

export function QuizCard({
  title,
  rows: rowsRaw,
  raw,
  children,
}: {
  title?: string
  rows?: string
  raw?: string
  children?: React.ReactNode
}): React.JSX.Element {
  const insertToComposer = useUiStore((s) => s.insertToComposer)
  const streaming = useStreaming()
  const options = React.useMemo(() => parseQuiz(rowsRaw), [rowsRaw])
  const [picked, setPicked] = React.useState<string | undefined>(undefined)

  if (options.length === 0) {
    return (
      <div className="md-quiz">
        {raw ? <pre className="md-quiz-static">{raw}</pre> : null}
        {children}
      </div>
    )
  }

  return (
    <div className="md-quiz" data-quiz-card="">
      <div className="md-quiz-head">
        <GraduationCap className="size-3.5" aria-hidden />
        <span className="md-quiz-title">{title || '每日一练'}</span>
        <span className="md-quiz-count">{options.length} 选项</span>
      </div>
      <div className="md-quiz-options" role="group" aria-label="选项">
        {options.map((o) => (
          <button
            type="button"
            key={o.key}
            className={cn('md-quiz-option', picked === o.key && 'is-picked')}
            disabled={streaming}
            aria-pressed={picked === o.key}
            data-quiz-option={o.key}
            onClick={() => setPicked(o.key)}
          >
            <span className="md-quiz-key">{o.key}</span>
            <span className="md-quiz-text">{o.text}</span>
          </button>
        ))}
      </div>
      {children}
      <div className="md-quiz-foot">
        <button
          type="button"
          className="md-quiz-submit"
          disabled={streaming || picked === undefined}
          title={picked === undefined ? '先选一个选项' : '把答案写入输入框（可编辑后发送）'}
          data-quiz-submit=""
          onClick={() => insertToComposer(`我的答案：${picked}。请批改并讲解。`)}
        >
          <Send className="size-3" />
          提交给成员
        </button>
      </div>
    </div>
  )
}

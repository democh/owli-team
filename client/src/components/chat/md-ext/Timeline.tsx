/**
 * 时间轴（::: timeline [标题]，条目 `- 日期 | 事项 | 负责人`）：
 * - 条目由 remark-ext finalize 拆为 data-* 结构化节点：日期 chip + 事项 + 负责人 chip；
 * - 「今天」高亮：支持 2026-07-01 / 07-01 / 7月1日 三种日期形态（仅做展示提示，不校验日期合法性）；
 * - 点负责人 chip → 回填 `@负责人 ` 草稿（与纪要待办同语义；ADR 0064：只写草稿不直发）；
 * - 非条目子节点原样渲染在时间轴之后。
 */
import * as React from 'react'
import { cn } from '../../../lib/utils'
import { useUiStore } from '../../../stores/ui-store'
import { useStreaming } from './streaming'

/** 判断条目日期是否为「今天」（三种常见形态；无法识别 → false） */
export function isTodayDate(value: string): boolean {
  const t = value.trim()
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth() + 1
  const d = now.getDate()
  let yy: number | undefined
  let mm: number | undefined
  let dd: number | undefined
  const full = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t)
  if (full) {
    yy = Number(full[1])
    mm = Number(full[2])
    dd = Number(full[3])
  } else {
    const short = /^(\d{1,2})-(\d{1,2})$/.exec(t)
    if (short) {
      mm = Number(short[1])
      dd = Number(short[2])
    } else {
      const cn = /^(\d{1,2})月(\d{1,2})日/.exec(t)
      if (cn) {
        mm = Number(cn[1])
        dd = Number(cn[2])
      }
    }
  }
  if (mm === undefined || dd === undefined) return false
  if (yy !== undefined && yy !== y) return false
  return mm === m && dd === d
}

export function Timeline({ title, children }: { title?: string; children?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="md-timeline">
      {title ? <div className="md-timeline-title">{title}</div> : null}
      {children}
    </div>
  )
}

export function TimelineItem({
  date,
  text,
  owner,
  raw,
}: {
  date: string
  text: string
  owner: string
  raw: string
}): React.JSX.Element {
  const today = isTodayDate(date)
  const streaming = useStreaming()
  const insertToComposer = useUiStore((s) => s.insertToComposer)
  return (
    <div className="md-timeline-item" title={raw || undefined}>
      <span className={cn('md-timeline-date', today && 'is-today')}>{date}</span>
      <div className="md-timeline-main">
        <span className="md-timeline-text">{text}</span>
        {today ? <span className="md-timeline-today">今天</span> : null}
        {owner ? (
          <button
            type="button"
            className="md-timeline-owner"
            disabled={streaming}
            title={streaming ? '生成中不可派活' : `派活：回填 @${owner} 草稿（确认后发送）`}
            onClick={() => insertToComposer(`@${owner} `)}
          >
            {owner}
          </button>
        ) : null}
      </div>
    </div>
  )
}

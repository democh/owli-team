/**
 * M42（§71.2）：会议声明卡（::: meeting [标题]）——议题清单由 remark 侧转 data-items JSON。
 * - 三态：待议 / 进行中 / 已决（`- [>] / - [x]` 由容器声明）；
 * - 交互遵循「容器更新优先，本地勾选兜底」：容器显式标记（已决 / 进行中）的条目为静态展示；
 *   待议条目可点选为本地已决（sessionStorage `ma:meeting:<sessionId>`，跨组件即时同步——
 *   议题进度条读取同一数据源）；再点取消；
 * - 流式期间行不可点；解析失败 / 空条目 → raw 兜底静态渲染，其余内容照常。
 */
import * as React from 'react'
import { Check } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { effectiveState, parseMeetingItems, toggleMeetingCheck, useMeetingChecks, type MeetingState } from '../../../lib/meeting'
import { useMessageInfo } from './message-context'
import { useStreaming } from './streaming'

const STATE_LABEL: Record<MeetingState, string> = {
  todo: '待议',
  doing: '进行中',
  done: '已决',
}

export function MeetingCard({
  title,
  items: itemsRaw,
  raw,
  children,
}: {
  title?: string
  items?: string
  raw?: string
  children?: React.ReactNode
}): React.JSX.Element {
  const info = useMessageInfo()
  const streaming = useStreaming()
  const parsed = React.useMemo(() => parseMeetingItems(itemsRaw), [itemsRaw])
  const checks = useMeetingChecks(info?.sessionId)
  const localDone = React.useMemo(() => new Set(checks), [checks])

  // 无条目（解析失败 / 空容器）：raw 兜底静态渲染，其余内容照常
  if (parsed.length === 0) {
    return (
      <div className="md-meeting">
        {raw ? <pre className="md-meeting-static">{raw}</pre> : null}
        {children}
      </div>
    )
  }

  const states = parsed.map((it) => effectiveState(it, localDone))
  const doneCount = states.reduce((n, s) => n + (s === 'done' ? 1 : 0), 0)

  const toggle = (i: number): void => {
    toggleMeetingCheck(info?.sessionId, parsed[i]!.label)
  }

  return (
    <div className="md-meeting">
      <div className="md-meeting-head">
        <span className="md-meeting-title">{title || '会议议题'}</span>
        <span className="md-meeting-count">
          {doneCount}/{parsed.length} 已决
        </span>
      </div>
      <div className="md-meeting-list" role="list">
        {parsed.map((it, i) => {
          const state = states[i]!
          const interactive = it.state === 'todo'
          return (
            <button
              key={`${it.label}-${i}`}
              type="button"
              role="listitem"
              className={cn('md-meeting-row', `is-${state}`, interactive && 'is-interactive')}
              data-state={state}
              disabled={!interactive || streaming}
              aria-pressed={state === 'done'}
              title={interactive ? `本地标记${state === 'done' ? '待议' : '已决'}（容器更新优先）` : STATE_LABEL[state]}
              onClick={() => toggle(i)}
            >
              <span className="md-meeting-mark" aria-hidden>
                {state === 'done' ? <Check className="size-2.5" strokeWidth={3} /> : null}
                {state === 'doing' ? <span className="md-meeting-pulse" /> : null}
              </span>
              <span className="md-meeting-label">{it.label}</span>
              <span className="md-meeting-state">{STATE_LABEL[state]}</span>
            </button>
          )
        })}
      </div>
      {children}
    </div>
  )
}

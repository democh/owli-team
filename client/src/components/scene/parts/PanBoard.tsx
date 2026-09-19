/**
 * M52-A 元件 12/12：盘面板（PanBoard）——chartboard 面板核心件（§7.6，M51-E `::: pan` 复用）。
 * 多盘 tabs + 盘面渲染（复用 md-ext PanCard 行渲染）+「看解读」回填；activeId 受控（面板管持久化）。
 * M54-C：会话上下文注入（视图记忆 / 足迹）+ 当前盘「存为档案」（存档入口在工具行，卡内 ⭐ 隐藏）。
 */
import * as React from 'react'
import { cn } from '../../../lib/utils'
import { PanCard } from '../../chat/md-ext/PanCard'
import { saveArchive } from '../../chat/md-ext/pan/archive'
import { PAN_KIND_LABEL, PAN_KINDS } from '../../chat/md-ext/remark-ext'
import type { SceneRow } from '../derive'

export interface PanChart {
  /** 稳定键（messageId:seq） */
  id: string
  kind: string
  title: string
  fields: SceneRow[]
  items: SceneRow[]
  /** 容器原文（无结构化行时兜底渲染） */
  raw: string
}

export function PanBoard({
  charts,
  activeId,
  onActive,
  onInterpret,
  sessionId,
  onArchived,
}: {
  charts: PanChart[]
  activeId?: string
  onActive?: (id: string) => void
  /**「看解读」回填 */
  onInterpret?: (chart: PanChart) => void
  /** 会话 id（面板路径：盘面视图记忆 / 足迹 / 档案键；缺省静默降级） */
  sessionId?: string
  /** 存档成功通知（外层刷新档案抽屉） */
  onArchived?: () => void
}): React.JSX.Element {
  const active = charts.find((c) => c.id === activeId) ?? charts[0]
  const [note, setNote] = React.useState('')
  const noteTimer = React.useRef<number | null>(null)
  React.useEffect(
    () => () => {
      if (noteTimer.current !== null) window.clearTimeout(noteTimer.current)
    },
    [],
  )

  /** 当前盘存为档案（§5.3；同内容去重，上限 20 FIFO 溢出提示） */
  const saveActive = (): void => {
    if (!sessionId || !active) return
    const { status } = saveArchive(sessionId, {
      kind: active.kind,
      title: active.title,
      fields: JSON.stringify(active.fields),
      items: JSON.stringify(active.items),
      raw: active.raw,
      savedAt: Date.now(),
    })
    setNote(status === 'saved' ? '已存为档案' : status === 'dup' ? '已在档案中' : '已存（档案满，移除最旧）')
    if (noteTimer.current !== null) window.clearTimeout(noteTimer.current)
    noteTimer.current = window.setTimeout(() => setNote(''), 1800)
    if (status !== 'dup') onArchived?.()
  }

  return (
    <div className="scene-panboard">
      <div className="scene-pb-tabs" role="tablist" aria-label="盘面切换">
        {charts.map((c) => {
          const kindLabel = (PAN_KINDS as readonly string[]).includes(c.kind)
            ? PAN_KIND_LABEL[c.kind as keyof typeof PAN_KIND_LABEL]
            : '盘面'
          return (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={active?.id === c.id}
              className={cn('scene-pb-tab', active?.id === c.id && 'scene-pb-tab-on')}
              onClick={() => onActive?.(c.id)}
            >
              <span className="scene-pb-tab-kind">{kindLabel}</span>
              <span className="scene-pb-tab-title">{c.title}</span>
            </button>
          )
        })}
      </div>
      {active ? (
        <div className="scene-pb-body">
          <PanCard
            kind={active.kind}
            title={active.title}
            fields={JSON.stringify(active.fields)}
            items={JSON.stringify(active.items)}
            raw={active.raw}
            sessionId={sessionId}
            sourceKey={active.id}
            hideArchive
          />
          <div className="scene-pb-actions">
            {sessionId ? (
              <button type="button" className="scene-pb-arch" aria-live="polite" onClick={saveActive}>
                {note || '存为档案'}
              </button>
            ) : null}
            {onInterpret ? (
              <button type="button" className="scene-pb-interpret" onClick={() => onInterpret(active)}>
                看解读
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

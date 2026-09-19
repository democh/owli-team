/**
 * M52-A 元件 8/12：管道看板（KanbanBoard）——console 面板核心件（§7.6）。
 * 数据源：管道容器 / 派生分组；点卡 onCard 回填（推进 / 追问）。
 */
import * as React from 'react'
import { cn } from '../../../lib/utils'

export interface KanbanCard {
  id: string
  title: string
  meta?: string
}

export interface KanbanColumn {
  id: string
  title: string
  cards: KanbanCard[]
}

export function KanbanBoard({
  columns,
  onCard,
}: {
  columns: KanbanColumn[]
  onCard?: (card: KanbanCard, column: KanbanColumn) => void
}): React.JSX.Element {
  return (
    <div className="scene-kanban" role="list" aria-label="管道看板">
      {columns.map((col) => (
        <div className="scene-kb-col" key={col.id} role="listitem">
          <div className="scene-kb-head">
            <span className="scene-kb-title">{col.title}</span>
            <span className="scene-kb-count">{col.cards.length}</span>
          </div>
          <div className="scene-kb-cards">
            {col.cards.length === 0 ? (
              <div className="scene-kb-empty">—</div>
            ) : (
              col.cards.map((card) => (
                <button type="button" className={cn('scene-kb-card')} key={card.id} onClick={() => onCard?.(card, col)}>
                  <span className="scene-kb-card-title">{card.title}</span>
                  {card.meta ? <span className="scene-kb-card-meta">{card.meta}</span> : null}
                </button>
              ))
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * M52-A 元件 7/12：议程推进条（AgendaTrack）——roundtable / dock 顶部（§7.6）。
 * 数据源：agenda 资产 + 会话进度（当前步骤由外部传入）；点击 onPick 回填对应草稿。
 * M42（§71.3）：支持 heading —— 容器化议题时展示「议题 x/n · 当前：XXX」摘要行。
 * M59 修订：横向步骤条（节点 + 连线 + 标签）替代纵向清单——摘要行改贴卡片带右端（不再铺满、
 * 不再逐行重复状态字）；节点三态（完成实心 / 进行中实心 + 光环 / 待办空心），连线随前步着色。
 */
import * as React from 'react'
import { cn } from '../../../lib/utils'

export interface AgendaStep {
  label: string
  state: 'todo' | 'doing' | 'done'
  /** 回填草稿（点步骤时写入 Composer） */
  prompt?: string
}

export function AgendaTrack({
  items,
  heading,
  onPick,
}: {
  items: AgendaStep[]
  /** 摘要行（议题进度 / 完成度；空则省略） */
  heading?: string
  onPick?: (step: AgendaStep) => void
}): React.JSX.Element {
  return (
    <div className="scene-agenda" role="list" aria-label="议程推进">
      <div className="scene-ag-track" role="presentation">
        {items.map((it, i) => (
          <React.Fragment key={`${it.label}-${i}`}>
            {i > 0 ? (
              <span className="scene-ag-link" data-state={items[i - 1]!.state === 'done' ? 'done' : 'todo'} aria-hidden />
            ) : null}
            <button
              type="button"
              role="listitem"
              className={cn('scene-ag-step', `scene-ag-${it.state}`)}
              data-state={it.state}
              title={it.label}
              onClick={() => onPick?.(it)}
            >
              <span className="scene-ag-node" aria-hidden />
              <span className="scene-ag-label">{it.label}</span>
            </button>
          </React.Fragment>
        ))}
      </div>
      {heading ? (
        <div className="scene-ag-heading" role="presentation" data-ag-heading>
          {heading}
        </div>
      ) : null}
    </div>
  )
}

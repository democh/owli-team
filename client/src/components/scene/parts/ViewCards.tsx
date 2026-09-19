/**
 * M63（批一 N1）：四路观点卡（invest versus 面板）——`::: claim` 扩展字段（视角 / 倾向 / 置信度）
 * 聚合呈现：基本面 / 技术面 / 舆情 / 量化各一卡（未知视角追加在后）。
 * - 点卡体 → 回填「补充依据与置信度」模板；点定位钮 → 跳主张消息；
 * - 分歧提示（倾向同时含多与空）→ 顶部分歧 chip → 回填裁决模板（invest 协议第 8 条口径）。
 */
import * as React from 'react'
import { Crosshair, SplitSquareHorizontal } from 'lucide-react'
import type { AgentDefinition } from '@multi-agent/shared'
import { cn } from '../../../lib/utils'
import { stanceToneOf } from '../../../lib/pk'
import { AgentAvatar } from '../../agents/AgentAvatar'

export interface ViewCardData {
  perspective: string
  stance?: string
  confidence?: string
  claim: string
  reasons: number
  messageId: string
  agent?: AgentDefinition
}

export function ViewCards({
  views,
  divergent,
  onAsk,
  onFocus,
  onAdjudicate,
}: {
  views: ViewCardData[]
  /** 存在多空分歧（倾向集合同时含多与空） */
  divergent: boolean
  onAsk: (view: ViewCardData) => void
  onFocus?: (messageId: string) => void
  onAdjudicate?: () => void
}): React.JSX.Element | null {
  if (views.length === 0) return null
  return (
    <div className="scene-views">
      {divergent ? (
        <button
          type="button"
          className="scene-views-split"
          title="请主管按来源可靠性 > 时效 > 一致性裁决"
          onClick={onAdjudicate}
        >
          <SplitSquareHorizontal className="size-3" aria-hidden />
          存在多空分歧（{views.filter((v) => stanceToneOf(v.stance ?? '') !== 'none').length} 路）· 请主管裁决
        </button>
      ) : null}
      <div className="scene-views-grid" role="list" aria-label="四路观点">
        {views.map((v) => (
          <div
            className={cn('scene-view-card', `is-${stanceToneOf(v.stance ?? '')}`)}
            key={v.perspective}
            role="listitem"
            data-perspective={v.perspective}
          >
            <button type="button" className="scene-view-main" title="补充依据与置信度" onClick={() => onAsk(v)}>
              <span className="scene-view-head">
                {v.agent ? <AgentAvatar agent={v.agent} size={16} animated={false} className="shrink-0" /> : null}
                <span className="scene-view-perspective">{v.perspective}</span>
                {v.stance ? <span className="scene-view-stance">{v.stance}</span> : null}
                {v.confidence ? <span className="scene-view-conf">置信度 {v.confidence}</span> : null}
              </span>
              <span className="scene-view-claim">{v.claim}</span>
              <span className="scene-view-meta">{v.reasons} 条依据</span>
            </button>
            <button
              type="button"
              className="scene-view-locate"
              title="定位主张消息"
              onClick={() => onFocus?.(v.messageId)}
            >
              <Crosshair size={11} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * M43（§72.4）：评审判定卡（PK-3）——mode=review 且命中 ReviewRecord（runId + agentId 匹配）时
 * 挂载于回合卡顶部；匹配失败的评审消息回退常规「评审」徽章（零回归）。
 * - verdict 徽章（pass 绿 / conditional 琥珀 / fail 红）+ target 引用 + findings 列表 + 证据计数；
 * - fail 附「状态联动说明」（服务端口径：关联步骤 / 计划置 blocked，修复后可复审）；
 * - 元数据口径复用 PlanReviewCard.VERDICT_META（任务面板同源，单点维护）。
 */
import * as React from 'react'
import { FileText, ListChecks, Paperclip } from 'lucide-react'
import type { ReviewRecord } from '@multi-agent/shared'
import { Badge } from '../ui/badge'
import { VERDICT_META } from './PlanReviewCard'

/** 评审目标格式化：plan:pl_x → 计划 pl_x；artifact:path → 交付件 path；未知前缀原样 */
export function formatReviewTarget(target: string): string {
  const m = /^(plan|step|artifact|message):(.+)$/.exec(target)
  if (!m) return target
  const kind = m[1] === 'plan' ? '计划' : m[1] === 'step' ? '步骤' : m[1] === 'artifact' ? '交付件' : '消息'
  return `${kind} ${m[2]!.trim()}`
}

/** 头部判定徽章（替代常规「评审」徽章；判定标签与任务面板同源） */
export function ReviewVerdictBadge({ verdict }: { verdict: ReviewRecord['verdict'] }): React.JSX.Element {
  const meta = VERDICT_META[verdict]
  return (
    <Badge variant={meta.variant} title="本回合为评审范式：输出结构化评审判定">
      {meta.label}
    </Badge>
  )
}

/** 评审判定卡（消息内嵌）：判定 + 目标 + 发现清单 + 证据 */
export function ReviewVerdictCard({ review }: { review: ReviewRecord }): React.JSX.Element {
  const meta = VERDICT_META[review.verdict]
  return (
    <div className="review-verdict-card" data-verdict={review.verdict}>
      <div className="rvc-head">
        <span className="rvc-title">评审判定</span>
        <Badge variant={meta.variant}>{meta.label}</Badge>
        <span className="rvc-target" title={review.target}>
          <FileText className="size-3" />
          {formatReviewTarget(review.target)}
        </span>
      </div>
      {review.findings.length > 0 ? (
        <ul className="rvc-findings" role="list">
          {review.findings.map((f, i) => (
            <li key={i} className="rvc-finding">
              <ListChecks className="size-3" />
              {f}
            </li>
          ))}
        </ul>
      ) : null}
      {review.evidence.length > 0 ? (
        <div className="rvc-evidence">
          <Paperclip className="size-3" />
          证据 {review.evidence.length} 条
        </div>
      ) : null}
      {review.verdict === 'fail' ? (
        <div className="rvc-note">未通过：关联步骤 / 计划已阻塞（blocked），修复后可复审。</div>
      ) : null}
    </div>
  )
}

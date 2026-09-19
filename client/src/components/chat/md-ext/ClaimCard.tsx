/**
 * M43（§72.6）：主张卡（`::: claim [主张]`）——主张 → 论据 → 证据的分层折叠（复用论断树元件，
 * §7.6 元件 6/12 的首次消费）。
 * - 结构由 remark 侧转 data-detail（细节行）/ data-reasons JSON；
 * - 点论据 → composerInsert 追问模板（统一回填语义，ADR 0064 / 0118，只写草稿不直发）；
 * - 解析失败 → raw 兜底静态渲染，其余内容照常。
 */
import * as React from 'react'
import { claimReasonsOfLines, parseClaimReasons, type ClaimNodeData } from '../../../lib/pk'
import { useUiStore } from '../../../stores/ui-store'
import { ClaimTree } from '../../scene/parts/ClaimTree'
import { useMessageInfo } from './message-context'

export function ClaimCard({
  title,
  detail,
  reasons: reasonsRaw,
  raw,
  children,
}: {
  title?: string
  detail?: string
  reasons?: string
  raw?: string
  children?: React.ReactNode
}): React.JSX.Element {
  // 消息 id 仅用于潜在回源（当前渲染不依赖）；与 MeetingCard 同构读取，保持容器上下文一致
  useMessageInfo()
  const parsed = React.useMemo(() => {
    const fromJson = parseClaimReasons(reasonsRaw)
    if (fromJson.length > 0) return fromJson
    return raw ? claimReasonsOfLines(raw.split('\n')) : []
  }, [reasonsRaw, raw])

  if (!title && parsed.length === 0) {
    return (
      <div className="md-claim">
        {raw ? <pre className="md-claim-static">{raw}</pre> : null}
        {children}
      </div>
    )
  }

  const node: ClaimNodeData = {
    claim: title || '（未命名主张）',
    ...(detail ? { detail } : {}),
    reasons: parsed,
  }

  return (
    <div className="md-claim" data-claim-card="">
      <ClaimTree
        nodes={[node]}
        onPick={(text) => useUiStore.getState().insertToComposer(`请补充论据「${text}」的证据与出处。`)}
      />
      {children}
    </div>
  )
}

/**
 * M43（§72.3）：缺陷-修补配对卡（`::: findings [标题]`）——条目由 remark 侧转 data-items JSON。
 * - 每行 = 缺陷编号 + 描述 + 修补方向（配对不完整 → 行级降级「未附修补方向」）；
 * - 「已响应」由后续消息提及缺陷编号推导（lib/pk.respondedSig；primitive 订阅——
 *   签名未变不触发重渲染，see ADR 0117 显式结构口径）；
 * - 点「缺陷 N」→ 回填「回应缺陷 N：」草稿（ADR 0064：只写草稿不直发；发送后点亮「已响应」）；
 * - 解析失败 → raw 兜底静态渲染，其余内容照常。
 */
import * as React from 'react'
import { CheckCheck } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { findingIdsOfSig, findingsOfLines, parseFindingsItems, respondedSig } from '../../../lib/pk'
import { useSessionStore } from '../../../stores/session-store'
import { useUiStore } from '../../../stores/ui-store'
import { useMessageInfo } from './message-context'
import { useStreaming } from './streaming'

export function FindingsCard({
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
  const insertToComposer = useUiStore((s) => s.insertToComposer)
  const parsed = React.useMemo(() => {
    const fromJson = parseFindingsItems(itemsRaw)
    if (fromJson.length > 0) return fromJson
    return raw ? findingsOfLines(raw.split('\n')) : []
  }, [itemsRaw, raw])

  const messageId = info?.messageId ?? ''
  const sig = useSessionStore((s) => (messageId ? respondedSig(s, messageId) : ''))
  const responded = React.useMemo(() => findingIdsOfSig(sig), [sig])

  if (parsed.length === 0) {
    return (
      <div className="md-findings">
        {raw ? <pre className="md-findings-static">{raw}</pre> : null}
        {children}
      </div>
    )
  }

  const respondedCount = parsed.reduce((n, f) => n + (responded.has(f.id) ? 1 : 0), 0)

  return (
    <div className="md-findings">
      <div className="md-findings-head">
        <span className="md-findings-title">{title || '缺陷与修补'}</span>
        <span className="md-findings-count">{`${respondedCount}/${parsed.length} 已响应`}</span>
      </div>
      <div className="md-findings-list" role="list">
        {parsed.map((f, i) => {
          const hit = responded.has(f.id)
          return (
            <div
              key={`${f.id}-${i}`}
              role="listitem"
              className={cn('md-findings-row', hit && 'is-responded')}
              data-responded={hit ? 'true' : 'false'}
            >
              <button
                type="button"
                className="md-findings-id"
                disabled={streaming}
                title={streaming ? '生成中不可回应' : `回应缺陷 ${f.id}（写入草稿，可编辑后发送）`}
                onClick={() => insertToComposer(`回应缺陷 ${f.id}：`)}
              >
                {`缺陷 ${f.id}`}
              </button>
              <span className="md-findings-body">
                <span className="md-findings-text">{f.text}</span>
                {f.fix ? (
                  <span className="md-findings-fix">{`修补：${f.fix}`}</span>
                ) : (
                  <span className="md-findings-nofix">未附修补方向</span>
                )}
              </span>
              {hit ? (
                <span className="md-findings-badge" title="后续消息已引用该缺陷编号">
                  <CheckCheck className="size-3" />
                  已响应
                </span>
              ) : null}
            </div>
          )
        })}
      </div>
      {children}
    </div>
  )
}

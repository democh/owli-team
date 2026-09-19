/**
 * M38（§92）：点子卡（`::: idea [N] 标题`）——研讨产物最小单元（消息流与汇聚板「点子池」共用）。
 * - 结构由 remark 侧转 data-fields（`键：值`）/ data-items（`- 键 | 值`）JSON；
 *   字段「状态：候选|入选|被毙」→ data-status（无状态 → 无徽标）；
 * - 「点亮」本地计数（sessionStorage `ma:sc:lights:<sessionId>`，键含 messageId+编号+标题；ADR 0145），
 *   与汇聚板点子池跨实例同步（LIGHTS_EVENT）；
 * - 「深入」→ composerInsert 草稿（统一回填语义，ADR 0064；只写草稿不直发）；
 * - 解析失败 / 无内容 → raw 兜底静态渲染。
 */
import * as React from 'react'
import { PenLine, Star } from 'lucide-react'
import { useUiStore } from '../../../stores/ui-store'
import { cn } from '../../../lib/utils'
import { useSceneLights } from '../../scene/persist'
import { useMessageInfo } from './message-context'
import { useStreaming } from './streaming'
import { IDEA_STATUS_LABEL, ideaStatusOf, type IdeaStatus, type PanRow } from './remark-ext'

/** data-fields JSON → 字段行（非法 JSON / 形状不符 → 空数组，走 raw / children 回退） */
export function parseIdeaFields(json: string | undefined): PanRow[] {
  if (!json) return []
  try {
    const arr: unknown = JSON.parse(json)
    if (!Array.isArray(arr)) return []
    const out: PanRow[] = []
    for (const v of arr) {
      if (!v || typeof v !== 'object') continue
      const o = v as { label?: unknown; value?: unknown }
      if (typeof o.label !== 'string' || typeof o.value !== 'string') continue
      out.push({ label: o.label, value: o.value })
    }
    return out
  } catch {
    return []
  }
}

/** 状态 prop 容错（data-status 非法词 → 从字段行重算） */
function statusOf(status: string | undefined, fields: readonly PanRow[]): IdeaStatus {
  if (status === 'candidate' || status === 'chosen' || status === 'rejected') return status
  return ideaStatusOf(fields)
}

export function IdeaCard({
  no,
  title,
  fields: fieldsRaw,
  status: statusRaw,
  raw,
  children,
  /** 覆盖回填回调（汇聚板传入场景 ctx.insert；缺省走 ui-store 草稿回填） */
  onInsert,
  /** 覆盖点亮态（汇聚板与卡片同源 hook；缺省卡片自持） */
  litOverride,
  onToggleLight,
}: {
  no?: string
  title?: string
  fields?: string
  status?: string
  raw?: string
  children?: React.ReactNode
  onInsert?: (text: string) => void
  litOverride?: boolean
  onToggleLight?: () => void
}): React.JSX.Element {
  const info = useMessageInfo()
  const streaming = useStreaming()
  const insertToComposer = useUiStore((s) => s.insertToComposer)
  const fields = React.useMemo(() => parseIdeaFields(fieldsRaw), [fieldsRaw])
  const view = React.useMemo(() => fields.filter((f) => f.label !== '状态'), [fields])
  const status = statusOf(statusRaw, fields)

  const [selfLights, toggleSelf] = useSceneLights(info?.sessionId ?? '')
  const ideaKey = info ? `${info.messageId}:${no ?? ''}:${title ?? ''}` : ''
  const lit = litOverride ?? (ideaKey !== '' && selfLights.has(ideaKey))
  const onLight = onToggleLight ?? ((): void => toggleSelf(ideaKey))

  const insert = onInsert ?? ((text: string): void => insertToComposer(text))

  if (title === undefined && view.length === 0) {
    return (
      <div className="md-idea">
        {raw ? <pre className="md-idea-static">{raw}</pre> : null}
        {children}
      </div>
    )
  }

  return (
    <div className="md-idea" data-idea-card="">
      <div className="md-idea-head">
        {no ? <span className="md-idea-no">{no}</span> : <span className="md-idea-dot" aria-hidden />}
        <span className="md-idea-title">{title || '（未命名点子）'}</span>
        {status !== 'none' ? <span className={cn('md-idea-status', `is-${status}`)}>{IDEA_STATUS_LABEL[status]}</span> : null}
        <button
          type="button"
          className={cn('md-idea-light', lit && 'is-lit')}
          aria-pressed={lit}
          disabled={streaming}
          title={lit ? '取消点亮' : '点亮这个点子（本地记录）'}
          onClick={onLight}
        >
          <Star className="size-3" fill={lit ? 'currentColor' : 'none'} />
          {lit ? '已点亮' : '点亮'}
        </button>
      </div>
      {view.length > 0 ? (
        <div className="md-idea-fields">
          {view.map((f, i) => (
            <span className="md-idea-field" key={i}>
              <b>{f.label}</b>
              {f.value}
            </span>
          ))}
        </div>
      ) : null}
      {children}
      <div className="md-idea-foot">
        <button
          type="button"
          className="md-idea-dig"
          disabled={streaming}
          title="把这个点子写入输入框（可编辑后发送）"
          onClick={() => insert(`请深入展开点子「${title || '本点子'}」，给出最小可行版本与验证方式。`)}
        >
          <PenLine className="size-3" />
          深入
        </button>
      </div>
    </div>
  )
}

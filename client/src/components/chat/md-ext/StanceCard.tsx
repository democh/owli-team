/**
 * M66（N4）：立场卡（`::: stance <立场方>`）——立场三要素（主张 / 核心关切 / 被忽视视角）+ 依据。
 * - 结构由 remark 侧转 data-fields / data-items JSON（字段行 `主张：…` 等；条目 `- 依据 | …`）；
 * - 三要素按固定序渲染（缺省字段按出现顺序排后）；依据文本走 U1 证据等级徽标（无等级可点击补标）；
 * - 「推演关切」→ composerInsert 草稿（统一回填语义；只写草稿不直发）；
 * - 解析失败 → raw 兜底静态渲染（不空白、不丢内容）。
 */
import * as React from 'react'
import { Users } from 'lucide-react'
import { parseOfferRows, TEMPLATES } from '../../../lib/pk'
import { EVIDENCE_LABEL, gradeOf } from '../../../lib/evidence'
import { cn } from '../../../lib/utils'
import { useUiStore } from '../../../stores/ui-store'
import { useMessageInfo } from './message-context'
import { useStreaming } from './streaming'

/** 立场首选字段顺序（未出现的跳过；其余字段按出现顺序排后） */
const STANCE_KEYS = ['主张', '核心关切', '被忽视视角']

export function StanceCard({
  title,
  fields: fieldsRaw,
  items: itemsRaw,
  raw,
  children,
  /** 覆盖回填回调（消息流缺省走 ui-store 草稿回填） */
  onInsert,
}: {
  /** 立场方（容器首参） */
  title?: string
  fields?: string
  items?: string
  raw?: string
  children?: React.ReactNode
  onInsert?: (text: string) => void
}): React.JSX.Element {
  // 消息 id 仅用于潜在回源（渲染不依赖）；与 DecisionCard 同构读取保持容器上下文一致
  useMessageInfo()
  const streaming = useStreaming()
  const insertToComposer = useUiStore((s) => s.insertToComposer)
  const insert = onInsert ?? ((text: string): void => insertToComposer(text))
  const fields = React.useMemo(() => parseOfferRows(fieldsRaw), [fieldsRaw])
  const items = React.useMemo(() => parseOfferRows(itemsRaw), [itemsRaw])

  const ordered = React.useMemo(() => {
    const rest = [...fields]
    const head: typeof fields = []
    for (const key of STANCE_KEYS) {
      const idx = rest.findIndex((f) => f.label === key)
      if (idx >= 0) head.push(rest.splice(idx, 1)[0]!)
    }
    return [...head, ...rest]
  }, [fields])

  const role = title || '相关方'
  const care = ordered.find((f) => f.label === '核心关切')?.value

  if (ordered.length === 0 && items.length === 0) {
    return (
      <div className="md-stance">
        {raw ? <pre className="md-stance-static">{raw}</pre> : null}
        {children}
      </div>
    )
  }

  return (
    <div className="md-stance" data-stance-card="">
      <div className="md-stance-head">
        <Users className="size-3.5" aria-hidden />
        <span className="md-stance-badge">立场</span>
        <span className="md-stance-title">{role}</span>
      </div>
      <div className="md-stance-body">
        {ordered.map((f, i) => (
          <div className="md-stance-sec" key={i}>
            <span className="md-stance-k">{f.label}</span>
            <span className="md-stance-v">{f.value}</span>
          </div>
        ))}
      </div>
      {items.length > 0 ? (
        <div className="md-stance-items">
          {items.map((it, i) => {
            const grade = gradeOf(it.value)
            return (
              <div className="md-stance-item" key={i}>
                <span className="md-stance-item-label">{it.label || '依据'}</span>
                <span className="md-stance-item-text">{it.value}</span>
                {grade ? (
                  <span className={cn('scene-claim-grade', `is-${grade}`)} title={`证据等级：${EVIDENCE_LABEL[grade]}`}>
                    {EVIDENCE_LABEL[grade]}
                  </span>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : null}
      {children}
      <div className="md-stance-foot">
        <button
          type="button"
          className="md-stance-ask"
          disabled={streaming}
          title="写入输入框（可编辑后发送）"
          onClick={() => insert(TEMPLATES.stanceAsk(role, care ?? '其核心诉求'))}
        >
          推演关切
        </button>
      </div>
    </div>
  )
}

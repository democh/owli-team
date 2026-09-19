/**
 * M38（§92）：来源卡组（`::: sources`）——研究来源墙（域名 chip + 可信度徽章 高/中/低）。
 * - 结构由 remark 侧转 data-sources JSON（parseSourceLines 单一实现：标题 | URL | 日期 | 要点 | 可信度）；
 * - 「引用」→ composerInsert 草稿（统一回填语义，ADR 0064；只写草稿不直发）；
 * - 解析失败 → raw 兜底静态渲染。
 */
import * as React from 'react'
import { BookOpen, Quote } from 'lucide-react'
import { useUiStore } from '../../../stores/ui-store'
import { cn } from '../../../lib/utils'
import { useMessageInfo } from './message-context'
import { useStreaming } from './streaming'
import type { SourceItem } from './remark-ext'

const LEVEL_LABEL: Record<Exclude<SourceItem['level'], 'none'>, string> = {
  high: '高可信',
  mid: '中可信',
  low: '低可信',
}

/** data-sources JSON → 条目数组（非法 JSON / 形状不符 → 空数组，走 raw 回退） */
export function parseSources(json: string | undefined): SourceItem[] {
  if (!json) return []
  try {
    const arr: unknown = JSON.parse(json)
    if (!Array.isArray(arr)) return []
    const out: SourceItem[] = []
    for (const v of arr) {
      if (!v || typeof v !== 'object') continue
      const o = v as Record<string, unknown>
      if (typeof o.title !== 'string' || o.title === '') continue
      const level = o.level === 'high' || o.level === 'mid' || o.level === 'low' ? o.level : 'none'
      out.push({
        title: o.title,
        url: typeof o.url === 'string' ? o.url : '',
        domain: typeof o.domain === 'string' ? o.domain : '',
        date: typeof o.date === 'string' ? o.date : '',
        note: typeof o.note === 'string' ? o.note : '',
        level,
      })
    }
    return out
  } catch {
    return []
  }
}

export function SourcesCard({
  title,
  sources: sourcesRaw,
  raw,
  children,
  /** 覆盖回填回调（汇聚板传入场景 ctx.insert；缺省走 ui-store 草稿回填） */
  onInsert,
}: {
  title?: string
  sources?: string
  raw?: string
  children?: React.ReactNode
  onInsert?: (text: string) => void
}): React.JSX.Element {
  const info = useMessageInfo()
  const streaming = useStreaming()
  const insertToComposer = useUiStore((s) => s.insertToComposer)
  const items = React.useMemo(() => parseSources(sourcesRaw), [sourcesRaw])
  const insert = onInsert ?? ((text: string): void => insertToComposer(text))

  if (items.length === 0) {
    return (
      <div className="md-sources">
        {raw ? <pre className="md-sources-static">{raw}</pre> : null}
        {children}
      </div>
    )
  }

  // 消息上下文仅用于潜在回源（渲染不依赖），与 ClaimCard 同构读取保持容器上下文一致
  void info

  return (
    <div className="md-sources" data-sources-card="">
      <div className="md-sources-head">
        <BookOpen className="size-3.5" aria-hidden />
        <span className="md-sources-title">{title || '来源清单'}</span>
        <span className="md-sources-count">{items.length} 条</span>
      </div>
      <div className="md-sources-list">
        {items.map((s, i) => (
          <div className="md-source-row" key={i} data-level={s.level}>
            <div className="md-source-main">
              {s.url !== '' ? (
                <a className="md-source-title" href={s.url} target="_blank" rel="noreferrer">
                  {s.title}
                </a>
              ) : (
                <span className="md-source-title">{s.title}</span>
              )}
              {s.domain !== '' ? <span className="md-source-domain">{s.domain}</span> : null}
              {s.date !== '' ? <span className="md-source-date">{s.date}</span> : null}
              {s.level !== 'none' ? <span className={cn('md-source-level', `is-${s.level}`)}>{LEVEL_LABEL[s.level]}</span> : null}
              <button
                type="button"
                className="md-source-quote"
                disabled={streaming}
                title="引用这条来源（写入输入框，可编辑后发送）"
                onClick={() =>
                  insert(`引用来源《${s.title}》${s.url !== '' ? `（${s.url}）` : ''}：请纳入证据链并核对可信度。`)
                }
              >
                <Quote className="size-3" />
                引用
              </button>
            </div>
            {s.note !== '' ? <div className="md-source-note">{s.note}</div> : null}
          </div>
        ))}
      </div>
      {children}
    </div>
  )
}

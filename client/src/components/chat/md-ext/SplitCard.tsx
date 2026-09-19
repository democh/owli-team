/**
 * M66（N4）：共识分歧板（`::: split <标题>`）——条目 `- 共识 | …` / `- 分歧 | …` / `- 存疑 | …`。
 * - 三列并列（共识绿 / 分歧橙 / 存疑灰），分歧置中主位；未知键条目落「其他」行（fail-safe 不丢内容）；
 * - 点分歧条目 → 回填「中间路径」模板；点存疑条目 → 回填「核实路径」模板（只写草稿不直发）；
 * - 解析失败 / 空条目 → raw 兜底静态渲染。
 */
import * as React from 'react'
import { Scale } from 'lucide-react'
import { parseOfferRows, TEMPLATES } from '../../../lib/pk'
import { cn } from '../../../lib/utils'
import { useUiStore } from '../../../stores/ui-store'
import { useMessageInfo } from './message-context'
import { useStreaming } from './streaming'

type SplitBucket = 'consensus' | 'split' | 'doubt' | 'other'

/** 条目键 → 分桶（共识 / 分歧 / 存疑；未知键 → other） */
export function splitBucketOf(label: string): SplitBucket {
  const l = label.trim()
  if (/共识|一致/.test(l)) return 'consensus'
  if (/分歧|争议/.test(l)) return 'split'
  if (/存疑|待核|未定/.test(l)) return 'doubt'
  return 'other'
}

const BUCKET_CAP: Record<Exclude<SplitBucket, 'other'>, string> = {
  consensus: '共识',
  split: '分歧',
  doubt: '存疑',
}

export function SplitCard({
  title,
  items: itemsRaw,
  raw,
  children,
  /** 覆盖回填回调（消息流缺省走 ui-store 草稿回填） */
  onInsert,
}: {
  title?: string
  items?: string
  raw?: string
  children?: React.ReactNode
  onInsert?: (text: string) => void
}): React.JSX.Element {
  // 消息 id 仅用于潜在回源（渲染不依赖）；与 StanceCard 同构读取保持容器上下文一致
  useMessageInfo()
  const streaming = useStreaming()
  const insertToComposer = useUiStore((s) => s.insertToComposer)
  const insert = onInsert ?? ((text: string): void => insertToComposer(text))
  const items = React.useMemo(() => parseOfferRows(itemsRaw).filter((it) => it.value !== ''), [itemsRaw])

  const buckets = React.useMemo(() => {
    const out: Record<SplitBucket, string[]> = { consensus: [], split: [], doubt: [], other: [] }
    for (const it of items) out[splitBucketOf(it.label)].push(it.label && splitBucketOf(it.label) === 'other' ? `${it.label}：${it.value}` : it.value)
    return out
  }, [items])

  if (items.length === 0) {
    return (
      <div className="md-split">
        {raw ? <pre className="md-split-static">{raw}</pre> : null}
        {children}
      </div>
    )
  }

  const col = (bucket: Exclude<SplitBucket, 'other'>): React.JSX.Element => (
    <div className={cn('md-split-col', `is-${bucket}`)} data-bucket={bucket}>
      <div className="md-split-cap">
        {BUCKET_CAP[bucket]}
        <span className="md-split-count">{buckets[bucket].length}</span>
      </div>
      {buckets[bucket].length === 0 ? (
        <div className="md-split-silent">暂无</div>
      ) : (
        buckets[bucket].map((text, i) =>
          bucket === 'consensus' ? (
            <div className="md-split-item" key={i}>
              {text}
            </div>
          ) : (
            <button
              type="button"
              className="md-split-item is-action"
              key={i}
              disabled={streaming}
              title={bucket === 'split' ? '推演中间路径（写入输入框）' : '补充核实路径（写入输入框）'}
              onClick={() => insert(bucket === 'split' ? TEMPLATES.splitPath(text) : TEMPLATES.splitVerify(text))}
            >
              {text}
            </button>
          ),
        )
      )}
    </div>
  )

  return (
    <div className="md-split" data-split-card="">
      {title ? (
        <div className="md-split-head">
          <Scale className="size-3.5" aria-hidden />
          <span className="md-split-title">{title}</span>
        </div>
      ) : null}
      <div className="md-split-cols">
        {col('consensus')}
        {col('split')}
        {col('doubt')}
      </div>
      {buckets.other.length > 0 ? (
        <div className="md-split-other">
          {buckets.other.map((text, i) => (
            <span className="md-split-other-row" key={i}>
              {text}
            </span>
          ))}
        </div>
      ) : null}
      {children}
    </div>
  )
}

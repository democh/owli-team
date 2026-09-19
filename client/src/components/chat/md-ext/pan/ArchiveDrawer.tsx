/**
 * M54-C t3：档案抽屉（§5.3）——chartboard 面板底部「档案（n）」。
 *
 * - 行 = 类型徽标 + 标题 + 存档时间 + 删除；点行选中（≤2）：选 1 → 盘面回看，选 2 → 并排对照；
 * - 对照：同 kind → 逐项差异块 `.pn-diff`（差异行高亮、相同行淡显）；异 kind → 仅并排；
 * - 回看 / 对照的盘面卡由存档 JSON 原文直灌 PanCard（零重解析；隐藏 ⭐，档案内不设重复存档入口）；
 * - 无会话上下文不渲染；`version` 为外部存档事件（PanBoard 存档后 +1）触发重读。
 */
import * as React from 'react'
import { Archive, ChevronDown, Trash2 } from 'lucide-react'
import { cn } from '../../../../lib/utils'
import { PAN_KIND_LABEL, PAN_KINDS, type PanKind } from '../remark-ext'
import { PanCard, parsePanRows } from '../PanCard'
import { archiveTime, readArchive, removeArchive, type ArchiveEntry } from './archive'
import { diffPan, type PanDiffRow } from './diff'
import { derivePan } from './derive'
import type { PanModel } from './model'

function kindLabel(kind: string): string {
  return (PAN_KINDS as readonly string[]).includes(kind) ? PAN_KIND_LABEL[kind as keyof typeof PAN_KIND_LABEL] : '盘面'
}

/** 存档条目 → 盘面模型（kind 不在四盘 / 派生失败 → null，回看仍走 PanCard 表格兜底） */
function modelOf(e: ArchiveEntry): PanModel | null {
  const k = (PAN_KINDS as readonly string[]).includes(e.kind) ? (e.kind as PanKind) : undefined
  if (!k) return null
  return derivePan(k, e.title, parsePanRows(e.fields), parsePanRows(e.items))
}

/** 两档差异行（同 kind 才有；异 kind / 派生失败 → null 仅并排） */
function diffRowsOf(pair: [ArchiveEntry, ArchiveEntry]): PanDiffRow[] | null {
  const ma = modelOf(pair[0])
  const mb = modelOf(pair[1])
  if (!ma || !mb) return null
  return diffPan(ma, mb)
}

/** 回看 / 对照的盘面卡（档案内不设 ⭐ 与视图记忆——PanCard 缺省无会话上下文即静默） */
function EntryCard({ entry }: { entry: ArchiveEntry }): React.JSX.Element {
  return <PanCard kind={entry.kind} title={entry.title} fields={entry.fields} items={entry.items} raw={entry.raw} hideArchive />
}

export function ArchiveDrawer({
  sessionId,
  version = 0,
}: {
  sessionId?: string
  /** 外部存档事件版本（+1 触发重读；展开时同样重读） */
  version?: number
}): React.JSX.Element | null {
  const [open, setOpen] = React.useState(false)
  const [list, setList] = React.useState<ArchiveEntry[]>([])
  const [picked, setPicked] = React.useState<number[]>([])

  React.useEffect(() => {
    if (!sessionId) return
    const next = readArchive(sessionId)
    setList(next)
    setPicked((prev) => {
      const kept = prev.filter((t) => next.some((e) => e.savedAt === t))
      return kept.length === prev.length ? prev : kept
    })
  }, [sessionId, version, open])

  if (!sessionId) return null

  const togglePick = (savedAt: number): void => {
    setPicked((prev) => {
      if (prev.includes(savedAt)) return prev.filter((t) => t !== savedAt)
      if (prev.length >= 2) return [prev[1]!, savedAt]
      return [...prev, savedAt]
    })
  }

  const del = (savedAt: number): void => {
    setList(removeArchive(sessionId, savedAt))
    setPicked((prev) => prev.filter((t) => t !== savedAt))
  }

  const pickedEntries = picked
    .map((t) => list.find((e) => e.savedAt === t))
    .filter((e): e is ArchiveEntry => e !== undefined)
  const pair = pickedEntries.length === 2 ? ([pickedEntries[0]!, pickedEntries[1]!] as [ArchiveEntry, ArchiveEntry]) : null
  const diffRows = pair ? diffRowsOf(pair) : null
  const diffCount = diffRows ? diffRows.filter((r) => r.diff).length : 0

  return (
    <div className="pn-arch">
      <button type="button" className="pn-arch-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Archive size={12} aria-hidden="true" />
        <span className="pn-arch-count">档案（{list.length}）</span>
        <ChevronDown size={12} aria-hidden="true" className={cn('pn-arch-caret', open && 'is-open')} />
      </button>
      {open ? (
        list.length === 0 ? (
          <div className="pn-arch-empty">尚无档案——聊天中的盘面卡点 ⭐，或在上方点「存为档案」即可收藏（本地保存）。</div>
        ) : (
          <>
            <ul className="pn-arch-list" aria-label="盘面档案列表">
              {list.map((e) => {
                const on = picked.includes(e.savedAt)
                return (
                  <li key={e.savedAt} className={cn('pn-arch-row', on && 'is-picked')}>
                    <button
                      type="button"
                      className="pn-arch-main"
                      aria-pressed={on}
                      title="点击回看；选两张同类型盘可对照"
                      onClick={() => togglePick(e.savedAt)}
                    >
                      <span className="pn-arch-badge">{kindLabel(e.kind)}</span>
                      <span className="pn-arch-title">{e.title || kindLabel(e.kind)}</span>
                      <span className="pn-arch-time">{archiveTime(e.savedAt)}</span>
                    </button>
                    <button type="button" className="pn-arch-del" aria-label="删除档案" onClick={() => del(e.savedAt)}>
                      <Trash2 size={12} aria-hidden="true" />
                    </button>
                  </li>
                )
              })}
            </ul>
            {pickedEntries.length === 1 ? (
              <div className="pn-arch-view" aria-label="档案回看">
                <EntryCard entry={pickedEntries[0]!} />
              </div>
            ) : null}
            {pair ? (
              <div className="pn-arch-view" aria-label="档案对照">
                <div className="pn-arch-pair">
                  {pair.map((e) => (
                    <EntryCard key={e.savedAt} entry={e} />
                  ))}
                </div>
                {diffRows ? (
                  <div className="pn-diff" aria-label="盘面对照差异">
                    <div className="pn-diff-head">
                      {diffCount > 0 ? `差异对照（${diffCount} / ${diffRows.length} 处）` : '差异对照（两盘数据一致）'}
                    </div>
                    <div className="pn-diff-row is-head" aria-hidden="true">
                      <span className="pn-diff-label" />
                      <span className="pn-diff-a">{pair[0].title || kindLabel(pair[0].kind)}</span>
                      <span className="pn-diff-b">{pair[1].title || kindLabel(pair[1].kind)}</span>
                    </div>
                    {diffRows.map((r, i) => (
                      <div key={i} className={cn('pn-diff-row', r.diff ? 'is-diff' : 'is-same')}>
                        <span className="pn-diff-label">{r.label}</span>
                        <span className="pn-diff-a">{r.a}</span>
                        <span className="pn-diff-b">{r.b}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="pn-arch-mix">异类盘仅并排呈现，不做逐项差异。</div>
                )}
              </div>
            ) : null}
          </>
        )
      ) : null}
    </div>
  )
}

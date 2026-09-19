/**
 * M51-E（E6）：盘面卡（::: pan <bazi|ziwei|natal|gua> [标题]）——
 * 盘面数据由 remark 侧结构化：字段行（`键：值`）→ data-fields JSON、条目行（`- 键 | 值`）→ data-items JSON。
 * - 类型徽标四色：八字 / 紫微 / 星盘 / 卦；未命中 / 缺省类型降级通用「盘面」徽标（中性色）；
 * - 纯静态卡（无本地交互）：fields/items 全空 → raw 兜底渲染，其余内容照常；
 * - 先盘后论：本卡只呈现可复查的盘面数据，解读文本在容器外。
 *
 * M54-A（可玩盘面）：视图切换（盘面 / 表格）——
 * - 可派生（§3.8 必需门全过）→ 默认盘面（懒加载 PanView）；切换记忆 `ma:pn:view:<sid>:<mid>`（session）；
 * - 不可派生 / 流式冻结 / chunk 或渲染失败 → 表格（= M51-E 今天形态，零回归路径）；
 * - 盘面模式不丢信息：一键切「表格」即完整原卡。
 *
 * M54-C（参与层）：
 * - 头部「存为档案」（本地，§5.3；同内容去重，上限 20 FIFO 溢出提示）；
 * - 会话上下文可显式注入（面板路径 `sessionId / sourceKey`；缺省取 MessageContext，§7.9 约束①）。
 */
import * as React from 'react'
import { Star } from 'lucide-react'
import { useUiStore } from '../../../stores/ui-store'
import { readStored, writeStored } from '../../scene/persist'
import { useMessageInfo } from './message-context'
import { PAN_KIND_LABEL, PAN_KINDS, type PanKind } from './remark-ext'
import { useStreaming } from './streaming'
import { derivePan } from './pan/derive'
import { saveArchive } from './pan/archive'

/** 盘面视图按需懒加载（pan 目录整体单 chunk，不进主包；fallback = 表格） */
const PanView = React.lazy(() => import('./pan').then((m) => ({ default: m.PanView })))

export interface PanRowData {
  label: string
  value: string
}

/** data-fields / data-items JSON → 行数组（非法 JSON / 形状不符 → 空数组，走 raw / children 回退） */
/** M63-F：盘面印记（卡头右端印章块；设计 §5.8 传统点缀四件套之一——朱砂细边 + 2 字口径缩写，quiet-mode 隐藏，aria-hidden） */
export const PAN_SEAL: Record<string, string> = {
  bazi: '四柱',
  ziwei: '斗数',
  natal: '本命',
  gua: '六爻',
  transit: '行运',
  synastry: '合盘',
  daliuren: '时家',
  qimen: '时家',
  qizheng: '中气',
}

export function parsePanRows(json: string | undefined): PanRowData[] {
  if (!json) return []
  try {
    const arr: unknown = JSON.parse(json)
    if (!Array.isArray(arr)) return []
    const out: PanRowData[] = []
    for (const v of arr) {
      if (!v || typeof v !== 'object') continue
      const o = v as { label?: unknown; value?: unknown }
      if (typeof o.label !== 'string' || o.label === '') continue
      out.push({ label: o.label, value: typeof o.value === 'string' ? o.value : '' })
    }
    return out
  } catch {
    return []
  }
}

function panViewKey(sessionId: string, messageId: string): string {
  return `ma:pn:view:${sessionId || '-'}:${messageId}`
}

/** chunk 加载失败兜底（ErrorBoundary 必须在 lazy 之外；失败 → 表格） */
class PanLazyBoundary extends React.Component<{ fallback: React.ReactNode; children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  render(): React.ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

export function PanCard({
  kind,
  title,
  fields: fieldsRaw,
  items: itemsRaw,
  raw,
  children,
  sessionId: sessionIdProp,
  sourceKey: sourceKeyProp,
  hideArchive,
}: {
  kind?: string
  title?: string
  fields?: string
  items?: string
  raw?: string
  children?: React.ReactNode
  /** 显式会话上下文（面板路径用；缺省取 MessageContext） */
  sessionId?: string
  /** 来源键（视图记忆 / 档案去重；缺省取 messageId） */
  sourceKey?: string
  /** 隐藏头部「存为档案」（面板路径由 PanBoard 工具行承担入口；档案回看亦隐藏） */
  hideArchive?: boolean
}): React.JSX.Element {
  const fields = React.useMemo(() => parsePanRows(fieldsRaw), [fieldsRaw])
  const items = React.useMemo(() => parsePanRows(itemsRaw), [itemsRaw])
  const k = kind && (PAN_KINDS as readonly string[]).includes(kind) ? (kind as PanKind) : undefined
  const info = useMessageInfo()
  const sid = sessionIdProp ?? info?.sessionId ?? ''
  const mid = sourceKeyProp ?? info?.messageId ?? ''
  const streaming = useStreaming()
  const insertToComposer = useUiStore((s) => s.insertToComposer)

  // 派生（纯函数；必需门失败 → null → 表格，§3.8）
  const model = React.useMemo(
    () => (k && fields.length + items.length > 0 ? derivePan(k, title ?? '', fields, items) : null),
    [k, title, fields, items],
  )
  const storeKey = sid !== '' && mid !== '' ? panViewKey(sid, mid) : null
  const [view, setView] = React.useState<'board' | 'table'>(() =>
    storeKey ? readStored<'board' | 'table'>('session', storeKey, 'board') : 'board',
  )
  const pickView = React.useCallback(
    (v: 'board' | 'table') => {
      setView(v)
      if (storeKey) writeStored('session', storeKey, v)
    },
    [storeKey],
  )

  // 存为档案（§5.3；本地、同内容去重、上限 20 FIFO）——短暂反馈后自动清除
  const [archNote, setArchNote] = React.useState('')
  const archTimer = React.useRef<number | null>(null)
  React.useEffect(
    () => () => {
      if (archTimer.current !== null) window.clearTimeout(archTimer.current)
    },
    [],
  )
  const canArchive = !hideArchive && sid !== '' && k !== undefined && fields.length + items.length > 0
  const saveAsArchive = (): void => {
    if (!canArchive || !k) return
    const { status } = saveArchive(sid, {
      kind: k,
      title: title ?? '',
      fields: fieldsRaw ?? '',
      items: itemsRaw ?? '',
      raw: raw ?? '',
      savedAt: Date.now(),
    })
    setArchNote(status === 'saved' ? '已存为档案' : status === 'dup' ? '已在档案中' : '已存（档案满，移除最旧）')
    if (archTimer.current !== null) window.clearTimeout(archTimer.current)
    archTimer.current = window.setTimeout(() => setArchNote(''), 1800)
  }

  // 无结构化行（空容器 / 解析失败）：raw 兜底静态渲染，其余内容照常
  if (fields.length === 0 && items.length === 0) {
    return (
      <div className="md-pan">
        {raw ? <pre className="md-pan-static">{raw}</pre> : null}
        {children}
      </div>
    )
  }

  const tableBody = (
    <div className="md-pan-body">
      {fields.length > 0 ? (
        <div className="md-pan-fields">
          {fields.map((f, i) => (
            <div className="md-pan-row" key={i}>
              <span className="md-pan-label">{f.label}</span>
              <span className="md-pan-value">{f.value}</span>
            </div>
          ))}
        </div>
      ) : null}
      {items.length > 0 ? (
        <div className="md-pan-items">
          {items.map((it, i) => (
            <div className="md-pan-item" key={i}>
              <span className="md-pan-item-label">{it.label}</span>
              <span className="md-pan-item-value">{it.value}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )

  const showBoard = view === 'board' && model !== null && !streaming

  return (
    <div className={`md-pan${k ? ` md-pan-${k}` : ''}${showBoard ? ' md-pan-board' : ''}`}>
      <div className="md-pan-head">
        <span className="md-pan-badge">{k ? PAN_KIND_LABEL[k] : '盘面'}</span>
        {title ? <span className="md-pan-title">{title}</span> : null}
        <div className="md-pan-headright">
          {k && PAN_SEAL[k] ? (
            <span className="pn-seal" aria-hidden="true">
              {PAN_SEAL[k]}
            </span>
          ) : null}
          {canArchive ? (
            <button
              type="button"
              className="md-pan-archbtn"
              aria-label="存为档案"
              title="存为档案（本地，可在盘面面板对照回看）"
              onClick={saveAsArchive}
            >
              <Star size={12} aria-hidden="true" />
            </button>
          ) : null}
          {model && !streaming ? (
            <div className="md-pan-viewtoggle" role="group" aria-label="视图切换">
              <button type="button" className="md-pan-viewbtn" aria-pressed={view === 'board'} onClick={() => pickView('board')}>
                盘面
              </button>
              <button type="button" className="md-pan-viewbtn" aria-pressed={view === 'table'} onClick={() => pickView('table')}>
                表格
              </button>
            </div>
          ) : null}
        </div>
      </div>
      {archNote !== '' ? (
        <div className="md-pan-archnote" role="status">
          {archNote}
        </div>
      ) : null}
      {showBoard ? (
        <PanLazyBoundary fallback={tableBody}>
          <React.Suspense fallback={tableBody}>
            <PanView
              model={model}
              onAsk={(text) => insertToComposer(text)}
              fallback={tableBody}
              sessionId={sid !== '' ? sid : undefined}
              sourceKey={mid !== '' ? mid : undefined}
              title={title}
            />
          </React.Suspense>
        </PanLazyBoundary>
      ) : (
        tableBody
      )}
      {children}
    </div>
  )
}

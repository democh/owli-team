/**
 * M69：回合结算卡（`::: sim`）——business-sim 沙盘回合的结构化呈现。
 * - 数据由 remark 侧转 data-items JSON（条目 `- 决策 | … | 反馈 | … | 指标 | …`）；
 * - 「下个回合」→ composerInsert 草稿（统一回填语义，ADR 0064；只写草稿不直发）；
 * - 解析失败 → raw 兜底静态渲染。
 */
import * as React from 'react'
import { LineChart } from 'lucide-react'
import { useUiStore } from '../../../stores/ui-store'
import { useMessageInfo } from './message-context'
import { useStreaming } from './streaming'

/** 单回合结算记录（三段 + 指标 chips） */
export interface SimTurn {
  decision: string
  feedback: string
  metrics: string[]
}

const SEG_KEYS = ['决策', '反馈', '指标'] as const

function parseItems(json: string | undefined): string[] {
  if (!json) return []
  try {
    const arr: unknown = JSON.parse(json)
    if (!Array.isArray(arr)) return []
    const out: string[] = []
    for (const v of arr) {
      if (!v || typeof v !== 'object') continue
      const o = v as { label?: unknown; value?: unknown }
      if (typeof o.label !== 'string' || typeof o.value !== 'string') continue
      // 合并整行再拆（label 可能是首键「决策」）
      out.push(`${o.label} | ${o.value}`)
    }
    return out
  } catch {
    return []
  }
}

/** 整行 → 三段（按已知键折叠；未知键内容拼入当前段） */
function foldSegments(raw: string): SimTurn {
  const segs = raw.split('|').map((s) => s.trim())
  const acc: Record<string, string[]> = { 决策: [], 反馈: [], 指标: [] }
  let cur: string = '决策'
  for (const s of segs) {
    const m = /^(决策|反馈|指标)[：:]?\s*(.*)$/.exec(s)
    if (m && SEG_KEYS.includes(m[1] as (typeof SEG_KEYS)[number])) {
      cur = m[1]!
      if (m[2]) acc[cur]!.push(m[2])
    } else if (s) {
      acc[cur]!.push(s)
    }
  }
  const metrics = acc['指标']!.join(' · ')
    .split(/[·、,，]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  return { decision: acc['决策']!.join('；'), feedback: acc['反馈']!.join('；'), metrics }
}

/** data-items JSON → 回合列表 */
export function parseSim(itemsRaw: string | undefined): SimTurn[] {
  const rows = parseItems(itemsRaw)
  const out: SimTurn[] = []
  for (const row of rows) {
    const t = foldSegments(row)
    if (t.decision || t.feedback || t.metrics.length > 0) out.push(t)
  }
  return out
}

export function SimCard({
  title,
  items: itemsRaw,
  raw,
  children,
  onInsert,
}: {
  title?: string
  items?: string
  raw?: string
  children?: React.ReactNode
  onInsert?: (text: string) => void
}): React.JSX.Element {
  useMessageInfo()
  const streaming = useStreaming()
  const insertToComposer = useUiStore((s) => s.insertToComposer)
  const turns = React.useMemo(() => parseSim(itemsRaw), [itemsRaw])
  const insert = onInsert ?? ((text: string): void => insertToComposer(text))

  if (turns.length === 0) {
    return (
      <div className="md-sim">
        {raw ? <pre className="md-sim-static">{raw}</pre> : null}
        {children}
      </div>
    )
  }

  const nextText = `@掌局 进入下一个回合：我先给出本回合决策，随后请 @市衡 出市场反馈并完成结算。`
  return (
    <div className="md-sim" data-sim-card="">
      <div className="md-sim-head">
        <LineChart className="size-3.5" aria-hidden />
        <span className="md-sim-title">{title || '回合结算'}</span>
      </div>
      <div className="md-sim-body">
        {turns.map((t, i) => (
          <div className="md-sim-turn" key={i}>
            {t.decision ? (
              <div className="md-sim-seg">
                <span className="md-sim-k">决策</span>
                <span className="md-sim-v">{t.decision}</span>
              </div>
            ) : null}
            {t.feedback ? (
              <div className="md-sim-seg">
                <span className="md-sim-k">反馈</span>
                <span className="md-sim-v">{t.feedback}</span>
              </div>
            ) : null}
            {t.metrics.length > 0 ? (
              <div className="md-sim-metrics">
                {t.metrics.map((m, j) => (
                  <span className="md-sim-chip" key={j}>{m}</span>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>
      {children}
      <div className="md-sim-foot">
        <button
          type="button"
          className="md-sim-next"
          disabled={streaming}
          title="写入输入框（可编辑后发送）"
          onClick={() => insert(nextText)}
        >
          <LineChart className="size-3" />
          下个回合
        </button>
      </div>
    </div>
  )
}

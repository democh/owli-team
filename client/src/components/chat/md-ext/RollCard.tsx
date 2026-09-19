/**
 * M69：骰卡（`::: roll`）——trpg 掷骰结果的结构化呈现。
 * - 数据由 remark 侧转 data-fields JSON（`骰式：… | 种子：…` / `明细：… | 修正：… | 总值：…`）；
 * - 「再掷一次」→ composerInsert 草稿（统一回填语义，ADR 0064；只写草稿不直发）；
 * - 解析失败 → raw 兜底静态渲染。
 */
import * as React from 'react'
import { Dices } from 'lucide-react'
import { useUiStore } from '../../../stores/ui-store'
import { useMessageInfo } from './message-context'
import { useStreaming } from './streaming'
import type { PanRow } from './remark-ext'

export interface RollParsed {
  formula: string
  seed: string
  rolls: string[]
  modifier: string
  total: string
}

/** data-fields JSON → 字段行（非法 JSON / 形状不符 → 空数组，走 raw 回退） */
function parseFields(json: string | undefined): PanRow[] {
  if (!json) return []
  try {
    const arr: unknown = JSON.parse(json)
    if (!Array.isArray(arr)) return []
    const out: PanRow[] = []
    for (const v of arr) {
      if (!v || typeof v !== 'object') continue
      const o = v as { label?: unknown; value?: unknown }
      if (typeof o.label !== 'string' || typeof o.value !== 'string' || o.label === '') continue
      out.push({ label: o.label, value: o.value })
    }
    return out
  } catch {
    return []
  }
}

/** 字段行 → 骰卡结构（宽松解析：按 | 拆段，再按「键：值」提子字段） */
export function parseRoll(fieldsRaw: string | undefined): RollParsed | undefined {
  const fields = parseFields(fieldsRaw)
  if (fields.length === 0) return undefined
  const segs: string[] = []
  let formula = ''
  let seed = ''
  for (const f of fields) {
    if (f.label === '骰式') formula = f.value.split('|')[0]?.trim() ?? ''
    segs.push(...f.value.split('|').map((s) => s.trim()))
  }
  // 段内子键提取（「种子：482910」/「修正：+3」/「总值：18」）
  const sub = (key: RegExp): string => {
    for (const s of segs) {
      const m = key.exec(s)
      if (m) return m[1]!.trim()
    }
    return ''
  }
  seed = sub(/种子[：:]\s*(.+)$/)
  const modifier = sub(/修正[：:]\s*(.+)$/)
  const total = sub(/总值[：:]\s*(.+)$/)
  // 骰面：明细段（去掉含「修正 / 总值 / 种子」的段）里的数字串
  let rolls: string[] = []
  for (const f of fields) {
    if (f.label !== '明细') continue
    const first = f.value.split('|')[0]?.trim() ?? ''
    rolls = first
      .split(/[+\s、]+/)
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s))
  }
  if (!formula && !total) return undefined
  return { formula, seed, rolls, modifier, total }
}

export function RollCard({
  title,
  fields: fieldsRaw,
  raw,
  children,
  onInsert,
}: {
  title?: string
  fields?: string
  raw?: string
  children?: React.ReactNode
  onInsert?: (text: string) => void
}): React.JSX.Element {
  useMessageInfo()
  const streaming = useStreaming()
  const insertToComposer = useUiStore((s) => s.insertToComposer)
  const parsed = React.useMemo(() => parseRoll(fieldsRaw), [fieldsRaw])
  const insert = onInsert ?? ((text: string): void => insertToComposer(text))

  if (!parsed) {
    return (
      <div className="md-roll">
        {raw ? <pre className="md-roll-static">{raw}</pre> : null}
        {children}
      </div>
    )
  }

  const rollText = `@开卷 重掷一次：${parsed.formula}（换新种子），骰卡照原格式输出。`
  const replayText = `@开卷 用种子 ${parsed.seed} 重掷 ${parsed.formula}（复现本次结果），骰卡照原格式输出。`
  return (
    <div className="md-roll" data-roll-card="">
      <div className="md-roll-head">
        <Dices className="size-3.5" aria-hidden />
        <span className="md-roll-title">{title || parsed.formula || '掷骰'}</span>
        {parsed.seed ? <span className="md-roll-seed" title="同种子重掷逐位复现">种子 {parsed.seed}</span> : null}
      </div>
      <div className="md-roll-body">
        {parsed.rolls.length > 0 ? (
          <div className="md-roll-dice" aria-label="骰面">
            {parsed.rolls.map((r, i) => (
              <span className="md-roll-die" key={i}>{r}</span>
            ))}
          </div>
        ) : null}
        <div className="md-roll-total">
          <span className="md-roll-total-k">总值</span>
          <span className="md-roll-total-v">{parsed.total || '—'}</span>
          {parsed.modifier ? <span className="md-roll-mod">{parsed.modifier}</span> : null}
        </div>
      </div>
      {children}
      <div className="md-roll-foot">
        {parsed.seed ? (
          <button
            type="button"
            className="md-roll-replay"
            disabled={streaming}
            title="同种子重掷（逐位复现本次结果）"
            onClick={() => insert(replayText)}
          >
            <Dices className="size-3" />
            复现本次
          </button>
        ) : null}
        <button
          type="button"
          className="md-roll-again"
          disabled={streaming}
          title="写入输入框（可编辑后发送）"
          onClick={() => insert(rollText)}
        >
          <Dices className="size-3" />
          再掷一次
        </button>
      </div>
    </div>
  )
}

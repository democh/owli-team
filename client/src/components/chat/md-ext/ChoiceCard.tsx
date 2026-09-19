/**
 * M37-5（§52）：单选项卡（::: choice [标题]）——选项由 remark 侧转 data-options JSON。
 * - 点选为单选本地态（sessionStorage ma:choice:<sessionId>:<messageId> 存选项下标；再点取消）；
 * - 「选这个」把「拍板：<选项>」写入 Composer 草稿（ADR 0064：用户确认后发送）；
 * - 流式期间整卡静态（行不可点、按钮禁用）；无消息上下文时仅即时态、不落存储。
 */
import * as React from 'react'
import { PenLine } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { useUiStore } from '../../../stores/ui-store'
import { useMessageInfo } from './message-context'
import { useStreaming } from './streaming'

export interface ChoiceOptionData {
  label: string
}

/** data-options JSON → 选项数组（非法 JSON / 形状不符 → 空数组，走 raw / children 回退） */
export function parseChoiceOptions(json: string | undefined): ChoiceOptionData[] {
  if (!json) return []
  try {
    const arr: unknown = JSON.parse(json)
    if (!Array.isArray(arr)) return []
    const out: ChoiceOptionData[] = []
    for (const v of arr) {
      if (!v || typeof v !== 'object') continue
      const o = v as { label?: unknown }
      if (typeof o.label !== 'string' || o.label === '') continue
      out.push({ label: o.label })
    }
    return out
  } catch {
    return []
  }
}

/** 选定项 → 回填文本（用户可编辑后发送） */
export function buildChoiceBackfill(label: string): string {
  return `拍板：${label}`
}

function readPicked(key: string): number | null {
  if (!key) return null
  try {
    const raw = sessionStorage.getItem(key)
    if (raw === null) return null
    const n = Number(raw)
    return Number.isInteger(n) && n >= 0 ? n : null
  } catch {
    return null // 存储损坏 / 隐私模式：回到未选态
  }
}

function writePicked(key: string, i: number | null): void {
  if (!key) return
  try {
    if (i === null) sessionStorage.removeItem(key)
    else sessionStorage.setItem(key, String(i))
  } catch {
    // 配额 / 隐私模式：忽略，仅本次会话内生效
  }
}

export function ChoiceCard({
  title,
  options: optionsRaw,
  raw,
  children,
}: {
  title?: string
  options?: string
  raw?: string
  children?: React.ReactNode
}): React.JSX.Element {
  const info = useMessageInfo()
  const streaming = useStreaming()
  const insertToComposer = useUiStore((s) => s.insertToComposer)
  const parsed = React.useMemo(() => parseChoiceOptions(optionsRaw), [optionsRaw])
  const key = info && info.sessionId && info.messageId ? `ma:choice:${info.sessionId}:${info.messageId}` : ''
  const [snap, setSnap] = React.useState<{ key: string; picked: number | null }>(() => ({ key, picked: readPicked(key) }))
  const picked = snap.key === key ? snap.picked : readPicked(key)

  // 无选项（解析失败 / 空容器）：raw 兜底静态渲染，其余内容照常
  if (parsed.length === 0) {
    return (
      <div className="md-choice">
        {raw ? <pre className="md-choice-static">{raw}</pre> : null}
        {children}
      </div>
    )
  }

  const pickedOption = picked !== null ? parsed[picked] : undefined

  const pick = (i: number): void => {
    const next = picked === i ? null : i
    setSnap({ key, picked: next })
    writePicked(key, next)
  }

  return (
    <div className="md-choice">
      <div className="md-choice-head">{title ? <span>{title}</span> : null}</div>
      <div className="md-choice-list">
        {parsed.map((it, i) => {
          const isPicked = picked === i
          return (
            <button
              key={i}
              type="button"
              className={cn('md-choiceline', isPicked && 'is-picked')}
              disabled={streaming}
              aria-pressed={isPicked}
              onClick={() => pick(i)}
            >
              <span className="md-choiceradio" aria-hidden />
              <span className="md-choice-label">{it.label}</span>
            </button>
          )
        })}
      </div>
      {children}
      <div className="md-choice-foot">
        <span className="min-w-0 flex-1 truncate">
          {pickedOption ? `已选：${pickedOption.label}` : '点选一项后确认'}
        </span>
        <button
          type="button"
          className="md-choice-pick"
          disabled={streaming || !pickedOption}
          title="把「拍板：选项」写入输入框（可编辑后发送）"
          onClick={() => {
            if (pickedOption) insertToComposer(buildChoiceBackfill(pickedOption.label))
          }}
        >
          <PenLine className="size-3" />
          选这个
        </button>
      </div>
    </div>
  )
}

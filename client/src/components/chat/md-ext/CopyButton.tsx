/**
 * 复制按钮（md 扩展通用）：clipboard API + execCommand 兜底（非安全上下文可用）；
 * 成功后 1.6s 显示「已复制」，失败显示「复制失败」（不打断渲染）。
 */
import * as React from 'react'
import { Check, Copy } from 'lucide-react'
import { cn } from '../../../lib/utils'

/** 复制纯文本：clipboard API + execCommand 兜底（非安全上下文可用）。导出供 KPI 数值点击等轻量场景复用。 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 非安全上下文 / 权限拒绝 → 走 execCommand 兜底
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = typeof document.execCommand === 'function' && document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}

export function CopyButton({
  text,
  label = '复制',
  compact = false,
}: {
  /** 文本或取值函数（渲染后才可取的动态内容，如邮件正文） */
  text: string | (() => string)
  label?: string
  /** 紧凑态：仅图标（title 携带状态文案；K 线块头等窄场景用） */
  compact?: boolean
}): React.JSX.Element {
  const [state, setState] = React.useState<'idle' | 'done' | 'fail'>('idle')
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  React.useEffect(() => () => clearTimeout(timer.current), [])
  const onClick = (): void => {
    const value = typeof text === 'function' ? text() : text
    void copyText(value).then((ok) => {
      setState(ok ? 'done' : 'fail')
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setState('idle'), 1600)
    })
  }
  return (
    <button
      type="button"
      className={cn('md-block-btn', state === 'fail' && 'is-fail')}
      title={state === 'done' ? '已复制' : state === 'fail' ? '复制失败' : label}
      onClick={onClick}
    >
      {state === 'done' ? <Check className="size-3.5 text-emerald-600" /> : <Copy className="size-3.5" />}
      {!compact && <span>{state === 'done' ? '已复制' : state === 'fail' ? '复制失败' : label}</span>}
    </button>
  )
}

/**
 * M81：过程叙述折叠块（`::: process [标题]`）——TurnCard 过程区第三件（思考 / 工具 / 过程）。
 * 交互对齐既有范式：流式展开跟随 / 回合结束折叠一次 / 用户手动切换（touched）后不再自动干预
 * （与 ReasoningBlock、ToolCallsPanel 同构）；展开体为容器 mdast children 的正常 Markdown 渲染；
 * 空容器不渲染（返回 null）。顶部 remark 侧已做「顶层块上提至消息头部」。
 */
import * as React from 'react'
import { ChevronDown, Footprints } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { useStreaming } from './streaming'

export function ProcessBlock({
  title,
  chars,
  children,
}: {
  title?: string
  /** 容器内可见文本字数（remark 侧 data-chars 预算；缺省或 0 不显示计数） */
  chars?: number
  children?: React.ReactNode
}): React.JSX.Element | null {
  const streaming = useStreaming()
  const [open, setOpen] = React.useState(streaming)
  const [touched, setTouched] = React.useState(false)

  React.useEffect(() => {
    // streaming 在回合内单调（true 恒 true 至回合结束），据此开合不会抖动
    if (!streaming && !touched) setOpen(false)
  }, [streaming, touched])

  if (React.Children.count(children) === 0) return null
  const label = title?.trim() || '过程'
  const count = typeof chars === 'number' && chars > 0 ? ` · ${chars.toLocaleString()} 字` : ''

  return (
    <div className="md-process mb-2" data-process="">
      <button
        type="button"
        className="md-process-summary process-row flex items-center gap-1.5 text-[11.5px] text-muted-foreground transition-colors hover:text-foreground"
        title={open ? '收起过程' : '展开过程'}
        onClick={() => {
          setTouched(true)
          setOpen((v) => !v)
        }}
      >
        <Footprints className="size-3.5 text-primary/60" aria-hidden />
        <span>
          {label}
          {count}
        </span>
        <ChevronDown className={cn('size-3 transition-transform duration-200', open && 'rotate-180')} aria-hidden />
      </button>
      {open && (
        <div className="md-process-body animate-fade-in mt-1.5 rounded-lg border-l-2 border-primary/25 bg-primary/[0.04] py-2 pl-2.5 pr-3 text-[12px] leading-5 text-muted-foreground">
          {children}
        </div>
      )}
    </div>
  )
}

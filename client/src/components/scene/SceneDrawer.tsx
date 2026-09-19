/**
 * M52-A：窄屏（<900px）工作区底部抽屉——默认收起（§7.3-4）；dock / roundtable 共用。
 */
import * as React from 'react'
import { ChevronDown, ChevronUp, GripHorizontal } from 'lucide-react'
import { cn } from '../../lib/utils'

export function SceneDrawer({
  label = '工作区',
  children,
}: {
  label?: string
  children: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  return (
    <div className={cn('scene-drawer', open && 'scene-drawer-open')}>
      <button type="button" className="scene-drawer-bar" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <GripHorizontal size={13} className="shrink-0" />
        <span>{label}</span>
        {open ? <ChevronDown size={14} className="ml-auto shrink-0" /> : <ChevronUp size={14} className="ml-auto shrink-0" />}
      </button>
      {open ? <div className="scene-drawer-body">{children}</div> : null}
    </div>
  )
}

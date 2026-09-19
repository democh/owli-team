/**
 * M52-A：工作区面板统一壳（dock 右区 / roundtable 汇聚板）——标题栏 + 空态；
 * 空态文案口径：不空白、不报错（§7.3-3）。
 * M58：标题行收口——图标 + 标题 + 徽标贴左，操作区（折叠 / 关闭，宿主经 chrome 注入）右推同行；
 * 内容区内部滚动（标题行固定）。
 */
import * as React from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { usePanelChrome } from './chrome'

export function PanelShell({
  title,
  icon: Icon,
  badge,
  actions,
  children,
  className,
}: {
  title: string
  icon?: LucideIcon
  /** 标题右侧徽标（计数 / 状态），贴标题不右推 */
  badge?: React.ReactNode
  /** 标题行右端操作区（缺省取宿主注入的 chrome.actions） */
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  const chrome = usePanelChrome()
  const headActions = actions ?? chrome.actions
  return (
    <div className={cn('scene-panel', className)}>
      <div className="scene-panel-head">
        {Icon ? <Icon size={13} className="scene-panel-icon" /> : null}
        <span className="scene-panel-title">{title}</span>
        {badge ? <span className="scene-panel-badge">{badge}</span> : null}
        {headActions ? <div className="scene-panel-actions">{headActions}</div> : null}
      </div>
      <div className="scene-panel-body">{children}</div>
    </div>
  )
}

export function PanelEmpty({
  icon: Icon,
  text,
  hint,
}: {
  icon?: LucideIcon
  text: string
  hint?: string
}): React.JSX.Element {
  return (
    <div className="scene-empty">
      {Icon ? <Icon size={18} className="scene-empty-icon" /> : null}
      <p className="scene-empty-text">{text}</p>
      {hint ? <p className="scene-empty-hint">{hint}</p> : null}
    </div>
  )
}

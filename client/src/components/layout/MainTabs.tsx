/**
 * 主区页签（对话 / 画布）与面板显隐钮——M85 头部合并（2026-09-25）。
 * Chat 模式下由会话头行渲染（Tabs 左端 / 面板钮右端）——顶部三层横条（页签行 + 会话标题行 + 核心交付药丸）
 * 合并为一行；其余模式（artifacts / canvas / database / terminal）由 AppLayout 头行渲染。
 * 从 AppLayout 抽出为独立模块，避免 ChatArea ↔ AppLayout 循环依赖；AppLayout 保留 re-export（测试 import 面不变）。
 */
import * as React from 'react'
import { ChevronLeft, ChevronRight, PanelRightClose, PanelRightOpen } from 'lucide-react'
import { useUiStore, type MainTab } from '../../stores/ui-store'
import { Button } from '../ui/button'
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs'

/** 主区页签（含画布新写入计数徽章） */
export function MainTabs(): React.JSX.Element {
  const mainTab = useUiStore((s) => s.mainTab)
  const setMainTab = useUiStore((s) => s.setMainTab)
  // 临时隐藏：画布页签已注释，未读角标同步不再读取
  // const newCanvasCount = useUiStore((s) => s.newCanvasCount)
  return (
    <Tabs value={mainTab} onValueChange={(v) => setMainTab(v as MainTab)}>
      <TabsList>
        <TabsTrigger value="chat">对话</TabsTrigger>
        {/* 临时隐藏「画布」页签（恢复时取消本段注释）
        <TabsTrigger value="canvas">
          画布
          {newCanvasCount > 0 && (
            <span
              className="ml-1 shrink-0 rounded-full bg-primary/15 px-1 text-[9.5px] font-semibold tabular-nums text-primary"
              title="Agent 在画布上有新写入"
            >
              {newCanvasCount}
            </span>
          )}
        </TabsTrigger>
        */}
      </TabsList>
    </Tabs>
  )
}

/** 面板显隐钮（左 = 主区左缘悬浮把手内 / 右 = 主区头部最右端）：常驻双态——展开态 = 「隐藏 X 栏」、
 *  收起态 = 「显示 X 栏」，左钮折角箭头方向随态翻转（展开 = 向左收起 / 收起 = 向右展开）；
 *  与 ⌘B / ⌘⇧B、命令面板同源；仅宽屏渲染（窄屏抽屉入口在顶栏 / 底部成员条）。 */
export function PanelToggleButton({
  side,
  className,
}: {
  side: 'left' | 'right'
  className?: string
}): React.JSX.Element {
  const open = useUiStore((s) => (side === 'left' ? s.leftPanelOpen : s.rightPanelOpen))
  const toggle = useUiStore((s) => (side === 'left' ? s.toggleLeftPanel : s.toggleRightPanel))
  const name = side === 'left' ? '左栏' : '右栏'
  const keys = side === 'left' ? '⌘⇧B' : '⌘B'
  const Icon = side === 'left' ? (open ? ChevronLeft : ChevronRight) : open ? PanelRightClose : PanelRightOpen
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className={className}
      title={`${open ? '隐藏' : '显示'}${name}（${keys}）`}
      onClick={toggle}
    >
      <Icon className="size-4" />
    </Button>
  )
}

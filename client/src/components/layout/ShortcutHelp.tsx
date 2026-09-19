/**
 * 快捷键帮助（M12）：`?` 键 / HeaderBar 键盘按钮 / 命令面板入口打开。
 * 纯展示组件——实际绑定见 AppLayout（Alt+1..9 / ⌘K / ⌘B / ?）、Composer（Enter/候选键）与
 * ApprovalPanel（⌘⏎ / ⌘⌫）；「指派语义」块解释行首 @ 与行内 @ 的调度差异。
 */
import * as React from 'react'
import { Keyboard } from 'lucide-react'
import { useUiStore } from '../../stores/ui-store'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'

interface Shortcut {
  label: string
  keys: string[]
}

const GROUPS: { title: string; items: Shortcut[] }[] = [
  {
    title: '通用',
    items: [
      { label: '命令面板', keys: ['⌘/Ctrl', 'K'] },
      { label: '显示 / 隐藏左栏', keys: ['⌘/Ctrl', '⇧B'] },
      { label: '显示 / 隐藏右栏', keys: ['⌘/Ctrl', 'B'] },
      { label: '快捷键帮助', keys: ['?'] },
      { label: '切换第 N 个会话', keys: ['Alt', '1..9'] },
      { label: '关闭浮层 / 取消', keys: ['Esc'] },
    ],
  },
  {
    title: '输入框',
    items: [
      { label: '发送消息', keys: ['Enter'] },
      { label: '换行', keys: ['Shift', 'Enter'] },
      { label: '@ 候选选择', keys: ['↑', '↓'] },
      { label: '补全候选', keys: ['Tab'] },
    ],
  },
  {
    title: '审批卡',
    items: [
      { label: '批准（反馈框打开时 = 提交反馈）', keys: ['⌘/Ctrl', 'Enter'] },
      { label: '拒绝', keys: ['⌘/Ctrl', 'Backspace'] },
    ],
  },
]

function Kbd({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <kbd className="rounded border bg-muted/80 px-1.5 py-0.5 font-mono text-[10.5px] leading-4 text-muted-foreground">
      {children}
    </kbd>
  )
}

export function ShortcutHelp(): React.JSX.Element {
  const open = useUiStore((s) => s.helpOpen)
  const setOpen = useUiStore((s) => s.setHelpOpen)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[14px]">
            <Keyboard className="size-4 text-primary" />
            键盘快捷键
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {GROUPS.map((group) => (
            <div key={group.title}>
              <div className="mb-1.5 text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">
                {group.title}
              </div>
              <ul className="divide-y divide-border/60 rounded-lg border">
                {group.items.map((item) => (
                  <li key={item.label} className="flex items-center gap-2 px-3 py-2 text-[12.5px]">
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    <span className="flex shrink-0 items-center gap-1">
                      {item.keys.map((k) => (
                        <Kbd key={k}>{k}</Kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          <div className="rounded-lg border border-primary/20 bg-primary/[0.04] px-3 py-2 text-[11.5px] leading-5 text-muted-foreground">
            <span className="font-medium text-foreground">指派语义</span>：行首 @ 指定首棒（多个 @ 按顺序接力）；
            行内 @ 仅提及不改变队列；交接条头像 / 成员卡「@ 召唤」= 一键接棒。
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

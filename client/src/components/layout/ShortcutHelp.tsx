/**
 * 快捷键帮助（M12；本次重设计：分组 Tab 化——一次只展开一组，替代原先长列表通铺）。
 * 入口：`?` 键 / ⌘⇧/ / HeaderBar 键盘按钮 / 命令面板；纯展示组件——实际绑定见
 * AppLayout（Alt+1..9 / ⌘K / ⌘B / ⇧⌘B / ?）、Composer（Enter / @ 与命令候选键）、
 * ApprovalPanel（⌘⏎ / ⌘⌫）与 CanvasView（H / V、⇧0-2、⌘Z 等）。
 * 「指派语义」说明块随「输入框」页签（@ 语义属输入行为）；页签选择在组件内记忆（重开停留上次分组）。
 */
import * as React from 'react'
import {
  AtSign,
  Command,
  // Frame, // 临时隐藏画布快捷键组
  Info,
  Keyboard,
  MessageSquareText,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '../../lib/utils'
import { useUiStore } from '../../stores/ui-store'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs'

interface Shortcut {
  label: string
  /** 按键组合：外层 = 可替代组合（渲染以「/」分隔），内层 = 组合键（相邻「键帽」） */
  combos: string[][]
  /** 补充说明（次行小字，如适用条件） */
  note?: string
}

interface ShortcutGroup {
  // 临时隐藏画布：id 'canvas' 不再出现（保留类型以兼容旧值）
  id: 'general' | 'composer' | 'approval' | 'canvas'
  label: string
  icon: LucideIcon
  /** 分组说明（内容区顶部一行，可缺省） */
  hint?: string
  /** 页签底部说明块（可选；如 @ 指派语义 / 审批流语义） */
  note?: { icon: LucideIcon; primary?: boolean; content: React.ReactNode }
  items: Shortcut[]
}

const GROUPS: ShortcutGroup[] = [
  {
    id: 'general',
    label: '通用',
    icon: Command,
    items: [
      { label: '命令面板', combos: [['⌘/Ctrl', 'K']] },
      { label: '显示 / 隐藏左栏', combos: [['⌘/Ctrl', '⇧B']] },
      { label: '显示 / 隐藏右栏', combos: [['⌘/Ctrl', 'B']] },
      { label: '快捷键帮助', combos: [['?'], ['⌘/Ctrl', '⇧/']] },
      { label: '切换第 N 个会话', combos: [['Alt', '1..9']] },
      { label: '关闭浮层 / 取消', combos: [['Esc']] },
    ],
  },
  {
    id: 'composer',
    label: '输入框',
    icon: MessageSquareText,
    items: [
      { label: '发送消息', combos: [['Enter']] },
      { label: '换行', combos: [['⇧', 'Enter']] },
      { label: '@ / 命令候选选择', combos: [['↑'], ['↓']] },
      { label: '候选补全', combos: [['Enter'], ['Tab']], note: '候选弹层打开时 Enter 为补全而非发送' },
      { label: '关闭候选 / 清空命令', combos: [['Esc']] },
    ],
    note: {
      icon: AtSign,
      primary: true,
      content: (
        <>
          <span className="font-medium text-foreground">指派语义</span>
          ：行首 @ 指定首棒（多个 @ 按顺序接力）；行内 @ 仅提及不改变队列；交接条头像 / 成员卡「@ 召唤」=
          一键接棒。
        </>
      ),
    },
  },
  {
    id: 'approval',
    label: '审批卡',
    icon: ShieldCheck,
    items: [
      { label: '批准', combos: [['⌘/Ctrl', 'Enter']], note: '反馈框打开时 = 提交反馈' },
      { label: '拒绝', combos: [['⌘/Ctrl', 'Backspace']] },
    ],
    note: {
      icon: Info,
      content: <>仅作用于首张挂起卡：批准 → 成员继续执行；拒绝 → 改换方案；附反馈提交 → 模型据此调整。</>,
    },
  },
  // 临时隐藏画布快捷键组（恢复时取消本段注释）
  // {
  //   id: 'canvas',
  //   label: '画布',
  //   icon: Frame,
  //   hint: '在「画布」页签内生效；输入控件聚焦时不拦截。',
  //   items: [
  //     { label: '缩放 100% / 适应视野 / 缩放到选区', combos: [['⇧0'], ['⇧1'], ['⇧2']] },
  //     { label: '手型工具 / 选择工具', combos: [['H'], ['V']] },
  //     { label: '临时平移', combos: [['Space']], note: '按住拖动；滚轮 / 双指直接平移，⌘+滚轮缩放' },
  //     {
  //       label: '撤销 / 重做',
  //       combos: [
  //         ['⌘/Ctrl', 'Z'],
  //         ['⌘/Ctrl', '⇧Z'],
  //         ['⌘/Ctrl', 'Y'],
  //       ],
  //     },
  //     {
  //       label: '复制 / 粘贴选中节点',
  //       combos: [
  //         ['⌘/Ctrl', 'C'],
  //         ['⌘/Ctrl', 'V'],
  //       ],
  //     },
  //     { label: '删除选中节点 / 连线', combos: [['Backspace'], ['Delete']] },
  //     {
  //       label: '脑图加子节点 / 加兄弟节点',
  //       combos: [['Tab'], ['Enter']],
  //       note: '选中单个脑图节点时（xmind 式手感）',
  //     },
  //     { label: '新建节点菜单', combos: [['双击空白']] },
  //     { label: '保存并提交画布文档', combos: [['⌘/Ctrl', 'S']] },
  //   ],
  // },
]

/** 键帽 */
function Kbd({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <kbd className="rounded-[5px] border border-b-2 bg-muted/70 px-1.5 py-0.5 font-mono text-[10.5px] leading-4 text-muted-foreground">
      {children}
    </kbd>
  )
}

/** 按键列（可替代组合以「/」分隔，组合键相邻并列） */
function KeyCaps({ combos }: { combos: string[][] }): React.JSX.Element {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {combos.map((combo, i) => (
        <React.Fragment key={combo.join('+')}>
          {i > 0 && <span className="px-0.5 text-[10px] text-muted-foreground/60">/</span>}
          {combo.map((key) => (
            <Kbd key={key}>{key}</Kbd>
          ))}
        </React.Fragment>
      ))}
    </span>
  )
}

/** 页签底部说明块（icon + 文案；primary = 主色强调） */
function NoteCard({
  icon: Icon,
  primary,
  children,
}: {
  icon: LucideIcon
  primary?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'mt-3 flex gap-2 rounded-lg border px-3 py-2 text-[11.5px] leading-5 text-muted-foreground',
        primary ? 'border-primary/20 bg-primary/[0.04]' : 'border-border/70 bg-muted/40',
      )}
    >
      <Icon
        className={cn('mt-0.5 size-3.5 shrink-0', primary ? 'text-primary' : 'text-muted-foreground')}
        aria-hidden
      />
      <p>{children}</p>
    </div>
  )
}

export function ShortcutHelp(): React.JSX.Element {
  const open = useUiStore((s) => s.helpOpen)
  const setOpen = useUiStore((s) => s.setHelpOpen)
  const [tab, setTab] = React.useState<ShortcutGroup['id']>('general')

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-lg gap-0 overflow-hidden p-0">
        {/* 头部：图标 + 标题 + 副题（右侧留出内置关闭钮位） */}
        <DialogHeader className="flex-row items-center gap-2.5 border-b bg-muted/30 py-3 pl-5 pr-12">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Keyboard className="size-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <DialogTitle className="text-[13.5px] leading-5">键盘快捷键</DialogTitle>
            <DialogDescription className="text-[11px] leading-4">
              ⌘ = Ctrl（非 macOS）· ? 键随时呼出，Esc 关闭
            </DialogDescription>
          </div>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as ShortcutGroup['id'])}>
          {/* 分组页签：等宽三格（通用 / 输入框 / 审批卡）；画布组已临时隐藏 */}
          <div className="px-5 pt-3">
            <TabsList className="w-full" aria-label="快捷键分组">
              {GROUPS.map((group) => (
                <TabsTrigger
                  key={group.id}
                  value={group.id}
                  className="flex-1 gap-1.5 focus-visible:ring-1 focus-visible:ring-primary/40"
                >
                  <group.icon className="size-3.5" aria-hidden />
                  {group.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          {/* 内容区：最小高度（短组不塌陷）+ 上限内部滚动（画布等长组） */}
          <div className="max-h-[52vh] min-h-[232px] overflow-y-auto px-5 pb-4 pt-3">
            {GROUPS.map((group) => (
              <TabsContent key={group.id} value={group.id} className="mt-0">
                {group.hint && (
                  <p className="mb-2 text-[11px] leading-4 text-muted-foreground">{group.hint}</p>
                )}
                <ul className="divide-y divide-border/60 rounded-lg border">
                  {group.items.map((item) => (
                    <li key={item.label} className="flex items-center gap-3 px-3 py-2">
                      <span className="min-w-0 flex-1 text-[12.5px] leading-5">
                        {item.label}
                        {item.note && (
                          <span className="block text-[11px] leading-4 text-muted-foreground">
                            {item.note}
                          </span>
                        )}
                      </span>
                      <KeyCaps combos={item.combos} />
                    </li>
                  ))}
                </ul>
                {group.note && (
                  <NoteCard icon={group.note.icon} primary={group.note.primary}>
                    {group.note.content}
                  </NoteCard>
                )}
              </TabsContent>
            ))}
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

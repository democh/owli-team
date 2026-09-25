/**
 * M80-A：表情选择器（docs/emoji-and-readreceipt-design.md §5）。
 *
 * - 内置数据集（shared/emoji-data）：常用 48 直达 + 8 分类 + 中英/拼音搜索；
 * - 键盘：↑↓←→ 移动高亮（×8 网格行距）· Enter 插入 · Esc 关闭（文档 §5.2 口径）；
 * - 最近使用：localStorage 每端 24 槽（纯本地偏好，不落库不同步）；
 * - 纯 Unicode 插入（无短代码体系）；Esc / 点外部关闭；
 * - 复用方：Composer 工具条（插正文）+ 消息反应快捷条「更多」（M80-B）。
 */
import * as React from 'react'
import { Search, X } from 'lucide-react'
import { EMOJI_CATEGORIES, EMOJI_COMMON, searchEmoji, type EmojiItem } from '@multi-agent/shared'
import { cn } from '../../lib/utils'

const RECENT_KEY = 'ma:emoji:recent'
const RECENT_MAX = 24

export function loadRecentEmojis(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    const arr = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string').slice(0, RECENT_MAX) : []
  } catch {
    return []
  }
}

/** 记录一次使用（置顶去重；纯本地） */
export function pushRecentEmoji(char: string): void {
  try {
    const next = [char, ...loadRecentEmojis().filter((c) => c !== char)].slice(0, RECENT_MAX)
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    // 隐私模式等：静默
  }
}

const ALL_BY_CHAR = new Map(EMOJI_CATEGORIES.flatMap((c) => c.items).map((i) => [i.char, i]))

export interface EmojiPickerProps {
  onPick: (char: string) => void
  onClose: () => void
  /** 面板高度风格：composer = 大网格（默认）；compact = 反应快捷条「更多」（更矮） */
  variant?: 'composer' | 'compact'
}

export function EmojiPicker({ onPick, onClose, variant = 'composer' }: EmojiPickerProps): React.JSX.Element {
  const [query, setQuery] = React.useState('')
  const [category, setCategory] = React.useState<string>(EMOJI_CATEGORIES[0].id)
  const [recent, setRecent] = React.useState<string[]>(() => loadRecentEmojis())
  /** 键盘导航高亮位（相对 flat 平面序列；查询 / 分类变化时复位） */
  const [activeIndex, setActiveIndex] = React.useState(0)
  const rootRef = React.useRef<HTMLDivElement>(null)
  const searchRef = React.useRef<HTMLInputElement>(null)

  // 打开聚焦搜索；Esc 关闭；点外部关闭
  React.useEffect(() => {
    searchRef.current?.focus()
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') {
        ev.stopPropagation()
        onClose()
      }
    }
    const onDown = (ev: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(ev.target as Node)) onClose()
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('mousedown', onDown)
    }
  }, [onClose])

  const pick = (char: string): void => {
    pushRecentEmoji(char)
    setRecent(loadRecentEmojis())
    onPick(char)
  }

  const searching = query.trim().length > 0
  const results: EmojiItem[] = searching ? searchEmoji(query) : []
  const recentItems = recent.map((c) => ALL_BY_CHAR.get(c)).filter((x): x is EmojiItem => !!x)
  const active = EMOJI_CATEGORIES.find((c) => c.id === category) ?? EMOJI_CATEGORIES[0]
  /** 快捷区（最近使用 / 常用 48） */
  const quickItems =
    recentItems.length > 0 ? recentItems : EMOJI_COMMON.map((c) => ALL_BY_CHAR.get(c)).filter((x): x is EmojiItem => !!x)
  /** 键盘导航平面序列（搜索 = 结果；否则 = 快捷区 + 当前分类）——与 DOM 渲染顺序一致 */
  const flat: EmojiItem[] = searching ? results : [...quickItems, ...active.items]

  React.useEffect(() => {
    setActiveIndex(0)
  }, [query, category])

  /** ↑↓←→ 移动高亮（网格 8 列）/ Enter 插入（文档 §5.2） */
  const onKeyDown = (ev: React.KeyboardEvent): void => {
    if (flat.length === 0) return
    const step =
      ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : ev.key === 'ArrowDown' ? 8 : ev.key === 'ArrowUp' ? -8 : 0
    if (step !== 0) {
      ev.preventDefault()
      setActiveIndex((i) => Math.min(flat.length - 1, Math.max(0, i + step)))
      return
    }
    if (ev.key === 'Enter') {
      ev.preventDefault()
      const item = flat[Math.min(activeIndex, flat.length - 1)]
      if (item) pick(item.char)
    }
  }

  const cell = (item: EmojiItem, index: number): React.JSX.Element => (
    <button
      key={item.char}
      type="button"
      title={item.name}
      aria-label={item.name}
      onClick={() => pick(item.char)}
      className={cn(
        'flex size-8 items-center justify-center rounded-md text-[20px] transition-colors hover:bg-primary/10 active:bg-primary/20',
        activeIndex === index && 'ring-1 ring-primary/60 bg-primary/10',
      )}
    >
      {item.char}
    </button>
  )

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label="表情选择"
      onKeyDown={onKeyDown}
      className={cn(
        'flex w-[320px] flex-col overflow-hidden rounded-xl border bg-popover shadow-lg',
        variant === 'compact' ? 'h-[280px]' : 'h-[360px]',
      )}
    >
      {/* 搜索行 */}
      <div className="flex items-center gap-1.5 border-b px-2.5 py-2">
        <Search className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          ref={searchRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索表情（中文 / 英文 / 拼音）"
          className="min-w-0 flex-1 bg-transparent text-[12.5px] placeholder:text-muted-foreground/70 focus:outline-none"
        />
        {searching && (
          <button type="button" aria-label="清空搜索" onClick={() => setQuery('')} className="text-muted-foreground hover:text-foreground">
            <X className="size-3.5" />
          </button>
        )}
      </div>

      {/* 分类 tab（搜索时隐藏） */}
      {!searching && (
        <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b px-2 py-1.5">
          {EMOJI_CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setCategory(c.id)}
              className={cn(
                'shrink-0 rounded-full px-2 py-0.5 text-[11px] transition-colors',
                category === c.id ? 'bg-primary/12 font-medium text-primary' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}

      {/* 网格区 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {searching ? (
          results.length > 0 ? (
            <div className="grid grid-cols-8 gap-0.5">{results.map((item, i) => cell(item, i))}</div>
          ) : (
            <p className="py-8 text-center text-[12px] text-muted-foreground">没有找到「{query.trim()}」相关表情</p>
          )
        ) : (
          <>
            {quickItems.length > 0 && (
              <>
                <p className="px-1 pb-1 text-[11px] font-medium text-muted-foreground">{recentItems.length > 0 ? '最近使用' : '常用'}</p>
                <div className="grid grid-cols-8 gap-0.5 pb-2">{quickItems.map((item, i) => cell(item, i))}</div>
              </>
            )}
            <p className="px-1 pb-1 text-[11px] font-medium text-muted-foreground">{active.label}</p>
            <div className="grid grid-cols-8 gap-0.5">{active.items.map((item, i) => cell(item, quickItems.length + i))}</div>
          </>
        )}
      </div>
    </div>
  )
}

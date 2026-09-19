/**
 * M26：控制台表单基元（无额外依赖，风格对齐既有 UI kit）。
 * - FieldRow：标签 + 提示 + 子控件；
 * - TextInput：受控文本输入（密度略紧于主界面 Input）；
 * - Switch：开关；
 * - TagInput：标签数组编辑（回车 / 逗号提交，退格删除末项）；
 * - RefMultiSelect：候选多选（工具白名单 / 技能预载 / 交接对象）；
 * - IconPicker：lucide 注册表（ICON_REGISTRY）图标选择；
 * - ColorPair：渐变双色（avatar.gradient）；
 * - MarkdownField：Markdown 编辑 / 预览切换（复用 chat/Markdown）。
 */
import * as React from 'react'
import { Check, X } from 'lucide-react'
import { ICON_REGISTRY } from '../../lib/avatar-icons'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Markdown } from '../chat/Markdown'

export function FieldRow({
  label,
  hint,
  children,
  className,
}: {
  label: string
  hint?: string
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div className={cn('space-y-1', className)}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-medium">{label}</span>
        {hint && <span className="text-[11px] text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </div>
  )
}

export function TextInput({
  value,
  onChange,
  placeholder,
  mono,
  ariaLabel,
  disabled,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  mono?: boolean
  ariaLabel?: string
  disabled?: boolean
}): React.JSX.Element {
  return (
    <input
      value={value}
      aria-label={ariaLabel}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        'h-8 w-full rounded-md border border-input bg-card px-2.5 text-[12.5px] shadow-sm transition-colors placeholder:text-muted-foreground/70 focus-visible:border-primary/40 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/15 disabled:cursor-not-allowed disabled:opacity-60',
        mono && 'font-mono text-[12px]',
      )}
    />
  )
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label?: string
  disabled?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => {
        if (!disabled) onChange(!checked)
      }}
      className={cn(
        'relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-primary' : 'bg-input',
      )}
    >
      <span
        className={cn('absolute top-0.5 size-4 rounded-full bg-white shadow transition-all', checked ? 'left-[18px]' : 'left-0.5')}
      />
    </button>
  )
}

export function TagInput({
  value,
  onChange,
  placeholder,
}: {
  value: string[]
  onChange: (v: string[]) => void
  placeholder?: string
}): React.JSX.Element {
  const [draft, setDraft] = React.useState('')
  const commit = (raw: string): void => {
    const token = raw.trim().replace(/[,，]$/, '').trim()
    if (!token) return
    if (!value.includes(token)) onChange([...value, token])
    setDraft('')
  }
  return (
    <div className="flex min-h-8 flex-wrap items-center gap-1.5 rounded-md border border-input bg-card px-2 py-1">
      {value.map((tag) => (
        <span key={tag} className="inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-[11.5px]">
          {tag}
          <button
            type="button"
            aria-label={`移除 ${tag}`}
            className="text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => onChange(value.filter((t) => t !== tag))}
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        value={draft}
        placeholder={value.length === 0 ? (placeholder ?? '输入后回车') : ''}
        className="h-6 min-w-24 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-muted-foreground/70"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
            e.preventDefault()
            commit(draft)
          } else if (e.key === 'Backspace' && draft === '' && value.length > 0) {
            onChange(value.slice(0, -1))
          }
        }}
        onBlur={() => commit(draft)}
      />
    </div>
  )
}

export interface RefOption {
  id: string
  label: string
  hint?: string
}

export function RefMultiSelect({
  options,
  value,
  onChange,
  disabled,
  emptyText,
  heightClass = 'max-h-44',
}: {
  options: RefOption[]
  value: string[]
  onChange: (v: string[]) => void
  disabled?: boolean
  emptyText?: string
  heightClass?: string
}): React.JSX.Element {
  const [query, setQuery] = React.useState('')
  const keyword = query.trim().toLowerCase()
  const filtered = keyword
    ? options.filter((o) => o.label.toLowerCase().includes(keyword) || o.id.toLowerCase().includes(keyword))
    : options
  const toggle = (id: string): void => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id])
  return (
    <div className={cn('rounded-md border border-input bg-card', disabled && 'opacity-60')}>
      {options.length > 8 && (
        <input
          value={query}
          disabled={disabled}
          placeholder="过滤…"
          className="h-8 w-full border-b bg-transparent px-2.5 text-[12px] outline-none placeholder:text-muted-foreground/70"
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      <div className={cn('overflow-y-auto p-1', heightClass)}>
        {filtered.map((o) => {
          const checked = value.includes(o.id)
          return (
            <button
              key={o.id}
              type="button"
              disabled={disabled}
              aria-pressed={checked}
              onClick={() => toggle(o.id)}
              className={cn('flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12.5px] hover:bg-accent/70', checked && 'bg-primary/5')}
            >
              <span
                className={cn(
                  'flex size-3.5 shrink-0 items-center justify-center rounded border',
                  checked ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
                )}
              >
                {checked && <Check className="size-2.5" />}
              </span>
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
              {o.hint && <span className="shrink-0 text-[11px] text-muted-foreground">{o.hint}</span>}
            </button>
          )
        })}
        {filtered.length === 0 && (
          <div className="px-2 py-3 text-center text-[11.5px] text-muted-foreground">{emptyText ?? '无候选'}</div>
        )}
      </div>
    </div>
  )
}

export function IconPicker({
  value,
  onChange,
}: {
  value?: string
  onChange: (v: string | undefined) => void
}): React.JSX.Element {
  const names = Object.keys(ICON_REGISTRY)
  return (
    <div className="flex max-h-36 flex-wrap gap-1 overflow-y-auto rounded-md border border-input bg-card p-1.5">
      {names.map((name) => {
        const Icon = ICON_REGISTRY[name]
        const active = value === name
        return (
          <button
            key={name}
            type="button"
            title={name}
            aria-label={`图标 ${name}`}
            aria-pressed={active}
            className={cn(
              'flex size-7 items-center justify-center rounded transition-colors',
              active ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-accent',
            )}
            onClick={() => onChange(active ? undefined : name)}
          >
            <Icon className="size-3.5" />
          </button>
        )
      })}
    </div>
  )
}

export function ColorPair({
  value,
  onChange,
}: {
  value?: [string, string]
  onChange: (v: [string, string] | undefined) => void
}): React.JSX.Element {
  const current: [string, string] = value ?? ['#6366f1', '#818cf8']
  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        aria-label="渐变色 1"
        value={current[0]}
        onChange={(e) => onChange([e.target.value, current[1]])}
        className="h-8 w-10 cursor-pointer rounded border border-input bg-card p-0.5"
      />
      <input
        type="color"
        aria-label="渐变色 2"
        value={current[1]}
        onChange={(e) => onChange([current[0], e.target.value])}
        className="h-8 w-10 cursor-pointer rounded border border-input bg-card p-0.5"
      />
      <span className="text-[11px] text-muted-foreground">预览</span>
      <span className="size-6 rounded" style={{ background: `linear-gradient(135deg, ${current[0]}, ${current[1]})` }} />
      {value && (
        <Button type="button" variant="ghost" size="xs" onClick={() => onChange(undefined)}>
          清除
        </Button>
      )}
    </div>
  )
}

export function MarkdownField({
  value,
  onChange,
  rows = 14,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  rows?: number
  placeholder?: string
}): React.JSX.Element {
  const [preview, setPreview] = React.useState(false)
  return (
    <div className="overflow-hidden rounded-md border border-input bg-card">
      <div className="flex items-center justify-between border-b px-2 py-1">
        <span className="text-[11px] text-muted-foreground">Markdown 正文</span>
        <div className="flex gap-1">
          <Button type="button" variant={preview ? 'ghost' : 'secondary'} size="xs" onClick={() => setPreview(false)}>
            编辑
          </Button>
          <Button type="button" variant={preview ? 'secondary' : 'ghost'} size="xs" onClick={() => setPreview(true)}>
            预览
          </Button>
        </div>
      </div>
      {preview ? (
        <div className="max-h-[420px] min-h-32 overflow-y-auto px-3 py-2">
          <Markdown content={value || '（空）'} />
        </div>
      ) : (
        <textarea
          value={value}
          rows={rows}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="block w-full resize-y bg-transparent px-3 py-2 font-mono text-[12px] leading-5 outline-none placeholder:text-muted-foreground/70"
        />
      )}
    </div>
  )
}
